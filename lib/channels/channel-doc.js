/**
 * channel-doc.js — 频道长消息拆成独立 Markdown 文件 + 群内短 stub
 *
 * 超过 CHANNEL_DOC_CHAR_THRESHOLD 字时：正文写入 channelsDir/_docs/{channelId}/*.md，
 * 频道里只存带 hana-channel-doc: 链接的摘要，客户端点击后 GET /api/channels/:id/docs/:docId 查看。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

/** 超过该字数（字符数）则另存为文档 */
export const CHANNEL_DOC_CHAR_THRESHOLD = 1000;

const DOC_ID_RE = /^[0-9]+_[a-f0-9]{8}\.md$/;

/**
 * @param {string} docId
 * @returns {boolean}
 */
export function isSafeDocId(docId) {
  return typeof docId === "string" && DOC_ID_RE.test(docId);
}

/**
 * @param {string} channelsDir
 * @param {string} channelId
 * @returns {string}
 */
export function docsDirForChannel(channelsDir, channelId) {
  return path.join(channelsDir, "_docs", channelId);
}

/**
 * 解析频道文档绝对路径（防穿越）
 * @param {string} channelsDir
 * @param {string} channelId
 * @param {string} docId
 * @returns {string|null}
 */
export function resolveChannelDocFile(channelsDir, channelId, docId) {
  if (!channelsDir || !channelId || !isSafeDocId(docId)) return null;
  const channelsBase = path.resolve(channelsDir);
  const docDir = path.resolve(docsDirForChannel(channelsDir, channelId));
  if (!docDir.startsWith(channelsBase + path.sep)) return null;
  const filePath = path.join(docDir, docId);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(docDir + path.sep) && resolved !== docDir) return null;
  return resolved;
}

/**
 * 从 Markdown 抽一段纯文本摘要（用于 stub）
 * @param {string} markdown
 * @param {number} maxLen
 * @returns {string}
 */
export function markdownPlainTeaser(markdown, maxLen = 160) {
  let t = String(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > maxLen) t = `${t.slice(0, maxLen)}…`;
  return t;
}

/**
 * 写入文档并返回 docId（文件名）
 * @param {string} channelsDir
 * @param {string} channelId
 * @param {string} sender
 * @param {string} markdownBody
 * @returns {string} docId
 */
export function saveChannelMarkdownDoc(channelsDir, channelId, sender, markdownBody) {
  const dir = docsDirForChannel(channelsDir, channelId);
  fs.mkdirSync(dir, { recursive: true });
  const docId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.md`;
  const header = "---\n"
    + `channel: ${channelId}\n`
    + `sender: ${sender}\n`
    + `created: ${new Date().toISOString()}\n`
    + "---\n\n";
  fs.writeFileSync(path.join(dir, docId), header + String(markdownBody).trim(), "utf-8");
  return docId;
}

/**
 * 生成发到频道里的短消息（含可点击的伪协议链接）
 * @param {string} markdown 原文
 * @param {string} channelId
 * @param {string} docId
 * @returns {string}
 */
export function buildChannelDocStubBody(markdown, channelId, docId) {
  const n = String(markdown).length;
  const teaser = markdownPlainTeaser(markdown, 200);
  const link = `hana-channel-doc:${channelId}/${docId}`;
  let stub = `📄 **长文已另存为 Markdown 文档**（${n} 字）→ [**点此查看全文**](${link})`;
  if (teaser) stub += `\n\n> ${teaser}`;
  return stub;
}

/**
 * 若超过阈值则落盘文档并返回 stub；否则原样返回正文
 * @param {string} channelsDir
 * @param {string} channelId
 * @param {string} sender
 * @param {string} body
 * @param {{ threshold?: number }} [opts]
 * @returns {{ body: string, fullMarkdown: string|null, docId: string|null }}
 */
export function channelBodyWithOptionalDoc(channelsDir, channelId, sender, body, opts = {}) {
  const threshold = opts.threshold ?? CHANNEL_DOC_CHAR_THRESHOLD;
  const trimmed = String(body ?? "").trim();
  if (!trimmed || trimmed.length <= threshold) {
    return { body: trimmed, fullMarkdown: null, docId: null };
  }
  const docId = saveChannelMarkdownDoc(channelsDir, channelId, sender, trimmed);
  const stub = buildChannelDocStubBody(trimmed, channelId, docId);
  return { body: stub, fullMarkdown: trimmed, docId };
}
