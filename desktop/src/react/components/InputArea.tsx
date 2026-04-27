/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 替代 app-input-shim.ts + app-ui-shim.ts 中的模型/PlanMode/Todo 逻辑。
 * 通过 portal 渲染到 index.html 的 #inputAreaPortal。
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../stores';
import { ensureSession } from '../stores/session-actions';
import { getWebSocket } from '../services/websocket';
import { waitDiaryWsOnce } from '../services/diary-ws';
import { streamBufferManager } from '../hooks/use-stream-buffer';
import { executePromptSend, appendOptimisticUserMessage } from './input/execute-prompt-send';
import {
  countMediaAttachments,
  guessMediaMimeType,
  isAudioFile,
  isImageFile,
  isVideoFile,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MEDIA_ATTACHMENTS,
  MAX_VIDEO_BYTES,
} from '../utils/format';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { buildMediaAcceptAttr, isMimeAllowedForModelInput } from '../utils/model-media';
import type { ThinkingLevel } from '../stores/model-slice';
import type { AttachedFile } from '../stores/input-slice';
import { showHanaToast } from '../utils/hana-toast';
import { TodoDisplay } from './input/TodoDisplay';
import { collectPendingFileChanges } from '../utils/file-change-collect';
import { DiffView } from './chat/DiffView';

// ── 斜杠命令 ──

const XING_PROMPT = `回顾这个 session 里我（用户）发送的消息。只从我的对话内容中提取指导、偏好、纠正和工作流程，整理成一份可复用的工作指南。

注意：不要提取系统提示词、记忆文件、人格设定等预注入内容，只关注我在本次对话中实际说的话。

要求：
1. 只保留可复用的模式，过滤仅限本次的具体上下文（如具体文件名、具体话题）
2. 按类别组织：风格偏好、工作流程、质量标准、注意事项
3. 措辞用指令式（"做 X"、"避免 Y"）
4. 步骤流程用编号列出

标题要具体，能一眼看出这个工作流是干什么的（例："战争报道事实核查流程""论文润色风格指南"），不要用泛化的名字（如"工作流总结""对话复盘"）。

严格按照以下格式输出（注意用直引号 "，不要用弯引号 ""）：

<xing title="具体的工作流名称">
## 风格偏好
- 做 X
- 避免 Y

## 工作流程
1. 第一步
2. 第二步
</xing>

以上是格式示范，实际内容根据对话提取。`;

// ── 斜杠命令定义 ──

export interface SlashCommand {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  execute: () => Promise<void>;
}

// ── 主组件 ──

export function InputArea() {
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = document.getElementById('inputAreaPortal');
    if (!el) console.warn('[InputArea] portal target #inputAreaPortal not found');
    setPortalEl(el);
  }, []);
  if (!portalEl) return null;
  return createPortal(<InputAreaInner />, portalEl);
}

/** t() 翻译缺失时返回 key 本身（truthy），|| fallback 不会触发。这个包一层检测 */
const tSafe = (
  t: (k: string, v?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) => {
  const v = vars ? t(key, vars) : t(key);
  if (v !== key) return v;
  if (!vars) return fallback;
  let out = fallback;
  for (const [k, val] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(val));
  }
  return out;
};

const MULTIMODAL_STORAGE_KEY = 'hana-multimodal-to-model';
const SEND_QUEUE_MODE_STORAGE_KEY = 'hana-send-queue-mode';

function formatBlockedMediaKinds(blocked: Array<'image' | 'video' | 'audio'>): string {
  const loc = typeof window !== 'undefined' && window.i18n?.locale?.startsWith('en') ? 'en' : 'zh';
  const isEn = loc === 'en';
  const map: Record<string, string> = {
    image: isEn ? 'image' : '图片',
    video: isEn ? 'video' : '视频',
    audio: isEn ? 'audio' : '音频',
  };
  return blocked.map(k => map[k] || k).join(isEn ? ', ' : '、');
}

/** 流式进行中：待发 prompt 快照（会话切换时丢弃） */
type PendingPromptSend = {
  sessionPath: string;
  displayText: string;
  mentionedFiles: Array<{ name: string; path: string }>;
  attachedFiles: AttachedFile[];
  planTagActive: boolean;
  multimodalToModel: boolean;
};

const EMPTY_ITEMS: import('../stores/chat-types').ChatListItem[] = [];

/** 输入框上方：本会话 AI 变更 Review（汇总 +/- 行数）+ 全部撤销；点击查看全部 diff */
function SessionFileChangesBar({ sessionPath }: { sessionPath: string | null }) {
  const { t } = useI18n();
  const items = useStore(s => (sessionPath ? s.chatSessions[sessionPath]?.items : null) ?? EMPTY_ITEMS);
  const reverted = useStore(s => (sessionPath ? s.revertedTurnIdsBySession[sessionPath] : undefined));
  const pending = useMemo(() => collectPendingFileChanges(items, reverted), [items, reverted]);
  const [undoing, setUndoing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReviewOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviewOpen]);

  const handleUndoAll = useCallback(async () => {
    if (undoing || !sessionPath) return;
    const rawItems = useStore.getState().chatSessions[sessionPath]?.items ?? [];
    const rev = useStore.getState().revertedTurnIdsBySession[sessionPath];
    const { turnIdsOrdered } = collectPendingFileChanges(rawItems, rev);
    if (turnIdsOrdered.length === 0) return;
    setUndoing(true);
    try {
      const okIds: string[] = [];
      const failHints: string[] = [];
      for (const tid of [...turnIdsOrdered].reverse()) {
        try {
          const res = await hanaFetch('/api/revert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ turnId: tid }),
          });
          const data = (await res.json()) as { ok?: boolean; error?: string };
          if (data.ok) okIds.push(tid);
          else if (data.error) failHints.push(String(data.error));
        } catch (e) {
          failHints.push(e instanceof Error ? e.message : String(e));
        }
      }
      const total = turnIdsOrdered.length;
      if (okIds.length) useStore.getState().markTurnsReverted(sessionPath, okIds);

      if (okIds.length === total) {
        showHanaToast(
          tSafe(t, 'input.undoAllDone', 'Reverted {n} turn(s).', { n: okIds.length }),
          'success',
        );
      } else if (okIds.length > 0) {
        showHanaToast(
          tSafe(t, 'input.undoAllPartial', 'Reverted {ok} of {total} turn(s). Others had no server file snapshot (e.g. after server restart).', {
            ok: okIds.length,
            total,
          }),
          'success',
        );
      } else {
        const hint = failHints[0]
          ? ` ${failHints[0]}`
          : '';
        showHanaToast(
          `${tSafe(
            t,
            'input.undoAllNone',
            'Nothing was reverted: the server has no in-memory file snapshot for these turns (often after restart).',
          )}${hint}`,
          'error',
        );
      }
    } finally {
      setUndoing(false);
    }
  }, [sessionPath, undoing, t]);

  if (!sessionPath || pending.paths.length === 0) return null;

  const reviewLabel = tSafe(t, 'input.reviewChanges', 'Review');
  const dialogTitle = tSafe(t, 'input.sessionDiffTitle', 'Session changes');

  return (
    <>
      <div className="session-file-changes-bar" role="status">
        <div className="session-file-changes-bar-row">
          <button
            type="button"
            className="session-file-changes-review-pill"
            onClick={() => setReviewOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={reviewOpen}
            aria-label={`${reviewLabel} +${pending.totalAdd} -${pending.totalRemove}`}
          >
            <span className="session-file-changes-review-label">{reviewLabel}</span>
            <span className="session-file-changes-review-add">+{pending.totalAdd}</span>
            <span className="session-file-changes-review-remove">-{pending.totalRemove}</span>
          </button>
          <button
            type="button"
            className="session-file-changes-undo-all"
            onClick={handleUndoAll}
            disabled={undoing || pending.turnIdsOrdered.length === 0}
          >
            {undoing
              ? tSafe(t, 'input.undoAllBusy', 'Undoing…')
              : tSafe(t, 'input.undoAll', 'Undo all')}
          </button>
        </div>
      </div>
      {reviewOpen &&
        createPortal(
          <div
            className="session-diff-review-overlay"
            onClick={() => setReviewOpen(false)}
            role="presentation"
          >
            <div
              className="session-diff-review-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="session-diff-review-title"
              onClick={e => e.stopPropagation()}
            >
              <div className="session-diff-review-head">
                <h2 id="session-diff-review-title" className="session-diff-review-title">
                  {dialogTitle}
                </h2>
                <button
                  type="button"
                  className="session-diff-review-close"
                  onClick={() => setReviewOpen(false)}
                  aria-label={tSafe(t, 'input.closeDiffReview', 'Close')}
                >
                  ✕
                </button>
              </div>
              <div className="session-diff-review-body">
                {pending.diffEntries.length === 0 ? (
                  <p className="session-diff-review-empty">
                    {tSafe(
                      t,
                      'input.noDiffText',
                      'No diff text is available for these changes.',
                    )}
                  </p>
                ) : (
                  pending.diffEntries.map((e, i) => (
                    <DiffView
                      key={`${e.filePath}-${i}`}
                      diff={e.diff}
                      filePath={e.filePath || undefined}
                    />
                  ))
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function InputAreaInner() {
  const { t } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const sessionTodos = useStore(s => s.sessionTodos);
  const setSessionTodos = useStore(s => s.setSessionTodos);
  const attachedFiles = useStore(s => s.attachedFiles);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);

  const currentModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  /** 文件选择器 accept：与 models.json / Pi 的 model.input 一致；模型未就绪时不收紧 */
  const mediaAccept = useMemo(
    () => buildMediaAcceptAttr(currentModelInfo?.id ? currentModelInfo.input : undefined),
    [currentModelInfo?.id, currentModelInfo?.input],
  );
  const applyModelMediaCaps = Boolean(currentModelInfo?.id);

  // Desk files for @ mentions
  const deskFiles = useStore(s => s.deskFiles);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);

  // Local state
  const [inputText, setInputText] = useState('');
  /** 与 engine 默认 planMode=false 一致；挂载后 GET /api/plan-mode 与 WS plan_mode 再校准 */
  const [planMode, setPlanMode] = useState(false);
  const [codingMode, setCodingMode] = useState(false);
  const [planTagActive, setPlanTagActive] = useState(false);
  const [planIndent, setPlanIndent] = useState(0);
  const planTagRef = useRef<HTMLSpanElement>(null);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atSelected, setAtSelected] = useState(0);
  const [atQuery, setAtQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const [mentionedFiles, setMentionedFiles] = useState<Array<{ name: string; path: string }>>([]);
  const handleSendRef = useRef<() => Promise<void>>(async () => {});
  const planFlowPhase = useStore(s => s.planFlowPhase);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const isComposing = useRef(false);

  // 测量 plan 标签宽度，用于 text-indent 让首行缩进、换行回最左
  useLayoutEffect(() => {
    if (planTagActive && planTagRef.current) {
      setPlanIndent(planTagRef.current.offsetWidth + 8);
    } else {
      setPlanIndent(0);
    }
  }, [planTagActive]);

  /** 默认关闭：需用户按下开关后 localStorage 写 '1' 才启用多模态 */
  const [multimodalToModel, setMultimodalToModel] = useState(() => {
    try {
      return localStorage.getItem(MULTIMODAL_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  /** 开启时：助手流式输出中点发送为「排队」，等本轮结束再发 prompt；关闭时为「插话」 */
  const [sendQueueMode, setSendQueueMode] = useState(() => {
    try {
      return localStorage.getItem(SEND_QUEUE_MODE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const pendingSendQueueRef = useRef<PendingPromptSend[]>([]);
  const [queuedSendCount, setQueuedSendCount] = useState(0);
  const flushQueuedSendRef = useRef(false);

  const toggleSendQueueMode = useCallback(() => {
    setSendQueueMode((v) => {
      const next = !v;
      try {
        localStorage.setItem(SEND_QUEUE_MODE_STORAGE_KEY, next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  // @ mention: resolve desk file → full path
  const resolveDeskPath = useCallback((name: string) => {
    if (!deskBasePath) return null;
    return deskCurrentPath
      ? `${deskBasePath}/${deskCurrentPath}/${name}`
      : `${deskBasePath}/${name}`;
  }, [deskBasePath, deskCurrentPath]);

  // @ mention: filtered file list
  const atFilteredFiles = useMemo(() => {
    if (!atMenuOpen || !deskFiles.length) return [];
    const q = atQuery.toLowerCase();
    const matched = q
      ? deskFiles.filter(f => f.name.toLowerCase().includes(q))
      : deskFiles;
    return matched.slice(0, 12);
  }, [atMenuOpen, atQuery, deskFiles]);

  // ── 统一命令发送 ──

  /** 统一的"以用户身份发送"入口，所有斜杠命令共用 */
  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (useStore.getState().isStreaming) return false;

    if (pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return false;
    }

    appendOptimisticUserMessage(displayText ?? text, null);
    const sp = useStore.getState().currentSessionPath;
    ws.send(JSON.stringify({ type: 'prompt', text, ...(sp ? { sessionPath: sp } : {}) }));
    return true;
  }, [pendingNewSession]);

  // ── 斜杠命令 ──

  const executeDiary = useCallback(async () => {
    setSlashBusy('diary');
    setInputText('');
    setSlashMenuOpen(false);

    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showHanaToast(tSafe(t, 'slash.diaryFailed', '日记写入失败'), 'error');
      setSlashBusy(null);
      return;
    }

    try {
      const wait = waitDiaryWsOnce();
      ws.send(JSON.stringify({ type: 'diary_write' }));
      const outcome = await wait;
      if (!outcome.ok) {
        const errMsg =
          outcome.error === 'timeout'
            ? tSafe(t, 'slash.diaryTimeout', '日记生成超时，请查看日志或稍后重试')
            : outcome.error === 'diary_wait_overlap'
              ? tSafe(t, 'error.diaryBusy', '已有日记任务在进行')
              : outcome.error;
        showHanaToast(errMsg, 'error');
        return;
      }
      showHanaToast(tSafe(t, 'slash.diaryDone', '日记已保存'), 'success');
    } catch {
      showHanaToast(tSafe(t, 'slash.diaryFailed', '日记写入失败'), 'error');
    } finally {
      setSlashBusy(null);
    }
  }, [t]);

  const executeXing = useCallback(async () => {
    setInputText('');
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser]);

  const slashCommands: SlashCommand[] = useMemo(() => [
    {
      name: 'plan',
      label: '/plan',
      description: tSafe(t, 'slash.plan', '用待办拆解任务（确认后执行）'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
      execute: async () => {
        setPlanTagActive(true);
        setSlashMenuOpen(false);
        setInputText(prev => prev.replace(/^\/\w*\s*/i, '').trimStart());
        textareaRef.current?.focus();
      },
    },
    {
      name: 'diary',
      label: '/diary',
      description: tSafe(t, 'slash.diary', '写今日日记'),
      busyLabel: tSafe(t, 'slash.diaryBusy', '正在写日记...'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      execute: executeDiary,
    },
    {
      name: 'xing',
      label: '/xing',
      description: tSafe(t, 'slash.xing', '反省当前对话'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
      execute: executeXing,
    },
  ], [executeDiary, executeXing, t]);

  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    const query = inputText.slice(1).toLowerCase();
    return slashCommands.filter(c => c.name.startsWith(query));
  }, [inputText, slashCommands]);

  // @ mention: select file → insert @filename inline, track path
  const pendingCursorPos = useRef<number | null>(null);

  const handleAtSelect = useCallback((file: { name: string; isDir: boolean }) => {
    const fullPath = resolveDeskPath(file.name);
    if (!fullPath) return;

    const before = inputText.slice(0, atStartPos);
    const after = inputText.slice(atStartPos + 1 + atQuery.length);
    const tag = `@${file.name} `;
    const newText = before + tag + after;

    pendingCursorPos.current = before.length + tag.length;
    setInputText(newText);
    setMentionedFiles(prev => {
      if (prev.some(f => f.path === fullPath)) return prev;
      return [...prev, { name: file.name, path: fullPath }];
    });
    setAtMenuOpen(false);
    setAtQuery('');
    setAtStartPos(-1);
  }, [inputText, atStartPos, atQuery, resolveDeskPath]);

  // Restore cursor after React flushes the new inputText to the textarea
  useEffect(() => {
    if (pendingCursorPos.current !== null) {
      const el = textareaRef.current;
      if (el) {
        const pos = pendingCursorPos.current;
        el.focus();
        el.setSelectionRange(pos, pos);
      }
      pendingCursorPos.current = null;
    }
  }, [inputText]);

  // 输入 / 或 @ 时打开菜单
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setInputText(value);

    // slash commands
    if (value.startsWith('/') && value.length <= 20 && !planTagActive) {
      setSlashMenuOpen(true);
      setSlashSelected(0);
    } else if (!value.startsWith('/') || planTagActive) {
      setSlashMenuOpen(false);
    }

    // @ mention detection: find the last '@' preceded by start-of-string or whitespace
    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
    if (atMatch && deskFiles.length > 0) {
      const startIdx = textBeforeCursor.length - atMatch[2].length - 1;
      setAtStartPos(startIdx);
      setAtQuery(atMatch[2]);
      setAtMenuOpen(true);
      setAtSelected(0);
    } else {
      setAtMenuOpen(false);
      setAtQuery('');
      setAtStartPos(-1);
    }
  }, [deskFiles.length]);

  // @ mention: set of tracked names (for mirror highlighting)
  const mentionedNames = useMemo(
    () => new Set(mentionedFiles.map(f => f.name)),
    [mentionedFiles],
  );

  // @ mention: remove stale entries when user deletes @name from text
  useEffect(() => {
    if (mentionedFiles.length === 0) return;
    const still = mentionedFiles.filter(f => inputText.includes(`@${f.name}`));
    if (still.length !== mentionedFiles.length) setMentionedFiles(still);
  }, [inputText, mentionedFiles]);

  // Can send?
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0;
  const canSend = hasContent && connected && !isStreaming;

  // ── Auto resize ──
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [inputText]);

  // ── Placeholder from yuan ──
  const placeholder = (() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();


  const toggleMultimodalToModel = useCallback(() => {
    setMultimodalToModel((v) => {
      const next = !v;
      try {
        localStorage.setItem(MULTIMODAL_STORAGE_KEY, next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── 剪贴板图片/视频/语音：始终可粘贴，是否发给模型由「看图/视频/语音」开关决定（默认关闭）──
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;

    let reservedMediaSlots = countMediaAttachments(useStore.getState().attachedFiles);
    let handledAny = false;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const kind = item.type || '';
      if (!kind.startsWith('image/') && !kind.startsWith('video/') && !kind.startsWith('audio/')) continue;

      const file = item.getAsFile();
      if (!file) continue;

      if (reservedMediaSlots >= MAX_MEDIA_ATTACHMENTS) {
        if (handledAny) break;
        showHanaToast(tSafe(t, 'input.mediaTooMany', `最多 ${MAX_MEDIA_ATTACHMENTS} 个媒体附件`), 'error');
        break;
      }

      if (kind.startsWith('image/') || file.type.startsWith('image/')) {
        if (file.size > MAX_IMAGE_BYTES) {
          showHanaToast(tSafe(t, 'input.imageTooLarge', '单张图片不得超过 10MB'), 'error');
          continue;
        }
      } else if (kind.startsWith('video/') || file.type.startsWith('video/')) {
        if (file.size > MAX_VIDEO_BYTES) {
          showHanaToast(tSafe(t, 'input.videoTooLarge', '单个视频不得超过 20MB'), 'error');
          continue;
        }
      } else if (kind.startsWith('audio/') || file.type.startsWith('audio/')) {
        if (file.size > MAX_AUDIO_BYTES) {
          showHanaToast(tSafe(t, 'input.audioTooLarge', '单条语音不得超过 20MB'), 'error');
          continue;
        }
      }

      const mimeType = (file.type && file.type !== '') ? file.type : kind;
      const baseMime = mimeType.split(';')[0].trim().toLowerCase();
      const kindCat: 'image' | 'video' | 'audio' | null = baseMime.startsWith('image/')
        ? 'image'
        : baseMime.startsWith('video/')
          ? 'video'
          : baseMime.startsWith('audio/')
            ? 'audio'
            : null;
      if (applyModelMediaCaps && kindCat && !isMimeAllowedForModelInput(baseMime, currentModelInfo?.input)) {
        if (!handledAny) e.preventDefault();
        handledAny = true;
        showHanaToast(
          tSafe(t, 'error.modelMediaNotSupported', '当前模型不支持此类媒体（{mime}）。请在 models.json 的 input 中加入 image、video 或 audio。', {
            mime: baseMime,
          }),
          'error',
        );
        continue;
      }
      const spPaste = useStore.getState().currentSessionPath;
      const midPaste = currentModelInfo?.id;
      if (kindCat && spPaste && midPaste && useStore.getState().isSessionMediaKindRejected(spPaste, midPaste, kindCat)) {
        if (!handledAny) e.preventDefault();
        handledAny = true;
        showHanaToast(
          tSafe(t, 'error.sessionMediaKindCached', '本会话中该模型已确认不支持此类附件：{kinds}', {
            kinds: formatBlockedMediaKinds([kindCat]),
          }),
          'error',
        );
        continue;
      }
      const sub = mimeType.split('/')[1] || 'bin';
      const isVideo = mimeType.startsWith('video/');
      const isAudio = mimeType.startsWith('audio/');
      const displayName = isVideo ? `粘贴视频.${sub}` : isAudio ? `粘贴语音.${sub}` : `粘贴图片.${sub}`;

      if (!handledAny) e.preventDefault();
      handledAny = true;
      reservedMediaSlots++;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return;
        const [, parsedMime, base64Data] = match;
        addAttachedFile({
          path: `clipboard-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.${sub}`,
          name: displayName,
          base64Data,
          mimeType: parsedMime,
        });
      };
      reader.readAsDataURL(file);
    }
  }, [addAttachedFile, t, currentModelInfo?.id, currentModelInfo?.input, applyModelMediaCaps]);

  const handlePickMediaFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list?.length) return;
    let queued = countMediaAttachments(useStore.getState().attachedFiles);
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      if (!isImageFile(file.name) && !isVideoFile(file.name) && !isAudioFile(file.name)) {
        showHanaToast(tSafe(t, 'input.mediaInvalidType', '不支持的媒体类型'), 'error');
        continue;
      }
      const mimeGuessPick = (file.type && file.type !== '')
        ? file.type.split(';')[0].trim().toLowerCase()
        : (guessMediaMimeType(file.name) || '');
      const kindPick: 'image' | 'video' | 'audio' | null = mimeGuessPick.startsWith('image/')
        ? 'image'
        : mimeGuessPick.startsWith('video/')
          ? 'video'
          : mimeGuessPick.startsWith('audio/')
            ? 'audio'
            : isImageFile(file.name)
              ? 'image'
              : isVideoFile(file.name)
                ? 'video'
                : isAudioFile(file.name)
                  ? 'audio'
                  : null;
      const mimeForCaps = mimeGuessPick || guessMediaMimeType(file.name) || '';
      if (applyModelMediaCaps && kindPick && mimeForCaps && !isMimeAllowedForModelInput(mimeForCaps, currentModelInfo?.input)) {
        showHanaToast(
          tSafe(t, 'error.modelMediaNotSupported', '当前模型不支持此类媒体（{mime}）。请在 models.json 的 input 中加入 image、video 或 audio。', {
            mime: mimeForCaps,
          }),
          'error',
        );
        continue;
      }
      const spPick = useStore.getState().currentSessionPath;
      const midPick = currentModelInfo?.id;
      if (kindPick && spPick && midPick && useStore.getState().isSessionMediaKindRejected(spPick, midPick, kindPick)) {
        showHanaToast(
          tSafe(t, 'error.sessionMediaKindCached', '本会话中该模型已确认不支持此类附件：{kinds}', {
            kinds: formatBlockedMediaKinds([kindPick]),
          }),
          'error',
        );
        continue;
      }
      if (queued >= MAX_MEDIA_ATTACHMENTS) {
        showHanaToast(tSafe(t, 'input.mediaTooMany', `最多 ${MAX_MEDIA_ATTACHMENTS} 个媒体附件`), 'error');
        break;
      }
      if (isImageFile(file.name) && file.size > MAX_IMAGE_BYTES) {
        showHanaToast(tSafe(t, 'input.imageTooLarge', '单张图片不得超过 10MB'), 'error');
        continue;
      }
      if (isVideoFile(file.name) && file.size > MAX_VIDEO_BYTES) {
        showHanaToast(tSafe(t, 'input.videoTooLarge', '单个视频不得超过 20MB'), 'error');
        continue;
      }
      if (isAudioFile(file.name) && file.size > MAX_AUDIO_BYTES) {
        showHanaToast(tSafe(t, 'input.audioTooLarge', '单条语音不得超过 20MB'), 'error');
        continue;
      }
      queued++;
      const reader = new FileReader();
      const fname = file.name;
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return;
        const mimeType = match[1];
        const base64Data = match[2];
        addAttachedFile({
          path: `picked-${Date.now()}-${fname}`,
          name: fname,
          base64Data,
          mimeType,
        });
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  }, [addAttachedFile, t, currentModelInfo?.id, currentModelInfo?.input, applyModelMediaCaps]);

  // ── Load plan mode + coding mode + thinking level on mount ──
  useEffect(() => {
    hanaFetch('/api/plan-mode')
      .then(r => r.json())
      .then(d => setPlanMode(d.enabled ?? false))
      .catch(() => {});

    hanaFetch('/api/coding-mode')
      .then(r => r.json())
      .then(d => setCodingMode(d.enabled ?? false))
      .catch(() => {});

    hanaFetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
      .catch(() => {});

    const planHandler = (e: Event) => {
      setPlanMode((e as CustomEvent).detail?.enabled ?? false);
    };
    const codingHandler = (e: Event) => {
      setCodingMode((e as CustomEvent).detail?.enabled ?? false);
    };
    window.addEventListener('hana-plan-mode', planHandler);
    window.addEventListener('hana-coding-mode', codingHandler);
    return () => {
      window.removeEventListener('hana-plan-mode', planHandler);
      window.removeEventListener('hana-coding-mode', codingHandler);
    };
  }, []);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    const isPlanSlash = planTagActive;

    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles) || !connected) return;
    if (isStreaming) return;
    if (sending) return;
    setSending(true);

    try {
      const ok = await executePromptSend({
        displayText: text,
        mentionedFiles,
        attachedFiles: attachedFiles.map(f => ({ ...f })),
        planTagActive: isPlanSlash,
        multimodalToModel,
        pendingNewSession,
        t,
      });
      if (ok) {
        setInputText('');
        if (isPlanSlash) setPlanTagActive(false);
        clearAttachedFiles();
        setMentionedFiles([]);
      }
    } finally {
      setSending(false);
    }
  }, [inputText, attachedFiles, connected, isStreaming, sending, pendingNewSession, clearAttachedFiles, slashMenuOpen, filteredCommands, slashSelected, multimodalToModel, mentionedFiles, planTagActive, t]);

  handleSendRef.current = handleSend;

  const handleQueueEnqueue = useCallback(() => {
    const text = inputText.trim();
    const isPlanSlash = planTagActive;
    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }
    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles) || !connected) return;
    if (!isStreaming || !sendQueueMode) return;
    if (sending) return;
    const sp = useStore.getState().currentSessionPath;
    if (!sp) return;

    pendingSendQueueRef.current.push({
      sessionPath: sp,
      displayText: text,
      mentionedFiles: [...mentionedFiles],
      attachedFiles: attachedFiles.map(f => ({ ...f })),
      planTagActive: isPlanSlash,
      multimodalToModel,
    });
    setQueuedSendCount(pendingSendQueueRef.current.length);
    setInputText('');
    if (isPlanSlash) setPlanTagActive(false);
    clearAttachedFiles();
    setMentionedFiles([]);
  }, [
    inputText,
    planTagActive,
    slashMenuOpen,
    filteredCommands,
    slashSelected,
    attachedFiles,
    connected,
    isStreaming,
    sendQueueMode,
    sending,
    clearAttachedFiles,
    mentionedFiles,
    multimodalToModel,
  ]);

  useEffect(() => {
    pendingSendQueueRef.current = [];
    setQueuedSendCount(0);
  }, [currentSessionPath]);

  useEffect(() => {
    if (isStreaming) return;
    const sp = useStore.getState().currentSessionPath;
    if (!sp) return;
    const q = pendingSendQueueRef.current;
    if (q.length === 0) return;
    if (q[0].sessionPath !== sp) {
      pendingSendQueueRef.current = q.filter(x => x.sessionPath === sp);
      setQueuedSendCount(pendingSendQueueRef.current.length);
      return;
    }
    if (flushQueuedSendRef.current) return;
    flushQueuedSendRef.current = true;
    void (async () => {
      try {
        const item = pendingSendQueueRef.current.shift()!;
        setQueuedSendCount(pendingSendQueueRef.current.length);
        setSending(true);
        try {
          const ok = await executePromptSend({
            displayText: item.displayText,
            mentionedFiles: item.mentionedFiles,
            attachedFiles: item.attachedFiles,
            planTagActive: item.planTagActive,
            multimodalToModel: item.multimodalToModel,
            pendingNewSession: false,
            t,
          });
          if (!ok) {
            pendingSendQueueRef.current.unshift(item);
            setQueuedSendCount(pendingSendQueueRef.current.length);
          }
        } finally {
          setSending(false);
        }
      } finally {
        flushQueuedSendRef.current = false;
      }
    })();
  }, [isStreaming, currentSessionPath, t]);

  const handleCancelPlan = useCallback(() => {
    useStore.getState().setPlanFlowPhase('idle');
  }, []);

  const handleConfirmPlan = useCallback(async (items: { text: string }[]) => {
    const lines = items.map(x => x.text.trim()).filter(Boolean);
    if (lines.length === 0) {
      showHanaToast(tSafe(t, 'plan.emptySteps', '请至少保留一条待办'), 'error');
      return;
    }
    if (pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return;
    }
    const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const body = `${tSafe(t, 'plan.executeUserBody', 'User confirmed the plan below. First, sync the todo list so it exactly matches these confirmed steps: clear mismatched draft todos if needed, then add each confirmed step once. Then execute in order. You MUST use the todo tool to mark each item completed (toggle) when that step is finished; do not mark done prematurely. If a step cannot be completed, explain why.')}\n\n${numbered}`;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showHanaToast(tSafe(t, 'input.notConnected', '未连接服务器，无法发送'), 'error');
      return;
    }
    setSessionTodos(lines.map((text, i) => ({ id: i + 1, text, done: false })));
    useStore.getState().setPlanFlowPhase('idle');
    const planSp = useStore.getState().currentSessionPath;
    ws.send(JSON.stringify({ type: 'prompt', text: body, ...(planSp ? { sessionPath: planSp } : {}) }));
  }, [pendingNewSession, setSessionTodos, t]);

  // ── Steer (插话) ──
  const handleSteer = useCallback(() => {
    const text = inputText.trim();
    if (!text || !isStreaming) return;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const sp = useStore.getState().currentSessionPath;
    if (sp) streamBufferManager.clear(sp);

    appendOptimisticUserMessage(text, null);

    setInputText('');
    ws.send(JSON.stringify({ type: 'steer', text, ...(sp ? { sessionPath: sp } : {}) }));
  }, [inputText, isStreaming]);

  // ── Stop generation ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws || ws.readyState !== WebSocket.OPEN) return;
    const abortSp = useStore.getState().currentSessionPath;
    ws.send(JSON.stringify({ type: 'abort', ...(abortSp ? { sessionPath: abortSp } : {}) }));
  }, [isStreaming]);

  // ── Key handler ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // @ 菜单导航
    if (atMenuOpen && atFilteredFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtSelected(i => (i + 1) % atFilteredFiles.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtSelected(i => (i - 1 + atFilteredFiles.length) % atFilteredFiles.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const file = atFilteredFiles[atSelected];
        if (file) handleAtSelect(file);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtMenuOpen(false);
        return;
      }
    }
    // 斜杠菜单导航
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelected(i => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected];
        if (cmd) {
          // plan 采用含内标签形式：与点击一致，直接 execute 以显示 tag bar
          if (cmd.name === 'plan') {
            cmd.execute();
          } else {
            setInputText('/' + cmd.name + ' ');
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      if (isStreaming && inputText.trim()) {
        if (sendQueueMode) handleQueueEnqueue();
        else handleSteer();
      } else {
        handleSend();
      }
    }
  }, [handleSend, handleSteer, handleQueueEnqueue, sendQueueMode, isStreaming, inputText, slashMenuOpen, filteredCommands, slashSelected, atMenuOpen, atFilteredFiles, atSelected, handleAtSelect]);

  return (
    <>
      <TodoDisplay
        todos={currentSessionPath ? sessionTodos : []}
        planFlowPhase={planFlowPhase}
        onCancelPlan={handleCancelPlan}
        onConfirmPlan={handleConfirmPlan}
        onClearTodos={currentSessionPath ? () => setSessionTodos([]) : undefined}
      />

      {slashMenuOpen && filteredCommands.length > 0 && (
        <SlashCommandMenu
          commands={filteredCommands}
          selected={slashSelected}
          busy={slashBusy}
          onSelect={(cmd) => cmd.execute()}
          onHover={(i) => setSlashSelected(i)}
        />
      )}

      {atMenuOpen && atFilteredFiles.length > 0 && (
        <AtMentionMenu
          files={atFilteredFiles}
          selected={atSelected}
          onSelect={handleAtSelect}
          onHover={(i) => setAtSelected(i)}
        />
      )}

      {slashBusy && (
        <div className="slash-busy-bar">
          <span className="slash-busy-dot" />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || '执行中...'}</span>
        </div>
      )}

      <div className="input-wrapper">
        <SessionFileChangesBar sessionPath={currentSessionPath ?? null} />
        {attachedFiles.length > 0 && (
          <AttachedFilesBar
            files={attachedFiles}
            onRemove={removeAttachedFile}
          />
        )}
        <div className="input-text-row">
          {planTagActive && (
            <span ref={planTagRef} className="plan-tag plan-tag-inline">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              <span className="plan-tag-label">{tSafe(t, 'slash.planTag', '/plan')}</span>
              <button type="button" className="plan-tag-remove" onClick={() => setPlanTagActive(false)} aria-label="remove">✕</button>
            </span>
          )}
          <div className="input-mirror-container">
          <MentionMirror text={inputText} mentionNames={mentionedNames} textIndent={planIndent} />
          <textarea
            ref={textareaRef}
            id="inputBox"
            className={'input-box' + (mentionedFiles.length > 0 ? ' has-mentions' : '')}
            placeholder={placeholder}
            rows={1}
            spellCheck={false}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => { isComposing.current = true; }}
            onCompositionEnd={() => { isComposing.current = false; }}
            style={planIndent > 0 ? { textIndent: `${planIndent}px` } : undefined}
          />
          </div>
        </div>

        <div className="input-bottom-bar">
          <div className="input-actions">
            <PlanModeButton enabled={planMode} onToggle={setPlanMode} />
            <CodingModeButton enabled={codingMode} onToggle={(v) => {
              setCodingMode(v);
              if (v) setPlanMode(true);
            }} />
            <MultimodalToggleButton
              enabled={multimodalToModel}
              onToggle={toggleMultimodalToModel}
            />
            <SendQueueModeToggleButton
              enabled={sendQueueMode}
              queuedCount={queuedSendCount}
              onToggle={toggleSendQueueMode}
            />
            {multimodalToModel && mediaAccept.length > 0 && (
              <>
                <input
                  ref={mediaFileInputRef}
                  type="file"
                  className="hana-hidden-file-input"
                  accept={mediaAccept}
                  multiple
                  onChange={handlePickMediaFiles}
                />
                <MediaAttachButton onClick={() => mediaFileInputRef.current?.click()} />
              </>
            )}
          </div>
          <div className="input-controls">
            {currentModelInfo?.reasoning !== false && (
              <ThinkingLevelButton
                level={thinkingLevel}
                onChange={setThinkingLevel}
                modelXhigh={currentModelInfo?.xhigh ?? false}
              />
            )}
            <ModelSelector models={models} />
            <SendButton
              isStreaming={isStreaming}
              sendQueueMode={sendQueueMode}
              hasInput={!!inputText.trim()}
              disabled={isStreaming ? false : !canSend}
              onSend={handleSend}
              onSteer={handleSteer}
              onQueue={handleQueueEnqueue}
              onStop={handleStop}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Attached Files（贴在输入框正上方，内联 base64 的图/视频显示缩略图）──

function AttachedFilesBar({ files, onRemove }: {
  files: AttachedFile[];
  onRemove: (index: number) => void;
}) {
  const { SVG_ICONS } = (window as any).HanaModules?.icons ?? {};

  return (
    <div className="attached-files attached-files--above-input" aria-label="attachments">
      {files.map((f, i) => {
        const mime = f.mimeType || '';
        const hasInline = !!(f.base64Data && mime);
        const isVid = mime.startsWith('video/') || isVideoFile(f.name);
        const isAud = mime.startsWith('audio/') || isAudioFile(f.name);
        const isImg = (mime.startsWith('image/') || isImageFile(f.name)) && !isVid && !isAud;
        const showPreview = hasInline && (isImg || isVid || isAud);
        const dataUrl = showPreview ? `data:${mime};base64,${f.base64Data}` : null;

        return (
          <div
            key={`${i}-${f.path}`}
            className={'file-tag' + (showPreview ? ' file-tag--preview' : ' file-tag--path')}
          >
            {showPreview && dataUrl && isImg && (
              <div className="file-tag-thumb-wrap">
                <img className="file-tag-thumb" src={dataUrl} alt="" />
              </div>
            )}
            {showPreview && dataUrl && isVid && (
              <div className="file-tag-thumb-wrap file-tag-thumb-wrap--video">
                <video className="file-tag-thumb" src={dataUrl} muted playsInline preload="metadata" />
                <span className="file-tag-video-badge">▶</span>
              </div>
            )}
            {showPreview && dataUrl && isAud && (
              <div className="file-tag-thumb-wrap file-tag-thumb-wrap--audio">
                <audio className="file-tag-thumb file-tag-thumb--audio" src={dataUrl} controls preload="metadata" />
              </div>
            )}
            <span className="file-tag-name">
              {!showPreview && (
                <span
                  className="file-tag-icon"
                  dangerouslySetInnerHTML={{ __html: f.isDirectory ? SVG_ICONS?.folder : SVG_ICONS?.clip }}
                />
              )}
              <span className="file-tag-label">{f.name}</span>
            </span>
            <button type="button" className="file-tag-remove" onClick={() => onRemove(i)} aria-label="Remove">✕</button>
          </div>
        );
      })}
    </div>
  );
}

// ── Plan Mode Button ──

function PlanModeButton({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  const { t } = useI18n();

  const handleClick = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/plan-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await res.json();
      onToggle(data.enabled);
    } catch (err) {
      console.error('[plan-mode] toggle failed:', err);
    }
  }, [enabled, onToggle]);

  const title = enabled
    ? tSafe(t, 'input.planModeTooltipOn', '已启动（点击关闭）')
    : tSafe(t, 'input.planModeTooltipOff', '未启动（点击开启）');

  return (
    <button
      className={'plan-mode-btn' + (enabled ? ' active' : '')}
      title={title}
      onClick={handleClick}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <span className="plan-mode-label">{t('input.planMode') || '操作电脑'}</span>
    </button>
  );
}

// ── Coding Mode Button ──

function CodingModeButton({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  const { t } = useI18n();

  const handleClick = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/coding-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await res.json();
      onToggle(data.enabled);
    } catch (err) {
      console.error('[coding-mode] toggle failed:', err);
    }
  }, [enabled, onToggle]);

  const title = enabled
    ? tSafe(t, 'input.codingModeTooltipOn', 'Coding mode on — click to turn off')
    : tSafe(t, 'input.codingModeTooltipOff', 'Coding mode off — click to enable');

  return (
    <button
      className={'coding-mode-btn' + (enabled ? ' active' : '')}
      title={title}
      onClick={handleClick}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
      <span className="coding-mode-label">{t('input.codingMode') || 'Coding'}</span>
    </button>
  );
}

// ── 多模态（图片/视频/语音发给模型）──

function MultimodalToggleButton({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();

  const title = enabled
    ? tSafe(t, 'input.multimodalTooltipOn', '已启动（点击关闭）')
    : tSafe(t, 'input.multimodalTooltipOff', '未启动（点击开启）');

  return (
    <button
      type="button"
      className={'multimodal-toggle-btn' + (enabled ? ' active' : '')}
      title={title}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      <span className="multimodal-toggle-label">{tSafe(t, 'input.multimodal', '看图/视频/语音')}</span>
    </button>
  );
}

/** 流式时发送按钮为「排队」或「插话」，由本开关切换 */
function SendQueueModeToggleButton({ enabled, queuedCount, onToggle }: {
  enabled: boolean;
  queuedCount: number;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const title = enabled
    ? tSafe(t, 'input.sendQueueModeTooltipOn', '当前：助手回复结束后再发送（点击改为插话）')
    : tSafe(t, 'input.sendQueueModeTooltipOff', '当前：流式中发送为插话（点击改为排队）');

  return (
    <button
      type="button"
      className={'send-queue-mode-btn' + (enabled ? ' active' : '')}
      title={title}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h16M4 12h10M4 18h14" />
      </svg>
      <span className="send-queue-mode-label">{tSafe(t, 'input.sendQueueMode', '排队')}</span>
      {queuedCount > 0 && (
        <span className="send-queue-mode-badge" aria-label={tSafe(t, 'input.sendQueuedCount', '{n} 条待发', { n: queuedCount })}>
          {queuedCount}
        </span>
      )}
    </button>
  );
}

function MediaAttachButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className="media-attach-btn"
      title={tSafe(t, 'input.mediaPickerTitle', '添加图片/视频/语音（≤5 个，图≤10MB，视频/语音≤20MB）')}
      onClick={onClick}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
      </svg>
    </button>
  );
}

// ── Thinking Level Button ──

const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'auto', 'xhigh'];

function ThinkingLevelButton({ level, onChange, modelXhigh }: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  modelXhigh: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const availableLevels = useMemo(() => {
    return ALL_THINKING_LEVELS.filter(lv => lv !== 'xhigh' || modelXhigh);
  }, [modelXhigh]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const selectLevel = useCallback(async (next: ThinkingLevel) => {
    onChange(next);
    setOpen(false);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinking_level: next }),
      });
    } catch (err) {
      console.error('[thinking-level] save failed:', err);
    }
  }, [onChange]);

  const tLevel = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const isOff = level === 'off';

  return (
    <div className={'thinking-selector' + (open ? ' open' : '')} ref={ref}>
      <button
        className={`thinking-pill${isOff ? '' : ' active'}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" /><path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
          {isOff && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5" />}
        </svg>
      </button>
      {open && (
        <div className="thinking-dropdown">
          {availableLevels.map(lv => (
            <button
              key={lv}
              className={'thinking-option' + (lv === level ? ' active' : '')}
              onClick={() => selectLevel(lv)}
            >
              <span className="thinking-option-name">{tLevel(`input.thinkingLevel.${lv}`, lv)}</span>
              <span className="thinking-option-desc">{tLevel(`input.thinkingDesc.${lv}`, '')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Model Selector ──

function ModelSelector({ models }: { models: Array<{ id: string; name: string; isCurrent?: boolean }> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = models.find(m => m.isCurrent);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const switchModel = useCallback(async (modelId: string) => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      // Reload models
      const favRes = await hanaFetch('/api/models/favorites');
      const favData = await favRes.json();
      useStore.setState({
        models: favData.models || [],
        currentModel: favData.current,
      });
    } catch (err) {
      console.error('[model] switch failed:', err);
    }
    setOpen(false);
  }, []);

  return (
    <div className={'model-selector' + (open ? ' open' : '')} ref={ref}>
      <button className="model-pill" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span>{current?.name || t('model.unknown') || '...'}</span>
        <span className="model-arrow">▾</span>
      </button>
      {open && (
        <div className="model-dropdown">
          {models.map(m => (
            <button
              key={m.id}
              className={'model-option' + (m.isCurrent ? ' active' : '')}
              onClick={() => switchModel(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Slash Command Menu ──

function SlashCommandMenu({ commands, selected, busy, onSelect, onHover }: {
  commands: SlashCommand[];
  selected: number;
  busy: string | null;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="slash-menu">
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={'slash-menu-item' + (i === selected ? ' selected' : '') + (busy === cmd.name ? ' busy' : '')}
          onMouseEnter={() => onHover(i)}
          onClick={() => !busy && onSelect(cmd)}
          disabled={!!busy}
        >
          <span className="slash-menu-icon" dangerouslySetInnerHTML={{ __html: cmd.icon }} />
          <span className="slash-menu-label">{cmd.label}</span>
          <span className="slash-menu-desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

// ── Mention Mirror (overlay that renders @name as inline tags) ──

function MentionMirror({ text, mentionNames, textIndent }: { text: string; mentionNames: Set<string>; textIndent?: number }) {
  if (mentionNames.size === 0) return null;

  const parts: Array<{ key: string; text: string; isMention: boolean }> = [];
  const sortedNames = [...mentionNames].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`@(${sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let ki = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ key: `t${ki++}`, text: text.slice(lastIdx, match.index), isMention: false });
    }
    parts.push({ key: `m${ki++}`, text: match[0], isMention: true });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ key: `t${ki++}`, text: text.slice(lastIdx), isMention: false });
  }

  return (
    <div className="input-mirror" aria-hidden="true" style={textIndent ? { textIndent: `${textIndent}px` } : undefined}>
      {parts.map(p =>
        p.isMention
          ? <span key={p.key} className="mirror-mention">{p.text}</span>
          : <span key={p.key}>{p.text}</span>,
      )}
      {/* trailing space keeps height in sync with textarea */}
      <span>{' '}</span>
    </div>
  );
}

// ── @ Mention Menu ──

function AtMentionMenu({ files, selected, onSelect, onHover }: {
  files: Array<{ name: string; isDir: boolean }>;
  selected: number;
  onSelect: (file: { name: string; isDir: boolean }) => void;
  onHover: (i: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className="at-mention-menu" ref={listRef}>
      {files.map((f, i) => (
        <button
          key={f.name}
          className={'at-mention-item' + (i === selected ? ' selected' : '')}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(f); }}
        >
          <span className="at-mention-icon" dangerouslySetInnerHTML={{
            __html: f.isDir
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
          }} />
          <span className="at-mention-name">{f.name}</span>
        </button>
      ))}
    </div>
  );
}

// ── Send Button ──

function SendButton({ isStreaming, sendQueueMode, hasInput, disabled, onSend, onSteer, onQueue, onStop }: {
  isStreaming: boolean;
  sendQueueMode: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onSteer: () => void;
  onQueue: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 四态：发送 / 排队 / 插话 / 停止
  const mode = !isStreaming
    ? 'send'
    : hasInput
      ? (sendQueueMode ? 'queue' : 'steer')
      : 'stop';

  return (
    <button
      className={
        'send-btn'
        + (mode === 'steer' ? ' is-steer' : '')
        + (mode === 'queue' ? ' is-queue' : '')
        + (mode === 'stop' ? ' is-streaming' : '')
      }
      disabled={disabled}
      onClick={
        mode === 'queue' ? onQueue
        : mode === 'steer' ? onSteer
        : mode === 'stop' ? onStop
        : onSend
      }
    >
      {mode === 'send' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span className="send-label-text">{t('chat.send') || '发送'}</span>
        </span>
      )}
      {mode === 'queue' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h12M4 12h8M4 18h16" />
          </svg>
          <span className="send-label-text">{tSafe(t, 'chat.queueSend', '排队')}</span>
        </span>
      )}
      {mode === 'steer' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="send-label-text">{t('chat.steer') || '插话'}</span>
        </span>
      )}
      {mode === 'stop' && (
        <span className="send-label">
          <svg className="stop-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span className="send-label-text">{t('chat.stop') || '停止'}</span>
        </span>
      )}
    </button>
  );
}
