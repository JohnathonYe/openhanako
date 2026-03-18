/**
 * cdp-client.js — 通过 CDP 连接本地 Chrome，多 Tab 管理与页面操作
 *
 * 依赖：Chrome 以 --remote-debugging-port=9222 启动后，本模块通过
 * GET /json/list 获取所有 Tab 的 webSocketDebuggerUrl，再对单个 Tab 建立
 * WebSocket 会话发送 CDP 命令（Page.navigate、DOM.*、Runtime.evaluate 等）。
 * 仅使用 ws 与原生 fetch，无额外 CDP 库。
 */

import WebSocket from "ws";

const DEFAULT_PORT = 9222;

/** 请求 id 递增 */
let _nextId = 1;
function nextId() {
  return _nextId++;
}

/**
 * 创建与单个 CDP 会话（一个 Tab）的 WebSocket 连接并发送/接收 JSON-RPC
 * @param {string} webSocketDebuggerUrl - 从 /json/list 得到的 ws URL
 * @param {number} timeoutMs - 单次命令超时
 * @returns {Promise<{ send(method, params): Promise<any>, close(): void }>}
 */
function connectSession(webSocketDebuggerUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: 8000 });
    const pending = new Map(); // id -> { resolve, reject, timer }

    ws.on("open", () => {
      const send = (method, params = {}) => {
        return new Promise((res, rej) => {
          const id = nextId();
          const timer = setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              rej(new Error(`CDP 命令超时: ${method}`));
            }
          }, timeoutMs);
          pending.set(id, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      };
      resolve({
        send,
        close: () => {
          ws.close();
        },
      });
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
    });

    ws.on("error", (err) => reject(err));
    ws.on("close", () => {
      pending.forEach((e) => {
        clearTimeout(e.timer);
        e.reject(new Error("CDP 连接已关闭"));
      });
      pending.clear();
    });
  });
}

/**
 * 获取浏览器所有可调试页面（Tab）列表
 * @param {number} port - 远程调试端口，默认 9222
 * @returns {Promise<Array<{ id: string, type: string, title: string, url: string, webSocketDebuggerUrl: string }>>}
 */
export async function listTabs(port = DEFAULT_PORT) {
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`无法连接 Chrome 调试端口 ${port}，请确认已用 --remote-debugging-port=${port} 启动 Chrome`);
  const list = await res.json();
  return list.filter((t) => t.type === "page").map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title || "",
    url: t.url || "",
    webSocketDebuggerUrl: t.webSocketDebuggerUrl,
  }));
}

/**
 * 检查指定端口是否有 Chrome 调试服务
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isChromeDebuggingAvailable(port = DEFAULT_PORT) {
  try {
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * CDP 浏览器会话封装：保持一个 Tab 的连接，提供 navigate / snapshot / evaluate 等
 */
export class CdpBrowserSession {
  /**
   * @param {string} webSocketDebuggerUrl - 该 Tab 的 CDP WebSocket URL
   * @param {number} [timeoutMs=15000]
   * @param {string} [targetId] - Tab 的 target id（来自 /json/list 的 id），截图前会先激活该 Tab 以保证渲染
   */
  constructor(webSocketDebuggerUrl, timeoutMs = 15000, targetId = null) {
    this._url = webSocketDebuggerUrl;
    this._timeoutMs = timeoutMs;
    this._targetId = targetId || null;
    this._session = null;
  }

  /** 是否已连接 */
  get connected() {
    return this._session != null;
  }

  /** Tab 的 target id（用于判断是否仍为同一 Tab，便于复用会话） */
  get targetId() {
    return this._targetId;
  }

  /**
   * 建立连接（在调用 navigate/snapshot 等前必须调用）
   */
  async connect() {
    if (this._session) return;
    this._session = await connectSession(this._url, this._timeoutMs);
  }

  /** 断开连接 */
  close() {
    if (this._session) {
      this._session.close();
      this._session = null;
    }
  }

  async _send(method, params = {}) {
    if (!this._session) await this.connect();
    return this._session.send(method, params);
  }

  /**
   * 导航到 URL
   * @param {string} url
   */
  async navigate(url) {
    await this._send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 800));
  }

  /**
   * 获取当前页面可读文本快照（便于 AI 理解页面内容）
   * 使用 DOM.getDocument + 递归取 innerText 的方式简化实现
   */
  async snapshot() {
    const result = await this._send("Runtime.evaluate", {
      expression: `
        (function() {
          function getText(node) {
            if (node.nodeType === 3) return node.textContent || '';
            if (node.nodeType !== 1) return '';
            var tag = node.tagName ? node.tagName.toLowerCase() : '';
            if (tag === 'script' || tag === 'style') return '';
            var text = '';
            for (var i = 0; i < node.childNodes.length; i++) text += getText(node.childNodes[i]);
            if (tag === 'input' || tag === 'textarea') {
              var v = node.value || node.placeholder || '';
              if (v) text = (text.trim() ? text + ' ' : '') + '[' + v + ']';
            }
            return text;
          }
          var body = document.body;
          return body ? getText(body).replace(/\\s+/g, ' ').trim().slice(0, 120000) : '';
        })();
      `,
      returnByValue: true,
    });
    if (result.exceptionDetails) return `[页面执行异常] ${result.exceptionDetails.text || ""}`;
    return (result.result && result.result.value) || "";
  }

  /**
   * 纯文本提取：仅提取页面中的可读文字，块级元素后换行，便于做摘要/检索
   * 与 snapshot 区别：保留段落换行、不把整页压成一行；可限制长度
   * @param {object} [opts]
   * @param {number} [opts.maxLength=150000] - 最大字符数，超出截断
   * @returns {Promise<string>}
   */
  async extractText(opts = {}) {
    const maxLen = opts.maxLength ?? 150000;
    const result = await this._send("Runtime.evaluate", {
      expression: `
        (function() {
          var BLOCK = { p:1, div:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, li:1, tr:1, br:1, hr:1, blockquote:1, pre:1, section:1, article:1, header:1, footer:1, nav:1, main:1 };
          function getText(node, out) {
            if (node.nodeType === 3) {
              var t = (node.textContent || '').trim();
              if (t) out.push(t);
              return;
            }
            if (node.nodeType !== 1) return;
            var tag = node.tagName ? node.tagName.toLowerCase() : '';
            if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
            if (tag === 'br' || tag === 'hr') { out.push(''); return; }
            for (var i = 0; i < node.childNodes.length; i++) getText(node.childNodes[i], out);
            if (tag === 'input' || tag === 'textarea') {
              var v = (node.value || node.placeholder || '').trim();
              if (v) out.push('[' + v + ']');
            }
            if (BLOCK[tag] && out.length > 0 && out[out.length-1] !== '') out.push('');
          }
          var out = [];
          var root = document.body;
          if (root) getText(root, out);
          var text = out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
          return text.slice(0, ${maxLen});
        })();
      `,
      returnByValue: true,
    });
    if (result.exceptionDetails) return `[纯文本提取异常] ${result.exceptionDetails.text || ""}`;
    return (result.result && result.result.value) || "";
  }

  /**
   * 在页面中执行 JavaScript，返回序列化结果
   * @param {string} expression
   * @returns {Promise<string>}
   */
  async evaluate(expression) {
    const result = await this._send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) return `[异常] ${result.exceptionDetails.text || ""}`;
    const v = result.result && result.result.value;
    if (v === undefined) return String(result.result?.description ?? "");
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  /**
   * 获取当前页 <head> 内重要信息：title、meta（description/keywords/og 等）、canonical、charset、viewport
   * @returns {Promise<{ title: string, meta: Array<{ name?: string, property?: string, content: string }>, canonical: string | null, charset: string | null, viewport: string | null }>}
   */
  async headInfo() {
    const result = await this._send("Runtime.evaluate", {
      expression: `
        (function() {
          var doc = document;
          var head = doc.head;
          if (!head) return { title: '', meta: [], canonical: null, charset: null, viewport: null };
          var title = doc.title || '';
          var meta = [];
          var list = head.querySelectorAll('meta');
          for (var i = 0; i < list.length; i++) {
            var m = list[i];
            var name = m.getAttribute('name') || m.getAttribute('property');
            var content = m.getAttribute('content') || '';
            if (name || content) meta.push({ name: name || null, property: m.getAttribute('property') || null, content: content });
          }
          var canonical = null;
          var link = head.querySelector('link[rel="canonical"]');
          if (link) canonical = link.getAttribute('href') || null;
          var charsetEl = head.querySelector('meta[charset]');
          var charset = charsetEl ? charsetEl.getAttribute('charset') : null;
          var vp = head.querySelector('meta[name="viewport"]');
          var viewport = vp ? vp.getAttribute('content') : null;
          return { title: title, meta: meta, canonical: canonical, charset: charset, viewport: viewport };
        })();
      `,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "headInfo 执行异常");
    return result.result?.value ?? { title: "", meta: [], canonical: null, charset: null, viewport: null };
  }

  /**
   * 获取页面 DOM 结构摘要（标签层级，便于理解页面骨架）
   * @param {object} [opts]
   * @param {number} [opts.maxDepth=6] - 最大深度
   * @param {number} [opts.maxChildren=12] - 每节点最多展示子节点数，超出显示为 "...+N"
   * @param {number} [opts.maxTotal=800] - 总节点数上限（约等于输出行数）
   * @returns {Promise<string>}
   */
  async domTree(opts = {}) {
    const maxDepth = opts.maxDepth ?? 6;
    const maxChildren = opts.maxChildren ?? 12;
    const maxTotal = opts.maxTotal ?? 800;
    const result = await this._send("Runtime.evaluate", {
      expression: `
        (function() {
          function desc(node) {
            if (node.nodeType !== 1) return null;
            var tag = node.tagName ? node.tagName.toLowerCase() : '?';
            var id = node.id ? '#' + node.id : '';
            var cls = node.className && typeof node.className === 'string' ? node.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
            if (cls) cls = '.' + cls;
            return tag + id + cls;
          }
          function walk(n, depth, out, limits) {
            if (depth > limits.maxDepth || out.length >= limits.maxTotal) return;
            var d = desc(n);
            if (!d) return;
            var indent = '  '.repeat(depth);
            var childCount = 0;
            for (var i = 0; i < n.childNodes.length; i++) {
              if (n.childNodes[i].nodeType === 1) childCount++;
            }
            var suffix = '';
            if (childCount > limits.maxChildren) suffix = ' (...+' + (childCount - limits.maxChildren) + ' more)';
            out.push(indent + d + (childCount > 0 ? ' (' + childCount + ')' : '') + suffix);
            var seen = 0;
            for (var j = 0; j < n.childNodes.length && out.length < limits.maxTotal; j++) {
              var c = n.childNodes[j];
              if (c.nodeType === 1) {
                seen++;
                if (seen <= limits.maxChildren) walk(c, depth + 1, out, limits);
                else if (seen === limits.maxChildren + 1) {
                  out.push('  '.repeat(depth + 1) + '...');
                  break;
                }
              }
            }
          }
          var limits = { maxDepth: ${maxDepth}, maxChildren: ${maxChildren}, maxTotal: ${maxTotal} };
          var out = [];
          var root = document.documentElement || document.body;
          if (root) walk(root, 0, out, limits);
          return out.join('\\n');
        })();
      `,
      returnByValue: true,
    });
    if (result.exceptionDetails) return `[DOM 结构获取异常] ${result.exceptionDetails.text || ""}`;
    return (result.result && result.result.value) || "";
  }

  /**
   * 截取截图（base64 JPEG，与 single_use_browser 一致）
   * 若构造时传入了 targetId，会先调用 Target.activateTarget 激活该 Tab 再截图，避免后台 Tab 未渲染导致失败。
   * @returns {Promise<{ base64: string, mimeType: string }>}
   */
  async screenshot() {
    if (this._targetId) {
      await this._send("Target.activateTarget", { targetId: this._targetId });
      await new Promise((r) => setTimeout(r, 400));
    }
    await this._send("Page.enable", {});
    const result = await this._send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 75,
      captureBeyondViewport: true,
    });
    const data = result && result.data;
    if (typeof data !== "string" || !data) {
      throw new Error(
        "截图失败：Chrome 未返回有效数据（若当前 Tab 在后台，工具已尝试激活；请确保 Chrome 窗口未被最小化）",
      );
    }
    return { base64: data, mimeType: "image/jpeg" };
  }
}
