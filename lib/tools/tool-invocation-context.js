/**
 * tool-invocation-context.js — Custom 工具调用时的异步上下文（频道 / 临时会话等）
 *
 * 由 hub/agent-executor 的 runAgentSession 注入，供需要区分场景的工具读取。
 */

import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage();

/**
 * @typedef {object} ToolInvocationContext
 * @property {boolean} [ephemeral] - 来自 runAgentSession 的临时会话（默认 true）
 * @property {string} [channelName] - 当前频道 id（文件名不含 .md）
 */

/**
 * @param {ToolInvocationContext} ctx
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithToolInvocationContext(ctx, fn) {
  return storage.run(ctx, fn);
}

/** @returns {ToolInvocationContext|null} */
export function getToolInvocationContext() {
  return storage.getStore() ?? null;
}
