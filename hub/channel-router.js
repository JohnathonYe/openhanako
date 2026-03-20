/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（不改 ticker，只提供回调）。
 *
 * 搬出的方法：
 *   _getChannelAgentOrder  → getAgentOrder()
 *   _executeChannelCheck   → _executeCheck()
 *   _executeChannelReply   → _executeReply()
 *   _channelMemorySummarize → _memorySummarize()
 *   _setupChannelPostHandler → setupPostHandler()
 *   toggleChannels          → toggle()
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.js";
import { appendMessage, formatMessagesForLLM, getRecentMessages } from "../lib/channels/channel-store.js";
import { channelBodyWithOptionalDoc } from "../lib/channels/channel-doc.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { callProviderText } from "../lib/llm/provider-client.js";
import { runAgentSession } from "./agent-executor.js";
import { debugLog, previewForLog } from "../lib/debug-log.js";

/** 本地调试：跳过 triage 的 YES/NO 与 [NO_REPLY] 收口，尽量保证有一条可见回复。见项目概览「调试环境变量」。 */
function isChannelForceReplyDebug() {
  return process.env.HANA_DEBUG_CHANNEL_FORCE_REPLY === "1";
}

function parseChannelTimestamp(ts) {
  if (!ts) return null;
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || "0");
  const d = new Date(year, month, day, hour, minute, second);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 秒
  static _SELF_REPLY_COOLDOWN_MS = 90_000;

  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  // ──────────── 生命周期 ────────────

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) {
      debugLog()?.warn("channel", "ChannelRouter.start() skipped: engine.channelsDir missing");
      return;
    }

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
    debugLog()?.log("channel", `ChannelRouter ticker started (${engine.channelsDir})`);
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    if (!this._ticker) {
      const reason = !this._engine.channelsDir
        ? "no channelsDir"
        : "ticker not running (channels disabled or start failed)";
      debugLog()?.warn("channel", `triggerImmediate skipped #${channelName}: ${reason}`);
      console.warn(`[channel] triage 未执行: ${reason}`);
      return undefined;
    }
    debugLog()?.log("channel", `triggerImmediate #${channelName} ${JSON.stringify(opts ?? {})}`);
    return this._ticker.triggerImmediate(channelName, opts);
  }

  /**
   * 注入频道 post 回调到当前 agent
   * agent 用 channel tool 发消息后，触发其他 agent 的 triage
   */
  setupPostHandler() {
    this._engine.agent._channelPostHandler = (channelName, senderId) => {
      debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, triggering triage`);
      this.triggerImmediate(channelName)?.catch(err =>
        console.error(`[channel] agent post triage 失败: ${err.message}`)
      );
    };
  }

  // ──────────── 频道 Agent 顺序 ────────────

  /** 获取参与频道轮转的 agent 列表（只含有 channels.md 的，30s TTL 缓存） */
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const channelsMd = path.join(this._engine.agentsDir, e.name, "channels.md");
          return fs.existsSync(channelsMd);
        })
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  _getRecentChannelMessages(channelName, count = 30) {
    try {
      const channelFile = path.join(this._engine.channelsDir, `${channelName}.md`);
      return getRecentMessages(channelFile, count);
    } catch {
      return [];
    }
  }

  _isSelfSender(sender, agentId, agentName) {
    if (!sender) return false;
    return sender === agentId || sender === agentName;
  }

  _extractBody(msg) {
    return String(msg?.body ?? msg?.text ?? "").trim();
  }

  _shouldSuppressRapidFollowup({ recentMessages, agentId, agentName, isMentioned, asksEachMember }) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) return false;
    if (isMentioned || asksEachMember) return false;

    let lastSelfIdx = -1;
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      if (this._isSelfSender(recentMessages[i]?.sender, agentId, agentName)) {
        lastSelfIdx = i;
        break;
      }
    }
    if (lastSelfIdx < 0) return false;

    const lastSelf = recentMessages[lastSelfIdx];
    const lastSelfTime = parseChannelTimestamp(lastSelf?.timestamp);
    if (!lastSelfTime) return false;
    if ((Date.now() - lastSelfTime.getTime()) > ChannelRouter._SELF_REPLY_COOLDOWN_MS) return false;

    const followups = recentMessages.slice(lastSelfIdx + 1)
      .filter(m => !this._isSelfSender(m?.sender, agentId, agentName));
    if (followups.length === 0) return false;

    const followupText = followups.map(m => this._extractBody(m)).join("\n");
    if (new RegExp(`@(?:${agentId}|${agentName})\\b`, "i").test(followupText)) return false;
    if (/[?？]/.test(followupText)) return false;

    return true;
  }

  _getAgentProfile(agentId) {
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const agentInstance = engine.agents?.get(agentId);
    const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));
    return {
      agentName: cfg?.agent?.name || agentId,
    };
  }

  // ──────────── Reply 流程 ────────────

  /**
   * 频道检查回调：轻量规则门控 → 单轮 Agent Session → 写入回复
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal, mentionedAgents } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);
    const recentChannelMessages = this._getRecentChannelMessages(channelName, 30);
    debugLog()?.log(
      "channel",
      `_executeCheck ${agentId} #${channelName} windowMsgs=${newMessages.length} contextPreview=${previewForLog(msgText, 700)}`,
    );

    const { agentName } = this._getAgentProfile(agentId);

    // ── 检测 @ ──
    const isMentionedInText =
      msgText.includes(`@${agentName}`) || msgText.includes(`@${agentId}`);
    /** POST /channels/... 解析出的 @ 列表（如 @3号 解析到 id，正文里未必出现 @sanhao） */
    const isMentionedByRoute =
      Array.isArray(mentionedAgents) && mentionedAgents.includes(agentId);
    const isMentioned = isMentionedInText || isMentionedByRoute;

    /** 用户是否在要求「多人各自参与」（与「有一个代表回一句」不同） */
    const asksEachMember =
      /(每个人|每人|大家|各位|你们几个|都帮我|各自|挨个|一个一个)/.test(msgText);

    const suppressRapidFollowup = this._shouldSuppressRapidFollowup({
      recentMessages: recentChannelMessages,
      agentId,
      agentName,
      isMentioned,
      asksEachMember,
    });

    if (!isChannelForceReplyDebug() && suppressRapidFollowup) {
      debugLog()?.log("channel", `reply-gate ${agentId}/#${channelName}: NO (rapid followup guard)`);
      return { replied: false };
    }

    // 单轮生成，是否 [NO_REPLY] 由模型根据上下文决定。
    try {
      const replyText = await this._executeReply(agentId, channelName, msgText, {
        signal,
        isMentioned,
        asksEachMember,
      });

      if (!replyText) {
        debugLog()?.log(
          "channel",
          `reply ${agentId}/#${channelName}: NO_REPLY${isMentioned ? " (mentioned, fallback skipped)" : ""}`,
        );
        return { replied: false };
      }

      // 超过字数则写入 _docs/*.md，频道内只发摘要 + 查看链接
      const { body: channelBody, fullMarkdown } = channelBodyWithOptionalDoc(
        engine.channelsDir,
        channelName,
        agentId,
        replyText,
      );

      // 写入频道文件
      const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
      appendMessage(channelFile, agentId, channelBody);

      const logLen = fullMarkdown ? `${fullMarkdown.length} chars (stub+doc)` : `${replyText.length} chars`;
      console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${logLen})\x1b[0m`);
      debugLog()?.log("channel", `${agentId} replied #${channelName} (${logLen})`);

      // WS 广播
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

      // 记忆摘要仍用完整正文，避免只摘要到 stub
      return { replied: true, replyContent: fullMarkdown ?? replyText };
    } catch (err) {
      console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
      return { replied: false };
    }
  }

  /**
   * 单轮 Agent Session 生成频道回复
   */
  async _executeReply(agentId, channelName, msgText, { signal, isMentioned = false, asksEachMember = false } = {}) {
    const engine = this._engine;

    if (isChannelForceReplyDebug()) {
      const text = await runAgentSession(
        agentId,
        [
          {
            text: `#${channelName} 最近消息：\n\n${msgText}\n\n`
              + `---\n[调试 HANA_DEBUG_CHANNEL_FORCE_REPLY] 用一两句中文回复，直接输出正文。`
              + `禁止输出 [NO_REPLY]；接不上话可简单说「在的」或「跟我说」。`,
            capture: true,
          },
        ],
        { engine, signal, sessionSuffix: "channel-temp" },
      );
      const cleaned = typeof text === "string" ? text.trim() : "";
      if (!cleaned || cleaned.includes("[NO_REPLY]")) {
        return "在的，我听见啦。";
      }
      return cleaned;
    }

    const dispatchMeta = [
      `被点名: ${isMentioned ? "yes" : "no"}`,
      `多人各自参与请求: ${asksEachMember ? "yes" : "no"}`,
      "若没有新增价值可输出 [NO_REPLY]",
    ].join(" | ");

    const text = await runAgentSession(
      agentId,
      [
        {
          text: `#${channelName} 最近消息：\n\n${msgText}\n\n`
            + `调度提示：${dispatchMeta}\n\n`
            + "请直接输出你发到频道里的最终内容。\n"
            + "规则：\n"
            + "1) 默认 1-3 句，先给结论/建议/下一步。\n"
            + "2) 像真实群聊，避免模板腔和空话。\n"
            + "3) 不重复他人或你自己刚说过的话；无新增价值时输出 [NO_REPLY]。\n"
            + "4) 若被点名或用户要求大家各自回答，优先给出实质回应，不要装作没看见。\n"
            + "5) 信息不全时，先问一个关键澄清问题再推进。\n"
            + "6) 不要输出角色标签、前缀或代码块；只输出正文，或 [NO_REPLY]。",
          capture: true,
        },
      ],
      { engine, signal, sessionSuffix: "channel-temp" },
    );

    const cleaned = String(text || "").trim();
    if (!cleaned || cleaned.includes("[NO_REPLY]")) {
      // 被点名/明确要各自回答时，尽量保证有可见回应，避免体验“喊了没反应”。
      if (isMentioned || asksEachMember) {
        return "嗯嗯";
      }
      debugLog()?.log("channel", `${agentId}/#${channelName}: chose not to reply`);
      return null;
    }

    return cleaned;
  }

  /**
   * 频道记忆摘要
   * 从 engine._channelMemorySummarize 搬入
   */
  async _memorySummarize(agentId, channelName, contextText) {
    const engine = this._engine;
    try {
      const { utility: model, api_key, base_url, api } = engine.resolveUtilityConfig();
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} 无 API 配置，跳过记忆摘要\x1b[0m`);
        return;
      }

      const summaryText = await callProviderText({
        api,
        model,
        api_key,
        base_url,
        systemPrompt: "将频道对话摘要为一条简短的记忆（一两句话），记录关键信息和结论。直接输出摘要，不要前缀。",
        messages: [{ role: "user", content: `频道 #${channelName}：\n${contextText.slice(0, 2000)}` }],
        temperature: 0.3,
        max_tokens: 200,
      });

      // 写入 agent 的 fact store
      const isCurrentAgent = (agentId === engine.currentAgentId);
      let factStore = null;
      let needClose = false;

      if (isCurrentAgent && engine.agent?.factStore) {
        factStore = engine.agent.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.js");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const now = new Date();
      try {
        factStore.add({
          fact: `[#${channelName}] ${summaryText}`,
          tags: ["频道", channelName],
          time: now.toISOString().slice(0, 16),
          session_id: `channel-${channelName}`,
        });
      } finally {
        if (needClose) factStore.close();
      }

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }
}
