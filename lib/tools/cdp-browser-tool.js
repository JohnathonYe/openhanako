/**
 * cdp-browser-tool.js — 通过 CDP 控制本地 Chrome 多 Tab 并获取数据
 *
 * 依赖用户本机已用 --remote-debugging-port=9222 启动的 Chrome。
 * 提供：连接检测、Tab 列表、切换 Tab、导航、页面快照、执行 JS、截图。
 * 当工具不可用时（Chrome 未开启远程调试），应通过技能引导用户开启。
 */

import { Type } from "@sinclair/typebox";
import { listTabs, isChromeDebuggingAvailable, CdpBrowserSession } from "../cdp/cdp-client.js";
import { launchChrome, waitForPort } from "../cdp/launch-chrome.js";

const DEFAULT_PORT = 9222;

function ok(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function err(text, details = {}) {
  return {
    content: [{ type: "text", text: `错误: ${text}` }],
    details: { error: text, ...details },
  };
}

/**
 * 创建 CDP 本地浏览器工具
 * @param {object} [opts]
 * @param {number} [opts.port=9222] - Chrome 远程调试端口
 * @param {boolean} [opts.autoLaunch=true] - 端口未监听时是否自动启动 Chrome（含 --user-data-dir）
 * @param {string} [opts.userDataDir] - 自动启动时使用的 user-data-dir，默认 /tmp/chrome-cdp-9222（或 Windows %TEMP%）
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createCdpBrowserTool(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const autoLaunch = opts.autoLaunch !== false;
  const userDataDir = opts.userDataDir;
  /** @type {CdpBrowserSession | null} */
  let currentSession = null;
  /** @type {Array<{ id: string, title: string, url: string, webSocketDebuggerUrl: string }>} */
  let tabsCache = [];
  /** 当前选中的 Tab 索引（与 tabs 列表对应） */
  let activeTabIndex = 0;
  /** 本工具实例是否已自动启动过 Chrome，避免重复启动多个浏览器进程 */
  let launchedChromeOnce = false;

  return {
    name: "cdp_local_browser",
    label: "本地 Chrome 浏览器（CDP）",
    description:
      "通过 Chrome 远程调试协议（CDP）控制用户本机已打开的 Chrome 浏览器，支持多 Tab：列出、切换、导航、获取页面文本快照、执行 JavaScript、截图。\n\n" +
      "**调用方式**：与其它工具一致，传入单个 JSON 对象作为参数，字段见 parameters（action 必填，其余按需：index、url、expression、maxDepth、maxChildren、maxLength）。例：{\"action\":\"connect\"}、{\"action\":\"navigate\",\"url\":\"https://example.com\"}。\n\n" +
      "**使用前**：本机需有 Chrome 以远程调试方式运行（端口 9222）。若未检测到，可配置为自动启动 Chrome（见 cdp.auto_launch）；否则需用户按技能 cdp-browser-guide 手动启动。\n\n" +
      "操作：\n" +
      "- connect：检测并连接 Chrome，刷新 Tab 列表\n" +
      "- disconnect：断开当前 Tab 的 CDP 连接（不关闭 Chrome）\n" +
      "- tabs：列出当前所有 Tab（标题、URL、索引）\n" +
      "- activate(index)：切换到第 index 个 Tab（从 0 开始）\n" +
      "- navigate(url)：在当前 Tab 导航到 url\n" +
      "- snapshot：获取当前 Tab 页面的文本快照\n" +
      "- extract_text：纯文本提取（仅可读文字，块级换行，适合摘要/检索）\n" +
      "- head_info：获取当前 Tab 的 <head> 内重要信息（title、meta description/keywords/og、canonical、charset、viewport）\n" +
      "- dom_tree：获取当前页 DOM 结构摘要（标签层级与子节点数，便于理解页面骨架）\n" +
      "- evaluate(expression)：在当前页面执行 JavaScript，返回结果\n" +
      "- screenshot：截取当前 Tab 截图（PNG base64）\n\n" +
      "当返回“无法连接”或“请先启动 Chrome 远程调试”时，应使用技能引导用户开启功能。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("connect"),
        Type.Literal("disconnect"),
        Type.Literal("tabs"),
        Type.Literal("activate"),
        Type.Literal("navigate"),
        Type.Literal("snapshot"),
        Type.Literal("extract_text"),
        Type.Literal("head_info"),
        Type.Literal("dom_tree"),
        Type.Literal("evaluate"),
        Type.Literal("screenshot"),
      ], { description: "操作类型" }),
      index: Type.Optional(Type.Number({ description: "Tab 索引（activate 时必填，从 0 开始）" })),
      url: Type.Optional(Type.String({ description: "URL（navigate 时必填）" })),
      expression: Type.Optional(Type.String({ description: "JavaScript 表达式（evaluate 时必填）" })),
      maxDepth: Type.Optional(Type.Number({ description: "dom_tree 时可选，最大层级深度（默认 6）" })),
      maxChildren: Type.Optional(Type.Number({ description: "dom_tree 时可选，每节点最多展示子节点数（默认 12）" })),
      maxLength: Type.Optional(Type.Number({ description: "extract_text 时可选，最大字符数（默认 150000）" })),
    }),

    execute: async (_toolCallId, params) => {
      /** 若端口未监听且启用了 autoLaunch，则尝试启动 Chrome 并等待端口就绪。尽量复用已有浏览器：先重试连接，且每个工具实例最多自动启动一次。 */
      const ensureChromeAvailable = async () => {
        const maxRetries = 3;
        const retryDelayMs = 800;
        let available = false;
        for (let i = 0; i < maxRetries; i++) {
          available = await isChromeDebuggingAvailable(port);
          if (available) return;
          if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        if (autoLaunch && !launchedChromeOnce) {
          launchedChromeOnce = true;
          const launched = await launchChrome(port, userDataDir);
          if (launched) available = await waitForPort(port, 10000, 500);
        }
        if (!available) {
          throw new Error(
            `无法连接本机 Chrome（端口 ${port}）。${autoLaunch && launchedChromeOnce ? "已启动过 Chrome，若已关闭请重新打开或重试。" : autoLaunch ? "已尝试自动启动 Chrome 但未就绪。" : ""}请使用“远程调试”方式启动 Chrome 后重试。详见技能 cdp-browser-guide。`,
          );
        }
      };

      /** 确保已连接当前 Tab 的 CDP 会话，尽量复用已有 session（同一 Tab 不重建）。 */
      const ensureConnected = async () => {
        await ensureChromeAvailable();
        const tabs = await listTabs(port);
        if (tabs.length === 0) throw new Error("Chrome 中暂无页面，请至少打开一个 Tab。");
        tabsCache = tabs;
        const needNewSession =
          !currentSession ||
          activeTabIndex >= tabs.length ||
          (currentSession.targetId && tabs[activeTabIndex]?.id !== currentSession.targetId);
        if (needNewSession) {
          if (currentSession) currentSession.close();
          if (activeTabIndex >= tabs.length) activeTabIndex = 0;
          const tab = tabs[activeTabIndex];
          currentSession = new CdpBrowserSession(tab.webSocketDebuggerUrl, 15000, tab.id);
        }
        return tabs;
      };

      try {
        switch (params.action) {
          case "connect": {
            try {
              await ensureChromeAvailable();
            } catch (e) {
              return err(e.message, { port, hint: "cdp-browser-guide" });
            }
            tabsCache = await listTabs(port);
            if (tabsCache.length === 0) {
              return ok("已连接 Chrome，但当前没有打开的页面。请先在 Chrome 中打开至少一个 Tab。", {
                port,
                tabsCount: 0,
              });
            }
            const tab0 = tabsCache[0];
            const reuseSession = currentSession && currentSession.targetId === tab0.id;
            if (!reuseSession) {
              if (currentSession) currentSession.close();
              activeTabIndex = 0;
              currentSession = new CdpBrowserSession(tab0.webSocketDebuggerUrl, 15000, tab0.id);
              await currentSession.connect();
            } else {
              activeTabIndex = 0;
            }
            return ok(
              `已连接 Chrome，共 ${tabsCache.length} 个 Tab。当前 Tab: [0] ${tabsCache[0].title || tabsCache[0].url}`,
              { port, tabsCount: tabsCache.length, activeIndex: 0 },
            );
          }

          case "disconnect": {
            if (currentSession) {
              currentSession.close();
              currentSession = null;
            }
            tabsCache = [];
            return ok("已断开 CDP 连接（Chrome 未关闭）。", {});
          }

          case "tabs": {
            try {
              await ensureChromeAvailable();
            } catch (e) {
              return err(e.message, { port, hint: "cdp-browser-guide" });
            }
            tabsCache = await listTabs(port);
            if (tabsCache.length === 0) {
              return ok("Chrome 已连接，但当前没有打开的页面。请先在 Chrome 中打开至少一个 Tab。", {
                tabsCount: 0,
              });
            }
            const lines = tabsCache.map((t, i) => `[${i}] ${t.title || "(无标题)"} — ${t.url}`);
            return ok(`当前共 ${tabsCache.length} 个 Tab：\n\n${lines.join("\n")}`, {
              tabs: tabsCache.map((t, i) => ({ index: i, title: t.title, url: t.url })),
              activeIndex: currentSession ? activeTabIndex : null,
            });
          }

          case "activate": {
            if (params.index == null) return err("activate 需要 index 参数（Tab 索引，从 0 开始）");
            await ensureChromeAvailable();
            tabsCache = await listTabs(port);
            if (tabsCache.length === 0) throw new Error("Chrome 中暂无页面，请至少打开一个 Tab。");
            const idx = Number(params.index);
            if (idx < 0 || idx >= tabsCache.length) return err(`index 应在 0～${tabsCache.length - 1} 之间`);
            const tabIdx = tabsCache[idx];
            const reuseSession = currentSession && currentSession.targetId === tabIdx.id;
            if (!reuseSession) {
              if (currentSession) currentSession.close();
              activeTabIndex = idx;
              currentSession = new CdpBrowserSession(tabIdx.webSocketDebuggerUrl, 15000, tabIdx.id);
              await currentSession.connect();
            } else {
              activeTabIndex = idx;
            }
            const t = tabsCache[idx];
            return ok(`已切换到 Tab [${idx}]：${t.title || t.url}`, {
              activeIndex: idx,
              title: t.title,
              url: t.url,
            });
          }

          case "navigate": {
            if (!params.url) return err("navigate 需要 url 参数");
            await ensureConnected();
            await currentSession.navigate(params.url);
            const snapshot = await currentSession.snapshot();
            const preview = snapshot.slice(0, 2000);
            return ok(`已导航到 ${params.url}\n\n页面快照（前 2000 字）：\n${preview}`, {
              url: params.url,
              snapshotPreview: preview,
            });
          }

          case "snapshot": {
            await ensureConnected();
            const text = await currentSession.snapshot();
            const truncated = text.length > 30000 ? text.slice(0, 30000) + "\n\n[... 已截断]" : text;
            return ok(truncated, { length: text.length });
          }

          case "extract_text": {
            await ensureConnected();
            const maxLength = params.maxLength ?? 150000;
            const text = await currentSession.extractText({ maxLength });
            const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n\n[... 已截断]" : text;
            return ok(truncated, { length: text.length, maxLength });
          }

          case "head_info": {
            await ensureConnected();
            const info = await currentSession.headInfo();
            const lines = [
              `title: ${info.title || "(无)"}`,
              `canonical: ${info.canonical ?? "(无)"}`,
              `charset: ${info.charset ?? "(无)"}`,
              `viewport: ${info.viewport ?? "(无)"}`,
              "",
              "meta:",
              ...info.meta.map((m) => {
                const key = m.property || m.name || "content";
                return `  ${key}: ${(m.content || "").slice(0, 200)}`;
              }),
            ];
            const text = lines.join("\n");
            return ok(text, { title: info.title, metaCount: info.meta.length });
          }

          case "dom_tree": {
            await ensureConnected();
            const maxDepth = params.maxDepth ?? 6;
            const maxChildren = params.maxChildren ?? 12;
            const tree = await currentSession.domTree({ maxDepth, maxChildren });
            const truncated = tree.length > 15000 ? tree.slice(0, 15000) + "\n\n[... 已截断]" : tree;
            return ok(truncated, { maxDepth, maxChildren });
          }

          case "evaluate": {
            if (!params.expression) return err("evaluate 需要 expression 参数");
            await ensureConnected();
            const result = await currentSession.evaluate(params.expression);
            return ok(result, { expression: params.expression });
          }

          case "screenshot": {
            await ensureConnected();
            const { base64, mimeType } = await currentSession.screenshot();
            // 只把文本放进 content，模型才能稳定收到“成功”并继续；图片通过 details 由服务端推给前端展示
            return {
              content: [
                {
                  type: "text",
                  text: "截图已成功，已展示在对话中。请根据截图内容继续后续操作或回答用户。",
                },
              ],
              details: { mimeType, screenshotBase64: base64 },
            };
          }

          default:
            return err(`未知操作: ${params.action}`);
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return err(msg, { hint: "若提示无法连接 Chrome，请使用技能 cdp-browser-guide 引导用户开启远程调试。" });
      }
    },
  };
}
