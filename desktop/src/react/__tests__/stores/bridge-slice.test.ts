import { describe, it, expect, beforeEach } from 'vitest';
import { createBridgeSlice, type BridgeSlice } from '../../stores/bridge-slice';

function makeSlice(): BridgeSlice {
  let state: BridgeSlice;
  const set = (partial: Partial<BridgeSlice> | ((s: BridgeSlice) => Partial<BridgeSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createBridgeSlice(set);
  return new Proxy({} as BridgeSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('bridge-slice', () => {
  let slice: BridgeSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态', () => {
    expect(slice.bridgeLatestMessage).toBeNull();
    expect(slice.bridgeStatusTrigger).toBe(0);
  });

  it('addBridgeMessage 设置最新消息', () => {
    const msg = { sessionKey: 'tg_123', direction: 'in', text: 'hello' };
    slice.addBridgeMessage(msg);
    expect(slice.bridgeLatestMessage).toEqual(msg);
  });

  it('addBridgeMessage 连续调用覆盖前一条', () => {
    slice.addBridgeMessage({ sessionKey: 'a', direction: 'in', text: '1' });
    slice.addBridgeMessage({ sessionKey: 'b', direction: 'out', text: '2' });
    expect(slice.bridgeLatestMessage?.sessionKey).toBe('b');
    expect(slice.bridgeLatestMessage?.text).toBe('2');
  });

  it('triggerBridgeReload 递增计数器', () => {
    slice.triggerBridgeReload();
    expect(slice.bridgeStatusTrigger).toBe(1);
    slice.triggerBridgeReload();
    expect(slice.bridgeStatusTrigger).toBe(2);
  });

  it('addBridgeMessage 和 triggerBridgeReload 互不干扰', () => {
    slice.addBridgeMessage({ sessionKey: 'x', direction: 'in', text: 'msg' });
    slice.triggerBridgeReload();
    expect(slice.bridgeLatestMessage?.text).toBe('msg');
    expect(slice.bridgeStatusTrigger).toBe(1);
  });
});
