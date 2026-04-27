/**
 * 从 InputArea 抽离的 prompt 发送逻辑，供即时发送与「流式结束后队列发送」共用。
 */
import { useStore } from '../../stores';
import { ensureSession } from '../../stores/session-actions';
import { getWebSocket } from '../../services/websocket';
import { renderMarkdown } from '../../utils/markdown';
import type { ChatMessage, UserAttachment } from '../../stores/chat-types';
import {
  isMediaAttachment,
  guessMediaMimeType,
  isVideoFile,
  MAX_MEDIA_ATTACHMENTS,
  MAX_WS_MESSAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
} from '../../utils/format';
import { isMimeAllowedForModelInput } from '../../utils/model-media';
import { mediaKindsFromPayloadImages } from '../../../../../lib/media-reject-heuristic.js';
import { showHanaToast } from '../../utils/hana-toast';
import type { AttachedFile } from '../../stores/input-slice';

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

function normalizeMimeForSend(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (base === 'image/jpg') return 'image/jpeg';
  if (base === 'video/x-quicktime') return 'video/quicktime';
  return base;
}

function isEphemeralAttachmentPath(p: string): boolean {
  const base = p.replace(/\\/g, '/').split('/').pop() || p;
  return base.startsWith('picked-') || base.startsWith('clipboard-');
}

function isPersistableLocalPathForHistory(p: string): boolean {
  if (!p || typeof p !== 'string' || isEphemeralAttachmentPath(p)) return false;
  if (p.startsWith('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

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

function shouldLogMediaDebug(): boolean {
  try {
    const viteDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
    if (viteDev) return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('hana-debug-media') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

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

function attachedFilesToUserAttachments(files: AttachedFile[] | null | undefined): UserAttachment[] | undefined {
  if (!files?.length) return undefined;
  return files.map(f => ({
    path: f.path,
    name: f.name,
    isDir: !!f.isDirectory,
    base64Data: f.base64Data,
    mimeType: f.mimeType,
  }));
}

export function appendOptimisticUserMessage(displayText: string, files: AttachedFile[] | null | undefined) {
  const path = useStore.getState().currentSessionPath;
  if (!path) return;
  const id = `local-${Date.now()}`;
  const msg: ChatMessage = {
    id,
    role: 'user',
    text: displayText,
    textHtml: displayText ? renderMarkdown(displayText) : undefined,
    attachments: attachedFilesToUserAttachments(files),
  };
  useStore.getState().appendItem(path, { type: 'message', data: msg });
}

export type ExecutePromptSendParams = {
  displayText: string;
  mentionedFiles: Array<{ name: string; path: string }>;
  attachedFiles: AttachedFile[];
  planTagActive: boolean;
  multimodalToModel: boolean;
  pendingNewSession: boolean;
  t: (k: string, v?: Record<string, string | number>) => string;
};

export async function executePromptSend(params: ExecutePromptSendParams): Promise<boolean> {
  const {
    displayText: text,
    mentionedFiles,
    attachedFiles,
    planTagActive: isPlanSlash,
    multimodalToModel,
    pendingNewSession,
    t,
  } = params;

  if (pendingNewSession) {
    const ok = await ensureSession();
    if (!ok) return false;
  }

  const models = useStore.getState().models;
  const currentModelInfo = models.find(m => m.isCurrent);
  const applyModelMediaCaps = Boolean(currentModelInfo?.id);

  const hasFiles = attachedFiles.length > 0;
  const mediaFiles = hasFiles ? attachedFiles.filter(f => isMediaAttachment(f)) : [];
  const pathOnlyMedia = !multimodalToModel && hasFiles ? mediaFiles : [];
  const mediaForModel = multimodalToModel ? mediaFiles : [];
  const otherFiles = hasFiles ? attachedFiles.filter(f => !isMediaAttachment(f)) : [];

  let finalText = text;
  for (const mf of mentionedFiles) {
    if (finalText.includes(`@${mf.name}`)) {
      finalText = finalText.split(`@${mf.name}`).join(mf.path);
    }
  }
  const pathParts: string[] = [
    ...otherFiles.map(f => (f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`)),
    ...pathOnlyMedia.map(f => `[附件] ${f.path}`),
  ];
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
    finalText = finalText ? `${finalText}\n\n${fileBlock}` : fileBlock;
  }

  const readB64 = (window as any).platform?.readFileBase64 ?? (window as any).hana?.readFileBase64;
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  const extraPathFromCaps: string[] = [];
  if (multimodalToModel && mediaForModel.length > 0) {
    if (mediaForModel.length > MAX_MEDIA_ATTACHMENTS) {
      showHanaToast(tSafe(t, 'input.mediaTooMany', `最多 ${MAX_MEDIA_ATTACHMENTS} 个媒体附件`), 'error');
      return false;
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
            return false;
          }
          if (applyModelMediaCaps && !isMimeAllowedForModelInput(mimeNorm, currentModelInfo?.input)) {
            extraPathFromCaps.push(`[附件] ${img.name}`);
            continue;
          }
          images.push({ type: 'image', data: base64, mimeType: mimeNorm });
        } else {
          showHanaToast(
            tSafe(
              t,
              'input.mediaReadFailed',
              '无法读取该媒体为 Base64，未发送。请检查文件是否存在，或关闭多模态开关改为仅发送路径。',
            ),
            'error',
          );
          return false;
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
        return false;
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

  const filesToRender = hasFiles ? [...attachedFiles] : null;

  const wsMsg: Record<string, unknown> = { type: 'prompt', text: finalText };
  const _sp = useStore.getState().currentSessionPath;
  if (_sp) wsMsg.sessionPath = _sp;
  if (images.length > 0) wsMsg.images = images;
  if (isPlanSlash) {
    wsMsg.planDraft = true;
    useStore.getState().setPlanFlowPhase('draft_sent');
  }

  let payloadStr: string;
  try {
    payloadStr = JSON.stringify(wsMsg);
  } catch {
    showHanaToast(tSafe(t, 'input.serializeFailed', '消息序列化失败，附件可能过大'), 'error');
    return false;
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
    return false;
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

  const ws = getWebSocket();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showHanaToast(tSafe(t, 'input.notConnected', '未连接服务器，无法发送'), 'error');
    return false;
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
      return false;
    }
  }
  useStore.getState().setLastOutboundMediaKinds(outboundKinds.length ? outboundKinds : null);

  try {
    ws.send(payloadStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showHanaToast(tSafe(t, 'input.sendFailed', '发送失败：') + msg, 'error');
    return false;
  }

  appendOptimisticUserMessage(text, filesToRender && filesToRender.length > 0 ? filesToRender : null);
  return true;
}
