import { describe, expect, it } from 'vitest';
import {
  clearSessionMediaRejectCache,
  isSessionMediaKindRejected,
  recordSessionMediaKindsRejected,
} from '../lib/session-media-reject-cache.js';

describe('session-media-reject-cache', () => {
  it('records and queries by session + model', () => {
    const sp = '/session/a';
    clearSessionMediaRejectCache(sp);
    expect(isSessionMediaKindRejected(sp, 'm1', 'image')).toBe(false);
    recordSessionMediaKindsRejected(sp, 'm1', ['image', 'video']);
    expect(isSessionMediaKindRejected(sp, 'm1', 'image')).toBe(true);
    expect(isSessionMediaKindRejected(sp, 'm1', 'audio')).toBe(false);
    expect(isSessionMediaKindRejected(sp, 'm2', 'image')).toBe(false);
  });

  it('ignores empty session or model', () => {
    recordSessionMediaKindsRejected('', 'm1', ['image']);
    expect(isSessionMediaKindRejected('', 'm1', 'image')).toBe(false);
    recordSessionMediaKindsRejected('/x', '', ['image']);
    expect(isSessionMediaKindRejected('/x', '', 'image')).toBe(false);
  });
});
