import { describe, expect, it } from 'vitest';
import {
  looksLikeProviderRejectedMultimodal,
  mediaKindsFromPayloadImages,
} from '../lib/media-reject-heuristic.js';

describe('looksLikeProviderRejectedMultimodal', () => {
  it('returns true for typical multimodal rejection phrases', () => {
    expect(looksLikeProviderRejectedMultimodal('Model does not support video input')).toBe(true);
    expect(looksLikeProviderRejectedMultimodal('Unsupported image mime type')).toBe(true);
    expect(looksLikeProviderRejectedMultimodal('Invalid message content: expected one of text')).toBe(true);
  });

  it('returns false for auth, quota, network, rate limit', () => {
    expect(looksLikeProviderRejectedMultimodal('401 unauthorized')).toBe(false);
    expect(looksLikeProviderRejectedMultimodal('Rate limit exceeded')).toBe(false);
    expect(looksLikeProviderRejectedMultimodal('ECONNRESET')).toBe(false);
    expect(looksLikeProviderRejectedMultimodal('Billing quota exceeded')).toBe(false);
  });

  it('returns false for empty', () => {
    expect(looksLikeProviderRejectedMultimodal('')).toBe(false);
    expect(looksLikeProviderRejectedMultimodal(null)).toBe(false);
  });
});

describe('mediaKindsFromPayloadImages', () => {
  it('dedupes kinds from mimeType', () => {
    expect(
      mediaKindsFromPayloadImages([
        { mimeType: 'image/png' },
        { mimeType: 'IMAGE/JPEG; charset=utf-8' },
        { mimeType: 'video/mp4' },
        { mimeType: 'audio/wav' },
      ]),
    ).toEqual(expect.arrayContaining(['image', 'video', 'audio']));
    expect(mediaKindsFromPayloadImages([{ mimeType: 'image/png' }, { mimeType: 'image/gif' }])).toEqual([
      'image',
    ]);
  });

  it('returns empty for missing', () => {
    expect(mediaKindsFromPayloadImages(undefined)).toEqual([]);
    expect(mediaKindsFromPayloadImages([{}])).toEqual([]);
  });
});
