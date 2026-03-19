/**
 * 媒体附件 UI（accept 等）与 lib/model-media-capabilities 工具函数
 *
 * 不在此按 provider 猜测模型能力；真实能力以 models.json / Pi 为准，
 * 附件是否进对话由用户开关与 Pi 转换层处理。需要路径+工具处理媒体时见技能 media-local-tools。
 */
import {
  isMimeAllowedForModelInput,
  mediaCapsFromModelInput,
  mimeMediaKind,
} from '../../../../lib/model-media-capabilities.js';

export { isMimeAllowedForModelInput, mediaCapsFromModelInput, mimeMediaKind };

/** 输入区文件选择器：始终允许常见图/视频/音频（与 format.ts 白名单一致） */
export const UI_FULL_MODEL_INPUT = ['text', 'image', 'video', 'audio'] as const;

export function defaultAttachmentAcceptAttr(): string {
  return buildMediaAcceptAttr([...UI_FULL_MODEL_INPUT]);
}

/** 文件选择器 accept：按声明的 model.input 子集生成；未传则用全套常见媒体 */
export function buildMediaAcceptAttr(modelInput: string[] | undefined): string {
  const caps = mediaCapsFromModelInput(
    modelInput?.length ? modelInput : [...UI_FULL_MODEL_INPUT],
  );
  const parts: string[] = [];
  if (caps.allowImage) {
    parts.push('image/*', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico');
  }
  if (caps.allowVideo) {
    parts.push('video/*', 'video/mp4', 'video/webm', 'video/quicktime', '.mp4', '.webm', '.mov');
  }
  if (caps.allowAudio) {
    parts.push('audio/*', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac');
  }
  return parts.join(',');
}
