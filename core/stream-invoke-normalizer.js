/**
 * Stream Invoke Normalizer — 在流结束时将 XML <invoke> 转为 toolCall，使同轮工具执行生效
 *
 * 当模型（如 Minimax）在流式输出中返回 XML 而非原生 tool_call 时，Pi 不会执行工具。
 * 包装 streamFn 返回的流，在 result() 中归一化最终 message.content，将 tool_use 转为
 * pi-ai 所需的 toolCall（含 id、arguments），同轮即可执行。
 *
 * 调试实际发往 LLM 的请求体（openai-completions 路径）：
 *   HANA_DEBUG_LLM_PAYLOAD=1 npm start
 * 终端会打印每条 message 的 content 结构摘要（data: URL 只显示 mime 与 base64 长度，不打印正文）。
 */
import { normalizeToolCallContent } from "./llm-utils.js";

/**
 * 摘要 OpenAI Chat Completions 请求里的 messages（Pi convertMessages 之后）
 * @param {object} model
 * @param {object} params - chat.completions.create 参数
 */
function summarizeOpenAiPayload(model, params) {
  const head = `[llm-payload] ${model?.provider}/${model?.id} api=${model?.api} model.input=${JSON.stringify(model?.input)}`;
  const msgs = params?.messages;
  if (!Array.isArray(msgs)) {
    console.log(`${head}\n[llm-payload] messages: (missing)`);
    return;
  }
  const lines = [head];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const role = m?.role ?? "?";
    const c = m?.content;
    if (typeof c === "string") {
      lines.push(`[llm-payload] #${i} ${role} text len=${c.length}`);
      continue;
    }
    if (!Array.isArray(c)) {
      lines.push(`[llm-payload] #${i} ${role} content type=${typeof c}`);
      continue;
    }
    const parts = c.map((p) => {
      if (!p || typeof p !== "object") return p;
      if (p.type === "text") return { type: "text", textLen: (p.text || "").length };
      if (p.type === "image_url") {
        const url = p.image_url?.url || "";
        const mimeMatch = url.match(/^data:([^;,]+)/);
        const mime = mimeMatch ? mimeMatch[1] : "url";
        const idx = url.indexOf("base64,");
        const b64len = idx >= 0 ? url.length - (idx + "base64,".length) : 0;
        return { type: "image_url", mime, base64Chars: b64len };
      }
      return { type: p.type };
    });
    lines.push(`[llm-payload] #${i} ${role} parts=${JSON.stringify(parts)}`);
  }
  console.log(lines.join("\n"));
}

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
  return function wrappedStreamFn(model, context, options = {}) {
    let mergedOpts = options;
    if (process.env.HANA_DEBUG_LLM_PAYLOAD === "1") {
      const prev = options.onPayload;
      mergedOpts = {
        ...options,
        onPayload: (params) => {
          try {
            prev?.(params);
            if (model?.api === "openai-completions") {
              summarizeOpenAiPayload(model, params);
            } else {
              console.log(
                `[llm-payload] ${model?.provider}/${model?.id} api=${model?.api} — 仅对 openai-completions 做 messages 摘要；其它协议请抓包或看 Pi provider 源码`,
              );
            }
          } catch (e) {
            console.error("[llm-payload] summarize failed:", e);
          }
        },
      };
    }
    const inner = streamFn(model, context, mergedOpts);
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
