/**
 * create_script_tool.js — 让 AI 在用户目录下创建「脚本形态」的自定义工具
 *
 * 用户可引导 AI 使用此工具，将一段符合 Pi ToolDefinition 的脚本写入 ~/.hanako/user-tools/<name>.mjs，
 * 之后新 session 会自动加载该工具。脚本需 export default { name, description, parameters, execute }。
 */

import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { getUserToolsDir } from "./registry.js";

const SAFE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * @param {object} opts
 * @param {string} opts.hanakoHome - 用户数据根目录（如 ~/.hanako）
 */
export function createCreateScriptTool({ hanakoHome }) {
  async function execute(_toolCallId, params) {
    const dir = getUserToolsDir(hanakoHome);
    const rawName = (params.tool_name || "").trim();
    if (!SAFE_NAME.test(rawName)) {
      return {
        content: [{ type: "text", text: "❌ tool_name 仅允许字母开头、字母数字下划线短横线，且长度 1～64。" }],
        details: {},
      };
    }
    const content = params.script_content?.trim();
    if (!content || !content.includes("export default")) {
      return {
        content: [{ type: "text", text: "❌ script_content 须为完整 ESM 模块内容，且包含 export default。" }],
        details: {},
      };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${rawName}.mjs`);
      fs.writeFileSync(filePath, content + "\n", "utf-8");
      return {
        content: [{
          type: "text",
          text: `✅ 已创建脚本工具：${rawName}.mjs（路径：${filePath}）。新会话或下次对话将自动加载该工具。`,
        }],
        details: { tool_name: rawName, path: filePath },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ 写入失败：${err.message}` }],
        details: {},
      };
    }
  }

  return {
    name: "create_script_tool",
    label: "Create script tool",
    description:
      "在用户目录下创建一个「脚本形态」的自定义工具，供后续对话使用。"
      + " 用户可以说「帮我写一个查天气的工具」等，由你生成脚本内容后调用本工具。"
      + " 脚本须为 ESM 模块，export default 一个对象：{ name, description, parameters, execute }。"
      + " parameters 须为纯 JSON Schema 对象（勿使用 import from '@sinclair/typebox'，用户脚本无法访问应用 node_modules）。"
      + " 写入路径为 user-tools/<tool_name>.mjs，新会话会自动加载。",
    parameters: Type.Object({
      tool_name: Type.String({
        description: "工具文件名（不含扩展名），仅允许字母数字下划线短横线，如 weather、my_calc",
      }),
      script_content: Type.String({
        description: "完整的 .mjs 文件内容，须包含 export default { name, description, parameters, execute }；parameters 用纯 JSON Schema，不要 import 任何 npm 包",
      }),
      reason: Type.Optional(Type.String({ description: "简要说明为何创建该工具（可选）" })),
    }),
    execute,
  };
}
