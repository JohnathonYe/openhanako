/**
 * user-script-loader.js — 加载用户目录下的脚本形态工具
 *
 * 从 ~/.hanako/user-tools/ 扫描 .mjs/.js 文件，动态 import 后取默认导出作为 Pi 兼容的 ToolDefinition。
 * 每个脚本应 export default { name, description, parameters, execute }。
 * 用于「用户引导 AI 创建外部脚本工具」场景。
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { getUserToolsDir } from "./registry.js";

/**
 * 从 user-tools 目录加载所有脚本工具定义
 * @param {string} hanakoHome - 用户数据根目录（如 ~/.hanako）
 * @returns {Promise<object[]>} 符合 Pi ToolDefinition 的数组
 */
export async function loadUserScriptTools(hanakoHome) {
  const dir = getUserToolsDir(hanakoHome);
  const tools = [];
  try {
    if (!fs.existsSync(dir)) return tools;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== ".mjs" && ext !== ".js") continue;
      const filePath = path.join(dir, e.name);
      const base = path.basename(e.name, ext);
      const expectedName = `user_${base}`;
      try {
        const url = pathToFileURL(filePath).href;
        const mod = await import(url);
        const def = mod.default || mod;
        if (def && typeof def.execute === "function") {
          def.name = expectedName;
          tools.push(def);
        }
      } catch (err) {
        const hint = /Cannot find package|Cannot find module/.test(err.message)
          ? " (用户脚本不可 import npm 包，parameters 请用纯 JSON Schema)"
          : "";
        console.warn(`[user-script-tools] skip ${e.name}: ${err.message}${hint}`);
      }
    }
  } catch (_) {}
  return tools;
}

/**
 * 同步版本：仅返回当前已加载的脚本路径列表，不执行 import（用于 registry 扫描）
 * 实际加载由 loadUserScriptTools 在 buildTools 时完成。
 */
export function listUserScriptPaths(hanakoHome) {
  const dir = getUserToolsDir(hanakoHome);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(mjs|js)$/i.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
