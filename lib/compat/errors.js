/**
 * compat/errors.js — 兼容性检查中的致命错误（需中止启动）
 */
export class FatalCompatError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: Error }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "FatalCompatError";
    if (opts.cause) this.cause = opts.cause;
  }
}
