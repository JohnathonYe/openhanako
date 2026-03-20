/**
 * heartbeat.js — 日常巡检 + 笺目录扫描
 *
 * 让 agent 从被动应答变成主动行动的关键机制。
 * 两个阶段：
 *   Phase 1: 工作空间文件变化检测
 *   Phase 2: 笺扫描（根目录 + 一级子目录的 jian.md，指纹比对后隔离执行）
 *
 * 定时任务（cron）由独立的 cron-scheduler 调度，不经过巡检。
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { debugLog } from "../debug-log.js";

/** 12 位 MD5 短指纹 */
function quickHash(str) {
  return createHash("md5").update(str).digest("hex").slice(0, 12);
}

/** 定时任务关键词：包含这些视为「已存在则跳过」的定时任务 */
const SCHEDULED_TASK_KEYWORDS = /每天|每日|定时|cron|每周|每小时|每早|每晚|固定时间|周期|重复/;

/** 行首状态 emoji：已完成、执行中、执行失败 */
const EMOJI_DONE = "✅";
const EMOJI_IN_PROGRESS = "🔄";
const EMOJI_FAILED = "❌";

/** 发生时间标签格式 [YYYY-MM-DD HH:mm] */
const OCCURRENCE_TIME_REGEX = /\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\]/;

/** 返回当前时间的 [发生时间] 字符串 */
function formatOccurrenceTime() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `[${y}-${m}-${d} ${h}:${min}]`;
}

/** 归一化任务行（去首尾空白、去掉行首状态 emoji 与 [发生时间]） */
function normalizeTaskLine(line) {
  let t = line.trim();
  t = t.replace(/^✅\s*/, "").replace(/^🔄\s*/, "").replace(/^❌\s*/, "");
  t = t.replace(OCCURRENCE_TIME_REGEX, "").trim();
  return t.trim();
}

/** 内容键：归一化后再去掉行首序号（1. 2)），用于匹配时容错 */
function contentKey(line) {
  const n = normalizeTaskLine(line);
  const withoutNum = n.replace(/^\d+[.)]\s*/, "").trim();
  return withoutNum || n;
}

/** 判断行首是否有状态 emoji（含 emoji + [发生时间] 形式） */
function hasStatusEmoji(line) {
  const trimmed = line.trim();
  return /^(✅|🔄|❌)(\s|\[)/.test(trimmed) || /^(✅|🔄|❌)$/.test(trimmed);
}

/**
 * 解析笺内容为任务行：✅ 已完成、🔄 执行中、❌ 执行失败，其余为待办；识别定时任务
 * 执行中的不重复执行，执行失败的不再执行；全打上标签则通知用户
 * @returns {{ completed: string[], inProgress: string[], failed: string[], pending: string[], pendingScheduled: string[], pendingNormal: string[], allLines: string[] }}
 */
function parseJianTasks(jianContent) {
  const allLines = jianContent.split(/\r?\n/);
  const completed = [];
  const inProgress = [];
  const failed = [];
  const pending = [];
  const pendingScheduled = [];
  const pendingNormal = [];

  for (const raw of allLines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^✅\s/.test(line) || line.startsWith("✅")) {
      completed.push(line);
      continue;
    }
    if (/^🔄\s/.test(line) || line.startsWith("🔄")) {
      inProgress.push(line);
      continue;
    }
    if (/^❌\s/.test(line) || line.startsWith("❌")) {
      failed.push(line);
      continue;
    }
    pending.push(line);
    if (SCHEDULED_TASK_KEYWORDS.test(line)) {
      pendingScheduled.push(line);
    } else {
      pendingNormal.push(line);
    }
  }

  return {
    completed,
    inProgress,
    failed,
    pending,
    pendingScheduled,
    pendingNormal,
    allLines,
  };
}

/** 任务行指纹（用于定时任务去重） */
function taskFingerprint(line) {
  return quickHash(normalizeTaskLine(line));
}

/** 人类可读文件大小 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ═══════════════════════════════════════
//  Prompt 构建
// ═══════════════════════════════════════

/**
 * 工作空间巡检 prompt（支持 i18n）
 */
function buildHeartbeatContext({ deskFiles, overwatch, isZh }) {
  const now = new Date();
  const timeStr = now.toLocaleString(isZh ? "zh-CN" : "en-US", { hour12: false });

  const parts = isZh
    ? [
        `[心跳巡检] 现在是 ${timeStr}`,
        "",
        "**注意：这是系统自动触发的巡检消息，不是用户发来的。用户目前没有在跟你对话，不要把巡检当作用户的提问来回应。**",
        "你需要独立判断是否有需要主动处理的事项，如果有就直接执行，不要向用户提问或等待回复。",
        "",
      ]
    : [
        `[Heartbeat Patrol] Current time: ${timeStr}`,
        "",
        "**Note: This is an automated patrol message, NOT from the user. The user is not currently talking to you — do not treat this as a user query.**",
        "Independently determine if there are items that need proactive handling. If so, act directly — do not ask the user or wait for a reply.",
        "",
      ];

  if (overwatch) {
    parts.push("## Overwatch");
    parts.push(overwatch);
    parts.push("");
  }

  if (deskFiles && deskFiles.length > 0) {
    parts.push(isZh ? "## 工作空间文件：" : "## Workspace files:");
    for (const f of deskFiles) {
      parts.push(`- ${f.isDir ? "📁 " : ""}${f.name}`);
    }
    parts.push("");
  }

  parts.push("---");
  parts.push(isZh
    ? "请**仅根据以上提供的内容**判断是否有需要主动处理的事项。不要主动查询定时任务状态等未在上文列出的系统信息。发现需要关注的事项时，用 notify 工具通知用户。如果一切正常，不要调用任何工具。"
    : "Determine if anything needs proactive attention **based solely on the information provided above**. Do not proactively query system status such as cron jobs that is not listed above. If you find anything noteworthy, use the notify tool to alert the user. If everything is fine, do not call any tools.");

  return parts.join("\n");
}

/**
 * 笺目录专用 prompt（支持 i18n）
 * @param {string} [effectiveContent] - 本次需处理的未完成任务内容（若提供则优先展示，并附 COMPLETED 规则）
 */
function buildJianPrompt({ dirPath, jianContent, files, jianChanged, filesChanged, isZh, effectiveContent }) {
  const parts = isZh
    ? [
        `[目录巡检] ${dirPath}`,
        "",
        "**注意：这是系统自动触发的目录巡检，不是用户发来的消息。**",
        "请根据笺的指令独立判断并处理，不要向用户提问或等待回复。",
        "",
      ]
    : [
        `[Directory Patrol] ${dirPath}`,
        "",
        "**Note: This is an automated directory patrol, NOT a user message.**",
        "Follow the jian instructions independently — do not ask the user or wait for a reply.",
        "",
      ];

  parts.push(isZh ? "## 笺" : "## Jian");
  if (effectiveContent !== undefined && effectiveContent !== null) {
    parts.push(effectiveContent);
    parts.push("");
    parts.push(isZh
      ? "**规则：** 仅处理以上未完成任务。执行后请在回复末尾写 **TASK_RESULT**，下一行起按顺序每行一条：`序号 空格 success 或 failed`（与上面任务顺序一致，只做二元判断）。"
      : "**Rules:** Only process the pending tasks above. After execution, write **TASK_RESULT** at the end of your reply, then one line per task in order: `index space success or failed` (match the order above; binary outcome only).");
  } else {
    parts.push(jianContent);
    parts.push("");
    parts.push(isZh
      ? "**规则：** 执行后请在回复末尾写 **TASK_RESULT**，下一行起每行：`序号 success 或 failed`。"
      : "**Rules:** After execution write **TASK_RESULT**, then one line per task: `index success or failed`.");
  }
  parts.push("");

  if (files.length > 0) {
    parts.push(isZh ? "## 文件列表" : "## File list");
    for (const f of files) {
      const prefix = f.isDir ? "📁 " : "📄 ";
      const size = f.isDir ? "" : ` (${formatSize(f.size)})`;
      parts.push(`- ${prefix}${f.name}${size}`);
    }
    parts.push("");
  }

  parts.push(isZh ? "## 变化" : "## Changes");
  parts.push(`- jian.md: ${jianChanged ? (isZh ? "已变化" : "changed") : (isZh ? "未变" : "unchanged")}`);
  parts.push(`- ${isZh ? "文件" : "files"}: ${filesChanged ? (isZh ? "有变化" : "changed") : (isZh ? "未变" : "unchanged")}`);
  parts.push("");
  parts.push(isZh
    ? "请根据笺的指令处理。如果无需行动，不要调用任何工具。"
    : "Follow the jian instructions. If no action is needed, do not call any tools.");

  return parts.join("\n");
}

// ═══════════════════════════════════════
//  笺目录扫描
// ═══════════════════════════════════════

/**
 * 列出目录下的文件（排除 . 开头和 jian.md 本身）
 */
function listDirFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "jian.md")
      .map(e => {
        const fp = path.join(dir, e.name);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { return null; }
        if (stat.isSymbolicLink()) return null; // 跳过 symlink
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 扫描工作空间，找到所有含 jian.md 的目录（根目录 + 一级子目录）
 */
function scanJianDirs(wsPath) {
  if (!wsPath || !fs.existsSync(wsPath)) return [];

  const dirs = [];

  // 根目录
  if (fs.existsSync(path.join(wsPath, "jian.md"))) {
    try {
      dirs.push({
        name: ".",
        absPath: wsPath,
        jianContent: fs.readFileSync(path.join(wsPath, "jian.md"), "utf-8"),
        files: listDirFiles(wsPath),
      });
    } catch {}
  }

  // 一级子目录
  try {
    const entries = fs.readdirSync(wsPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const subPath = path.join(wsPath, e.name);
      const jianFile = path.join(subPath, "jian.md");
      if (!fs.existsSync(jianFile)) continue;
      try {
        dirs.push({
          name: e.name,
          absPath: subPath,
          jianContent: fs.readFileSync(jianFile, "utf-8"),
          files: listDirFiles(subPath),
        });
      } catch {}
    }
  } catch {}

  return dirs;
}

// ═══════════════════════════════════════
//  心跳调度器
// ═══════════════════════════════════════

/**
 * 创建心跳调度器
 *
 * @param {object} opts
 * @param {() => Array} [opts.getDeskFiles] - 获取根目录文件列表
 * @param {() => string} [opts.getWorkspacePath] - 获取工作空间路径
 * @param {string} [opts.registryPath] - jian-registry.json 存储路径
 * @param {(prompt: string) => Promise<void>} opts.onBeat - 工作空间巡检回调
 * @param {(prompt: string, cwd: string) => Promise<{ replyText?: string, error?: string } | void>} [opts.onJianBeat] - 笺巡检回调（带 cwd），可返回 replyText 用于解析 COMPLETED
 * @param {(title: string, body: string) => void} [opts.onNotify] - 全部完成时发送通知（桌面弹窗）
 * @param {(affectedDir?: string) => void} [opts.onDeskChanged] - 笺文件被写入后调用，可传受影响的目录路径以便前端刷新该路径的笺
 * @param {(active: boolean) => void} [opts.onJianExecuting] - 笺任务开始/结束执行时调用，用于前端显示「执行中」闪烁
 * @param {number} [opts.intervalMinutes] - 巡检间隔（分钟），默认 15
 * @param {(text: string, level?: string) => void} [opts.emitDevLog]
 * @returns {{ start, stop, beat, triggerNow }}
 */
export function createHeartbeat({
  getDeskFiles, getWorkspacePath, registryPath,
  onBeat, onJianBeat, onNotify, onDeskChanged, onJianExecuting,
  intervalMinutes, emitDevLog,
  overwatchPath, locale,
}) {
  const isZh = !locale || String(locale).startsWith("zh");
  const devlog = (text, level = "heartbeat") => {
    emitDevLog?.(text, level);
  };
  const INTERVAL = (intervalMinutes || 17) * 60 * 1000;
  const COOLDOWN = 2 * 60 * 1000;
  const BEAT_TIMEOUT = 5 * 60 * 1000;

  let _timer = null;
  let _running = false;
  let _beatPromise = null;
  let _lastTrigger = 0;
  let _lastDeskFingerprint = "";

  // ── 指纹注册表 ──

  function loadRegistry() {
    if (!registryPath) return {};
    try {
      return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveRegistry(reg) {
    if (!registryPath) return;
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[heartbeat] saveRegistry 失败: ${err.message}`);
    }
  }

  // ── 心跳执行 ──

  async function beat() {
    if (_running) return;
    _running = true;
    const p = _doBeat();
    _beatPromise = p;
    await p;
  }

  async function _doBeat() {
    try {
      const tag = "\x1b[36m[heartbeat]\x1b[0m";
      console.log(`${tag} ── 心跳开始 ──`);
      debugLog()?.log("heartbeat", "beat start");
      devlog("── 心跳开始 ──");

      // ── 收集上下文 ──
      const deskFiles = getDeskFiles?.() || [];
      const deskFingerprint = deskFiles.map(f => `${f.name}:${f.mtime || 0}`).join("|");
      const deskChanged = deskFingerprint !== _lastDeskFingerprint;

      // Overwatch 注意力清单
      let overwatch = null;
      if (overwatchPath) {
        try {
          const content = fs.readFileSync(overwatchPath, "utf-8").trim();
          if (content) overwatch = content;
        } catch {}
      }

      // 笺目录扫描
      const wsPath = getWorkspacePath?.();
      const jianDirs = (onJianBeat && wsPath) ? scanJianDirs(wsPath) : [];
      const jianChanges = _detectJianChanges(jianDirs);

      // 汇总日志
      const summaryParts = [`文件: ${deskFiles.length}${deskChanged ? " (变化)" : ""}`];
      if (overwatch) summaryParts.push("overwatch: 有内容");
      if (jianDirs.length > 0) summaryParts.push(`笺: ${jianDirs.length} 目录, ${jianChanges.length} 变化`);
      const summary = summaryParts.join("  |  ");
      console.log(`${tag}  ${summary}`);
      devlog(summary);

      // 全部无事，跳过
      if (!deskChanged && !overwatch && jianChanges.length === 0) {
        console.log(`${tag}  无待处理事项，跳过`);
        devlog("无待处理事项，跳过");
        debugLog()?.log("heartbeat", "beat skip: no desk change, no overwatch, no jian dirs/changes");
        return;
      }

      // ── Phase 1: 工作空间文件变化 / Overwatch ──
      if (deskChanged || overwatch) {
        if (deskChanged) _lastDeskFingerprint = deskFingerprint;
        const prompt = buildHeartbeatContext({ deskFiles, overwatch, isZh });
        console.log(`${tag}  Phase 1: 工作空间巡检 (${prompt.length} chars)`);
        debugLog()?.log("heartbeat", `beat phase1: desk/overwatch prompt=${prompt.length} chars`);
        devlog("Phase 1: 工作空间巡检执行中...");
        {
          let timer;
          try {
            await Promise.race([
              onBeat(prompt),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("心跳执行超时 (5min)")), BEAT_TIMEOUT); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
      }

      // ── Phase 2: 笺目录执行 ──
      if (jianChanges.length > 0) {
        const registry = loadRegistry();
        const toNotifyAllDone = [];
        const toExecute = [];

        for (const ch of jianChanges) {
          if (ch.allDone) {
            const lastNotified = registry[ch.absPath]?.lastAllDoneNotifiedAt;
            const jianFinger = ch.jianHash;
            const prevFinger = registry[ch.absPath]?.jianHash;
            if (!lastNotified || prevFinger !== jianFinger) toNotifyAllDone.push(ch);
          }
          if (ch.effectiveContent && ch.effectivePending.length > 0) toExecute.push(ch);
        }

        for (const ch of toNotifyAllDone) {
          const label = ch.name === "." ? "根目录" : ch.name;
          const title = isZh ? "笺任务已全部打标" : "Jian tasks all tagged";
          const body = isZh
            ? `笺 [${label}] 所有任务已打上标签：✅ 完成 / 🔄 执行中 / ❌ 失败`
            : `All tasks in jian [${label}] have a status: ✅ done / 🔄 in progress / ❌ failed`;
          onNotify?.(title, body);
          registry[ch.absPath] = {
            ...(registry[ch.absPath] || {}),
            jianHash: ch.jianHash,
            filesHash: ch.filesHash,
            lastCheckedAt: new Date().toISOString(),
            lastAllDoneNotifiedAt: new Date().toISOString(),
          };
          saveRegistry(registry);
        }

        if (toExecute.length > 0) {
          debugLog()?.log("heartbeat", `beat phase2: jian execute dirs=${toExecute.length}`);
          try {
            onJianExecuting?.(true);
            await _processJianChanges(toExecute, tag);
          } finally {
            onJianExecuting?.(false);
          }
        } else {
          // 有待办但全部为已执行过的定时任务：只更新指纹，避免下次重复触发
          for (const ch of jianChanges) {
            if (ch.effectivePending.length === 0 && ch.parsed.pending.length > 0 && !ch.allDone) {
              registry[ch.absPath] = {
                ...(registry[ch.absPath] || {}),
                jianHash: ch.jianHash,
                filesHash: ch.filesHash,
                lastCheckedAt: new Date().toISOString(),
              };
              saveRegistry(registry);
            }
          }
        }
      }

      console.log(`${tag} ── 心跳完成 ──`);
      debugLog()?.log("heartbeat", "beat done");
      devlog("── 心跳完成 ──");
    } catch (err) {
      console.error(`[heartbeat] beat error: ${err.message}`);
      debugLog()?.error("heartbeat", `beat error: ${err.message}`);
      devlog(`错误: ${err.message}`, "error");
    } finally {
      _running = false;
    }
  }

  /**
   * 对比注册表，找出有变化的笺目录；解析任务行，过滤已完成的 ✅ 与已执行过的定时任务
   */
  function _detectJianChanges(jianDirs) {
    if (jianDirs.length === 0) return [];

    const registry = loadRegistry();
    const result = [];

    for (const dir of jianDirs) {
      const key = dir.absPath;
      const jianHash = quickHash(dir.jianContent);
      const filesHash = quickHash(dir.files.map(f => `${f.name}:${f.mtime}`).join("|"));

      const prev = registry[key];
      const jianChanged = !prev || prev.jianHash !== jianHash;
      const filesChanged = !prev || prev.filesHash !== filesHash;

      const parsed = parseJianTasks(dir.jianContent);
      const executedSet = new Set(prev?.executedTaskHashes || []);

      // 仅待办参与执行；🔄 执行中不重复执行，❌ 执行失败不再执行；定时任务已存在则跳过
      const effectiveScheduled = parsed.pendingScheduled.filter(
        (line) => !executedSet.has(taskFingerprint(line))
      );
      const effectivePending = [...parsed.pendingNormal, ...effectiveScheduled];
      const effectiveContent = effectivePending.length > 0
        ? effectivePending.join("\n")
        : null;

      // 全打上标签（无待办，且至少有一条任务）：可通知用户
      const totalTagged = parsed.completed.length + parsed.inProgress.length + parsed.failed.length;
      const allDone = parsed.pending.length === 0 && totalTagged > 0;

      result.push({
        ...dir,
        jianHash,
        filesHash,
        jianChanged,
        filesChanged,
        parsed,
        effectivePending,
        effectiveContent,
        allDone,
      });
    }

    return result;
  }

  /**
   * 从 agent 回复中解析 TASK_RESULT 块，返回按序的 { index, success } 列表（index 从 1 起）
   */
  function _parseTaskResultsFromReply(replyText) {
    if (!replyText || typeof replyText !== "string") return [];
    const lines = replyText.split(/\r?\n/);
    let inBlock = false;
    const results = [];
    const taskLine = /^\s*(\d+)\s+(success|failed)\s*$/i;
    for (const line of lines) {
      if (/TASK_RESULT/i.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      const m = line.match(taskLine);
      if (m) results.push({ index: parseInt(m[1], 10), success: /success/i.test(m[2]) });
      else if (line.trim()) inBlock = false; // 非空非任务行则结束块
    }
    return results;
  }

  /**
   * 在 jian.md 中为指定行设置行首状态 emoji（匹配归一化内容，覆盖原有 ✅🔄❌）
   * @param {string} jianPath
   * @param {Array<{ normalized: string, emoji: string }>} updates
   */
  function _applyJianStatusUpdates(jianPath, updates) {
    if (updates.length === 0) return false;
    const byNormalized = new Map(updates.map((u) => [u.normalized, u.emoji]));
    // 容错：同时用 contentKey 注册，便于行首空格/序号差异时仍能匹配
    for (const u of updates) {
      const ck = contentKey(u.normalized);
      if (ck !== u.normalized && !byNormalized.has(ck)) byNormalized.set(ck, u.emoji);
    }
    let raw = fs.readFileSync(jianPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const normalized = normalizeTaskLine(line);
      if (!normalized) continue;
      let emoji = byNormalized.get(normalized);
      if (!emoji) emoji = byNormalized.get(contentKey(normalized));
      if (!emoji) continue;
      const newLine = (line.startsWith(" ") ? " " : "") + emoji + " " + formatOccurrenceTime() + " " + normalized;
      if (lines[i] !== newLine) {
        lines[i] = newLine;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(jianPath, lines.join("\n"), "utf-8");
    return changed;
  }

  /**
   * 执行前：将本次要执行的任务行在 jian.md 中标为 🔄 执行中（避免下次巡检重复执行）
   */
  function _markJianLinesInProgress(jianPath, pendingLineContents) {
    const updates = pendingLineContents.map((c) => ({ normalized: normalizeTaskLine(c), emoji: EMOJI_IN_PROGRESS }));
    return _applyJianStatusUpdates(jianPath, updates);
  }

  /**
   * 执行后：按 TASK_RESULT 的序号对 effectivePending 打 ✅/❌（未出现在结果里的按 failed）
   */
  function _markJianLinesByTaskResults(jianPath, taskResults, effectivePending) {
    const byIndex = new Map(taskResults.map((r) => [r.index, r.success]));
    const updates = effectivePending.map((line, i) => {
      const index = i + 1;
      const success = byIndex.has(index) ? byIndex.get(index) : false;
      return { normalized: normalizeTaskLine(line), emoji: success ? EMOJI_DONE : EMOJI_FAILED };
    });
    return _applyJianStatusUpdates(jianPath, updates);
  }

  /**
   * 逐个执行有变化的笺目录；执行前打 🔄，执行后根据 TASK_RESULT 打 ✅ 或 ❌，更新 executedTaskHashes
   */
  async function _processJianChanges(changes, tag) {
    const registry = loadRegistry();

    for (const dir of changes) {
      const label = dir.name === "." ? "根目录" : dir.name;
      const jianPath = path.join(dir.absPath, "jian.md");
      const effectivePending = dir.effectivePending || [];

      // 执行前：立即将本次要执行的任务标为 🔄 执行中（下次巡检不重复执行）
      if (effectivePending.length > 0) {
        if (_markJianLinesInProgress(jianPath, effectivePending)) onDeskChanged?.(dir.absPath);
      }

      console.log(`${tag}  Phase 2: 笺 [${label}] 执行中...`);
      devlog(`笺 [${label}] 执行中...`);

      const prompt = buildJianPrompt({
        dirPath: dir.absPath,
        jianContent: dir.jianContent,
        files: dir.files,
        jianChanged: dir.jianChanged,
        filesChanged: dir.filesChanged,
        isZh,
        effectiveContent: dir.effectiveContent,
      });

      let result;
      let runFailed = false;
      try {
        let timer;
        try {
          result = await Promise.race([
            onJianBeat(prompt, dir.absPath),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`笺 [${label}] 执行超时 (5min)`)), BEAT_TIMEOUT); }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        runFailed = !!result?.error;
      } catch (err) {
        runFailed = true;
        result = { replyText: "", error: err.message };
        devlog(`笺 [${label}] 执行失败: ${err.message}`, "error");
      }

      // 执行后：按 TASK_RESULT 打 ✅/❌；整批失败则全部❌并通知
      if (effectivePending.length > 0) {
        let jianUpdated = false;
        if (runFailed) {
          jianUpdated = _applyJianStatusUpdates(
            jianPath,
            effectivePending.map((l) => ({ normalized: normalizeTaskLine(l), emoji: EMOJI_FAILED }))
          );
          const errMsg = result?.error || "";
          const title = isZh ? "笺任务执行失败" : "Jian execution failed";
          const body = isZh
            ? `笺 [${label}] 本批任务全部执行失败${errMsg ? `：${errMsg}` : ""}`
            : `Jian [${label}] all tasks failed${errMsg ? `: ${errMsg}` : ""}`;
          onNotify?.(title, body);
        } else {
          const taskResults = _parseTaskResultsFromReply(result?.replyText || "");
          jianUpdated = _markJianLinesByTaskResults(jianPath, taskResults, effectivePending);
        }
        if (jianUpdated) onDeskChanged?.(dir.absPath);
      }

      // 仅对 TASK_RESULT 里 success 的任务记入 executedTaskHashes（定时任务去重用）
      if (!runFailed && effectivePending.length > 0) {
        const taskResults = _parseTaskResultsFromReply(result?.replyText || "");
        const successIndexes = new Set(taskResults.filter((r) => r.success).map((r) => r.index));
        const prev = registry[dir.absPath] || {};
        const executed = new Set(prev.executedTaskHashes || []);
        effectivePending.forEach((line, i) => {
          if (successIndexes.has(i + 1)) executed.add(taskFingerprint(line));
        });
        registry[dir.absPath] = { ...(registry[dir.absPath] || {}), ...prev, executedTaskHashes: [...executed] };
      }

      // 用执行后的内容更新指纹，避免自激振荡
      const postFiles = listDirFiles(dir.absPath);
      const postFilesHash = quickHash(postFiles.map(f => `${f.name}:${f.mtime}`).join("|"));
      let postJianHash = dir.jianHash;
      let postJianContent = "";
      try {
        postJianContent = fs.readFileSync(jianPath, "utf-8");
        postJianHash = quickHash(postJianContent);
      } catch {}

      registry[dir.absPath] = {
        ...(registry[dir.absPath] || {}),
        jianHash: postJianHash,
        filesHash: postFilesHash,
        lastCheckedAt: new Date().toISOString(),
      };

      // 本批执行后若该目录已全部打标（无待办），则通知用户
      if (postJianContent) {
        const parsed = parseJianTasks(postJianContent);
        const totalTagged = parsed.completed.length + parsed.inProgress.length + parsed.failed.length;
        const allDone = parsed.pending.length === 0 && totalTagged > 0;
        if (allDone) {
          const title = isZh ? "笺任务已全部完成" : "Jian tasks all done";
          const body = isZh
            ? `笺 [${label}] 所有任务已打上标签：✅ 完成 / 🔄 执行中 / ❌ 失败`
            : `Jian [${label}] all tasks have a status: ✅ done / 🔄 in progress / ❌ failed`;
          onNotify?.(title, body);
          registry[dir.absPath].lastAllDoneNotifiedAt = new Date().toISOString();
        }
      }
      saveRegistry(registry);

      devlog(`笺 [${label}] 执行完成`);
    }
  }

  // ── 调度 ──

  function start() {
    if (_timer) return;
    const now = Date.now();
    const msIntoSlot = now % INTERVAL;
    const delay = INTERVAL - msIntoSlot;
    const nextTime = new Date(now + delay);
    console.log(`\x1b[90m[heartbeat] 已启动，下次心跳: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}\x1b[0m`);
    debugLog()?.log("heartbeat", `started, next: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    devlog(`心跳已启动，下次: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    _timer = setTimeout(function fire() {
      beat();
      _timer = setInterval(() => beat(), INTERVAL);
      if (_timer.unref) _timer.unref();
    }, delay);
    if (_timer.unref) _timer.unref();
  }

  async function stop() {
    if (_timer) {
      clearTimeout(_timer);
      clearInterval(_timer);
      _timer = null;
    }
    if (_beatPromise) {
      await _beatPromise.catch(() => {});
    }
    _running = false; // 确保 stop 后状态干净
    debugLog()?.log("heartbeat", "stopped");
    devlog("心跳已停止");
  }

  function triggerNow() {
    const now = Date.now();
    if (now - _lastTrigger < COOLDOWN) {
      devlog("手动触发冷却中，跳过");
      return false;
    }
    _lastTrigger = now;
    devlog("手动触发心跳");
    beat();
    return true;
  }

  return { start, stop, beat, triggerNow };
}
