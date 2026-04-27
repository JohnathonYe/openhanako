/**
 * 从会话消息列表汇总 AI 写入/编辑涉及的文件路径、diff 与可回滚的 turnId 顺序。
 * 从历史 API 重建的消息往往没有 turnId，仍计入 Review；turnIdsOrdered 仅含带 turnId 的轮次（供全部撤销）。
 */

import { countDiffLineStats } from './diff-parse';
import type { ChatListItem, ToolCall } from '../stores/chat-types';

const FILE_MOD_TOOLS = new Set(['write', 'edit', 'edit-diff']);

export function toolFilePath(tool: ToolCall): string {
  return String(tool.args?.file_path || tool.args?.path || '');
}

export interface PendingDiffEntry {
  filePath: string;
  diff: string;
}

export interface PendingFileChangesResult {
  paths: string[];
  turnIdsOrdered: string[];
  /** 本会话未回滚的工具 diff，按消息时间顺序 */
  diffEntries: PendingDiffEntry[];
  totalAdd: number;
  totalRemove: number;
}

export function collectPendingFileChanges(
  items: ChatListItem[],
  revertedTurnIds: Record<string, true> | undefined,
): PendingFileChangesResult {
  const pathSet = new Set<string>();
  const turnOrder: string[] = [];
  const seenTurn = new Set<string>();
  const diffEntries: PendingDiffEntry[] = [];
  let totalAdd = 0;
  let totalRemove = 0;

  for (const item of items) {
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    const msg = item.data;
    const tid = msg.turnId;
    if (tid && revertedTurnIds?.[tid]) continue;

    let hasFileMod = false;
    for (const block of msg.blocks || []) {
      if (block.type !== 'tool_group') continue;
      for (const t of block.tools) {
        if (!FILE_MOD_TOOLS.has(t.name) || !t.done || !t.success) continue;
        hasFileMod = true;
        const p = toolFilePath(t);
        if (p) pathSet.add(p);
        const rawDiff = t.details?.diff;
        if (typeof rawDiff === 'string' && rawDiff.length > 0) {
          diffEntries.push({ filePath: p, diff: rawDiff });
          const st = countDiffLineStats(rawDiff);
          totalAdd += st.add;
          totalRemove += st.remove;
        }
      }
    }
    if (hasFileMod && tid && !seenTurn.has(tid)) {
      seenTurn.add(tid);
      turnOrder.push(tid);
    }
  }

  return {
    paths: [...pathSet],
    turnIdsOrdered: turnOrder,
    diffEntries,
    totalAdd,
    totalRemove,
  };
}
