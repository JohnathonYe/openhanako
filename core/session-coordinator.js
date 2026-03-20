/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { streamSimple } from "@mariozechner/pi-ai";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { wrapStreamFnForInvokeXml } from "./stream-invoke-normalizer.js";
import { filterImagesForModelInput } from "../lib/model-media-capabilities.js";

const log = createModuleLogger("session");

/** 巡检/定时任务默认工具白名单 */
export const PATROL_TOOLS_DEFAULT = [
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  "web_search", "web_fetch",
  "todo", "cron", "notify",
  "present_files", "message_agent",
];

const STEER_PREFIX = "（插话，无需 MOOD）\n";
const MAX_CACHED_SESSIONS = 20;

export class SessionCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - 列出所有 agent
   * @param {() => Promise<void>} [deps.flushBridgeOwnerMemory] - 收尾 Bridge 本人会话记忆
   */
  constructor(deps) {
    this._d = deps;
    this._session = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._headlessRefCount = 0;
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? null;
  }

  // ── Session 创建 / 切换 ──

  async createSession(sessionMgr, cwd, memoryEnabled = true) {
    const t0 = Date.now();
    const effectiveCwd = cwd || this._d.getHomeCwd() || process.cwd();
    const agent = this._d.getAgent();
    const models = this._d.getModels();
    log.log(`createSession cwd=${effectiveCwd} (传入: ${cwd || "未指定"})`);

    if (!models.currentModel) {
      throw new Error("没有可用的模型，请先在设置中配置 API key 和模型");
    }

    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }

    // 必须在 createAgentSession 前切换 session 级记忆状态，
    // 否则首轮 prompt 会沿用上一个 session 的 system prompt。
    agent.setMemoryEnabled(memoryEnabled);

    const { tools: sessionTools, customTools: sessionCustomTools } = await this._d.buildTools(effectiveCwd);
    const { session } = await createAgentSession({
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      model: models.currentModel,
      thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
      resourceLoader: this._d.getResourceLoader(),
      tools: sessionTools,
      customTools: sessionCustomTools,
      streamFn: wrapStreamFnForInvokeXml(streamSimple),
    });
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${models.currentModel?.name || "?"}`);
    this._session = session;
    this._sessionStarted = false;

    // 按当前「操作电脑」状态过滤工具：未开启时禁用 cdp_local_browser、single_use_browser、create_script_tool、install_skill 及技能 cdp-browser-guide
    if (this._d.syncPlanModeToSession) this._d.syncPlanModeToSession();

    // 事件转发
    const sessionPath = session.sessionManager?.getSessionFile?.();
    const unsub = session.subscribe((event) => {
      this._d.emitEvent(event, sessionPath);
    });

    // 存入 map
    const mapKey = sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();
    this._sessions.set(mapKey, { session, unsub });

    // 淘汰
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      for (const [key, entry] of this._sessions) {
        if (key === mapKey) continue;
        entry.unsub();
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return session;
  }

  async switchSession(sessionPath) {
    // 不按「文件所在 agents/某 id/sessions」强制切换主助手：
    // handoff 合并同一条 JSONL 后，文件仍在原助手目录，primary 已是转交目标；
    // 若此处 switchAgentOnly(路径归属)，会把主助手切回 3 号，后续回复又变成 3 号。
    // 打开会话始终以**当前** primary 重建 Pi session（与 reopenSessionAtPath / bridge 一致）。
    // 用户若要换成「路径归属助手」的人格，请用界面切换主助手后再点该会话。

    let memoryEnabled = true;
    try {
      const metaPath = path.join(path.dirname(sessionPath), "session-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const sessKey = path.basename(sessionPath);
      if (meta[sessKey]?.memoryEnabled === false) memoryEnabled = false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`session-meta.json 读取失败: ${err.message}`);
      }
    }

    // 如果已在 map 中，切指针
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session?.sessionManager?.getSessionFile?.();
        if (oldSp) await this._d.getAgent()?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
      }
      this._session = existing.session;
      this._d.getAgent()?.setMemoryEnabled(memoryEnabled);
      return existing.session;
    }

    // 不在 map 中，先 flush 当前再新建
    if (this._session) {
      const oldSp = this._session?.sessionManager?.getSessionFile?.();
      if (oldSp) await this._d.getAgent()?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
    }
    const sessionDir = path.dirname(sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    return this.createSession(sessionMgr, cwd, memoryEnabled);
  }

  /**
   * handoff 专用：在已 switchAgentOnly(目标) 后，用**同一** JSONL 路径重建 Pi session（模型可见完整历史）。
   * sessionPath 可位于原助手目录下；SessionManager 使用文件所在目录为第二参数（与 bridge 一致）。
   * @param {string} sessionPath
   */
  async reopenSessionAtPath(sessionPath) {
    const agentsDir = this._d.agentsDir;
    const resolved = path.resolve(sessionPath);
    const base = path.resolve(agentsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error("reopenSessionAtPath: 非法 session 路径");
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`reopenSessionAtPath: 文件不存在 ${resolved}`);
    }

    if (this._session) {
      const oldSp = this._session?.sessionManager?.getSessionFile?.();
      if (oldSp) await this._d.getAgent()?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
    }
    for (const [, entry] of this._sessions) {
      entry.unsub();
    }
    this._sessions.clear();
    this._session = null;

    let memoryEnabled = true;
    try {
      const metaPath = path.join(path.dirname(sessionPath), "session-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const sessKey = path.basename(sessionPath);
      if (meta[sessKey]?.memoryEnabled === false) memoryEnabled = false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`reopenSessionAtPath session-meta: ${err.message}`);
      }
    }

    const sessionDir = path.dirname(sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    return this.createSession(sessionMgr, cwd, memoryEnabled);
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error("没有活跃的 session，请先调用 createSession()");
    this._sessionStarted = true;
    const sessionModel = this._session.model;
    const origImages = opts?.images;
    let images = filterImagesForModelInput(origImages, sessionModel?.input);
    let effectiveText = text;
    if ((!effectiveText || !String(effectiveText).trim()) && origImages?.length && !images?.length) {
      effectiveText = "（所附媒体已省略：当前模型不支持。）";
    }
    const promptOpts = images?.length ? { images } : undefined;
    if (promptOpts?.images?.length) {
      const mimes = promptOpts.images.map((im) => im.mimeType).join(", ");
      log.log(
        `prompt → model: ${promptOpts.images.length} media [${mimes}], textLen=${(effectiveText || "").length}, model.input=${JSON.stringify(sessionModel?.input)}`,
      );
    }
    await this._session.prompt(effectiveText, promptOpts);
    const sp = this._session?.sessionManager?.getSessionFile?.();
    if (sp) this._d.getAgent()?._memoryTicker?.notifyTurn(sp);
  }

  async abort() {
    if (this._session?.isStreaming) {
      await this._session.abort();
    }
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    this._session.steer(STEER_PREFIX + text);
    return true;
  }

  // ── Session 关闭 ──

  async closeSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
      this._sessions.delete(sessionPath);
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
    }
  }

  async closeAllSessions() {
    const agent = this._d.getAgent();
    if (this._session) {
      const curSp = this._session?.sessionManager?.getSessionFile?.();
      if (curSp && agent?.memoryTicker?.notifySessionEnd) {
        await agent.memoryTicker.notifySessionEnd(curSp).catch(() => {});
      }
    }
    if (this._d.flushBridgeOwnerMemory) {
      await this._d.flushBridgeOwnerMemory().catch(() => {});
    }
    for (const [, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
    }
    this._sessions.clear();
    this._session = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  isSessionStreaming(sessionPath) {
    return !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  async abortSessionByPath(sessionPath) {
    const session = this.getSessionByPath(sessionPath);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async listSessions() {
    const allSessions = [];
    const agents = this._d.listAgents();

    for (const agent of agents) {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      if (!fs.existsSync(sessionDir)) continue;
      try {
        const sessions = await SessionManager.list(process.cwd(), sessionDir);
        const titles = await this._loadSessionTitlesFor(sessionDir);
        for (const s of sessions) {
          if (titles[s.path]) s.title = titles[s.path];
          s.agentId = agent.id;
          s.agentName = agent.name;
          allSessions.push(s);
        }
      } catch {}
    }

    const currentPath = this.currentSessionPath;
    const activeAgentId = this._d.getActiveAgentId();
    if (currentPath && this._sessionStarted && !allSessions.find(s => s.path === currentPath)) {
      allSessions.unshift({
        path: currentPath,
        title: null,
        firstMessage: "",
        modified: new Date(),
        messageCount: 0,
        cwd: this._session?.sessionManager?.getCwd?.() || "",
        agentId: activeAgentId,
        agentName: this._d.getAgent().agentName,
      });
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    titles[sessionPath] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async _loadSessionTitlesFor(sessionDir) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts), // async
      resolveModel:   (agentConfig) => {
        let id = agentConfig?.models?.chat;
        // 非 active agent 可能没有配 models.chat（模板默认为空），回退到全局默认模型
        if (!id) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定 models.chat，回退到默认模型 ${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error("resolveModel: 未指定 models.chat，无法选择模型");
        }
        const found = models.availableModels.find(m => m.id === id);
        if (!found) {
          // 模型 ID 在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          const hasAuth = models.modelRegistry
            ? `hasAuth("${models.inferModelProvider?.(id) || "?"}")=unknown`
            : "no registry";
          log.error(`[resolveModel] 找不到模型 "${id}"。availableModels=[${available}]。${hasAuth}`);
          throw new Error(`resolveModel: 模型 "${id}" 不在可用列表中`);
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile) {
    const agent = this._d.getAgent();
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile}`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  async executeIsolated(prompt, opts = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(`agent "${opts.agentId}" 不存在或未初始化`);

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.isRunning;
    this._headlessRefCount++;
    if (this._headlessRefCount === 1) bm.setHeadless(true);
    let tempSessionMgr;
    const cleanupTempSession = () => {
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || targetAgent.sessionDir;
      fs.mkdirSync(sessionDir, { recursive: true });

      const execCwd = opts.cwd || this._d.getHomeCwd() || process.cwd();
      const models = this._d.getModels();
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        const preferredId = targetAgent.config?.models?.chat;
        if (preferredId) {
          resolvedModel = models.availableModels.find(m => m.id === preferredId);
          if (!resolvedModel) {
            const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
            log.error(`[executeIsolated] 找不到模型 "${preferredId}"。availableModels=[${available}]`);
            throw new Error(`executeIsolated: 模型 "${preferredId}" 不在可用列表中`);
          }
        } else {
          // 主界面模型药丸只改 sessionModel（currentModel），不写 config.models.chat；
          // 当前助手的心跳/巡检应与主对话一致，故优先用 currentModel。
          const activeAgent = this._d.getAgent();
          if (targetAgent === activeAgent && models.currentModel) {
            log.log(
              `[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，使用当前会话模型 ${models.currentModel.id}`,
            );
            resolvedModel = models.currentModel;
          } else if (models.defaultModel) {
            log.log(
              `[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，回退到默认模型 ${models.defaultModel.id}`,
            );
            resolvedModel = models.defaultModel;
          } else {
            log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat`);
            throw new Error(`executeIsolated: agent "${targetAgent.agentName}" 未指定 models.chat`);
          }
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const { tools: allBuiltinTools, customTools: allCustomTools } = await this._d.buildTools(
        execCwd, targetAgent.tools, { agentDir: targetAgent.agentDir }
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      const allowSet = new Set(patrolAllowed);
      const actCustomTools = allCustomTools.filter(t => allowSet.has(t.name));

      // builtin tools 过滤：传入 builtinFilter 时只保留白名单内的 builtin 工具
      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      const execResourceLoader = (targetAgent === agent)
        ? resourceLoader
        : Object.create(resourceLoader, {
            getSystemPrompt: { value: () => targetAgent.systemPrompt },
            getSkills: { value: () => skills.getSkillsForAgent(targetAgent) },
          });

      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: actCustomTools,
        streamFn: wrapStreamFnForInvokeXml(streamSimple),
      });

      let replyText = "";
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
      });

      // abort signal：监听中止，转发到子 session
      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      // 二次检查：覆盖初始化期间 signal 已变 aborted 的竞争窗口
      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        unsub?.();
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        unsub?.();
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;

      // 流未产出 text_delta 时，从 persist 的 session 文件补全最后一条 assistant 文本（供巡检笺 COMPLETED 解析等）
      if (replyText === "" && sessionPath && opts.persist) {
        try {
          const raw = fs.readFileSync(sessionPath, "utf-8");
          let lastAssistantText = "";
          for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type !== "message" || !entry.message) continue;
              const msg = entry.message;
              if (msg.role !== "assistant") continue;
              const content = msg.content;
              if (Array.isArray(content)) {
                lastAssistantText = content.filter(b => b.type === "text" && b.text).map(b => b.text).join("");
              } else if (typeof content === "string") {
                lastAssistantText = content;
              }
            } catch { /* 跳过损坏行 */ }
          }
          if (lastAssistantText) replyText = lastAssistantText;
        } catch {}
      }

      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
        return { sessionPath: null, replyText, error: null };
      }

      return { sessionPath, replyText, error: null };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      // 清理失败的临时 session 文件
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      this._headlessRefCount = Math.max(0, this._headlessRefCount - 1);
      if (this._headlessRefCount === 0) bm.setHeadless(false);
      const browserNowRunning = bm.isRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning, url: bm.currentUrl }, null);
      }
    }
  }
}
