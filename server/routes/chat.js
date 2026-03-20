/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import { MoodParser, XingParser, ThinkTagParser } from "../../core/events.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { createModuleLogger, debugLog, previewForLog } from "../../lib/debug-log.js";
import { getLocale, t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MEDIA_ATTACHMENTS,
  MAX_VIDEO_BYTES,
} from "../../lib/media-limits.js";
import {
  looksLikeProviderRejectedMultimodal,
  mediaKindsFromPayloadImages,
} from "../../lib/media-reject-heuristic.js";
import {
  isSessionMediaKindRejected,
  recordSessionMediaKindsRejected,
} from "../../lib/session-media-reject-cache.js";
import { filterImagesForModelInput } from "../../lib/model-media-capabilities.js";

/** tool_start 事件只广播这些 arg 字段，避免传输完整文件内容（同步维护：chat-render-shim.ts extractToolDetail） */
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query"];

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/x-icon"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
  "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/x-aac",
  "audio/ogg", "audio/opus", "audio/flac", "audio/x-flac",
]);

/** 浏览器常带 codecs 等参数，如 video/mp4; codecs="avc1.42E01E" — 必须取主类型再白名单校验 */
const MIME_ALIASES = {
  "image/jpg": "image/jpeg",
  "video/x-quicktime": "video/quicktime",
};

function normalizeMediaMime(mime) {
  if (!mime || typeof mime !== "string") return "";
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_ALIASES[base] || base;
}

const logWsPrompt = createModuleLogger("ws-prompt");

function decodedBase64Bytes(data) {
  if (!data || typeof data !== "string") return 0;
  try {
    return Buffer.from(data, "base64").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function formatMediaKindsForLocale(kinds, localeKey) {
  const isEn = localeKey === "en";
  const map = {
    image: isEn ? "image" : "图片",
    video: isEn ? "video" : "视频",
    audio: isEn ? "audio" : "音频",
  };
  return kinds.map(k => map[k] || k).join(isEn ? ", " : "、");
}

/**
 * 从 Pi SDK 的 content 块中提取纯文本
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b.type === "text" && b.text)
    .map(b => b.text)
    .join("");
}

/** 会话路径尾部，便于日志对齐且不暴露完整 home 路径 */
function sessionPathTail(p, max = 56) {
  if (!p || typeof p !== "string") return "(none)";
  return p.length <= max ? p : `…${p.slice(-max)}`;
}

/** 统计本轮已记入 ss.events 的流式事件（turn_end 写入前调用） */
function summarizeWsStreamForDiag(ss) {
  let textDeltas = 0;
  let textChars = 0;
  let thinkingChars = 0;
  let toolStarts = 0;
  let moodTextChars = 0;
  let xingTextChars = 0;
  for (const e of ss.events || []) {
    const ev = e?.event;
    if (!ev?.type) continue;
    switch (ev.type) {
      case "text_delta":
        textDeltas++;
        textChars += String(ev.delta || "").length;
        break;
      case "thinking_delta":
        thinkingChars += String(ev.delta || "").length;
        break;
      case "tool_start":
        toolStarts++;
        break;
      case "mood_text":
        moodTextChars += String(ev.delta || "").length;
        break;
      case "xing_text":
        xingTextChars += String(ev.delta || "").length;
        break;
      default:
        break;
    }
  }
  return { textDeltas, textChars, thinkingChars, toolStarts, moodTextChars, xingTextChars };
}

export default async function chatRoute(app, { engine, hub }) {
  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const sessionState = new Map(); // sessionPath -> shared stream state

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (disconnectAbortTimer || activeWsClients > 0) return;
    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;

      const currentPath = engine.currentSessionPath;
      if (!currentPath) return;

      if (engine.isSessionStreaming(currentPath)) {
        debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms, abort streaming`);
        engine.abortSessionByPath(currentPath).catch(() => {});
      }
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  const MAX_SESSION_STATES = 20;

  function getState(sessionPath) {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
      // 超过上限时，淘汰非流式的旧 entry
      if (sessionState.size >= MAX_SESSION_STATES) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming && sp !== sessionPath) {
            sessionState.delete(sp);
            if (sessionState.size < MAX_SESSION_STATES) break;
          }
        }
      }
      sessionState.set(sessionPath, {
        thinkTagParser: new ThinkTagParser(),
        moodParser: new MoodParser(),
        xingParser: new XingParser(),
        isThinking: false,
        titleRequested: false,
        titlePreview: "",
        /** 最近一条带附件的 user prompt 的媒体大类，用于流式 error 时写入拒绝缓存 */
        lastPromptMediaKinds: null,
        /** 最近一轮 turn_end 诊断 */
        lastTurnDiag: null,
        /** 最近一轮是否为空流（且无明确 error 事件） */
        lastTurnEmptyNoError: false,
        /** 最近一轮是否出现 message_update.error */
        lastTurnHadError: false,
        ...createSessionStreamState(),
      });
    }
    return sessionState.get(sessionPath);
  }

  const clients = new Set();

  function broadcast(msg) {
    for (const client of clients) {
      wsSend(client, msg);
    }
  }

  engine.setAgentSwitchBroadcast((msg) => broadcast(msg));
  engine.setHandoffStreamingBroadcast((streaming) => {
    broadcast({ type: "status", isStreaming: !!streaming });
  });

  // 浏览器缩略图 30s 定时刷新（browser 活跃时）
  let _browserThumbTimer = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stopBrowserThumbPoll(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitStreamEvent(sessionPath, ss, event) {
    const entry = appendSessionStreamEvent(ss, event);
    if (sessionPath === engine.currentSessionPath) {
      broadcast({
        ...event,
        sessionPath,
        streamId: entry.streamId,
        seq: entry.seq,
      });
    } else if (
      event.type === "text_delta"
      && String(event.delta || "").length > 0
      && !ss._streamDiagInactiveWarned
    ) {
      ss._streamDiagInactiveWarned = true;
      debugLog()?.warn(
        "ws",
        `text_delta dropped (not current session): got=${sessionPathTail(sessionPath)} current=${sessionPathTail(engine.currentSessionPath)} deltaChars=${String(event.delta || "").length}`,
      );
    }
    return entry;
  }

  function maybeGenerateFirstTurnTitle(sessionPath, ss) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter(m => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find(m => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe((event, sessionPath) => {
    const isActive = sessionPath === engine.currentSessionPath;
    const ss = sessionPath ? getState(sessionPath) : null;

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        const delta = event.assistantMessageEvent.delta;
        // ThinkTagParser（最外层）→ MoodParser → XingParser
        ss.thinkTagParser.feed(delta, (tEvt) => {
          switch (tEvt.type) {
            case "think_start":
              emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
              break;
            case "think_text":
              emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
              break;
            case "think_end":
              emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
              break;
            case "text":
              // 非 think 内容继续走 MoodParser → XingParser 链
              ss.moodParser.feed(tEvt.data, (evt) => {
                switch (evt.type) {
                  case "text":
                    ss.xingParser.feed(evt.data, (xEvt) => {
                      switch (xEvt.type) {
                        case "text":
                          ss.titlePreview += xEvt.data || "";
                          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                          maybeGenerateFirstTurnTitle(sessionPath, ss);
                          break;
                        case "xing_start":
                          emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                          break;
                        case "xing_text":
                          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                          break;
                        case "xing_end":
                          emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                          break;
                      }
                    });
                    break;
                  case "mood_start":
                    emitStreamEvent(sessionPath, ss, { type: "mood_start" });
                    break;
                  case "mood_text":
                    emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
                    break;
                  case "mood_end":
                    emitStreamEvent(sessionPath, ss, { type: "mood_end" });
                    break;
                }
              });
              break;
          }
        });
      } else if (sub === "thinking_delta") {
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.assistantMessageEvent.delta || "",
        });
      } else if (sub === "toolcall_start") {
        // 不在这里关闭 thinking 状态
      } else if (sub === "error") {
        const errText = event.assistantMessageEvent.error || "Unknown error";
        if (ss) ss.lastTurnHadError = true;
        if (
          looksLikeProviderRejectedMultimodal(errText) &&
          ss?.lastPromptMediaKinds?.length &&
          engine.currentModel?.id
        ) {
          recordSessionMediaKindsRejected(sessionPath, engine.currentModel.id, ss.lastPromptMediaKinds);
        }
        if (isActive) broadcast({ type: "error", message: errText });
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // 只保留前端 extractToolDetail 需要的字段，避免广播完整文件内容
      const rawArgs = event.args;
      let args;
      if (rawArgs && typeof rawArgs === "object") {
        args = {};
        for (const k of TOOL_ARG_SUMMARY_KEYS) { if (rawArgs[k] !== undefined) args[k] = rawArgs[k]; }
      }
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: event.toolName || "",
        success: !event.isError,
        details: event.result?.details,
      });

      if (event.toolName === "present_files") {
        const details = event.result?.details || {};
        const files = details.files || [];
        if (files.length === 0 && details.filePath) {
          files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
        }
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, {
            type: "file_output",
            filePath: f.filePath,
            label: f.label,
            ext: f.ext || "",
          });
        }
      }

      if (event.toolName === "create_artifact") {
        const d = event.result?.details || {};
        emitStreamEvent(sessionPath, ss, {
          type: "artifact",
          artifactId: d.artifactId,
          artifactType: d.type,
          title: d.title,
          content: d.content,
          language: d.language,
        });
      }

      // 截图推送给前端：优先从 details.screenshotBase64 取（工具只返文本给模型时），否则从 content 的 image 块取
      const d = event.result?.details || {};
      if (d.screenshotBase64) {
        emitStreamEvent(sessionPath, ss, {
          type: "browser_screenshot",
          base64: d.screenshotBase64,
          mimeType: d.mimeType || "image/png",
        });
      } else if (event.result?.content?.length) {
        const imgBlock = event.result.content.find((c) => c.type === "image");
        if (imgBlock?.source?.data) {
          emitStreamEvent(sessionPath, ss, {
            type: "browser_screenshot",
            base64: imgBlock.source.data,
            mimeType: imgBlock.source.media_type || "image/jpeg",
          });
        }
      }

      if (event.toolName === "single_use_browser") {
        const d = event.result?.details || {};
        const statusMsg = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) statusMsg.thumbnail = d.thumbnail;
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else stopBrowserThumbPoll();
      }

      if (event.toolName === "cron") {
        const d = event.result?.details || {};
        if (d.action === "pending_add" && d.jobData) {
          emitStreamEvent(sessionPath, ss, { type: "cron_confirmation", jobData: d.jobData });
        }
      }

      if (isActive && ["write", "edit", "bash"].includes(event.toolName)) {
        broadcast({ type: "desk_changed", path: null });
      }
    } else if (event.type === "desk_changed") {
      broadcast({ type: "desk_changed", path: event.path ?? null });
    } else if (event.type === "jian_executing") {
      broadcast({ type: "jian_executing", active: event.active === true });
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url });
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "notification") {
      broadcast({ type: "notification", title: event.title, body: event.body });
    } else if (event.type === "channel_new_message") {
      broadcast({ type: "channel_new_message", channelName: event.channelName, sender: event.sender });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "turn_end") {
      if (!ss) return;
      // flush 顺序：ThinkTag → Mood → Xing（和 feed 顺序一致）
      // flush 内部的 mood → xing 管线（thinkTag flush 和 mood flush 共用）
      const feedMoodPipeline = (text) => {
        ss.moodParser.feed(text, (evt) => {
          if (evt.type === "text") {
            ss.xingParser.feed(evt.data, (xEvt) => {
              switch (xEvt.type) {
                case "text":
                  emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                  break;
                case "xing_start":
                  emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                  break;
                case "xing_text":
                  emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                  break;
                case "xing_end":
                  emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                  break;
              }
            });
          } else if (evt.type === "mood_start") {
            emitStreamEvent(sessionPath, ss, { type: "mood_start" });
          } else if (evt.type === "mood_text") {
            emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
          } else if (evt.type === "mood_end") {
            emitStreamEvent(sessionPath, ss, { type: "mood_end" });
          }
        });
      };
      ss.thinkTagParser.flush((tEvt) => {
        if (tEvt.type === "think_text") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
        } else if (tEvt.type === "think_end") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        } else if (tEvt.type === "text") {
          feedMoodPipeline(tEvt.data);
        }
      });
      ss.moodParser.flush((evt) => {
        if (evt.type === "text") {
          ss.xingParser.feed(evt.data, (xEvt) => {
            switch (xEvt.type) {
              case "text":
                emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                break;
              case "xing_start":
                emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                break;
              case "xing_text":
                emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                break;
              case "xing_end":
                emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                break;
            }
          });
        } else if (evt.type === "mood_text") {
          emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
        }
      });
      ss.xingParser.flush((xEvt) => {
        if (xEvt.type === "text") {
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
        } else if (xEvt.type === "xing_text") {
          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
        }
      });

      const diag = summarizeWsStreamForDiag(ss);
      const tail = sessionPathTail(sessionPath);
      const diagStr = `path=${tail} textΔ=${diag.textDeltas} textChars=${diag.textChars} thinkingChars=${diag.thinkingChars} tools=${diag.toolStarts} moodChars=${diag.moodTextChars} xingChars=${diag.xingTextChars} titlePreview=${(ss.titlePreview || "").length} events=${ss.events?.length ?? 0}`;

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      finishSessionStream(ss);
      ss.isThinking = false;
      ss.thinkTagParser.reset();
      ss.moodParser.reset();
      ss.xingParser.reset();

      if (isActive) {
        debugLog()?.log("ws", `assistant reply done | ${diagStr}`);
        const isEmptyNoError = (
          diag.textChars === 0
          && diag.moodTextChars === 0
          && diag.xingTextChars === 0
          && diag.toolStarts === 0
          && diag.thinkingChars === 0
          && !ss.lastTurnHadError
        );
        ss.lastTurnDiag = diag;
        ss.lastTurnEmptyNoError = isEmptyNoError;
        if (
          diag.textChars === 0
          && diag.moodTextChars === 0
          && diag.xingTextChars === 0
          && diag.toolStarts === 0
        ) {
          if (diag.thinkingChars > 0) {
            debugLog()?.warn("ws", `assistant: no main/mood/xing/tools; only thinking (${diag.thinkingChars} chars) | ${diagStr}`);
          } else {
            debugLog()?.warn("ws", `assistant: empty stream (no text/thinking/tools) | ${diagStr}`);
          }
        }
        maybeGenerateFirstTurnTitle(sessionPath, ss);
        // 推迟到本轮 turn_end 收尾之后，避免与 Pi 会话收尾并发导致 sessionManager 为空
        setTimeout(() => {
          engine.applyPendingServiceHandoffIfAny?.().catch(() => {});
        }, 0);
      } else {
        debugLog()?.warn("ws", `turn_end non-active session | ${diagStr}`);
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const ws = socket;
    let closed = false;
    activeWsClients++;
    clients.add(ws);
    cancelDisconnectAbort();
    debugLog()?.log("ws", "client connected");

    // 注意：token 校验由 server/index.js 的 onRequest hook 统一处理，
    // Fastify @fastify/websocket 的 WS 升级请求也会经过该 hook

    // 处理客户端消息
    ws.on("message", async (raw) => {
      const msg = wsParse(raw);
      if (!msg) return;

      if (msg.type === "abort") {
        if (engine.isStreaming) {
          try { await hub.abort(); } catch {}
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
        if (engine.steer(msg.text)) {
          wsSend(ws, { type: "steered" });
          return;
        }
        // agent 已停止，降级为正常 prompt（下面的 prompt 分支会处理）
        debugLog()?.log("ws", `steer missed, falling back to prompt`);
        msg.type = "prompt";
      }

      // session 切回时，前端请求补发离屏期间的流式内容
      if (msg.type === "resume_stream") {
        const currentPath = msg.sessionPath || engine.currentSessionPath;
        const ss = sessionState.get(currentPath);
        if (ss) {
          const resumed = resumeSessionStream(ss, {
            streamId: msg.streamId,
            sinceSeq: msg.sinceSeq,
          });
          wsSend(ws, {
            type: "stream_resume",
            sessionPath: currentPath,
            streamId: resumed.streamId,
            sinceSeq: resumed.sinceSeq,
            nextSeq: resumed.nextSeq,
            reset: resumed.reset,
            truncated: resumed.truncated,
            isStreaming: resumed.isStreaming,
            events: resumed.events,
          });
        } else {
          wsSend(ws, {
            type: "stream_resume",
            sessionPath: currentPath,
            streamId: null,
            sinceSeq: Number.isFinite(msg.sinceSeq) ? Math.max(0, msg.sinceSeq) : 0,
            nextSeq: 1,
            reset: false,
            truncated: false,
            isStreaming: false,
            events: [],
          });
        }
        return;
      }

      if (msg.type === "prompt" && (msg.text || msg.images?.length)) {
        // 媒体校验：最多 N 个，尺寸上限，白名单 MIME（规范化后校验）
        if (msg.images?.length) {
          if (msg.images.length > MAX_MEDIA_ATTACHMENTS) {
            logWsPrompt.warn(`reject: too many attachments (${msg.images.length} > ${MAX_MEDIA_ATTACHMENTS})`);
            wsSend(ws, { type: "error", message: `最多同时发送 ${MAX_MEDIA_ATTACHMENTS} 个图片、视频或语音` });
            return;
          }
          for (let i = 0; i < msg.images.length; i++) {
            const img = msg.images[i];
            const mimeRaw = img?.mimeType;
            const mime = normalizeMediaMime(mimeRaw);
            if (!mime || (!IMAGE_MIMES.has(mime) && !VIDEO_MIMES.has(mime) && !AUDIO_MIMES.has(mime))) {
              logWsPrompt.warn(
                `reject media #${i + 1}: rawMime=${JSON.stringify(mimeRaw)} norm=${mime || "(empty)"} bytes=${decodedBase64Bytes(img?.data)}`,
              );
              wsSend(ws, {
                type: "error",
                message: `不支持的媒体格式: ${mimeRaw || "unknown"}（规范化: ${mime || "—"}）`,
              });
              return;
            }
            const rawBytes = decodedBase64Bytes(img.data);
            if (IMAGE_MIMES.has(mime) && rawBytes > MAX_IMAGE_BYTES) {
              logWsPrompt.warn(`reject image #${i + 1}: ${rawBytes}B > ${MAX_IMAGE_BYTES}`);
              wsSend(ws, { type: "error", message: "单张图片不得超过 10MB" });
              return;
            }
            if (VIDEO_MIMES.has(mime) && rawBytes > MAX_VIDEO_BYTES) {
              logWsPrompt.warn(`reject video #${i + 1}: ${rawBytes}B > ${MAX_VIDEO_BYTES}`);
              wsSend(ws, { type: "error", message: "单个视频不得超过 20MB" });
              return;
            }
            if (AUDIO_MIMES.has(mime) && rawBytes > MAX_AUDIO_BYTES) {
              logWsPrompt.warn(`reject audio #${i + 1}: ${rawBytes}B > ${MAX_AUDIO_BYTES}`);
              wsSend(ws, { type: "error", message: "单条语音不得超过 20MB" });
              return;
            }
            // 下游 Pi / API 使用规范化 mime
            msg.images[i] = { ...img, mimeType: mime };
          }
          logWsPrompt.log(
            `accept ${msg.images.length} media: ${msg.images.map((im, j) => `#${j + 1} ${im.mimeType} ${decodedBase64Bytes(im.data)}B`).join(" | ")}`,
          );
        }
        const hadImagesAfterMimeCheck = !!(msg.images?.length);
        if (hadImagesAfterMimeCheck) {
          const filtered = filterImagesForModelInput(msg.images, engine.currentModel?.input);
          if (filtered?.length !== msg.images.length) {
            logWsPrompt.log(
              `model.input filter: ${msg.images.length} → ${filtered?.length ?? 0} (model.input=${JSON.stringify(engine.currentModel?.input)})`,
            );
          }
          msg.images = filtered;
        }
        // 只发媒体没文字时补占位文本，防止空 text 导致某些 API 异常
        let promptText = msg.text || "";
        if (!promptText.trim() && hadImagesAfterMimeCheck && !msg.images?.length) {
          promptText = t("error.mediaOmittedForModel");
        }
        if (!promptText.trim() && msg.images?.length) {
          const hasVideo = msg.images.some((i) => i?.mimeType && VIDEO_MIMES.has(i.mimeType));
          const hasAudio = msg.images.some((i) => i?.mimeType && AUDIO_MIMES.has(i.mimeType));
          if (hasVideo && hasAudio) promptText = "（看视频/图/听语音）";
          else if (hasVideo) promptText = "（看视频/图）";
          else if (hasAudio) promptText = "（听语音）";
          else promptText = "（看图）";
        }
        // 只检查当前活跃 session 是否在 streaming
        if (engine.isStreaming) {
          wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
          return;
        }
        const promptSessionPath = engine.currentSessionPath;
        debugLog()?.log(
          "ws",
          `user message (${promptText.length} chars, ${msg.images?.length || 0} media) session=${sessionPathTail(promptSessionPath)} wsClients=${activeWsClients} preview=${previewForLog(promptText, 120)}`,
        );
        const ss = getState(promptSessionPath);
        const modelId = engine.currentModel?.id;
        const promptKinds = msg.images?.length ? mediaKindsFromPayloadImages(msg.images) : [];
        if (ss && promptKinds.length && modelId) {
          const blocked = promptKinds.filter((k) =>
            isSessionMediaKindRejected(promptSessionPath, modelId, k),
          );
          if (blocked.length) {
            wsSend(ws, {
              type: "error",
              message: t("error.sessionMediaKindCached", {
                kinds: formatMediaKindsForLocale(blocked, getLocale()),
              }),
            });
            return;
          }
        }
        if (ss) ss.lastPromptMediaKinds = promptKinds.length ? promptKinds : null;
        try {
          ss.thinkTagParser.reset();
          ss.moodParser.reset();
          ss.xingParser.reset();
          ss.titleRequested = false;
          ss.titlePreview = "";
          ss.lastTurnHadError = false;
          ss.lastTurnEmptyNoError = false;
          ss.lastTurnDiag = null;
          beginSessionStream(ss);
          ss._streamDiagInactiveWarned = false;
          broadcast({ type: "status", isStreaming: true });
          await hub.send(promptText, msg.images ? { images: msg.images } : undefined);
          if (ss.lastTurnEmptyNoError) {
            wsSend(ws, { type: "error", message: t("error.emptyStreamNoOutput") });
          }
          // prompt 完成时，只有仍在活跃 session 才发 status:false
          if (engine.currentSessionPath === promptSessionPath) {
            broadcast({ type: "status", isStreaming: false });
          }
        } catch (err) {
          if (
            msg.images?.length &&
            modelId &&
            looksLikeProviderRejectedMultimodal(err.message) &&
            promptSessionPath
          ) {
            recordSessionMediaKindsRejected(
              promptSessionPath,
              modelId,
              mediaKindsFromPayloadImages(msg.images),
            );
          }
          if (!err.message?.includes("aborted")) {
            wsSend(ws, { type: "error", message: err.message });
          }
          if (engine.currentSessionPath === promptSessionPath) {
            broadcast({ type: "status", isStreaming: false });
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[ws] error:", err.message);
      debugLog()?.error("ws", err.message);
    });

    // 清理：WS 断开时只中断前台 session（后台 channel triage / cron 不受影响）
    ws.on("close", () => {
      if (closed) return;
      closed = true;
      activeWsClients = Math.max(0, activeWsClients - 1);
      clients.delete(ws);
      debugLog()?.log("ws", "client disconnected");
      scheduleDisconnectAbort();
      // 无活跃客户端时，清理非流式 session 状态（防止 Map 无限增长）
      if (activeWsClients === 0) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming) sessionState.delete(sp);
        }
      }
    });
  });
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 * 只在 session 还没有自定义标题时执行
 */
async function generateSessionTitle(engine, notify, opts = {}) {
  try {
    const sessionPath = opts.sessionPath || engine.currentSessionPath;
    if (!sessionPath) return false;

    // 检查是否已有标题（避免重复生成）
    const sessions = await engine.listSessions();
    const current = sessions.find(s => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find(m => m.role === "user");
    const assistantMsg = messages.find(m => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = (opts.userTextHint || extractText(userMsg?.content)).trim();
    const assistantText = (opts.assistantTextHint || extractText(assistantMsg?.content)).trim();
    if (!userText || !assistantText) return false;

    const TITLE_TIMEOUT = 15_000; // 15 秒超时
    let title = await Promise.race([
      engine.summarizeTitle(userText, assistantText),
      new Promise(resolve => setTimeout(() => resolve(null), TITLE_TIMEOUT)),
    ]);

    // API 失败时，用用户第一条消息截取作为 fallback 标题
    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return;
      title = fallback;
      console.log("[chat] session 标题 API 失败，使用 fallback:", title);
    }

    // 保存标题
    await engine.saveSessionTitle(sessionPath, title);

    // 通知前端更新
    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] 生成 session 标题失败:", err.message);
    return false;
  }
}
