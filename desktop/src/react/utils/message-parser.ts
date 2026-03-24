/**
 * message-parser.ts — 消息解析工具函数
 *
 * 从 app-messages-shim.ts 和 chat-render-shim.ts 提取，
 * 供 React 组件和 history-builder 共用。
 */

import type { ContentBlock } from '../stores/chat-types';
import type { TodoItem } from '../types';

// ── Mood 解析 ──

const TAG_TO_YUAN: Record<string, string> = { mood: 'hanako', pulse: 'butter', reflect: 'ming' };
const YUAN_LABELS: Record<string, string> = { hanako: '✿ MOOD', butter: '❊ PULSE', ming: '◈ REFLECT' };

export function moodLabel(yuan: string): string {
  return YUAN_LABELS[yuan] || YUAN_LABELS.hanako;
}

export function cleanMoodText(raw: string): string {
  return raw
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, yuan: null, text: content };
  const yuan = TAG_TO_YUAN[match[1]] || 'hanako';
  const mood = cleanMoodText(match[2].trim());
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
  return { mood, yuan, text };
}

// ── Xing 解析 ──

export interface ParsedXing { title: string; content: string }

export function parseXingFromContent(text: string): { xingBlocks: ParsedXing[]; text: string } {
  const xingRe = /<xing\s+title=["\u201C\u201D]([^"\u201C\u201D]*)["\u201C\u201D]>([\s\S]*?)<\/xing>/g;
  const blocks: ParsedXing[] = [];
  let match;
  while ((match = xingRe.exec(text)) !== null) {
    blocks.push({ title: match[1], content: match[2].trim() });
  }
  const remaining = text.replace(xingRe, '').replace(/^\n+/, '').trim();
  return { xingBlocks: blocks, text: remaining };
}

// ── /plan 草稿前缀剥离 ──

/**
 * 历史消息中，/plan 发送时服务端会把用户原文包裹成完整指令（plan.draftPrompt）。
 * 渲染时只需展示用户的任务文本，不展示注入给模型的指令部分。
 */
export function stripPlanDraftWrapper(content: string): string {
  const match = content.match(
    /^[\[【]\/plan[^\n]*\n[^\n]*[:：]\n([\s\S]*?)\n\n(?:你必须|You MUST|\*\*todo\*\*)/,
  );
  if (!match) return content;
  const task = match[1].trim();
  return task || content;
}

// ── 用户附件解析 ──

export interface ParsedAttachments {
  text: string;
  files: Array<{ path: string; name: string; isDirectory: boolean }>;
  deskContext: { dir: string; fileCount: number } | null;
}

export function parseUserAttachments(content: string): ParsedAttachments {
  if (!content) return { text: '', files: [], deskContext: null };
  const lines = content.split('\n');
  const textLines: string[] = [];
  const files: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const attachRe = /^\[(附件|目录)\]\s+(.+)$/;
  let deskContext: { dir: string; fileCount: number } | null = null;
  let inDeskBlock = false;

  for (const line of lines) {
    const deskMatch = line.match(/^\[当前书桌目录\]\s+(.+)$/);
    if (deskMatch) {
      inDeskBlock = true;
      deskContext = { dir: deskMatch[1].trim(), fileCount: 0 };
      continue;
    }
    if (inDeskBlock) {
      if (line.startsWith('  ') || line.startsWith('...')) {
        if (line.startsWith('  ')) deskContext!.fileCount++;
        continue;
      }
      inDeskBlock = false;
    }

    const m = line.match(attachRe);
    if (m) {
      const isDir = m[1] === '目录';
      const p = m[2].trim();
      const name = p.split('/').pop() || p;
      files.push({ path: p, name, isDirectory: isDir });
    } else {
      textLines.push(line);
    }
  }
  const text = textLines.join('\n').replace(/\n+$/, '').trim();
  return { text, files, deskContext };
}

// ── 工具详情提取 ──

export function truncatePath(p: string): string {
  if (!p || p.length <= 35) return p;
  return '…' + p.slice(-34);
}

export function extractHostname(u: string): string {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return u; }
}

export function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function extractToolDetail(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff':
      return truncatePath((args.file_path || args.path || '') as string);
    case 'bash':
      return truncateHead((args.command || '') as string, 40);
    case 'glob':
    case 'find':
      return (args.pattern || '') as string;
    case 'grep':
      return truncateHead((args.pattern || '') as string, 30) +
        (args.path ? ` in ${truncatePath(args.path as string)}` : '');
    case 'ls':
      return truncatePath((args.path || '') as string);
    case 'web_fetch':
      return extractHostname((args.url || '') as string);
    case 'web_search':
      return truncateHead((args.query || '') as string, 40);
    case 'browser':
      return extractHostname((args.url || '') as string);
    case 'search_memory':
      return truncateHead((args.query || '') as string, 40);
    case 'todo':
      return truncateHead((args.text || '') as string, 40);
    default:
      return '';
  }
}

/** 工具调用的完整摘要（不截断），用于展开查看具体命令与参数 */
export function extractToolDetailFull(name: string, args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '';
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff':
      return String(args.file_path || args.path || '');
    case 'bash':
      return String(args.command || '');
    case 'glob':
    case 'find':
      return String(args.pattern || '');
    case 'grep': {
      const pattern = String(args.pattern || '');
      const path = args.path ? String(args.path) : '';
      return path ? `${pattern} in ${path}` : pattern;
    }
    case 'ls':
      return String(args.path || '');
    case 'web_fetch':
      return String(args.url || '');
    case 'web_search':
      return String(args.query || '');
    case 'browser':
      return String(args.url || '');
    case 'search_memory':
      return String(args.query || '');
    case 'todo':
      return String(args.text || '');
    default:
      try {
        return JSON.stringify(args, null, 2);
      } catch {
        return String(args);
      }
  }
}

// ── /plan 确认：从单条 todo、正文 HTML 还原多步 ──

/** 将一条 todo 的 text 按「多行 1. 2.」拆成多条（模型常把多步写进一条 add） */
export function extractTodosFromAddText(text: string): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
  const numbered = lines.filter(l => /^\d+[.)]\s/.test(l));
  if (numbered.length >= 2) {
    return numbered
      .map(l => {
        const m = l.match(/^\d+[.)]\s*(.+)$/);
        return m ? m[1].trim() : '';
      })
      .filter(Boolean);
  }
  return [raw];
}

function stripHtmlToPlain(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 从助手消息 HTML 表格（序号|步骤）或编号列表提取步骤文案，至少 2 条才认为有效 */
function extractTablePlanSteps(html: string): string[] {
  const out: string[] = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRegex.exec(html)) !== null) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    if (cells.length < 2) continue;
    const c0 = stripHtmlToPlain(cells[0][1]);
    const c1 = stripHtmlToPlain(cells[1][1]);
    if (!c1) continue;
    if (/^\d+$/.test(c0)) out.push(c1);
  }
  return out;
}

function extractNumberedLinesFromHtml(html: string): string[] {
  const plain = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '\n');
  const out: string[] = [];
  for (const line of plain.split('\n')) {
    const t = line.trim();
    const num = t.match(/^(\d+)[.)]\s*(.+)$/);
    if (num && num[2]) {
      const s = num[2].trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** 从助手正文块中解析「计划」步骤（表格或编号列表），用于 /plan 与 todo 条数不一致时 */
export function extractPlanStepsFromAssistantBlocks(blocks: ContentBlock[]): string[] {
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    const fromTable = extractTablePlanSteps(b.html || '');
    if (fromTable.length >= 2) return fromTable;
  }
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    const fromLines = extractNumberedLinesFromHtml(b.html || '');
    if (fromLines.length >= 2) return fromLines;
  }
  return [];
}

function collectTodoAddsFromBlocks(blocks: ContentBlock[]): TodoItem[] {
  const collected: TodoItem[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_group') continue;
    for (const tool of b.tools) {
      if (tool.name === 'todo' && tool.args?.action === 'add' && typeof tool.args?.text === 'string') {
        for (const part of extractTodosFromAddText(String(tool.args.text))) {
          collected.push({ id: collected.length + 1, text: part, done: false });
        }
      }
    }
  }
  return collected;
}

/**
 * 合并 tool_group 中的 todo add 与正文中的计划表/列表，条数多者优先（模型常只调一次 todo 但正文写 5 步）
 */
export function mergePlanDraftTodosFromBlocks(blocks: ContentBlock[]): TodoItem[] {
  const fromTools = collectTodoAddsFromBlocks(blocks);
  const fromTextSteps = extractPlanStepsFromAssistantBlocks(blocks);
  const fromTextTodos = fromTextSteps.map((text, i) => ({ id: i + 1, text, done: false }));
  if (fromTextTodos.length > fromTools.length) return fromTextTodos;
  if (fromTools.length > 0) return fromTools;
  if (fromTextTodos.length > 0) return fromTextTodos;
  return [];
}

/** 将服务端 todo 列表中单条「多行编号」展开为多条（与 mergePlanDraft 一致） */
export function expandTodosNumberedLines(todos: TodoItem[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const td of todos) {
    const parts = extractTodosFromAddText((td.text || '').trim());
    if (parts.length > 1) {
      for (const p of parts) {
        out.push({ id: out.length + 1, text: p, done: false });
      }
    } else {
      out.push({ ...td, id: out.length + 1, text: parts[0] ?? td.text });
    }
  }
  return out;
}
