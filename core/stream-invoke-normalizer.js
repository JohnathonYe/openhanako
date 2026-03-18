/**
 * Stream Invoke Normalizer — 在流结束时将 XML <invoke> 转为 toolCall，使同轮工具执行生效
 *
 * 当模型（如 Minimax）在流式输出中返回 XML 而非原生 tool_call 时，Pi 不会执行工具。
 * 包装 streamFn 返回的流，在 result() 中归一化最终 message.content，将 tool_use 转为
 * pi-ai 所需的 toolCall（含 id、arguments），同轮即可执行。
 */
import { normalizeToolCallContent } from "./llm-utils.js";

/** 将归一化后的 content 块转为 pi-ai 的 toolCall 块（含 id、arguments） */
function contentToPiToolCalls(content) {
  if (!Array.isArray(content)) return content;
  const out = [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      out.push({
        type: "toolCall",
        id: crypto.randomUUID?.() ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: block.name,
        arguments: block.input ?? block.arguments ?? {},
      });
    } else if (block.type === "toolCall" && block.id) {
      out.push(block);
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
 * 若 message 为 assistant 且 content 含文本，归一化 content 并将 tool_use 转为 toolCall
 * @param {object} message - 流结束时的 assistant message
 * @returns {object} 归一化后的 message（可能为同一引用）
 */
function normalizeAssistantMessage(message) {
  if (!message || message.role !== "assistant" || !message.content) return message;
  const normalized = normalizeToolCallContent(message.content);
  const hasNewToolCalls = normalized.some(b => b.type === "tool_use" || b.type === "toolCall");
  if (!hasNewToolCalls) return message;
  return {
    ...message,
    content: contentToPiToolCalls(normalized),
  };
}

/**
 * 包装 streamFn，使返回的流在 result() 时返回归一化后的 assistant message（XML invoke → toolCall）
 * @param {(model, context, options) => AsyncIterable} streamFn - 原始 streamFn（如 streamSimple）
 * @returns {(model, context, options) => AsyncIterable & { result(): Promise<object> }}
 */
export function wrapStreamFnForInvokeXml(streamFn) {
  return function wrappedStreamFn(model, context, options) {
    const inner = streamFn(model, context, options);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of inner) {
          if (event.type === "done" && event.message) {
            yield { ...event, message: normalizeAssistantMessage(event.message) };
          } else {
            yield event;
          }
        }
      },
      result() {
        return inner.result().then(normalizeAssistantMessage);
      },
    };
  };
}
