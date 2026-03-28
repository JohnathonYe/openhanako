/**
 * session-path-context.js — 工具执行时的 session path 异步上下文
 *
 * 在 SessionCoordinator.prompt / promptSession 中注入，
 * 让工具回调（cron 确认、settings 确认等）能获取到正确的执行中 session path，
 * 而非依赖 currentSessionPath（焦点 session）。
 */

import { AsyncLocalStorage } from "async_hooks";

const sessionPathStorage = new AsyncLocalStorage();

/**
 * @param {string} sessionPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithSessionPath(sessionPath, fn) {
  return sessionPathStorage.run(sessionPath, fn);
}

/** @returns {string|null} */
export function getExecutingSessionPath() {
  return sessionPathStorage.getStore() ?? null;
}
