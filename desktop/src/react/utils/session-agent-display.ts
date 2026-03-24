/**
 * 从 session 文件路径解析所属 agent，并生成助手消息展示用元数据（与全局「当前选中 agent」解耦）。
 */

import type { ChatMessage } from '../stores/chat-types';
import { hanaUrl } from '../hooks/use-hana-fetch';

export interface AgentRow {
  id: string;
  name: string;
  yuan: string;
  hasAvatar?: boolean;
}

/** 匹配 .../agents/<id>/sessions/... */
export function parseAgentIdFromSessionPath(sessionPath: string): string | null {
  if (!sessionPath) return null;
  const norm = sessionPath.replace(/\\/g, '/');
  const m = norm.match(/[/\\]agents[/\\]([^/\\]+)[/\\]sessions[/\\]/i);
  return m?.[1] ?? null;
}

export function buildAssistantAgentMeta(
  sessionPath: string | null | undefined,
  agents: AgentRow[] | undefined,
): Partial<Pick<ChatMessage, 'agentId' | 'agentName' | 'agentYuan' | 'agentAvatarUrl'>> {
  const agentId = sessionPath ? parseAgentIdFromSessionPath(sessionPath) : null;
  if (!agentId) return {};
  const ag = agents?.find(a => a.id === agentId);
  return {
    agentId,
    agentName: ag?.name ?? agentId,
    agentYuan: ag?.yuan ?? 'hanako',
    agentAvatarUrl: ag?.hasAvatar ? hanaUrl(`/api/agents/${agentId}/avatar`) : null,
  };
}

export function agentYuanFromSessionPath(sessionPath: string, agents: AgentRow[] | undefined): string {
  const y = buildAssistantAgentMeta(sessionPath, agents).agentYuan;
  return y || 'hanako';
}
