export function looksLikeProviderRejectedMultimodal(message: unknown): boolean;

export function mediaKindsFromPayloadImages(
  images: Array<{ mimeType?: string }> | undefined,
): ("image" | "video" | "audio")[];
