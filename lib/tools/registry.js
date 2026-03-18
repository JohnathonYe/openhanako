/**
 * registry.js — 工具注册表（供设置页「工具」开关与 API 使用）
 *
 * 列出所有内置 / 自定义工具 id 与展示信息，不包含执行逻辑。
 * 用户脚本工具在运行时从 user-tools 目录扫描，由 getToolRegistry 合并返回。
 */

import fs from "fs";
import path from "path";

/** 内置工具（Pi SDK 提供） */
export const BUILTIN_TOOL_IDS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/** 内置工具展示标签（用于设置页） */
export const BUILTIN_LABELS = {
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  bash: "Run shell",
  grep: "Grep search",
  find: "Find files",
  ls: "List directory",
};

/** 自定义工具 id 与展示信息（与 lib/tools/*.js 及 memory 工具一致） */
export const CUSTOM_TOOL_REGISTRY = [
  { id: "search_memory", label: "Search memory", kind: "custom" },
  { id: "pin_memory", label: "Pin memory", kind: "custom" },
  { id: "unpin_memory", label: "Unpin memory", kind: "custom" },
  { id: "recall_experience", label: "Recall experience", kind: "custom" },
  { id: "record_experience", label: "Record experience", kind: "custom" },
  { id: "web_search", label: "Web search", kind: "custom" },
  { id: "web_fetch", label: "Web fetch", kind: "custom" },
  { id: "todo", label: "Todo list", kind: "custom" },
  { id: "cron", label: "Cron / scheduled tasks", kind: "custom" },
  { id: "present_files", label: "Present files", kind: "custom" },
  { id: "create_artifact", label: "Create artifact", kind: "custom" },
  { id: "channel", label: "Channel post", kind: "custom" },
  { id: "ask_agent", label: "Ask agent", kind: "custom" },
  { id: "dm", label: "Direct message", kind: "custom" },
  { id: "single_use_browser", label: "Single-use browser", kind: "custom" },
  { id: "cdp_local_browser", label: "CDP local browser", kind: "custom" },
  { id: "install_skill", label: "Install skill", kind: "custom" },
  { id: "notify", label: "Notify", kind: "custom" },
  { id: "delegate", label: "Delegate (sub-agent)", kind: "custom" },
  { id: "create_script_tool", label: "Create script tool", kind: "custom" },
];

const USER_TOOLS_DIR_NAME = "user-tools";

/**
 * 获取 user-tools 目录路径
 * @param {string} hanakoHome
 * @returns {string}
 */
export function getUserToolsDir(hanakoHome) {
  return path.join(hanakoHome, USER_TOOLS_DIR_NAME);
}

/**
 * 从 user-tools 目录扫描并返回工具元信息（仅 id/label/kind，不执行 import）
 * 用于设置页展示与 registry 合并。
 * @param {string} hanakoHome
 * @returns {{ id: string, label: string, kind: 'user_script' }[]}
 */
export function scanUserScriptToolIds(hanakoHome) {
  const dir = getUserToolsDir(hanakoHome);
  const result = [];
  try {
    if (!fs.existsSync(dir)) return result;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== ".mjs" && ext !== ".js") continue;
      const base = path.basename(e.name, ext);
      const id = `user_${base}`;
      result.push({ id, label: base.replace(/_/g, " "), kind: "user_script" });
    }
  } catch (_) {}
  return result;
}

/**
 * 合并内置、自定义与用户脚本工具列表（供设置页与 API 使用）
 * @param {string} [hanakoHome]
 * @returns {{ id: string, label: string, kind: string }[]}
 */
export function getToolRegistry(hanakoHome) {
  const builtin = BUILTIN_TOOL_IDS.map((id) => ({
    id,
    label: BUILTIN_LABELS[id] || id,
    kind: "builtin",
  }));
  const custom = CUSTOM_TOOL_REGISTRY.map(({ id, label, kind }) => ({ id, label, kind }));
  const userScripts = hanakoHome ? scanUserScriptToolIds(hanakoHome) : [];
  return [...builtin, ...custom, ...userScripts];
}

/**
 * 根据 user_script 工具 id 解析对应脚本文件路径（.mjs 优先，否则 .js）
 * @param {string} hanakoHome
 * @param {string} toolId - 如 "user_my_tool"
 * @returns {string|null} 绝对路径，不存在或非法则 null
 */
export function getUserScriptToolFilePath(hanakoHome, toolId) {
  if (!hanakoHome || typeof toolId !== "string" || !toolId.startsWith("user_")) return null;
  const base = toolId.slice(5);
  if (!base || /\.\.|[\/\\]/.test(base)) return null;
  const dir = getUserToolsDir(hanakoHome);
  const mjs = path.join(dir, `${base}.mjs`);
  const js = path.join(dir, `${base}.js`);
  if (fs.existsSync(mjs)) return mjs;
  if (fs.existsSync(js)) return js;
  return null;
}

/**
 * 删除用户脚本工具对应文件，并从磁盘移除
 * @param {string} hanakoHome
 * @param {string} toolId - 如 "user_my_tool"
 * @throws 若非法 id、非 user_script 或文件不存在
 */
export function deleteUserScriptTool(hanakoHome, toolId) {
  const filePath = getUserScriptToolFilePath(hanakoHome, toolId);
  if (!filePath) throw new Error("Tool not found or not a user script tool");
  fs.unlinkSync(filePath);
}
