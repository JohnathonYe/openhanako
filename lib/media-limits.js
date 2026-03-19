/**
 * 聊天附件 / 多模态体积上限（与前端 desktop/src/react/utils/format.ts、Electron read-file-base64 对齐）
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单视频：预览 IPC、上传、WS 校验均不超过此值 */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
/** 单条语音/音频（与视频同量级，便于 WS 与 IPC 一致） */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_MEDIA_ATTACHMENTS = 5;

/**
 * WebSocket 单帧最大字节（ws `maxPayload`）。
 * 5×20MB 视频经 Base64 后约 130MB+ JSON，100MB 默认会丢包导致「气泡有、模型无反应」。
 */
export const MAX_WS_MESSAGE_BYTES = 200 * 1024 * 1024;

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
/** 常见语音/音频（.webm 归为视频容器，语音多用 m4a/mp3） */
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);

export function isVideoFilename(name) {
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase();
  const m = lower.match(/(\.\w+)$/);
  return m ? VIDEO_EXT.has(m[1]) : false;
}

export function isAudioFilename(name) {
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase();
  const m = lower.match(/(\.\w+)$/);
  return m ? AUDIO_EXT.has(m[1]) : false;
}
