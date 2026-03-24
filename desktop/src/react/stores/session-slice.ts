import type { Session, SessionStream, TodoItem } from '../types';

/** /plan：仅 todo 规划 → 用户确认 → 执行 */
export type PlanFlowPhase = 'idle' | 'draft_sent' | 'awaiting_confirm';

export interface SessionSlice {
  sessions: Session[];
  currentSessionPath: string | null;
  sessionStreams: Record<string, SessionStream>;
  pendingNewSession: boolean;
  memoryEnabled: boolean;
  sessionTodos: TodoItem[];
  /** /plan 流程：draft_sent 等待本轮结束；awaiting_confirm 显示确认面板 */
  planFlowPhase: PlanFlowPhase;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionPath: (path: string | null) => void;
  setSessionStream: (sessionPath: string, stream: SessionStream) => void;
  removeSessionStream: (sessionPath: string) => void;
  setPendingNewSession: (pending: boolean) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setSessionTodos: (todos: TodoItem[]) => void;
  setPlanFlowPhase: (phase: PlanFlowPhase) => void;
}

export const createSessionSlice = (
  set: (partial: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice>)) => void
): SessionSlice => ({
  sessions: [],
  currentSessionPath: null,
  sessionStreams: {},
  pendingNewSession: false,
  memoryEnabled: true,
  sessionTodos: [],
  planFlowPhase: 'idle',
  setSessions: (sessions) => set({ sessions }),
  setCurrentSessionPath: (path) => set({ currentSessionPath: path }),
  setSessionStream: (sessionPath, stream) =>
    set((s) => ({
      sessionStreams: { ...s.sessionStreams, [sessionPath]: stream },
    })),
  removeSessionStream: (sessionPath) =>
    set((s) => {
      const { [sessionPath]: _, ...rest } = s.sessionStreams;
      return { sessionStreams: rest };
    }),
  setPendingNewSession: (pending) => set({ pendingNewSession: pending }),
  setMemoryEnabled: (enabled) => set({ memoryEnabled: enabled }),
  setSessionTodos: (todos) => set({ sessionTodos: todos }),
  setPlanFlowPhase: (phase) => set({ planFlowPhase: phase }),
});
