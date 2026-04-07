/**
 * project-context.js — Coding Mode 项目上下文收集
 *
 * 收集 cwd 下的 git 状态、目录结构、项目规则文件等信息，
 * 用于注入 Coding Mode 的 system prompt。
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const MAX_DIR_DEPTH = 3;
const MAX_DIR_ENTRIES = 200;
const MAX_SINGLE_RULE_BYTES = 4096;
const MAX_TOTAL_RULES_BYTES = 16384;
const MAX_README_BYTES = 2048;

function execGit(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(cwd) {
  return execGit("git rev-parse --is-inside-work-tree", cwd) === "true";
}

function getGitInfo(cwd) {
  if (!isGitRepo(cwd)) return null;
  return {
    branch: execGit("git rev-parse --abbrev-ref HEAD", cwd),
    status: execGit("git status --short", cwd),
    recentLog: execGit("git log --oneline -5 --no-decorate", cwd),
  };
}

function scanDirectory(dirPath, depth = 0, counts = { total: 0 }) {
  if (depth > MAX_DIR_DEPTH || counts.total >= MAX_DIR_ENTRIES) return [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const SKIP = new Set([
    "node_modules", ".git", ".next", "dist", "build", "__pycache__",
    ".venv", "venv", ".tox", "target", ".idea", ".vscode",
    "coverage", ".nyc_output", ".turbo", ".cache",
  ]);

  const lines = [];
  const indent = "  ".repeat(depth);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (counts.total >= MAX_DIR_ENTRIES) {
      lines.push(`${indent}... (truncated)`);
      break;
    }
    if (entry.name.startsWith(".") && depth === 0 && entry.isDirectory()) continue;
    if (SKIP.has(entry.name)) continue;
    counts.total++;
    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      lines.push(...scanDirectory(path.join(dirPath, entry.name), depth + 1, counts));
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }
  return lines;
}

function readTruncated(filePath, maxBytes) {
  try {
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    let text = buf.subarray(0, bytesRead).toString("utf-8");
    if (bytesRead === maxBytes) text += "\n... (truncated)";
    return text;
  } catch {
    return null;
  }
}

/**
 * 扫描 cwd 下的项目规则文件（不含 .rules/*.md，那由 agent._readWorkspaceRules 处理）：
 *   1. CLAUDE.md（根目录单文件）
 *   2. .cursor/rules/*.mdc（Cursor 规则）
 * 返回所有找到的规则，按来源分组
 */
function findProjectRules(cwd) {
  const results = [];
  let totalBytes = 0;

  // 1. CLAUDE.md
  const claudeMd = readTruncated(path.join(cwd, "CLAUDE.md"), MAX_SINGLE_RULE_BYTES);
  if (claudeMd?.trim()) {
    results.push({ file: "CLAUDE.md", content: claudeMd.trim() });
    totalBytes += claudeMd.length;
  }

  // 2. .cursor/rules/*.mdc
  const cursorRulesDir = path.join(cwd, ".cursor", "rules");
  try {
    if (fs.existsSync(cursorRulesDir) && fs.statSync(cursorRulesDir).isDirectory()) {
      const mdcFiles = fs.readdirSync(cursorRulesDir, { withFileTypes: true })
        .filter(e => !e.isDirectory() && e.name.endsWith(".mdc"))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const e of mdcFiles) {
        if (totalBytes >= MAX_TOTAL_RULES_BYTES) break;
        const content = readTruncated(path.join(cursorRulesDir, e.name), MAX_SINGLE_RULE_BYTES);
        if (content?.trim()) {
          results.push({ file: `.cursor/rules/${e.name}`, content: content.trim() });
          totalBytes += content.length;
        }
      }
    }
  } catch { /* skip unreadable */ }

  return results.length > 0 ? results : null;
}

function findReadme(cwd) {
  for (const name of ["README.md", "readme.md", "README", "README.txt"]) {
    const content = readTruncated(path.join(cwd, name), MAX_README_BYTES);
    if (content?.trim()) return content;
  }
  return null;
}

/**
 * 收集项目上下文
 * @param {string} cwd - 工作目录
 * @returns {{ cwd: string, git: object|null, directoryStructure: string, projectRules: Array<{file:string,content:string}>|null, readme: string|null }}
 */
export function gatherProjectContext(cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { cwd: cwd || "(unknown)", git: null, directoryStructure: "", projectRules: null, readme: null };
  }

  return {
    cwd,
    git: getGitInfo(cwd),
    directoryStructure: scanDirectory(cwd).join("\n"),
    projectRules: findProjectRules(cwd),
    readme: findReadme(cwd),
  };
}

/**
 * 将 gatherProjectContext 结果格式化为 system prompt 注入文本
 * @param {object} ctx - gatherProjectContext 返回值
 * @param {boolean} [isZh=true]
 * @returns {string}
 */
export function formatProjectContextForPrompt(ctx, isZh = true) {
  const sections = [];

  sections.push(`<context name="project">`);
  sections.push(`Working directory: ${ctx.cwd}`);

  if (ctx.git) {
    sections.push(`Git branch: ${ctx.git.branch || "(detached)"}`);
    if (ctx.git.status) {
      sections.push(`Git status:\n${ctx.git.status}`);
    }
    if (ctx.git.recentLog) {
      sections.push(`Recent commits:\n${ctx.git.recentLog}`);
    }
  } else {
    sections.push("Git: not a git repository");
  }

  if (ctx.directoryStructure) {
    sections.push(`\nDirectory structure:\n${ctx.directoryStructure}`);
  }

  sections.push(`</context>`);

  if (ctx.projectRules?.length) {
    for (const rule of ctx.projectRules) {
      sections.push(`\n<context name="project_rules" file="${rule.file}">`);
      sections.push(rule.content);
      sections.push(`</context>`);
    }
  }

  if (ctx.readme) {
    const label = isZh ? "项目 README（摘要）" : "Project README (summary)";
    sections.push(`\n<context name="readme">`);
    sections.push(`${label}:\n${ctx.readme}`);
    sections.push(`</context>`);
  }

  return sections.join("\n");
}
