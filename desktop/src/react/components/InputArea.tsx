/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 替代 app-input-shim.ts + app-ui-shim.ts 中的模型/PlanMode/Todo 逻辑。
 * 通过 portal 渲染到 index.html 的 #inputAreaPortal。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../stores';
import {
  countMediaAttachments,
  guessMediaMimeType,
  isAudioFile,
  isImageFile,
  isMediaAttachment,
  isVideoFile,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MEDIA_ATTACHMENTS,
  MAX_VIDEO_BYTES,
  MAX_WS_MESSAGE_BYTES,
} from '../utils/format';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { buildMediaAcceptAttr, isMimeAllowedForModelInput } from '../utils/model-media';
import { mediaKindsFromPayloadImages } from '../../../../lib/media-reject-heuristic.js';
import type { ThinkingLevel } from '../stores/model-slice';
import type { AttachedFile } from '../stores/input-slice';
import { showHanaToast } from '../utils/hana-toast';

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

interface SlashCommand {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  execute: () => Promise<void>;
}

// ── 主组件 ──

export function InputArea() {
  const portalEl = document.getElementById('inputAreaPortal');
  if (!portalEl) {
    console.warn('[InputArea] portal target #inputAreaPortal not found');
    return null;
  }
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

/** base64 字符串解码后的近似字节数（用于发送前体积校验） */
function approxDecodedBase64Bytes(b64: string): number {
  if (!b64) return 0;
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function maxBytesForMediaMime(mimeType: string): number {
  if (mimeType.startsWith('video/')) return MAX_VIDEO_BYTES;
  if (mimeType.startsWith('audio/')) return MAX_AUDIO_BYTES;
  return MAX_IMAGE_BYTES;
}

/** 与 server chat 路由一致：去掉 ;codecs=… 等参数，避免白名单校验失败 */
function normalizeMimeForSend(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (base === 'image/jpg') return 'image/jpeg';
  if (base === 'video/x-quicktime') return 'video/quicktime';
  return base;
}

/** 粘贴/选择器生成的假路径，不写进会话历史（重载后无法读盘） */
function isEphemeralAttachmentPath(p: string): boolean {
  const base = p.replace(/\\/g, '/').split('/').pop() || p;
  return base.startsWith('picked-') || base.startsWith('clipboard-');
}

/** 可写入会话文本的绝对路径：历史里用 `[附件]` 回显，文件删除则聊天区不展示该卡片 */
function isPersistableLocalPathForHistory(p: string): boolean {
  if (!p || typeof p !== 'string' || isEphemeralAttachmentPath(p)) return false;
  if (p.startsWith('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 媒体发送排查日志：
 * - Vite 开发：`import.meta.env.DEV`
 * - 任意环境：`localStorage.setItem('hana-debug-media','1')` 后刷新
 */
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

function shouldLogMediaDebug(): boolean {
  try {
    const viteDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
    if (viteDev) return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('hana-debug-media') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

function InputAreaInner() {
  const { t } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const sessionTodos = useStore(s => s.sessionTodos);
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
  const artifacts = useStore(s => s.artifacts);
  const currentArtifactId = useStore(s => s.currentArtifactId);
  const previewOpen = useStore(s => s.previewOpen);
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
  const [planMode, setPlanMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atSelected, setAtSelected] = useState(0);
  const [atQuery, setAtQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const [mentionedFiles, setMentionedFiles] = useState<Array<{ name: string; path: string }>>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const isComposing = useRef(false);

  /** 默认关闭：需用户按下开关后 localStorage 写 '1' 才启用多模态 */
  const [multimodalToModel, setMultimodalToModel] = useState(() => {
    try {
      return localStorage.getItem(MULTIMODAL_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const toggleDocContext = useStore(s => s.toggleDocContext);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);

  // Doc context: current open artifact with filePath
  const currentDoc = useMemo(() => {
    if (!previewOpen || !currentArtifactId) return null;
    const art = artifacts.find(a => a.id === currentArtifactId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, currentArtifactId, artifacts]);
  const hasDoc = !!currentDoc;

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
    const state = (window as any).__hanaState;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    if (useStore.getState().isStreaming) return false;

    if (pendingNewSession) {
      const _sb = () => (window as any).HanaModules.sidebar;
      const ok = await _sb().ensureSession();
      if (!ok) return false;
      _sb().loadSessions();
    }

    const _cr = () => (window as any).HanaModules.chatRender;
    _cr().addUserMessage(displayText ?? text);
    state.ws.send(JSON.stringify({ type: 'prompt', text }));
    return true;
  }, [pendingNewSession]);

  // ── 斜杠命令 ──

  const executeDiary = useCallback(async () => {
    setSlashBusy('diary');
    setInputText('');
    setSlashMenuOpen(false);

    try {
      const res = await hanaFetch('/api/diary/write', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || data.error) {
        showHanaToast(tSafe(t, 'slash.diaryFailed', '日记写入失败'), 'error');
        return;
      }

      showHanaToast(tSafe(t, 'slash.diaryDone', '日记已保存'), 'success');
    } catch (err) {
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

  // 过滤匹配的命令
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
    if (value.startsWith('/') && value.length <= 20) {
      setSlashMenuOpen(true);
      setSlashSelected(0);
    } else {
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
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached;
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

  // ── Load plan mode + thinking level on mount ──
  useEffect(() => {
    hanaFetch('/api/plan-mode')
      .then(r => r.json())
      .then(d => setPlanMode(d.enabled ?? false))
      .catch(() => {});

    hanaFetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
      .catch(() => {});

    // Listen for WS plan_mode updates
    const handler = (e: Event) => {
      setPlanMode((e as CustomEvent).detail?.enabled ?? false);
    };
    window.addEventListener('hana-plan-mode', handler);
    return () => window.removeEventListener('hana-plan-mode', handler);
  }, []);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const text = inputText.trim();

    // 斜杠命令拦截
    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles && !docContextAttached) || !connected) return;
    if (isStreaming) return; // streaming 时由 handleSteer 处理
    if (sending) return;
    setSending(true);

    try {
      const state = window.__hanaState;
      if (pendingNewSession) {
        const _sb = () => window.HanaModules.sidebar;
        const ok = await _sb().ensureSession();
        if (!ok) return;
        _sb().loadSessions();
      }

      // 分离可发给模型的媒体 vs 路径类附件（是否被上游接受由 Pi / 模型 input 决定）
      const mediaFiles = hasFiles ? attachedFiles.filter(f => isMediaAttachment(f)) : [];
      const pathOnlyMedia = !multimodalToModel && hasFiles ? mediaFiles : [];
      const mediaForModel = multimodalToModel ? mediaFiles : [];
      const otherFiles = hasFiles ? attachedFiles.filter(f => !isMediaAttachment(f)) : [];

      let finalText = text;
      // @ mentions: replace @filename with full path inline
      for (const mf of mentionedFiles) {
        if (finalText.includes(`@${mf.name}`)) {
          finalText = finalText.split(`@${mf.name}`).join(mf.path);
        }
      }
      const pathParts: string[] = [
        ...otherFiles.map(f => (f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`)),
        ...pathOnlyMedia.map(f => `[附件] ${f.path}`),
      ];
      // 多模态 inline 发送时仍把「真实磁盘路径」追加进会话文本，便于历史里按路径回显；假路径不写
      if (multimodalToModel && mediaForModel.length > 0) {
        const seen = new Set(pathParts);
        for (const f of mediaForModel) {
          if (!isPersistableLocalPathForHistory(f.path)) continue;
          const line = `[附件] ${f.path}`;
          if (!seen.has(line)) {
            seen.add(line);
            pathParts.push(line);
          }
        }
      }
      if (pathParts.length > 0) {
        const fileBlock = pathParts.join('\n');
        finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
      }

      // Pi SDK 使用 ImageContent：视频/音频也用 type: 'image' + 对应 mime，由 provider 映射为 inlineData / data URL
      const readB64 = (window as any).platform?.readFileBase64 ?? (window as any).hana?.readFileBase64;
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      const extraPathFromCaps: string[] = [];
      if (multimodalToModel && mediaForModel.length > 0) {
        if (mediaForModel.length > MAX_MEDIA_ATTACHMENTS) {
          showHanaToast(tSafe(t, 'input.mediaTooMany', `最多 ${MAX_MEDIA_ATTACHMENTS} 个媒体附件`), 'error');
          return;
        }
        for (const img of mediaForModel) {
          try {
            let base64: string | null | undefined;
            let mimeType: string | undefined;
            if (img.base64Data && img.mimeType) {
              base64 = img.base64Data;
              mimeType = img.mimeType;
            } else if (readB64) {
              base64 = await readB64(img.path);
              mimeType = guessMediaMimeType(img.name) || undefined;
            }
            if (base64 && mimeType) {
              const mimeNorm = normalizeMimeForSend(mimeType);
              const maxBytes = maxBytesForMediaMime(mimeNorm);
              if (approxDecodedBase64Bytes(base64) > maxBytes) {
                const msg = mimeNorm.startsWith('video/')
                  ? tSafe(t, 'input.videoTooLarge', '单个视频不得超过 20MB')
                  : mimeNorm.startsWith('audio/')
                    ? tSafe(t, 'input.audioTooLarge', '单条语音不得超过 20MB')
                    : tSafe(t, 'input.imageTooLarge', '单张图片不得超过 10MB');
                showHanaToast(msg, 'error');
                return;
              }
              if (applyModelMediaCaps && !isMimeAllowedForModelInput(mimeNorm, currentModelInfo?.input)) {
                extraPathFromCaps.push(`[附件] ${img.name}`);
                continue;
              }
              images.push({ type: 'image', data: base64, mimeType: mimeNorm });
            } else {
              // 已开启多模态则必须走 inline 通道；勿静默降级为纯路径（否则模型只能 read_file）
              showHanaToast(
                tSafe(
                  t,
                  'input.mediaReadFailed',
                  '无法读取该媒体为 Base64，未发送。请检查文件是否存在，或关闭多模态开关改为仅发送路径。',
                ),
                'error',
              );
              return;
            }
          } catch {
            showHanaToast(
              tSafe(
                t,
                'input.mediaReadFailed',
                '读取附件失败，未发送。请重试或关闭多模态开关改为仅发送路径。',
              ),
              'error',
            );
            return;
          }
        }
      }
      if (extraPathFromCaps.length) {
        const block = extraPathFromCaps.join('\n');
        finalText = finalText ? `${finalText}\n\n${block}` : block;
      }

      if (shouldLogMediaDebug()) {
        const vids = attachedFiles.filter(f => isVideoFile(f.name));
        if (vids.length > 0) {
          console.log('[InputArea] video in tray → ws payload', {
            multimodalToModel,
            videoNames: vids.map(v => v.name),
            imagesInPayload: images.length,
            pathOnlyVideos: pathOnlyMedia.filter(f => isVideoFile(f.name)).map(f => f.name),
          });
        }
      }

      // 文档上下文：把当前打开的文档路径附加到消息里
      let docForRender: { path: string; name: string } | null = null;
      if (docContextAttached && currentDoc) {
        const docBlock = `[参考文档] ${currentDoc.path}`;
        finalText = finalText ? `${finalText}\n\n${docBlock}` : docBlock;
        docForRender = currentDoc;
      }

      const filesToRender = hasFiles ? [...attachedFiles] : null;
      const allFiles = filesToRender ? [...filesToRender] : [];
      if (docForRender) {
        allFiles.push({ path: docForRender.path, name: docForRender.name });
      }

      const wsMsg: Record<string, unknown> = { type: 'prompt', text: finalText };
      if (images.length > 0) wsMsg.images = images;

      let payloadStr: string;
      try {
        payloadStr = JSON.stringify(wsMsg);
      } catch {
        showHanaToast(tSafe(t, 'input.serializeFailed', '消息序列化失败，附件可能过大'), 'error');
        return;
      }
      if (payloadStr.length > MAX_WS_MESSAGE_BYTES) {
        showHanaToast(
          tSafe(
            t,
            'input.payloadTooLarge',
            '整包消息超过传输上限（多为视频/语音 Base64），请减少附件或关闭多模态仅发路径。',
          ),
          'error',
        );
        return;
      }

      if (shouldLogMediaDebug()) {
        console.log('[InputArea] ws.send prompt', {
          textLen: finalText.length,
          mediaSlots: images.length,
          mimes: images.map(i => i.mimeType),
          approxDecodedBytes: images.map(i => approxDecodedBase64Bytes(i.data)),
          jsonChars: payloadStr.length,
        });
      }

      const ws = state.ws as WebSocket | undefined;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        showHanaToast(tSafe(t, 'input.notConnected', '未连接服务器，无法发送'), 'error');
        return;
      }

      const outboundKinds = images.length
        ? mediaKindsFromPayloadImages(images.map(i => ({ mimeType: i.mimeType })))
        : [];
      const sp = useStore.getState().currentSessionPath;
      const mid = currentModelInfo?.id;
      if (sp && mid && outboundKinds.length) {
        const blocked = outboundKinds.filter(k =>
          useStore.getState().isSessionMediaKindRejected(sp, mid, k),
        );
        if (blocked.length) {
          showHanaToast(
            tSafe(t, 'error.sessionMediaKindCached', '本会话中该模型已确认不支持此类附件：{kinds}', {
              kinds: formatBlockedMediaKinds(blocked),
            }),
            'error',
          );
          return;
        }
      }
      useStore.getState().setLastOutboundMediaKinds(outboundKinds.length ? outboundKinds : null);

      try {
        ws.send(payloadStr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showHanaToast(tSafe(t, 'input.sendFailed', '发送失败：') + msg, 'error');
        return;
      }

      if (docContextAttached) {
        setDocContextAttached(false);
      }

      const _cr = () => window.HanaModules.chatRender;
      _cr().addUserMessage(text, allFiles.length > 0 ? allFiles : null, null);
      setInputText('');
      clearAttachedFiles();
      setMentionedFiles([]);
    } finally {
      setSending(false);
    }
  }, [inputText, attachedFiles, docContextAttached, connected, isStreaming, sending, pendingNewSession, currentDoc, clearAttachedFiles, setDocContextAttached, slashMenuOpen, filteredCommands, slashSelected, multimodalToModel, currentModelInfo?.id, currentModelInfo?.input, applyModelMediaCaps, mentionedFiles, t]);

  // ── Steer (插话) ──
  const handleSteer = useCallback(() => {
    const text = inputText.trim();
    if (!text || !isStreaming) return;
    const state = window.__hanaState;
    if (!state.ws) return;

    // 断开当前 assistant 消息组（不封存工具），让后续回复出现在 steer 消息下方
    window.HanaModules.chatRender.breakAssistantGroup();
    window.HanaModules.chatRender.addUserMessage(text, null, null);

    setInputText('');
    state.ws.send(JSON.stringify({ type: 'steer', text }));
  }, [inputText, isStreaming]);

  // ── Stop generation ──
  const handleStop = useCallback(() => {
    const state = window.__hanaState;
    if (!isStreaming || !state.ws) return;
    state.ws.send(JSON.stringify({ type: 'abort' }));
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
        if (cmd) setInputText('/' + cmd.name);
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
        handleSteer();
      } else {
        handleSend();
      }
    }
  }, [handleSend, handleSteer, isStreaming, inputText, slashMenuOpen, filteredCommands, slashSelected, atMenuOpen, atFilteredFiles, atSelected, handleAtSelect]);

  return (
    <>
      <TodoDisplay todos={sessionTodos} />

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
        {attachedFiles.length > 0 && (
          <AttachedFilesBar
            files={attachedFiles}
            onRemove={removeAttachedFile}
          />
        )}
        <div className="input-mirror-container">
          <MentionMirror text={inputText} mentionNames={mentionedNames} />
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
          />
        </div>

        <div className="input-bottom-bar">
          <div className="input-actions">
            <PlanModeButton enabled={planMode} onToggle={setPlanMode} />
            <DocContextButton
              active={docContextAttached}
              disabled={!hasDoc}
              onToggle={toggleDocContext}
            />
            <MultimodalToggleButton
              enabled={multimodalToModel}
              onToggle={toggleMultimodalToModel}
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
              hasInput={!!inputText.trim()}
              disabled={isStreaming ? false : !canSend}
              onSend={handleSend}
              onSteer={handleSteer}
              onStop={handleStop}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Todo Display ──

function TodoDisplay({ todos }: { todos: Array<{ text: string; done: boolean }> }) {
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter(td => td.done).length;

  return (
    <div className="input-top-bar">
      <div className={'todo-display has-todos' + (open ? ' open' : '')}>
        <button className="todo-trigger" onClick={() => setOpen(!open)}>
          <span className="todo-trigger-icon">☑</span>
          <span className="todo-trigger-label">To Do</span>
          <span className="todo-trigger-count">{done}/{todos.length}</span>
        </button>
        {open && (
          <div className="todo-list">
            {todos.map((td, i) => (
              <div key={i} className={'todo-item' + (td.done ? ' done' : '')}>
                <span className="todo-check">{td.done ? '✓' : '○'}</span> {td.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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

// ── Doc Context Button ──

function DocContextButton({ active, disabled, onToggle }: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      className={'desk-context-btn' + (active ? ' active' : '')}
      title={t('input.docContext') || '看着文档说'}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      <span className="desk-context-label">{t('input.docContext') || '看着文档说'}</span>
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
      const state = window.__hanaState;
      state.models = favData.models || [];
      state.currentModel = favData.current;
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

function MentionMirror({ text, mentionNames }: { text: string; mentionNames: Set<string> }) {
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
    <div className="input-mirror" aria-hidden="true">
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

function SendButton({ isStreaming, hasInput, disabled, onSend, onSteer, onStop }: {
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 三态：发送 / 插话 / 停止
  const mode = isStreaming ? (hasInput ? 'steer' : 'stop') : 'send';

  return (
    <button
      className={'send-btn' + (mode === 'steer' ? ' is-steer' : mode === 'stop' ? ' is-streaming' : '')}
      disabled={disabled}
      onClick={mode === 'steer' ? onSteer : mode === 'stop' ? onStop : onSend}
    >
      {mode === 'send' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span className="send-label-text">{t('chat.send') || '发送'}</span>
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
