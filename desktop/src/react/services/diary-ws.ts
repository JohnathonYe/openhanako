/**
 * 日记 WebSocket 一次性等待（避免 HTTP 超时；完成态由 WS 推送）
 */

type DiaryWaitResult = { ok: true } | { ok: false; error: string };

let _resolver: ((v: DiaryWaitResult) => void) | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;

/** 在发送 { type: 'diary_write' } 之前调用，完成后由 ws-message-handler 触发 dispatchDiaryWsResult */
export function waitDiaryWsOnce(timeoutMs = 900_000): Promise<DiaryWaitResult> {
  return new Promise((resolve) => {
    if (_resolver) {
      resolve({ ok: false, error: 'diary_wait_overlap' });
      return;
    }
    _resolver = resolve;
    _timer = setTimeout(() => {
      _timer = null;
      if (_resolver) {
        const r = _resolver;
        _resolver = null;
        r({ ok: false, error: 'timeout' });
      }
    }, timeoutMs);
  });
}

export function dispatchDiaryWsResult(msg: {
  type: 'diary_done' | 'diary_error';
  message?: string;
}): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  if (!_resolver) return;
  const r = _resolver;
  _resolver = null;
  if (msg.type === 'diary_done') r({ ok: true });
  else r({ ok: false, error: msg.message || 'diary_error' });
}
