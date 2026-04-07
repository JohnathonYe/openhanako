/**
 * 从会话消息列表汇总 AI 写入/编辑涉及的文件路径与可回滚的 turnId 顺序。
 */

import type { ChatListItem, ToolCall } from '../stores/chat-types';

const FILE_MOD_TOOLS = new Set(['write', 'edit', 'edit-diff']);

export function toolFilePath(tool: ToolCall): string {
  return String(tool.args?.file_path || tool.args?.path || '');
}

export function collectPendingFileChanges(
  items: ChatListItem[],
  revertedTurnIds: Record<string, true> | undefined,
): { paths: string[]; turnIdsOrdered: string[] } {
  const pathSet = new Set<string>();
  const turnOrder: string[] = [];
  const seenTurn = new Set<string>();

  for (const item of items) {
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    const msg = item.data;
    const tid = msg.turnId;
    if (!tid || revertedTurnIds?.[tid]) continue;

    let hasFileMod = false;
    for (const block of msg.blocks || []) {
      if (block.type !== 'tool_group') continue;
      for (const t of block.tools) {
        if (!FILE_MOD_TOOLS.has(t.name) || !t.done || !t.success) continue;
        hasFileMod = true;
        const p = toolFilePath(t);
        if (p) pathSet.add(p);
      }
    }
    if (hasFileMod && !seenTurn.has(tid)) {
      seenTurn.add(tid);
      turnOrder.push(tid);
    }
  }

  return { paths: [...pathSet], turnIdsOrdered: turnOrder };
}
