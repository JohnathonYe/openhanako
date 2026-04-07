/**
 * tool-wrapper.js — 工具沙盒包装
 *
 * 在 Pi SDK 工具的 execute 外面套一层路径校验。
 * 被拦截时返回 LLM 可读的文本错误，不抛异常。
 *
 * macOS/Linux: bash 安全边界在 OS 沙盒（seatbelt/bwrap），preflight 只优化体验。
 * Windows: 无 OS 沙盒，bash 额外做路径提取 + PathGuard 校验作为安全层。
 */

import path from "path";
import { readFile } from "fs/promises";
import * as Diff from "diff";
import { recordFileChange } from "../tools/file-change-tracker.js";
import { t } from "../../server/i18n.js";

/**
 * Generate a unified diff string with line numbers and context.
 * Reimplemented locally to avoid importing unexported Pi SDK internals.
 */
function generateDiffString(oldContent, newContent, contextLines = 4) {
  const parts = Diff.diffLines(oldContent, newContent);
  const output = [];
  const maxLineNum = Math.max(
    oldContent.split("\n").length,
    newContent.split("\n").length,
  );
  const lineNumWidth = String(maxLineNum).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      if (lastWasChange || nextIsChange) {
        let linesToShow = raw;
        let skipStart = 0;
        let skipEnd = 0;
        if (!lastWasChange) {
          skipStart = Math.max(0, raw.length - contextLines);
          linesToShow = raw.slice(skipStart);
        }
        if (!nextIsChange && linesToShow.length > contextLines) {
          skipEnd = linesToShow.length - contextLines;
          linesToShow = linesToShow.slice(0, contextLines);
        }
        if (skipStart > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipStart;
          newLineNum += skipStart;
        }
        for (const line of linesToShow) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (skipEnd > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipEnd;
          newLineNum += skipEnd;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }
  return { diff: output.join("\n"), firstChangedLine };
}

/** 构造被拦截时返回给 LLM 的结果 */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

/** 解析工具参数中的路径为绝对路径 */
function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

/**
 * 轻量 preflight 模式匹配
 * macOS/Linux: 体验层（OS 沙盒兜底）
 * Windows: 安全层之一（无 OS 沙盒）
 */
const PREFLIGHT_UNIX = [
  [/\bsudo\s/, () => t("sandbox.noSudo")],
  [/\bsu\s+\w/, () => t("sandbox.noSu")],
  [/\bchmod\s/, () => t("sandbox.noChmod")],
  [/\bchown\s/, () => t("sandbox.noChown")],
];

const PREFLIGHT_WIN32 = [
  [/\bdel\s+\/s/i, () => t("sandbox.noDelRecursive")],
  [/\brmdir\s+\/s/i, () => t("sandbox.noRmdirRecursive")],
  [/\breg\s+(delete|add)\b/i, () => t("sandbox.noRegEdit")],
  [/\btakeown\b/i, () => t("sandbox.noTakeown")],
  [/\bicacls\b/i, () => t("sandbox.noIcacls")],
  [/\bnet\s+(user|localgroup)\b/i, () => t("sandbox.noNetUser")],
  [/\bschtasks\s+\/create\b/i, () => t("sandbox.noSchtasks")],
  [/\bsc\s+(create|delete)\b/i, () => t("sandbox.noScService")],
  [/powershell.*-e(xecutionpolicy)?\s*(bypass|unrestricted)/i, () => t("sandbox.noPsExecutionBypass")],
  [/\bformat\s+[a-z]:/i, () => t("sandbox.noFormat")],
  [/\bbcdedit\b/i, () => t("sandbox.noBcdedit")],
  [/\bwmic\b/i, () => t("sandbox.noWmic")],
];

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32]
  : PREFLIGHT_UNIX;

/**
 * 从 bash 命令中提取可能的文件路径（启发式）
 * 用于 Windows 无 OS 沙盒时的 PathGuard 校验
 */
const WIN_ABS_PATH = /[A-Za-z]:[\\\/][^\s"'|<>&;]+/g;
const UNIX_ABS_PATH = /(?:^|\s)(\/[^\s"'|<>&;]+)/g;
const QUOTED_PATH = /["']([A-Za-z]:[\\\/][^"']+)["']/g;

function extractPaths(command) {
  const paths = new Set();
  for (const re of [WIN_ABS_PATH, QUOTED_PATH]) {
    for (const m of command.matchAll(re)) {
      paths.add(m[1] || m[0]);
    }
  }
  if (process.platform !== "win32") {
    for (const m of command.matchAll(UNIX_ABS_PATH)) {
      paths.add(m[1] || m[0]);
    }
  }
  return [...paths];
}

/**
 * 包装路径类工具（read, write, edit, grep, find, ls）
 */
export function wrapPathTool(tool, guard, operation, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);

      if (!result.allowed) {
        return blockedResult(result.reason);
      }

      return tool.execute(toolCallId, params, ...rest);
    },
  };
}

/**
 * 包装 bash 工具
 *
 * 1. preflight：常见危险命令提前拦截
 * 2. 路径校验：提取命令中的绝对路径，用 PathGuard 检查（Windows 无 OS 沙盒时的安全层）
 * 3. 执行：OS 沙盒在 BashOperations.exec 里生效（macOS/Linux）
 * 4. 错误翻译：OS 沙盒拦截后 stderr 的 Operation not permitted
 *
 * @param {object} tool  原始 bash 工具
 * @param {object} [guard]  PathGuard 实例（Windows 必传，macOS/Linux 可选）
 * @param {string} [cwd]  工作目录
 */
/**
 * Wrap write tool to generate diff and record backup for rollback.
 * Compose outside wrapPathTool: wrapWriteWithDiff(wrapPathTool(...))
 */
export function wrapWriteWithDiff(tool, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path || params.file_path;
      const absolutePath = rawPath
        ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath))
        : cwd;

      let oldContent = null;
      try { oldContent = await readFile(absolutePath, "utf-8"); } catch { /* new file */ }

      recordFileChange(absolutePath, oldContent);

      const result = await tool.execute(toolCallId, params, ...rest);

      if (oldContent !== null && params.content != null) {
        try {
          const { diff, firstChangedLine } = generateDiffString(oldContent, params.content);
          result.details = { ...(result.details || {}), diff, firstChangedLine };
        } catch { /* diff generation failed, non-fatal */ }
      }

      return result;
    },
  };
}

/**
 * Wrap edit tool to record backup for rollback.
 * The edit tool already generates diff in details; we only add backup tracking.
 */
export function wrapEditWithBackup(tool, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path || params.file_path;
      const absolutePath = rawPath
        ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath))
        : cwd;

      let oldContent = null;
      try { oldContent = await readFile(absolutePath, "utf-8"); } catch { /* ignore */ }

      recordFileChange(absolutePath, oldContent);

      return tool.execute(toolCallId, params, ...rest);
    },
  };
}

export function wrapBashTool(tool, guard, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // preflight
      for (const [pattern, reasonFn] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          return blockedResult(reasonFn());
        }
      }

      // 路径校验：从命令中提取绝对路径，检查 PathGuard
      if (guard && cwd) {
        const paths = extractPaths(params.command);
        for (const p of paths) {
          const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
          const result = guard.check(abs, "read");
          if (!result.allowed) {
            return blockedResult(t("sandbox.restrictedPath", { path: p }));
          }
        }
      }

      try {
        const result = await tool.execute(toolCallId, params, ...rest);

        // 成功路径的错误翻译（exitCode 0 但 stderr 有 sandbox 拒绝）
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n" + t("sandbox.writeRestricted");
        }

        return result;
      } catch (err) {
        // Pi SDK 对非零退出 throw Error，错误消息里包含 stderr 输出。
        // 如果是沙盒拦截导致的，追加友好提示。
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        throw err;
      }
    },
  };
}
