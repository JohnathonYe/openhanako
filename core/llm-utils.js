/**
 * LLM Utilities — 轻量 LLM 调用（标题摘要、翻译、ID 生成等）
 *
 * 纯函数模块，不持有状态。调用方传入 utilConfig（model/api_key/base_url）。
 * 从 Engine 提取，消除 5 处重复的 fetch 模式。
 */
import fs from "fs";
import path from "path";
import { callProviderText } from "../lib/llm/provider-client.js";
import { getLocale } from "../server/i18n.js";

/**
 * 本项目中，助手消息里工具调用的统一格式（由 Pi SDK 解析模型输出后得到）：
 * - content 中块类型为 "tool_use" 或 "toolCall"
 * - 块内必有 name（工具名），参数在 input 或 arguments（单个 JSON 对象）
 * - 执行时以 (toolCallId, params) 调用 tool.execute，params 即上述 JSON 对象
 * 若模型/厂商返回其他格式（如 XML <invoke>/<parameter>），通过 normalizeToolCallContent 转为上述格式后全项目统一使用。
 */
export const isToolCallBlock = (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name;

/** 取工具调用参数（兼容 input / arguments） */
export const getToolArgs = (b) => b.input || b.arguments;

// ─── XML <invoke>/<parameter> 解析（兼容 Minimax 等返回 XML 工具调用的模型） ───

const INVOKE_REGEX = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;
const PARAM_REGEX = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
const PARAM_SELF_CLOSE_REGEX = /<parameter\s+name=["']([^"']+)["']\s*\/>/gi;

function tryParseValue(str) {
  const s = typeof str === "string" ? str.trim() : String(str);
  if (s === "") return s;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return parsed;
  } catch {
    return s;
  }
}

/**
 * 从文本中解析所有 <invoke name="...">...</invoke>，转为标准工具调用形状
 * @param {string} text - 可能包含 <invoke><parameter name="...">...</parameter></invoke> 的文本
 * @returns {Array<{ name: string, input: Record<string, unknown> }>}
 */
export function parseInvokeXml(text) {
  if (typeof text !== "string" || !text.includes("invoke")) return [];
  const out = [];
  let m;
  INVOKE_REGEX.lastIndex = 0;
  while ((m = INVOKE_REGEX.exec(text)) !== null) {
    const name = m[1].trim();
    const inner = m[2] || "";
    const input = {};
    PARAM_REGEX.lastIndex = 0;
    let pm;
    while ((pm = PARAM_REGEX.exec(inner)) !== null) {
      input[pm[1].trim()] = tryParseValue(pm[2]);
    }
    PARAM_SELF_CLOSE_REGEX.lastIndex = 0;
    while ((pm = PARAM_SELF_CLOSE_REGEX.exec(inner)) !== null) {
      if (input[pm[1].trim()] === undefined) input[pm[1].trim()] = "";
    }
    out.push({ name, input });
  }
  return out;
}

/**
 * 将 content（string 或 content 块数组）归一化为标准块数组：文本中的 <invoke> 转为 tool_use 块
 * 全项目统一在「消费」content 前调用，保证无论模型返回 JSON 还是 XML 都能得到一致的 tool_use 形态
 * @param {string | Array<{ type: string, text?: string, name?: string, input?: object, arguments?: object }>} content
 * @returns {Array<{ type: string, text?: string, name?: string, input?: object }>}
 */
export function normalizeToolCallContent(content) {
  const blocks = typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content.slice()
      : [];
  const result = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      const invokes = parseInvokeXml(block.text);
      for (const { name, input } of invokes) {
        result.push({ type: "tool_use", name, input });
      }
      const stripped = block.text.replace(INVOKE_REGEX, "").trim();
      if (stripped) result.push({ type: "text", text: stripped });
    } else if (isToolCallBlock(block)) {
      result.push(block);
    } else {
      result.push(block);
    }
  }
  return result;
}

/**
 * 统一的 utility LLM 调用
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.api_key
 * @param {string} opts.base_url
 * @param {Array} opts.messages
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.max_tokens=100]
 * @returns {Promise<string|null>} 回复文本
 */
async function callLlm({ model, api, api_key, base_url, messages, temperature = 0.3, max_tokens = 100 }) {
  return callProviderText({
    api,
    model,
    api_key,
    base_url,
    messages,
    temperature,
    max_tokens,
  });
}

/**
 * 从 .jsonl session 文件提取 user/assistant 文本和工具调用
 */
function parseSessionContent(sessionPath, { userLimit = 1000, assistantLimit = 1000 } = {}) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  let userText = "";
  let assistantText = "";
  const toolCalls = [];
  for (const line of lines) {
    if (line.type !== "message" || !line.message) continue;
    const msg = line.message;
    if (msg.role === "user" && !userText) {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      userText = textParts.map(c => c.text).join("\n").slice(0, userLimit);
    }
    if (msg.role === "assistant") {
      const normalized = normalizeToolCallContent(msg.content || []);
      const textParts = normalized.filter(c => c.type === "text");
      assistantText = textParts.map(c => c.text).join("\n").slice(0, assistantLimit);
      const toolParts = normalized.filter(isToolCallBlock);
      for (const t of toolParts) toolCalls.push(t.name || "unknown_tool");
    }
  }
  return { userText, assistantText, toolCalls };
}

/**
 * 从 session 内容生成本地兜底摘要（不依赖外部 API）
 */
export function buildLocalSummary(assistantText, toolCalls) {
  const isZh = getLocale().startsWith("zh");
  const uniqueTools = [...new Set(toolCalls)];
  if (uniqueTools.length > 0) {
    if (isZh) {
      return `执行了 ${uniqueTools.slice(0, 3).join("、")}${uniqueTools.length > 3 ? " 等" : ""}`;
    }
    return `Ran ${uniqueTools.slice(0, 3).join(", ")}${uniqueTools.length > 3 ? ", etc." : ""}`;
  }
  if (assistantText) {
    const clean = assistantText.replace(/[#*_`>\-[\]()]/g, "").trim();
    if (clean.length <= 50) return clean;
    return clean.slice(0, 47) + "...";
  }
  return null;
}

/**
 * 生成对话标题
 */
export async function summarizeTitle(utilConfig, userText, assistantText) {
  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return null;

    const systemContent = isZh
      ? `你是一个对话标题生成器。根据用户和助手的第一轮对话，用一句极短的话概括对话主题。

规则：
1. 标题长度严格控制在 10 个字以内（中文）或 5 个单词以内（英文）
2. 语言必须和用户说的第一句话一致：用户说中文就用中文，用户说英文就用英文
3. 不要加引号、句号或其他标点
4. 直接输出标题，不要解释`
      : `You are a conversation title generator. Based on the first exchange between user and assistant, summarize the topic in a very short phrase.

Rules:
1. Keep the title under 5 words (English) or 10 characters (Chinese)
2. The title language must match the user's first message
3. No quotes, periods, or other punctuation
4. Output the title directly, no explanation`;

    const userLabel = isZh ? "用户" : "User";
    const assistantLabel = isZh ? "助手" : "Assistant";

    return await callLlm({
      model, api, api_key, base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${userLabel}：${(userText || "").slice(0, 500)}\n${assistantLabel}：${(assistantText || "").slice(0, 500)}`,
        },
      ],
      max_tokens: 50,
    });
  } catch (err) {
    console.error("[llm-utils] summarizeTitle failed:", err.message);
    return null;
  }
}

/**
 * 批量翻译技能名称
 */
export async function translateSkillNames(utilConfig, names, lang) {
  if (!names.length) return {};
  const LANG_LABEL = { zh: "中文", ja: "日本語", ko: "한국어" };
  const label = LANG_LABEL[lang] || lang;
  try {
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return {};
    const isZh = getLocale().startsWith("zh");
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `将下列 kebab-case 英文技能名翻译成简短的${label}名称（2-4 个字）。直接输出 JSON 对象，key 为原名，value 为翻译。不解释。`
            : `Translate the following kebab-case English skill names into short ${label} names (2-4 characters). Output a JSON object directly, key = original name, value = translation. No explanation.`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    if (!text) return {};
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    console.error("[llm-utils] translateSkillNames 失败:", err.message);
    return {};
  }
}

/**
 * 为活动 session 生成摘要（用 utility_large 模型）
 * @param {object} utilConfig - resolveUtilityConfig() 结果
 * @param {string} sessionPath
 * @param {(text: string, level?: string) => void} [emitDevLog]
 */
export async function summarizeActivity(utilConfig, sessionPath, emitDevLog) {
  const log = emitDevLog || (() => {});
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText, toolCalls } = parseSessionContent(sessionPath);
    if (!userText && !assistantText) {
      log("[summarize] session empty, skipping");
      return null;
    }

    const toolInfo = toolCalls.length > 0
      ? (isZh
          ? `\n\n调用的工具：${[...new Set(toolCalls)].join("、")}`
          : `\n\nTools used: ${[...new Set(toolCalls)].join(", ")}`)
      : "";
    const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilConfig;
    if (!api_key || !base_url || !api) {
      log("[summarize] utility_large config incomplete, skipping");
      return null;
    }

    const systemContent = isZh
      ? `你是一个执行摘要生成器。根据 Agent 的巡检上下文、执行结果和使用的工具，概括它做了什么。

规则：
1. 用中文，50 字以内
2. 直接输出摘要，不要前缀、不要解释
3. 说清楚做了什么具体动作（拆解待办、搜索信息、标记完成、读取文件等）
4. 如果调用了工具，提一下工具名称和做了什么
5. 如果 Agent 回复了「一切正常」或没有执行动作，就说「巡检完毕，一切正常」`
      : `You are an execution summary generator. Based on the Agent's patrol context, execution results, and tools used, summarize what it did.

Rules:
1. In English, under 30 words
2. Output the summary directly, no prefix or explanation
3. Be specific about what actions were taken (broke down tasks, searched info, marked complete, read files, etc.)
4. If tools were called, mention the tool names and what they did
5. If the Agent reported "all clear" or took no action, say "Patrol complete, all clear"`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const text = await callProviderText({
      api,
      model,
      api_key,
      base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 600)}\n\n${replyLabel}：\n${assistantText.slice(0, 600)}${toolInfo}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    return text;
  } catch (err) {
    log(`[summarize] error: ${err.message}`);
    console.error("[llm-utils] summarizeActivity failed:", err.message);
    return null;
  }
}

/**
 * 快速摘要（用 utility 小模型）
 * @param {object} utilConfig
 * @param {string} sessionPath - activity session 文件绝对路径
 */
export async function summarizeActivityQuick(utilConfig, sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText } = parseSessionContent(sessionPath, {
      userLimit: 800, assistantLimit: 800,
    });
    if (!userText && !assistantText) return null;

    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return null;

    const systemContent = isZh
      ? `根据 Agent 的巡检上下文和执行结果，用一两句话概括它做了什么。30 字以内，中文，直接输出。`
      : `Based on the Agent's patrol context and execution results, summarize what it did in one or two sentences. Under 15 words, English, output directly.`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    return await callProviderText({
      api,
      model,
      api_key,
      base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 400)}\n\n${replyLabel}：\n${assistantText.slice(0, 400)}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 80,
    });
  } catch (err) {
    console.error("[llm-utils] summarizeActivityQuick failed:", err.message);
    return null;
  }
}

/**
 * 用 LLM 根据显示名生成 agent ID
 * @param {object} utilConfig
 * @param {string} name - 显示名
 * @param {string} agentsDir - agents 根目录（检查冲突）
 */
export async function generateAgentId(utilConfig, name, agentsDir) {
  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api } = utilConfig;
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `根据给定的助手名字，生成一个简短的英文小写 ID（用于文件夹名）。
规则：
1. 纯小写英文字母，可以用连字符
2. 2~12 个字符
3. 尽量是名字的英文音译或缩写
4. 直接输出 ID，不要解释

示例：
- "花子" → "hanako"
- "ミク" → "miku"
- "小助手" → "helper"
- "Alice" → "alice"`
            : `Given an assistant's display name, generate a short lowercase English ID (for use as a folder name).
Rules:
1. Lowercase English letters only, hyphens allowed
2. 2–12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, no explanation

Examples:
- "花子" → "hanako"
- "ミク" → "miku"
- "Helper" → "helper"
- "Alice" → "alice"`,
        },
        { role: "user", content: name },
      ],
      max_tokens: 20,
    });

    if (text) {
      const id = text.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12);
      if (id.length >= 2 && !fs.existsSync(path.join(agentsDir, id))) {
        return id;
      }
    }
  } catch (err) {
    console.error("[llm-utils] generateAgentId LLM failed:", err.message);
  }
  return `agent-${Date.now().toString(36)}`;
}
