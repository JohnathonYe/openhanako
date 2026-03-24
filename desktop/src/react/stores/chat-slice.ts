/**
 * chat-slice.ts — Per-session 消息数据 + 滚动位置
 */

import type { ChatListItem, ChatMessage, SessionMessages } from './chat-types';

export interface ChatSlice {
  chatSessions: Record<string, SessionMessages>;
  scrollPositions: Record<string, number>;

  initSession: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  prependItems: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  appendItem: (path: string, item: ChatListItem) => void;
  updateLastMessage: (path: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  /** 更新最后一条 assistant 消息（插话后列表末尾可能是 user，流式仍应更新 assistant） */
  updateLastAssistantMessage: (path: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  /** 移除指定 session 中最后一个 compaction notice */
  removeLastCompaction: (path: string) => void;
  setLoadingMore: (path: string, loading: boolean) => void;
  clearSession: (path: string) => void;
  saveScrollPosition: (path: string, scrollTop: number) => void;
}

const MAX_CACHED_SESSIONS = 8;

export const createChatSlice = (
  set: (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => void,
  get: () => ChatSlice,
): ChatSlice => ({
  chatSessions: {},
  scrollPositions: {},

  initSession: (path, items, hasMore) => set((s) => {
    const sessions = { ...s.chatSessions };
    sessions[path] = { items, hasMore, loadingMore: false, oldestId: items[0]?.type === 'message' ? items[0].data.id : undefined };
    // LRU 淘汰
    const keys = Object.keys(sessions);
    if (keys.length > MAX_CACHED_SESSIONS) {
      const oldest = keys.find(k => k !== path);
      if (oldest) delete sessions[oldest];
    }
    return { chatSessions: sessions };
  }),

  prependItems: (path, items, hasMore) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    const merged = [...items, ...session.items];
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: {
          ...session,
          items: merged,
          hasMore,
          loadingMore: false,
          oldestId: items[0]?.type === 'message' ? items[0].data.id : session.oldestId,
        },
      },
    };
  }),

  appendItem: (path, item) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, items: [...session.items, item] },
      },
    };
  }),

  updateLastMessage: (path, updater) => set((s) => {
    const session = s.chatSessions[path];
    if (!session || session.items.length === 0) return {};
    const items = [...session.items];
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    if (last.type !== 'message') return {};
    items[lastIdx] = { type: 'message', data: updater(last.data) };
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, items },
      },
    };
  }),

  updateLastAssistantMessage: (path, updater) => set((s) => {
    const session = s.chatSessions[path];
    if (!session || session.items.length === 0) return {};
    const items = [...session.items];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type !== 'message' || it.data.role !== 'assistant') continue;
      items[i] = { type: 'message', data: updater(it.data) };
      return {
        chatSessions: {
          ...s.chatSessions,
          [path]: { ...session, items },
        },
      };
    }
    return {};
  }),

  removeLastCompaction: (path) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    const items = [...session.items];
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'compaction') {
        items.splice(i, 1);
        return {
          chatSessions: {
            ...s.chatSessions,
            [path]: { ...session, items },
          },
        };
      }
    }
    return {};
  }),

  setLoadingMore: (path, loading) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, loadingMore: loading },
      },
    };
  }),

  clearSession: (path) => set((s) => {
    const sessions = { ...s.chatSessions };
    delete sessions[path];
    return { chatSessions: sessions };
  }),

  saveScrollPosition: (path, scrollTop) => set((s) => ({
    scrollPositions: { ...s.scrollPositions, [path]: scrollTop },
  })),
});
