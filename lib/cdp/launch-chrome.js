/**
 * launch-chrome.js — 按平台启动带远程调试的 Chrome
 *
 * 用于在 9222 未监听时自动拉起 Chrome（Chrome 136+ 需 --user-data-dir）。
 * 由 cdp-browser-tool 在 autoLaunch 开启时调用。
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

/**
 * 获取当前平台下 Chrome 可执行路径（优先带 user-data-dir 的独立配置）
 * @param {string} [userDataDir] - 用户数据目录，默认 /tmp/chrome-cdp-9222（或 Windows %TEMP%）
 * @returns {{ executable: string, args: string[] } | null} 无法解析时返回 null
 */
function getChromeLaunchConfig(port = 9222, userDataDir) {
  const args = [`--remote-debugging-port=${port}`];
  const platform = process.platform;

  if (platform === "darwin") {
    const dir = userDataDir || "/tmp/chrome-cdp-9222";
    args.push(`--user-data-dir=${dir}`);
    const exe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(exe)) return { executable: exe, args };
    return null;
  }

  if (platform === "win32") {
    const dir = userDataDir || path.join(process.env.TEMP || process.env.LOCALAPPDATA || "C:\\Temp", "chrome-cdp-9222");
    args.push(`--user-data-dir=${dir}`);
    const candidates = [
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean);
    for (const exe of candidates) {
      if (fs.existsSync(exe)) return { executable: exe, args };
    }
    return null;
  }

  if (platform === "linux") {
    const dir = userDataDir || "/tmp/chrome-cdp-9222";
    args.push(`--user-data-dir=${dir}`);
    return { executable: "google-chrome", args };
  }

  return null;
}

/**
 * 启动 Chrome（后台、不阻塞），不等待端口就绪
 * @param {number} port - 调试端口
 * @param {string} [userDataDir] - 可选，覆盖默认 user-data-dir
 * @returns {Promise<boolean>} 是否已成功 spawn（不保证端口已监听）
 */
export function launchChrome(port = 9222, userDataDir) {
  return new Promise((resolve) => {
    const config = getChromeLaunchConfig(port, userDataDir);
    if (!config) {
      resolve(false);
      return;
    }
    const child = spawn(config.executable, config.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    child.on("error", () => resolve(false));
    child.on("spawn", () => resolve(true));
    // 若 spawn 失败（如找不到 exe），可能直接 exit
    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) resolve(false);
    });
  });
}

/**
 * 等待端口可连接或超时
 * @param {number} port
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
export function waitForPort(port, timeoutMs = 8000, intervalMs = 400) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  function poll() {
    if (Date.now() >= deadline) return Promise.resolve(false);
    return fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => (ok ? true : new Promise((resolve) => setTimeout(() => resolve(poll()), intervalMs))));
  }
  return poll();
}
