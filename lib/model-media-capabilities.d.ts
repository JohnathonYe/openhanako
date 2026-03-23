export function mediaCapsFromModelInput(input: unknown): {
  allowImage: boolean;
  allowVideo: boolean;
  allowAudio: boolean;
};

export function mimeMediaKind(mime: string): "image" | "video" | "audio" | null;

export function isMimeAllowedForModelInput(
  mime: string,
  modelInput: string[] | undefined,
): boolean;

export function filterImagesForModelInput(
  images: Array<{ mimeType?: string }> | undefined | null,
  modelInput: unknown,
): Array<{ mimeType?: string }> | undefined;
