/**
 * HanaEngine — Hanako 的核心引擎（Thin Facade）
 *
 * 持有所有 Manager，对外暴露统一 API。
 * 具体逻辑委托给：
 *   - AgentManager       — agent CRUD / init / switch
 *   - SessionCoordinator — session 生命周期 / listing
 *   - ConfigCoordinator  — 配置读写 / 模型 / 搜索 / utility
 *   - ChannelManager     — 频道 CRUD / 成员管理
 *   - BridgeSessionManager — 外部平台 session
 *   - ModelManager        — 模型注册 / 发现
 *   - PreferencesManager  — 全局偏好
 *   - SkillManager        — 技能注册 / 同步
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  DefaultResourceLoader,
  codingTools,
  grepTool,
  findTool,
  lsTool,
} from "@mariozechner/pi-coding-agent";

/** 已知的外部 AI 工具技能目录（相对 $HOME） */
const WELL_KNOWN_SKILL_PATHS = [
  { suffix: ".claude/skills",     label: "Claude Code" },
  { suffix: ".codex/skills",      label: "Codex" },
  { suffix: ".openclaw/skills",   label: "OpenClaw" },
  { suffix: ".pi/agent/skills",   label: "Pi" },
  { suffix: ".agents/skills",     label: "Agents" },
];

const allBuiltInTools = [...codingTools, grepTool, findTool, lsTool];

import { syncSkills, migrateDeskRequiredRulesSkill } from "./first-run.js";
import { PreferencesManager } from "./preferences-manager.js";
import { ModelManager } from "./model-manager.js";
import { SkillManager } from "./skill-manager.js";
import { BridgeSessionManager } from "./bridge-session-manager.js";
import { AgentManager } from "./agent-manager.js";
import { SessionCoordinator } from "./session-coordinator.js";
import { ConfigCoordinator, PLAN_MODE_ONLY_SKILLS, SHARED_MODEL_KEYS } from "./config-coordinator.js";
import { ChannelManager } from "./channel-manager.js";
import {
  summarizeTitle as _summarizeTitle,
  translateSkillNames as _translateSkillNames,
  summarizeActivity as _summarizeActivity,
  summarizeActivityQuick as _summarizeActivityQuick,
} from "./llm-utils.js";
import { debugLog } from "../lib/debug-log.js";
import { createSandboxedTools } from "../lib/sandbox/index.js";
import { t, getLocale } from "../server/i18n.js";
import { getToolRegistry } from "../lib/tools/registry.js";
import { loadUserScriptTools } from "../lib/tools/user-script-loader.js";
import { wrapToolWithDebugLog } from "../lib/tools/tool-debug-log.js";

export class HanaEngine {
  /**
   * @param {object} dirs
   * @param {string} dirs.hanakoHome
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   */
  constructor({ hanakoHome, productDir, agentId }) {
    this.hanakoHome = hanakoHome;
    this.productDir = productDir;
    this.agentsDir = path.join(hanakoHome, "agents");
    this.userDir = path.join(hanakoHome, "user");
    this.channelsDir = path.join(hanakoHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });

    // ── Core managers ──
    this._prefs = new PreferencesManager({ userDir: this.userDir, agentsDir: this.agentsDir });
    this._models = new ModelManager({ hanakoHome });

    // 确定启动时焦点 agent
    const startId = agentId || this._prefs.getPrimaryAgent() || this._prefs.findFirstAgent();
    if (!startId) throw new Error(t("error.noAgentsFound"));

    // ── Channel Manager ──
    this._channels = new ChannelManager({
      channelsDir: this.channelsDir,
      agentsDir: this.agentsDir,
      userDir: this.userDir,
      getHub: () => this._hub,
    });

    // ── Agent Manager ──
    this._agentMgr = new AgentManager({
      agentsDir: this.agentsDir,
      productDir: this.productDir,
      userDir: this.userDir,
      channelsDir: this.channelsDir,
      getPrefs: () => this._prefs,
      getModels: () => this._models,
      getHub: () => this._hub,
      getSkills: () => this._skills,
      getSearchConfig: () => this.getSearchConfig(),
      resolveUtilityConfig: () => this.resolveUtilityConfig(),
      getSharedModels: () => this._configCoord.getSharedModels(),
      getChannelManager: () => this._channels,
      getSessionCoordinator: () => this._sessionCoord,
      getEngine: () => this,
      getResourceLoader: () => this._resourceLoader,
    });

    // ── Session Coordinator ──
    this._sessionCoord = new SessionCoordinator({
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getActiveAgentId: () => this.currentAgentId,
      getModels: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getSkills: () => this._skills,
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      getHomeCwd: () => this.homeCwd,
      agentIdFromSessionPath: (p) => this.agentIdFromSessionPath(p),
      switchAgentOnly: (id) => this._agentMgr.switchAgentOnly(id),
      getConfig: () => this.config,
      getPrefs: () => this._prefs,
      getAgents: () => this._agentMgr.agents,
      getActivityStore: (id) => this.getActivityStore(id),
      getAgentById: (id) => this._agentMgr.getAgent(id),
      listAgents: () => this.listAgents(),
      syncPlanModeToSession: () => this.setPlanMode(this.planMode),
      applyPlanDraftTodoOnly: (sp) => this.applyPlanDraftTodoOnly(sp),
      syncSessionToolsToPlanMode: (sp) => this.syncSessionToolsToPlanMode(sp),
      flushBridgeOwnerMemory: () => this.flushBridgeOwnerMemory(),
    });

    // ── Config Coordinator ──
    this._configCoord = new ConfigCoordinator({
      hanakoHome,
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getAgents: () => this._agentMgr.agents,
      getModels: () => this._models,
      getPrefs: () => this._prefs,
      getSkills: () => this._skills,
      getSession: () => this._sessionCoord.session,
      getHub: () => this._hub,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getCurrentModel: () => this.currentModel?.name,
    });

    // ── Bridge Session Manager ──
    this._bridge = new BridgeSessionManager({
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getAllAgents: () => [...this._agentMgr.agents.values()],
      getSkillsForAgent: (ag) => this._getSkillsForAgent(ag),
      getModelManager: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getPreferences: () => this._readPreferences(),
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      getHomeCwd: () => this.homeCwd,
      applyPendingHandoff: () => this.applyPendingServiceHandoffIfAny(),
    });

    // Pi SDK resources（init 时填充）
    this._resourceLoader = null;

    // 事件系统
    this._listeners = new Set();
    this._eventBus = null;

    // DevTools 日志
    this._devLogs = [];
    this._devLogsMax = 200;

    // 设置起始 agentId
    this._agentMgr.activeAgentId = startId;

    /** handoff_service 工具在主聊天中排队，于本轮 turn_end 后切换 agent 并代为 prompt */
    this._pendingServiceHandoff = null;
    /** Bridge 本人私聊 handoff 后，首轮回复发到 IM 后再由新助手接棒一条 */
    this._bridgeImHandoffFollowup = null;
    /** @type {((msg: object) => void) | null} WebSocket 广播，由 chat 路由注入 */
    this._agentSwitchBroadcast = null;
    /** handoff 触发的续写回合不经由 WS prompt，需单独广播 status 以同步 isStreaming */
    this._handoffStreamingBroadcast = null;
  }

  // ════════════════════════════
  //  Agent 代理（→ AgentManager）
  // ════════════════════════════

  get agent() { return this._agentMgr.agent; }
  getAgent(agentId) { return this._agentMgr.getAgent(agentId); }
  get currentAgentId() { return this._agentMgr.activeAgentId; }
  get confirmStore() { return this._confirmStore; }

  // 向后兼容 getter
  get agentDir() { return this.agent?.agentDir || path.join(this.agentsDir, this.currentAgentId); }
  get baseDir() { return this.agentDir; }
  get activityDir() { return path.join(this.agentDir, "activity"); }
  get activityStore() { return this.getActivityStore(this.currentAgentId); }
  getActivityStore(agentId) { return this._agentMgr.getActivityStore(agentId); }

  get agents() { return this._agentMgr.agents; }
  listAgents() { return this._agentMgr.listAgents(); }
  invalidateAgentListCache() { this._agentMgr.invalidateAgentListCache(); }
  async createAgent(opts) { return this._agentMgr.createAgent(opts); }
  async switchAgent(agentId) { return this._agentMgr.switchAgent(agentId); }
  /** handoff：切主助手但保留当前 JSONL（同线程上下文） */
  async switchAgentKeepSession(agentId) { return this._agentMgr.switchAgentKeepSession(agentId); }

  /**
   * 主聊天专用：排队在下一轮 turn 结束后切换服务对象并发送转交任务
   * @param {{ agentId: string, task: string, fromAgentId?: string, fromAgentName?: string }|null} payload
   */
  setPendingServiceHandoff(payload) {
    if (!payload?.agentId || typeof payload.task !== "string" || !String(payload.task).trim()) {
      this._pendingServiceHandoff = null;
      return;
    }
    this._pendingServiceHandoff = {
      agentId: payload.agentId,
      task: String(payload.task).trim(),
      fromAgentId: payload.fromAgentId || null,
      fromAgentName: payload.fromAgentName || null,
    };
  }

  /**
   * Bridge IM 私聊：handoff_service 已切换会话助手后排队，首轮助手回复发出后再跑一轮接棒（新助手开口）
   * @param {{ sessionKey: string, task?: string, mode?: 'switch'|'clear' }} payload
   */
  queueBridgeImHandoffFollowup(payload) {
    if (!payload?.sessionKey || typeof payload.sessionKey !== "string") return;
    const sk = payload.sessionKey.trim();
    if (!sk) return;
    const mode = payload.mode === "clear" ? "clear" : "switch";
    this._bridgeImHandoffFollowup = {
      sessionKey: sk,
      task: typeof payload.task === "string" ? payload.task.trim() : "",
      mode,
    };
  }

  /**
   * 由 bridge-manager 在首轮回复发到平台后调用：若队列匹配 sessionKey，则以新助手生成一条接棒回复
   * @param {string} sessionKey
   * @param {object} [meta]
   * @returns {Promise<string|null>}
   */
  async runBridgeHandoffFollowupMessage(sessionKey, meta) {
    const fu = this._bridgeImHandoffFollowup;
    if (!fu || fu.sessionKey !== sessionKey) return null;
    this._bridgeImHandoffFollowup = null;
    const isZh = getLocale().startsWith("zh");
    let prompt;
    if (fu.mode === "clear") {
      prompt = isZh
        ? "【系统】用户已把本对话恢复为设置中的默认 Bridge 助手。你可以看到之前的对话记录。请用一两句简短、自然的话向用户确认你已接棒。"
        : "[System] The user restored this chat to the default Bridge assistant. You can see prior conversation history. Briefly confirm you're taking over.";
    } else {
      const taskPart = fu.task
        ? (isZh ? `\n转交说明：${fu.task}` : `\nTask: ${fu.task}`)
        : "";
      prompt = isZh
        ? `【系统】用户刚把本社交平台对话转交给你。你可以看到之前的对话记录。${taskPart}\n请用一两句简短、自然的话向用户确认你已接棒，并可简要回应转交事项（如有）。`
        : `[System] The user handed this chat to you. You can see prior conversation history.${taskPart}\nBriefly confirm you're taking over and respond to the task if any.`;
    }
    return this.executeExternalMessage(prompt, sessionKey, meta, { isBridgeHandoffFollowup: true });
  }

  /** 由 server/routes/chat 注册，用于 handoff 后同步桌面当前助手与会话 */
  setAgentSwitchBroadcast(fn) {
    this._agentSwitchBroadcast = typeof fn === "function" ? fn : null;
  }

  /** @param {(streaming: boolean) => void} [fn] */
  setHandoffStreamingBroadcast(fn) {
    this._handoffStreamingBroadcast = typeof fn === "function" ? fn : null;
  }

  /** 在 WebSocket turn_end 或 Bridge owner 轮结束后调用：切换 agent 并向新会话发送转交任务 */
  async applyPendingServiceHandoffIfAny() {
    const p = this._pendingServiceHandoff;
    if (!p) return;
    this._pendingServiceHandoff = null;
    try {
      const keepPath = this.currentSessionPath;
      if (keepPath) {
        await this.switchAgentKeepSession(p.agentId);
        await this.reopenSessionAtPath(keepPath);
      } else {
        await this.switchAgent(p.agentId);
        if (!this.session) await this.createSession();
      }
      await new Promise((resolve) => setImmediate(resolve));

      const toYuan = this.agent?.config?.agent?.yuan || "hanako";
      try {
        this._agentSwitchBroadcast?.({
          type: "agent_switched",
          agentId: this.currentAgentId,
          agentName: this.agentName,
          yuan: toYuan,
          sessionPath: this.currentSessionPath,
          handoff: {
            fromAgentId: p.fromAgentId,
            fromAgentName: p.fromAgentName || p.fromAgentId || "助手",
            toAgentId: p.agentId,
            toAgentName: this.agentName,
            task: p.task.trim(),
          },
        });
      } catch {}

      const from = p.fromAgentName || p.fromAgentId || "另一位助手";
      const task = p.task.trim();
      const sess = this.session;
      if (!sess) {
        throw new Error("handoff: 切换后无活跃 session");
      }

      // 两段 custom 消息：
      // 1) 可见转交说明（不触发回合）— 持久化到 JSONL 供历史回放
      // 2) 不可见执行指令（触发回合）— 新助手以独立气泡回复
      if (typeof sess.sendCustomMessage === "function") {
        const handoffText =
          `助手「${from}」向你转交：${task}\n\n` +
          `请按你的身份直接对用户回应；不要复述或模仿用户口吻。`;

        await sess.sendCustomMessage(
          {
            customType: "hana_handoff",
            content: handoffText,
            display: true,
            details: {
              fromAgentId: p.fromAgentId,
              fromAgentName: p.fromAgentName,
              toAgentId: p.agentId,
              toAgentName: this.agentName,
              task,
            },
          },
          { triggerTurn: false },
        );

        this._handoffStreamingBroadcast?.(true);
        try {
          await sess.sendCustomMessage(
            {
              customType: "hana_handoff_instruction",
              content: "请按转交事项直接对用户回应；不要复述或模仿用户口吻。",
              display: false,
              details: {
                fromAgentId: p.fromAgentId,
                fromAgentName: p.fromAgentName,
                toAgentId: p.agentId,
                task,
              },
            },
            { triggerTurn: true },
          );
        } finally {
          this._handoffStreamingBroadcast?.(false);
        }
      } else {
        this._handoffStreamingBroadcast?.(true);
        try {
          await this.prompt(
            `【助手「${from}」转交】\n事项：${task}\n\n请按你的身份完成，勿用用户口吻复述。`,
          );
        } finally {
          this._handoffStreamingBroadcast?.(false);
        }
      }
    } catch (err) {
      console.error(`[engine] applyPendingServiceHandoffIfAny: ${err.message}`);
    }
  }
  async deleteAgent(agentId) { return this._agentMgr.deleteAgent(agentId); }
  setPrimaryAgent(agentId) { return this._agentMgr.setPrimaryAgent(agentId); }
  agentIdFromSessionPath(p) { return this._agentMgr.agentIdFromSessionPath(p); }
  async createSessionForAgent(agentId, cwd, mem) { return this._agentMgr.createSessionForAgent(agentId, cwd, mem); }

  // 向后兼容：agent 属性代理
  get agentName() { return this.agent.agentName; }
  set agentName(v) { this.agent.agentName = v; }
  get userName() { return this.agent.userName; }
  set userName(v) { this.agent.userName = v; }
  get configPath() { return this.agent.configPath; }
  get sessionDir() { return this.agent.sessionDir; }
  get factsDbPath() { return this.agent.factsDbPath; }
  get memoryMdPath() { return this.agent.memoryMdPath; }

  // ════════════════════════════
  //  Session 代理（→ SessionCoordinator）
  // ════════════════════════════

  get session() { return this._sessionCoord.session; }
  get messages() { return this._sessionCoord.session?.messages ?? []; }
  get isStreaming() { return this._sessionCoord.session?.isStreaming ?? false; }
  get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
  get cwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() ?? process.cwd(); }
  get deskCwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() || this.homeCwd || null; }

  async createSession(mgr, cwd, mem) { return this._sessionCoord.createSession(mgr, cwd, mem); }
  async reopenSessionAtPath(sessionPath) { return this._sessionCoord.reopenSessionAtPath(sessionPath); }
  async switchSession(p) { return this._sessionCoord.switchSession(p); }
  /** @deprecated Phase 2: 使用 promptSession(path, text, opts) */
  async prompt(text, opts) { return this._sessionCoord.prompt(text, opts); }

  /**
   * Bridge（外部平台）实际使用的助手：preferences.bridge.ownerAgentId 指定，否则为当前主界面助手。
   */
  getBridgeAgent() {
    const id = this._readPreferences()?.bridge?.ownerAgentId;
    if (id && typeof id === "string" && id.trim()) {
      const a = this._agentMgr.getAgent(id.trim());
      if (a) return a;
    }
    return this.agent;
  }

  /** 当前助手 + Bridge 专用助手：收尾 Bridge 本人会话 JSONL（避免切主界面后漏刷 Bridge 助手） */
  async flushBridgeOwnerMemory() {
    const ids = new Set([this.currentAgentId]);
    const bid = this._readPreferences()?.bridge?.ownerAgentId;
    if (bid && typeof bid === "string" && bid.trim()) ids.add(bid.trim());
    const bySession = this._readPreferences()?.bridge?.chatAgentBySession;
    if (bySession && typeof bySession === "object") {
      for (const v of Object.values(bySession)) {
        if (v && typeof v === "string" && v.trim()) ids.add(v.trim());
      }
    }
    for (const id of ids) {
      await this._agentMgr.getAgent(id)?.flushBridgeOwnerMemory?.();
    }
  }

  /** @deprecated Phase 2: 使用 abortSession(path) */
  async abort() { return this._sessionCoord.abort(); }
  /** @deprecated Phase 2: 使用 steerSession(path, text) */
  steer(text) { return this._sessionCoord.steer(text); }

  // ── Path 感知 API（Phase 2） ──
  async promptSession(p, text, opts) { return this._sessionCoord.promptSession(p, text, opts); }
  steerSession(p, text) { return this._sessionCoord.steerSession(p, text); }
  async abortSession(p) { return this._sessionCoord.abortSession(p); }
  get focusSessionPath() { return this._sessionCoord.currentSessionPath; }
  getMessages(p) { return this._sessionCoord.getSessionByPath(p)?.messages ?? []; }

  async abortAllStreaming() { return this._sessionCoord.abortAllStreaming(); }
  isBridgeSessionStreaming(key) { return this._bridge?.isSessionStreaming(key) ?? false; }
  async abortBridgeSession(key) { return this._bridge?.abortSession(key) ?? false; }
  steerBridgeSession(key, text) { return this._bridge?.steerSession(key, text) ?? false; }
  async closeSession(p) { return this._sessionCoord.closeSession(p); }
  getSessionByPath(p) { return this._sessionCoord.getSessionByPath(p); }
  isSessionStreaming(p) { return this._sessionCoord.isSessionStreaming(p); }
  async abortSessionByPath(p) { return this._sessionCoord.abortSessionByPath(p); }
  async listSessions() { return this._sessionCoord.listSessions(); }
  async saveSessionTitle(p, t) { return this._sessionCoord.saveSessionTitle(p, t); }
  createSessionContext() { return this._sessionCoord.createSessionContext(); }
  promoteActivitySession(f) { return this._sessionCoord.promoteActivitySession(f); }
  async executeIsolated(prompt, opts) { return this._sessionCoord.executeIsolated(prompt, opts); }

  // ════════════════════════════
  //  Config 代理（→ ConfigCoordinator）
  // ════════════════════════════

  get config() { return this.agent.config; }
  get factStore() { return this.agent.factStore; }
  get currentModel() { return this._sessionCoord.session?.model ?? this._models.currentModel; }
  get availableModels() { return this._models.availableModels; }
  get memoryEnabled() { return this.agent.memoryEnabled; }
  get planMode() { return this._configCoord.planMode; }
  get homeCwd() { return this._configCoord.getHomeFolder() || null; }
  get authStorage() { return this._models.authStorage; }
  get modelRegistry() { return this._models.modelRegistry; }
  get providerRegistry() { return this._models.providerRegistry; }
  get preferences() { return this._prefs; }

  /** 刷新可用模型列表（含 OAuth 自定义模型注入） */
  async refreshModels() { return this._models.refreshAvailable(); }

  getHomeFolder() { return this._configCoord.getHomeFolder(); }
  setHomeFolder(f) { return this._configCoord.setHomeFolder(f); }
  getSharedModels() { return this._configCoord.getSharedModels(); }
  setSharedModels(p) { return this._configCoord.setSharedModels(p); }
  getSearchConfig() { return this._configCoord.getSearchConfig(); }
  setSearchConfig(p) { return this._configCoord.setSearchConfig(p); }
  getUtilityApi() { return this._configCoord.getUtilityApi(); }
  setUtilityApi(p) { return this._configCoord.setUtilityApi(p); }
  resolveUtilityConfig() { return this._configCoord.resolveUtilityConfig(); }
  readFavorites() { return this._configCoord.readFavorites(); }
  async saveFavorites(f) { return this._configCoord.saveFavorites(f); }
  readAgentOrder() { return this._configCoord.readAgentOrder(); }
  saveAgentOrder(o) { return this._configCoord.saveAgentOrder(o); }
  async syncModelsAndRefresh(f) { return this._configCoord.syncModelsAndRefresh(f); }
  async setModel(id) { return this._configCoord.setModel(id); }
  getThinkingLevel() { return this._configCoord.getThinkingLevel(); }
  setThinkingLevel(l) { return this._configCoord.setThinkingLevel(l); }
  getSandbox() { return this._prefs.getSandbox(); }
  setSandbox(v) { this._prefs.setSandbox(v); }
  getLearnSkills() { return this._prefs.getLearnSkills(); }
  setLearnSkills(p) { this._prefs.setLearnSkills(p); }
  getLocale() { return this._prefs.getLocale(); }
  setLocale(l) { this._prefs.setLocale(l); }
  getTimezone() { return this._prefs.getTimezone(); }
  setTimezone(tz) { this._prefs.setTimezone(tz); }
  getUpdateChannel() { return this._prefs.getUpdateChannel(); }
  setUpdateChannel(ch) { this._prefs.setUpdateChannel(ch); }
  setMemoryEnabled(v) { return this._configCoord.setMemoryEnabled(v); }
  setMemoryMasterEnabled(id, v) { return this._configCoord.setMemoryMasterEnabled(id, v); }
  persistMemoryEnabled() { return this._configCoord.persistMemoryEnabled(); }
  setPlanMode(enabled) { return this._configCoord.setPlanMode(enabled, allBuiltInTools); }

  /** /plan 仅规划阶段：本轮仅允许 todo 工具，结束后恢复为 Plan Mode 对应工具集 */
  applyPlanDraftTodoOnly(sessionPath) {
    const entry = this._sessionCoord.sessions.get(sessionPath);
    if (!entry?.session?.setActiveToolsByName) return;
    entry.session.setActiveToolsByName(["todo"]);
  }

  /** 将指定 session 的工具列表恢复为当前「操作电脑」开关状态 */
  syncSessionToolsToPlanMode(sessionPath) {
    const entry = this._sessionCoord.sessions.get(sessionPath);
    if (!entry?.session) return;
    const agent = this.getAgent(entry.agentId) || this.agent;
    this._configCoord.applyPlanModeToolsToSession(entry.session, agent, allBuiltInTools);
  }
  async updateConfig(p) { return this._configCoord.updateConfig(p); }

  getPreferences() { return this._readPreferences(); }
  savePreferences(p) { return this._writePreferences(p); }

  getToolsDisabled() { return this._prefs.getToolsDisabled(); }
  setToolsDisabled(disabled) { return this._prefs.setToolsDisabled(disabled); }
  getToolRegistry() { return getToolRegistry(this.hanakoHome); }

  // ════════════════════════════
  //  Channel 代理（→ ChannelManager）
  // ════════════════════════════

  deleteChannelByName(n) { return this._channels.deleteChannelByName(n); }
  async triggerChannelTriage(n, o) { return this._channels.triggerChannelTriage(n, o); }

  // ════════════════════════════
  //  Bridge 代理（→ BridgeSessionManager）
  // ════════════════════════════

  /** 合并所有助手目录下的 bridge 索引（会话级 handoff 后索引可能分属不同助手） */
  getBridgeIndex() { return this._bridge.getMergedIndex(); }

  /** @deprecated 使用 saveBridgeIndexForAgent；旧版单索引写入 */
  saveBridgeIndex(i) { return this._bridge.writeIndex(i, this.getBridgeAgent()); }

  saveBridgeIndexForAgent(agent, index) { return this._bridge.writeIndex(index, agent); }

  /**
   * 指定 sessionKey 在社交平台对话中实际使用的助手（含 chatAgentBySession 覆盖）。
   */
  resolveBridgeSessionAgent(sessionKey) {
    return this._bridge.resolveSessionAgent(sessionKey);
  }

  /** 设置「本 IM 会话」固定使用的助手；agentId 为 null 则清除覆盖 */
  setBridgeChatAgentForSession(sessionKey, agentId) {
    const prefs = this.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (!prefs.bridge.chatAgentBySession) prefs.bridge.chatAgentBySession = {};
    if (agentId == null || agentId === "") {
      delete prefs.bridge.chatAgentBySession[sessionKey];
    } else {
      prefs.bridge.chatAgentBySession[sessionKey] = agentId;
    }
    this.savePreferences(prefs);
  }

  /** 清除某会话在索引中的 JSONL 引用（切换助手前调用，下次对话在新助手下新建 session） */
  clearBridgeSessionIndexEntry(sessionKey) {
    this._bridge.clearSessionEntry(sessionKey);
  }

  readBridgeIndexForAgent(agent) {
    return this._bridge.readIndex(agent);
  }

  /**
   * 定位某 sessionKey 的索引条目（优先当前解析助手，否则扫盘，兼容旧数据）
   * @returns {{ agent: object, raw: object|string }|null}
   */
  findBridgeSessionEntry(sessionKey) {
    const primary = this.resolveBridgeSessionAgent(sessionKey);
    const idx = this._bridge.readIndex(primary);
    if (idx[sessionKey] != null) return { agent: primary, raw: idx[sessionKey] };
    for (const ag of this._agentMgr.agents.values()) {
      const i = this._bridge.readIndex(ag);
      if (i[sessionKey] != null) return { agent: ag, raw: i[sessionKey] };
    }
    return null;
  }
  async executeExternalMessage(p, sk, m, o) { return this._bridge.executeExternalMessage(p, sk, m, o); }
  injectBridgeMessage(sk, t) { return this._bridge.injectMessage(sk, t); }

  /**
   * 向已对接社交平台上绑定的本人发送一条 IM（由 BridgeManager 校验 owner 与连接状态）。
   * @param {string} platform - telegram | feishu | qq
   * @param {string} [userId] - 省略则从 preferences.bridge.owner[platform] 使用；传入则须与配置一致
   * @param {string} text
   * @returns {Promise<{ ok: true, sent: true, platform: string, chatId: string, sessionKey: string } | { ok: false, reason?: string, error?: string }>}
   */
  async sendBridgeOwnerIm(platform, userId, text) {
    const bm = this._hub?.bridgeManager;
    if (!bm?.sendToOwner) return { ok: false, reason: "bridge_unavailable" };
    return bm.sendToOwner(platform, userId, text);
  }

  // ════════════════════════════
  //  Skills（→ SkillManager）
  // ════════════════════════════

  _syncAgentSkills() { this._skills.syncAgentSkills(this.agent); }
  _syncAllAgentSkills() { for (const ag of this._agentMgr.agents.values()) this._skills.syncAgentSkills(ag); }
  getAllSkills(agentId) {
    const ag = agentId ? this._agentMgr.getAgent(agentId) : this.agent;
    return this._skills.getAllSkills(ag || this.agent);
  }
  _getSkillsForAgent(ag) {
    const result = this._skills.getSkillsForAgent(ag);
    if (!this._configCoord.planMode && result.skills?.length) {
      result.skills = result.skills.filter(s => !PLAN_MODE_ONLY_SKILLS.includes(s.name));
    }
    return result;
  }
  get skillsDir() { return this._skills.skillsDir; }
  get userSkillsDir() { return this._skills.skillsDir; }
  get learnedSkillsDir() { return path.join(this.agent.agentDir, "learned-skills"); }
  get modelsJsonPath() { return this._models.modelsJsonPath; }
  get authJsonPath() { return this._models.authJsonPath; }

  async reloadSkills() {
    // 与 init 一致：先从 skills2set 覆盖同步到 skillsDir，再 reload，避免复用 server 或仅点「重载」时仍用旧内容
    const skillsDir = this._skills.skillsDir;
    const skillsSrc = path.join(this.productDir, "..", "skills2set");
    if (fs.existsSync(skillsSrc)) syncSkills(skillsSrc, skillsDir);

    await this._skills.reload(this._resourceLoader, this._agentMgr.agents);
    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
    this._syncAllAgentSkills();
  }

  /** 获取外部技能路径配置（供 API 使用） */
  getExternalSkillPaths() {
    // 刷新 exists 状态，检测运行期间新增的目录
    let newDirAppeared = false;
    for (const d of this._discoveredExternalPaths || []) {
      const nowExists = fs.existsSync(d.dirPath);
      if (nowExists && !d.exists) newDirAppeared = true;
      d.exists = nowExists;
    }
    // 运行期间有新目录出现：重新集成到 SkillManager（watcher + 扫描）
    if (newDirAppeared) {
      const merged = this._mergeExternalPaths(this._prefs.getExternalSkillPaths());
      this._skills.setExternalPaths(merged);
      this.reloadSkills().then(() => {
        this._emitEvent({ type: "skills-changed" }, null);
      }).catch(() => {});
    }
    return {
      configured: this._prefs.getExternalSkillPaths(),
      discovered: this._discoveredExternalPaths || [],
    };
  }

  /** 更新外部技能路径 + 同步 ResourceLoader + 重载 */
  async setExternalSkillPaths(paths) {
    this._prefs.setExternalSkillPaths(paths);
    const merged = this._mergeExternalPaths(paths);
    // 1. 更新 SkillManager（数据 + watcher，不 reload）
    this._skills.setExternalPaths(merged);
    // 2. 统一 reload（外部技能由 SkillManager 扫描，不走 ResourceLoader）
    await this.reloadSkills();
    // 3. 通知前端
    this._emitEvent({ type: "skills-changed" }, null);
  }

  /** 合并自动发现 + 用户配置的外部路径（去重） */
  _mergeExternalPaths(userConfiguredPaths) {
    // 每次合并时重新检测目录是否存在（不依赖初始化快照）
    for (const d of this._discoveredExternalPaths || []) {
      d.exists = fs.existsSync(d.dirPath);
    }
    const discovered = (this._discoveredExternalPaths || [])
      .filter(d => d.exists)
      .map(d => ({ dirPath: d.dirPath, label: d.label }));
    const userParsed = (userConfiguredPaths || []).map(p => ({
      dirPath: path.resolve(p),
      label: path.basename(path.dirname(p)),
    }));
    const merged = [...discovered];
    const seen = new Set(merged.map(m => m.dirPath));
    for (const up of userParsed) {
      if (!seen.has(up.dirPath)) {
        merged.push(up);
        seen.add(up.dirPath);
      }
    }
    return merged;
  }

  // ════════════════════════════
  //  Model 代理
  // ════════════════════════════

  _resolveThinkingLevel(l) { return this._models.resolveThinkingLevel(l); }
  _resolveExecutionModel(r) { return this._models.resolveExecutionModel(r); }
  _resolveProviderCredentials(p) { return this._models.resolveProviderCredentials(p, this.agent.config); }
  _inferModelProvider(id) { return this._models.inferModelProvider(id); }
  async refreshAvailableModels() { return this._models.refreshAvailable(); }

  static SHARED_MODEL_KEYS = SHARED_MODEL_KEYS;

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async init(log = () => {}) {
    const startupTimer = Date.now();

    // 0. Provider 迁移
    this._configCoord.migrateProvidersToGlobal(log);

    // 1. Pi SDK + ModelCatalog（必须在 agent init 之前，agent 需要解析记忆模型）
    log(`[init] 1/5 Pi SDK 初始化...`);
    this._models.init();
    this._models.setPreferences(this._prefs);
    // 注册用户覆盖源：从当前 agent 的 config.models.overrides 动态读取
    this._models.modelCatalog.setOverridesGetter(() => this.agent?.config?.models?.overrides || null);
    await this._models.modelCatalog.build();
    log(`[init] 1/5 AuthStorage + ModelRegistry + Catalog 就绪`);

    // 2. 初始化所有 agent
    log(`[init] 2/5 初始化所有 agent...`);
    await this._agentMgr.initAllAgents(log, this._agentMgr.activeAgentId);
    log(`[init] 2/5 ${this._agentMgr.agents.size} 个 agent 已就绪`);

    // 3. ResourceLoader + Skills
    log(`[init] 3/5 ResourceLoader 初始化...`);
    const t_rl = Date.now();
    const skillsDir = path.join(this.hanakoHome, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    // 每次 init 从项目 skills2set 覆盖同步，保证重启后看到最新内置技能
    const skillsSrc = path.join(this.productDir, "..", "skills2set");
    if (fs.existsSync(skillsSrc)) syncSkills(skillsSrc, skillsDir);

    // 解析外部兼容技能路径
    const homeDir = os.homedir();
    this._discoveredExternalPaths = WELL_KNOWN_SKILL_PATHS.map(w => ({
      dirPath: path.join(homeDir, w.suffix),
      label: w.label,
      exists: fs.existsSync(path.join(homeDir, w.suffix)),
    }));
    const externalPaths = this._mergeExternalPaths(this._prefs.getExternalSkillPaths());

    this._skills = new SkillManager({ skillsDir, externalPaths });
    this._resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: () => this.agent.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
    });
    await this._resourceLoader.reload();

    const HIDDEN_SKILLS = new Set(["canvas-design", "skill-creator", "skills-translate-temp"]);
    this._skills.init(this._resourceLoader, this._agentMgr.agents, HIDDEN_SKILLS);
    const extCount = this._skills.allSkills.filter(s => s.source === "external").length;
    log(`[init] 3/5 ResourceLoader 完成 (${Date.now() - t_rl}ms, ${this._skills.allSkills.length} skills${extCount ? `, ${extCount} external` : ""})`);

    migrateDeskRequiredRulesSkill({
      hanakoHome: this.hanakoHome,
      skillsDir,
      agents: this._agentMgr.agents,
      syncAgentSkills: (ag) => this._skills.syncAgentSkills(ag),
    });

    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);

    // 4. 模型发现
    log(`[init] 4/5 发现可用模型...`);
    try { await this.syncModelsAndRefresh(); } catch {}
    await this._models.refreshAvailable();
    this._configCoord.normalizeUtilityApiPreferences(log);
    const availableModels = this._models.availableModels;
    log(`[init] 4/5 找到 ${availableModels.length} 个模型: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
    if (availableModels.length === 0) {
      console.warn("[engine] ⚠ 未找到可用模型，请在设置中配置 API key");
      this._models.defaultModel = null;
    } else {
      const preferredId = this.agent.config.models?.chat;
      if (!preferredId) {
        console.warn("[engine] ⚠ 未配置 models.chat，defaultModel 为 null");
        this._models.defaultModel = null;
      } else {
        const model = availableModels.find(m => m.id === preferredId);
        if (!model) {
          console.error(`[engine] ⚠ 配置的模型 "${preferredId}" 不在可用列表中，defaultModel 为 null`);
          this._models.defaultModel = null;
        } else {
          this._models.defaultModel = model;
          log(`✿ 使用模型: ${model.name} (${model.provider})`);
        }
      }
    }

    // 5. 一次性迁移 favorites
    const prefs = this._readPreferences();
    if (!prefs.favorites) {
      const agentFavs = this.agent.config.models?.favorites;
      if (agentFavs?.length) {
        prefs.favorites = agentFavs;
        this._writePreferences(prefs);
        log(`✿ 已迁移 ${agentFavs.length} 个收藏模型到全局配置`);
      }
    }

    // 6. Sync skills + watch skillsDir
    this._syncAllAgentSkills();
    this._skills.watch(this._resourceLoader, this._agentMgr.agents, () => {
      this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
      this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
      this._syncAllAgentSkills();
    });

    // 7. Bridge 孤儿清理
    try { this._bridge.reconcile(); } catch {}

    // 8. 沙盒日志
    const sandboxEnabled = this._readPreferences().sandbox !== false;
    log(`✿ 沙盒${sandboxEnabled ? "已启用" : "已关闭"}`);

    // 9. 「操作电脑」每期进程启动默认开启（若已有 session 则同步工具列表并广播）
    this.setPlanMode(true);

    const totalTime = ((Date.now() - startupTimer) / 1000).toFixed(1);
    log(`✿ 初始化完成（${totalTime}s）`);

    try {
      const { startDiaryAutoScheduler } = await import("../lib/diary/diary-scheduler.js");
      startDiaryAutoScheduler(this);
    } catch (e) {
      console.warn(`[engine] diary scheduler: ${e.message}`);
    }
  }

  async dispose() {
    try {
      const { stopDiaryAutoScheduler } = await import("../lib/diary/diary-scheduler.js");
      stopDiaryAutoScheduler();
    } catch {}
    this._skills.unwatch();
    await this._agentMgr.disposeAll(this._sessionCoord.session);
    await this._sessionCoord.cleanupSession();
  }

  // ════════════════════════════
  //  工具构建
  // ════════════════════════════

  async buildTools(cwd, customTools, opts = {}) {
    const disabledSet = new Set(this.getToolsDisabled());
    const baseCt = customTools || this.agent.tools;
    const userTools = await loadUserScriptTools(this.hanakoHome);
    const mergedCt = Array.isArray(baseCt) ? [...baseCt, ...userTools] : [...userTools];
    const ct = mergedCt.filter((t) => t && !disabledSet.has(t.name));

    const effectiveAgentDir = opts.agentDir || this.agent.agentDir;
    const effectiveWorkspace = opts.workspace !== undefined ? opts.workspace : this.homeCwd;
    const sandboxEnabled = this._readPreferences().sandbox !== false;
    const effectiveMode = opts.mode || (sandboxEnabled ? "standard" : "full-access");

    const result = createSandboxedTools(cwd, ct, {
      agentDir: effectiveAgentDir,
      workspace: effectiveWorkspace,
      hanakoHome: this.hanakoHome,
      mode: effectiveMode,
    });
    result.tools = result.tools
      .filter((t) => !disabledSet.has(t.name))
      .map(wrapToolWithDebugLog);
    result.customTools = (result.customTools || []).map(wrapToolWithDebugLog);
    return result;
  }

  // ════════════════════════════
  //  事件系统
  // ════════════════════════════

  setEventBus(bus) {
    for (const fn of this._listeners) bus.subscribe(fn);
    this._listeners.clear();
    this._eventBus = bus;
  }

  subscribe(listener) {
    if (this._eventBus) return this._eventBus.subscribe(listener);
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitEvent(event, sessionPath) {
    if (this._eventBus) {
      this._eventBus.emit(event, sessionPath);
    } else {
      for (const fn of this._listeners) {
        try { fn(event, sessionPath); } catch {}
      }
    }
  }

  emitDevLog(text, level = "info") {
    const entry = { text, level, ts: Date.now() };
    this._devLogs.push(entry);
    if (this._devLogs.length > this._devLogsMax) {
      this._devLogs.shift();
    }
    const dl = debugLog();
    if (dl) {
      if (level === "error") dl.error("engine", text);
      else dl.log("engine", text);
    }
    this._emitEvent({ type: "devlog", text, level }, null);
  }

  getDevLogs() {
    return this._devLogs;
  }

  // ════════════════════════════
  //  日记 / 工具调用
  // ════════════════════════════

  /**
   * @param {object} [opts]
   * @param {string} [opts.agentId] - 默认当前助手
   * @param {{ logicalDate: string, rangeStart: Date, rangeEnd: Date }} [opts.logicalDay] - 覆盖「逻辑日」（日界自动会传入）
   * @param {(phase: string) => void} [opts.onProgress]
   * @param {boolean} [opts.skipMemoryFollowup] - 跳过日记后的记忆整理（调试）
   */
  async writeDiary(opts = {}) {
    const {
      agentId,
      logicalDay: logicalDayIn,
      onProgress,
      skipMemoryFollowup = false,
    } = typeof opts === "object" && opts !== null ? opts : {};

    const target = agentId ? this.getAgent(agentId) : this.agent;
    if (!target) {
      const { getLocale } = await import("../server/i18n.js");
      const isZh = getLocale().startsWith("zh");
      return { error: isZh ? "未找到助手" : "Agent not found" };
    }

    const effectiveAgentId = agentId || this.currentAgentId;
    const sessionPath = this.currentSessionPath;
    const pathAgentId = sessionPath ? this.agentIdFromSessionPath(sessionPath) : null;
    if (sessionPath && target.memoryTicker && pathAgentId === effectiveAgentId) {
      await target.memoryTicker.flushSession(sessionPath);
    }

    const { getLogicalDay } = await import("../lib/time-utils.js");
    const logicalDay = logicalDayIn || getLogicalDay();

    const { writeDiary: writeDiaryLib } = await import("../lib/diary/diary-writer.js");
    const diaryModelId = target.config.models?.chat || target.memoryModel;
    const resolvedModel = this._models.resolveModelWithCredentials(diaryModelId, target.config);

    const result = await writeDiaryLib({
      summaryManager: target.summaryManager,
      resolvedModel,
      agentPersonality: target.personality,
      memory: (() => {
        try { return fs.readFileSync(target.memoryMdPath, "utf-8"); } catch { return ""; }
      })(),
      userName: target.userName,
      agentName: target.agentName,
      cwd: this.homeCwd || process.cwd(),
      activityStore: this.getActivityStore(effectiveAgentId),
      logicalDay,
      onProgress: (phase) => onProgress?.(phase),
    });

    if (result.error) return result;

    if (!skipMemoryFollowup) {
      const { runDiaryMemoryFollowup } = await import("../lib/diary/diary-memory-followup.js");
      await runDiaryMemoryFollowup({
        agent: target,
        resolveModel: (bareId, cfg) => this._models.resolveModelWithCredentials(bareId, cfg),
        diaryContent: result.content,
        logicalDate: result.logicalDate,
        onProgress,
      });
    }

    return result;
  }

  async summarizeTitle(ut, at) {
    return _summarizeTitle(this.resolveUtilityConfig(), ut, at);
  }

  async translateSkillNames(names, lang) {
    return _translateSkillNames(this.resolveUtilityConfig(), names, lang);
  }

  async summarizeActivity(sp) {
    return _summarizeActivity(this.resolveUtilityConfig(), sp, (msg) => this.emitDevLog(msg));
  }

  async summarizeActivityQuick(activityId) {
    let entry = null, foundAgentId = null;
    for (const [agId] of this._agentMgr.agents) {
      const store = this.getActivityStore(agId);
      const e = store?.get(activityId);
      if (e) { entry = e; foundAgentId = agId; break; }
    }
    if (!entry?.sessionFile) return null;
    const sessionPath = path.join(this.agentsDir, foundAgentId, "activity", entry.sessionFile);
    return _summarizeActivityQuick(this.resolveUtilityConfig(), sessionPath);
  }

  // ════════════════════════════
  //  Desk 辅助
  // ════════════════════════════

  listDeskFiles() {
    try {
      const dir = this.homeCwd;
      if (!dir || !fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith("."))
        .map(e => {
          const fp = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(fp).mtimeMs; } catch {}
          return { name: e.name, isDir: e.isDirectory(), mtime };
        });
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  Preferences 代理
  // ════════════════════════════

  _readPreferences() { return this._prefs.getPreferences(); }
  _writePreferences(prefs) { return this._prefs.savePreferences(prefs); }
  _readPrimaryAgent() { return this._prefs.getPrimaryAgent(); }
  _savePrimaryAgent(agentId) { return this._prefs.savePrimaryAgent(agentId); }

  // ════════════════════════════
  //  巡检工具白名单（向后兼容静态引用）
  // ════════════════════════════

  static PATROL_TOOLS_DEFAULT = [
    "search_memory", "pin_memory", "unpin_memory",
    "recall_experience", "record_experience",
    "web_search", "web_fetch",
    "todo", "cron", "notify",
    "present_files", "message_agent",
  ];
}
