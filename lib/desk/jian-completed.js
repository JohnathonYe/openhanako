/**
 * jian-completed.js — 笺任务生命周期：标准化 → 标记完成/失败 → 自动剔除
 *
 * 笺采用 todo list 模式，每行一个任务：
 *   - [ ] 待办     — 待处理
 *   ✅ 已完成       — AI 完成，下次巡检自动移除
 *   ❌ 失败         — AI 执行失败，下次巡检回退为 - [ ] 重试
 *
 * 流程：
 *   1. normalizeJianContent  — 用户输入的纯文本行自动加上 `- [ ]` 前缀
 *   2. markCompletedInJian   — AI 完成任务后标记 ✅
 *   3. markFailedInJian      — AI 执行失败后标记 ❌
 *   4. pruneCompletedFromJian — 下次巡检前移除 ✅ 行，❌ 行回退为 - [ ]
 */

import fs from "fs";
import path from "path";

// ── 行匹配 ──
const CHECKBOX_RE = /^\s*[-*]\s+\[\s*\]\s*(.+)$/;
const CHECKBOX_ANY_RE = /^\s*[-*]\s+\[[ xX]\]/;
const LEGACY_DONE_RE = /^\s*[-*]\s+\[[xX]\]/;
const EMOJI_DONE_RE = /^\s*✅\s*/;
const EMOJI_FAIL_RE = /^\s*❌\s*/;
const HEADER_RE = /^\s*#{1,6}\s/;

// ── 文本块匹配 ──
const COMPLETED_RE = /<COMPLETED>([\s\S]*?)<\/COMPLETED>/i;
const FAILED_RE = /<FAILED>([\s\S]*?)<\/FAILED>/i;

/**
 * 从 session 文件中提取 todo 工具的最终状态，返回 done=true 的 text 数组
 */
export function extractCompletedFromSession(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return [];
  let lastTodos = null;
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !entry.message) continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "todo" || !msg.details?.todos) continue;
        lastTodos = msg.details.todos;
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    return [];
  }
  if (!Array.isArray(lastTodos)) return [];
  return lastTodos.filter(t => t && t.done === true && (t.text || "").trim()).map(t => String(t.text).trim());
}

/**
 * 从 replyText 中解析 <COMPLETED>...</COMPLETED> 内的完成项（每行一条）
 */
export function extractCompletedFromReply(replyText) {
  if (!replyText || typeof replyText !== "string") return [];
  const m = replyText.match(COMPLETED_RE);
  if (!m) return [];
  const block = (m[1] || "").trim();
  return block.split(/\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * 从 replyText 中解析 <FAILED>...</FAILED> 内的失败项（每行一条）
 */
export function extractFailedFromReply(replyText) {
  if (!replyText || typeof replyText !== "string") return [];
  const m = replyText.match(FAILED_RE);
  if (!m) return [];
  const block = (m[1] || "").trim();
  return block.split(/\n/).map(s => s.trim()).filter(Boolean);
}

// ═══════════════════════════════════════
//  模糊匹配辅助
// ═══════════════════════════════════════

function fuzzyMatch(lineText, targets) {
  const lineNorm = lineText.trim().toLowerCase();
  return targets.some(n => {
    if (!n) return false;
    if (lineNorm === n) return true;
    const shorter = lineNorm.length <= n.length ? lineNorm : n;
    const longer = lineNorm.length > n.length ? lineNorm : n;
    return shorter.length >= 2 && longer.includes(shorter);
  });
}

// ═══════════════════════════════════════
//  标记完成 / 失败
// ═══════════════════════════════════════

/**
 * 将已完成的项同步到 jian.md：`- [ ] task` → `✅ task`
 *
 * @param {string} jianPath
 * @param {string[]} completedTexts
 * @returns {boolean}
 */
export function markCompletedInJian(jianPath, completedTexts) {
  if (!completedTexts?.length || !jianPath || !fs.existsSync(jianPath)) return false;
  let content;
  try {
    content = fs.readFileSync(jianPath, "utf-8");
  } catch {
    return false;
  }
  const lines = content.split("\n");
  let changed = false;
  const normalized = completedTexts.map(t => t.trim().toLowerCase()).filter(n => n.length >= 1);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX_RE);
    if (!m) continue;
    const lineContent = m[1].trim();
    if (fuzzyMatch(lineContent, normalized)) {
      lines[i] = `✅ ${lineContent}`;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(jianPath, lines.join("\n"), "utf-8");
    } catch (err) {
      console.warn(`[jian-completed] write jian.md failed: ${err.message}`);
      return false;
    }
  }
  return changed;
}

/**
 * 将失败的项同步到 jian.md：`- [ ] task` → `❌ task`
 *
 * @param {string} jianPath
 * @param {string[]} failedTexts
 * @returns {boolean}
 */
export function markFailedInJian(jianPath, failedTexts) {
  if (!failedTexts?.length || !jianPath || !fs.existsSync(jianPath)) return false;
  let content;
  try {
    content = fs.readFileSync(jianPath, "utf-8");
  } catch {
    return false;
  }
  const lines = content.split("\n");
  let changed = false;
  const normalized = failedTexts.map(t => t.trim().toLowerCase()).filter(n => n.length >= 1);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX_RE);
    if (!m) continue;
    const lineContent = m[1].trim();
    if (fuzzyMatch(lineContent, normalized)) {
      lines[i] = `❌ ${lineContent}`;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(jianPath, lines.join("\n"), "utf-8");
    } catch (err) {
      console.warn(`[jian-completed] write jian.md failed: ${err.message}`);
      return false;
    }
  }
  return changed;
}

// ═══════════════════════════════════════
//  笺内容标准化 + 自动剔除
// ═══════════════════════════════════════

/**
 * normalizeJianContent — 将纯文本行标准化为 `- [ ]` 格式
 *
 * 保留空行、markdown 标题、已有的 checkbox / ✅ / ❌ 行。
 * 其它非空行自动补上 `- [ ]` 前缀，使每行都成为一个可追踪的待办。
 *
 * @param {string} content
 * @returns {string}
 */
export function normalizeJianContent(content) {
  if (!content || typeof content !== "string") return content || "";
  const lines = content.split("\n");
  const result = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (CHECKBOX_ANY_RE.test(line)) return line;
    if (EMOJI_DONE_RE.test(line)) return line;
    if (EMOJI_FAIL_RE.test(line)) return line;
    if (HEADER_RE.test(line)) return line;
    return `- [ ] ${trimmed}`;
  });
  return result.join("\n");
}

/**
 * pruneCompletedFromJian — 移除 ✅ 行，❌ 行回退为 `- [ ]`，兼容旧 `- [x]`
 *
 * 巡检开始前调用，自动清理上轮完成的任务，保持笺简洁。
 * 失败的任务回退为待办，以便下次巡检重试。
 * 若全部任务已完成（无剩余内容），删除 jian.md 文件。
 *
 * @param {string} jianPath
 * @returns {{ pruned: boolean, count: number, reverted: number }}
 */
export function pruneCompletedFromJian(jianPath) {
  if (!jianPath || !fs.existsSync(jianPath)) return { pruned: false, count: 0, reverted: 0 };
  let content;
  try {
    content = fs.readFileSync(jianPath, "utf-8");
  } catch {
    return { pruned: false, count: 0, reverted: 0 };
  }

  const lines = content.split("\n");
  let removeCount = 0;
  let revertCount = 0;
  const processed = [];

  for (const line of lines) {
    if (EMOJI_DONE_RE.test(line) || LEGACY_DONE_RE.test(line)) {
      removeCount++;
      continue;
    }
    if (EMOJI_FAIL_RE.test(line)) {
      const taskText = line.replace(EMOJI_FAIL_RE, "").trim();
      if (taskText) {
        processed.push(`- [ ] ${taskText}`);
        revertCount++;
      }
      continue;
    }
    processed.push(line);
  }

  if (removeCount === 0 && revertCount === 0) return { pruned: false, count: 0, reverted: 0 };

  let result = processed.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  try {
    if (!result) {
      fs.unlinkSync(jianPath);
    } else {
      fs.writeFileSync(jianPath, result + "\n", "utf-8");
    }
  } catch (err) {
    console.warn(`[jian-completed] prune failed: ${err.message}`);
    return { pruned: false, count: 0, reverted: 0 };
  }
  return { pruned: true, count: removeCount, reverted: revertCount };
}
