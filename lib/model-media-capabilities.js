/**
 * 模型多模态能力与 MIME 校验（与 Pi model.input 对齐）
 *
 * model.input 约定：
 * - "text" — 文本（必有）
 * - "image" — 可发图片（含走 image_url 的图）
 * - "video" — 可发视频（data:video/* 经 image_url）
 * - "audio" — 可发音频
 *
 * 未声明的能力：前端禁止附加；WS 校验拒绝；Pi 转换层剔除历史中的对应块。
 */

/**
 * @param {unknown} input
 * @returns {{ allowImage: boolean; allowVideo: boolean; allowAudio: boolean }}
 */
export function mediaCapsFromModelInput(input) {
  const arr = Array.isArray(input) ? input : ["text"];
  return {
    allowImage: arr.includes("image"),
    allowVideo: arr.includes("video"),
    allowAudio: arr.includes("audio"),
  };
}

/**
 * @param {string} mime 已规范化主类型，如 image/png
 * @returns {"image"|"video"|"audio"|null}
 */
export function mimeMediaKind(mime) {
  if (!mime || typeof mime !== "string") return null;
  const m = mime.split(";")[0].trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return null;
}

/**
 * @param {string} mime
 * @param {string[]|undefined} modelInput
 */
export function isMimeAllowedForModelInput(mime, modelInput) {
  const caps = mediaCapsFromModelInput(modelInput);
  const kind = mimeMediaKind(mime);
  if (kind === "image") return caps.allowImage;
  if (kind === "video") return caps.allowVideo;
  if (kind === "audio") return caps.allowAudio;
  return false;
}

/**
 * WS / prompt 入口：按 models.json 声明的 model.input 保留可下发的媒体块
 * @param {Array<{ mimeType?: string }>|undefined|null} images
 * @param {unknown} modelInput
 * @returns {Array<{ mimeType?: string }>|undefined}
 */
export function filterImagesForModelInput(images, modelInput) {
  if (!images?.length) return undefined;
  const input = Array.isArray(modelInput) ? modelInput : undefined;
  const out = images.filter((im) => isMimeAllowedForModelInput(im?.mimeType || "", input));
  return out.length ? out : undefined;
}
