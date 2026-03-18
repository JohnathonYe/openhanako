/**
 * tool-debug-log.js — 工具调用本地 debug 日志
 *
 * 包装任意工具的 execute，在调用前后打日志（名称、参数摘要、耗时、结果/错误），
 * 便于排查工具调用问题。日志同时写入 console 与 ~/.hanako/logs。
 *
 * 输出位置说明：
 * - 工具在 Server 进程（Node）中执行，console 输出到该进程的 stdout。
 * - 使用 npm start 时，Server 由 Electron fork，stdout 会转发到启动时的终端，
 *   因此 [tools] 日志会出现在运行 npm start 的终端里，不会出现在浏览器 DevTools 控制台。
 * - 若从 Dock/桌面启动且无终端附着，可查看 ~/.hanako/logs/ 下当日日志文件。
 */

import { createModuleLogger } from "../debug-log.js";

const MAX_PARAMS_LOG = 600;
const MAX_RESULT_LOG = 400;

function truncate(obj, maxLen) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

/**
 * 包装单个工具的 execute，增加本地 debug 日志
 * @param {object} tool - 含 name、execute 的 ToolDefinition
 * @returns {object} 同结构，execute 为包装后的异步函数
 */
export function wrapToolWithDebugLog(tool) {
  if (!tool || typeof tool.execute !== "function") return tool;
  const log = createModuleLogger("tools");
  const name = tool.name || "unknown";

  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const start = Date.now();
      const paramsStr = truncate(params, MAX_PARAMS_LOG);
      log.log(`tool call start name=${name} id=${toolCallId || "-"} params=${paramsStr}`);

      try {
        const result = await originalExecute.call(tool, toolCallId, params, ...rest);
        const elapsed = Date.now() - start;
        const resultSummary = summarizeResult(result);
        log.log(`tool call ok name=${name} id=${toolCallId || "-"} elapsed=${elapsed}ms ${resultSummary}`);
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        const msg = err?.message ?? String(err);
        log.error(`tool call error name=${name} id=${toolCallId || "-"} elapsed=${elapsed}ms ${truncate(msg, MAX_RESULT_LOG)}`);
        throw err;
      }
    },
  };
}

function summarizeResult(result) {
  if (!result) return "result=null";
  const content = result.content;
  if (!Array.isArray(content)) return "content=non-array";
  const textBlock = content.find((c) => c?.type === "text");
  const text = textBlock?.text;
  if (text == null) return "content.length=" + content.length;
  const len = typeof text === "string" ? text.length : 0;
  const preview = truncate(text, 120);
  return `textLen=${len} preview=${preview}`;
}
