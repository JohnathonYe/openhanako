import type { StateCreator } from 'zustand';
import type { StoreState } from './index';

export type MediaKind = 'image' | 'video' | 'audio';

function cacheKey(sessionPath: string, modelId: string): string {
  return `${sessionPath}\t${modelId}`;
}

export interface MediaSessionRejectSlice {
  /** key: sessionPath\tmodelId → 本会话该模型已确认不支持的媒体大类 */
  sessionMediaRejectByKey: Record<string, MediaKind[]>;
  /** 最近一次发出的 prompt 中的媒体类型（供 WS error 时学习） */
  lastOutboundMediaKinds: MediaKind[] | null;
  markSessionMediaKindsRejected: (sessionPath: string, modelId: string, kinds: MediaKind[]) => void;
  isSessionMediaKindRejected: (sessionPath: string, modelId: string, kind: MediaKind) => boolean;
  setLastOutboundMediaKinds: (kinds: MediaKind[] | null) => void;
  /** 归档或删除会话时调用，去掉该路径下所有模型的媒体拒绝缓存 */
  clearSessionMediaRejectForSession: (sessionPath: string) => void;
}

export const createMediaSessionRejectSlice: StateCreator<
  StoreState,
  [],
  [],
  MediaSessionRejectSlice
> = (set, get) => ({
  sessionMediaRejectByKey: {},
  lastOutboundMediaKinds: null,
  markSessionMediaKindsRejected: (sessionPath, modelId, kinds) => {
    if (!kinds.length) return;
    set((s) => {
      const key = cacheKey(sessionPath, modelId);
      const prev = new Set(s.sessionMediaRejectByKey[key] || []);
      for (const k of kinds) prev.add(k);
      return { sessionMediaRejectByKey: { ...s.sessionMediaRejectByKey, [key]: [...prev] as MediaKind[] } };
    });
  },
  isSessionMediaKindRejected: (sessionPath, modelId, kind) => {
    const arr = get().sessionMediaRejectByKey[cacheKey(sessionPath, modelId)];
    return !!arr?.includes(kind);
  },
  setLastOutboundMediaKinds: (kinds) => set({ lastOutboundMediaKinds: kinds }),
  clearSessionMediaRejectForSession: (sessionPath) => {
    if (!sessionPath) return;
    set((s) => {
      const prefix = `${sessionPath}\t`;
      const next = { ...s.sessionMediaRejectByKey };
      for (const k of Object.keys(next)) {
        if (k.startsWith(prefix)) delete next[k];
      }
      const cur = s.currentSessionPath;
      return {
        sessionMediaRejectByKey: next,
        lastOutboundMediaKinds: cur === sessionPath ? null : s.lastOutboundMediaKinds,
      };
    });
  },
});
