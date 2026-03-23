/**
 * 判断上游错误是否像「多模态/媒体类型不被接受」（用于会话级学习缓存）
 * 保守排除：鉴权、额度、网络、超时等
 * @param {unknown} message
 */
export function looksLikeProviderRejectedMultimodal(message) {
  const m = String(message || "").toLowerCase();
  if (!m || m.length > 8000) return false;
  if (
    /rate\s*limit|too many requests|timeout|econnreset|econnrefused|socket hang up|network|401|403|unauthorized|forbidden|billing|quota|exceeded|invalid\s*api|api\s*key|insufficient\s*funds|payment required/i.test(
      m,
    )
  ) {
    return false;
  }
  return /audio|video|image|multimodal|vision|inline_data|inline data|image_url|file must be|must be of type|unsupported|not support|does not support|cannot (accept|process|handle)|invalid[^\n]{0,48}(content|message|request|parameter|type)|\b400\b|bad request|mime|media type|content[- ]type|no (video|audio|image)|expected one of/i.test(
    m,
  );
}

/**
 * @param {Array<{ mimeType?: string }>|undefined} images
 * @returns {("image"|"video"|"audio")[]}
 */
export function mediaKindsFromPayloadImages(images) {
  const set = new Set();
  for (const im of images || []) {
    const mt = String(im?.mimeType || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (mt.startsWith("image/")) set.add("image");
    else if (mt.startsWith("video/")) set.add("video");
    else if (mt.startsWith("audio/")) set.add("audio");
  }
  return [...set];
}
