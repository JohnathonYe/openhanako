/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（不改 ticker，只提供回调）。
 *
 * 搬出的方法：
 *   _getChannelAgentOrder  → getAgentOrder()
 *   _executeChannelCheck   → _executeCheck()
 *   _executeChannelReply   → _executeReply()
 *   _channelMemorySummarize → _memorySummarize()
 *   _setupChannelPostHandler → setupPostHandler()
 *   toggleChannels          → toggle()
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.js";
import { appendMessage, formatMessagesForLLM } from "../lib/channels/channel-store.js";
import { channelBodyWithOptionalDoc } from "../lib/channels/channel-doc.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { callProviderText } from "../lib/llm/provider-client.js";
import { runAgentSession } from "./agent-executor.js";
import { debugLog } from "../lib/debug-log.js";

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 秒

  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  // ──────────── 生命周期 ────────────

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) return;

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    return this._ticker?.triggerImmediate(channelName, opts);
  }

  /**
   * 注入频道 post 回调到当前 agent
   * agent 用 channel tool 发消息后，触发其他 agent 的 triage
   */
  setupPostHandler() {
    this._engine.agent._channelPostHandler = (channelName, senderId) => {
      debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, triggering triage`);
      this.triggerImmediate(channelName)?.catch(err =>
        console.error(`[channel] agent post triage 失败: ${err.message}`)
      );
    };
  }

  // ──────────── 频道 Agent 顺序 ────────────

  /** 获取参与频道轮转的 agent 列表（只含有 channels.md 的，30s TTL 缓存） */
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const channelsMd = path.join(this._engine.agentsDir, e.name, "channels.md");
          return fs.existsSync(channelsMd);
        })
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  // ──────────── Triage + Reply ────────────

  /**
   * 频道检查回调：triage → 两轮 Agent Session → 写入回复
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);

    // ── 读 agent 完整上下文 ──
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const agentDir = path.join(engine.agentsDir, agentId);

    // 复用 Agent 实例的 personality（identity + yuan + ishiki 已在内存中组装）
    const agentInstance = engine.agents?.get(agentId);
    const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));
    const agentName = cfg.agent?.name || agentId;

    const agentContext = agentInstance?.personality
      || [readFile(path.join(agentDir, "identity.md")),
          readFile(path.join(engine.productDir, "yuan", `${cfg.agent?.yuan || "hanako"}.md`)),
          readFile(path.join(agentDir, "ishiki.md"))].filter(Boolean).join("\n\n");

    // memory.md 和 user.md 内容会变，仍需从磁盘读取
    const memoryMd = readFile(path.join(agentDir, "memory", "memory.md"));
    const userMd = readFile(path.join(engine.userDir, "user.md"));
    const memoryContext = memoryMd?.trim() ? `\n\n你的记忆：\n${memoryMd}` : "";
    const userContext = userMd?.trim() ? `\n\n用户档案：\n${userMd}` : "";

    // ── 检测 @ ──
    const isMentioned = msgText.includes(`@${agentName}`) || msgText.includes(`@${agentId}`);

    // ── Step 1: Triage（utility_large）──
    let shouldReply = false;

    try {
      const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = engine.resolveUtilityConfig();
      if (api_key && base_url && api) {
        const mentionNote = isMentioned ? "被 @ 也不强制发言，满足 NO 仍答 NO。\n" : "";

        const triageSystem = agentContext + memoryContext + userContext
          + "\n\n---\n\n"
          + "群聊频道：根据最近消息判断你是否还要再发一条。\n"
          + `你的发送者 id：「${agentId}」（显示名常作「${agentName}」）。上文若已有「${agentId}:」开头的消息，视为你已说过话。\n`
          + mentionNote
          + "YES：有人要你给**新**信息/执行；或你还没在本段对话里发过言且确实轮到你接话。\n"
          + "NO：你已自我介绍过、别人已接「介绍一下」而无人单独追你；"
          + "近期只有收到/记住了/对齐/请多指教等客套且无新问题；"
          + "换说法重复同义（含一条里两段重复介绍）；话题无关；你刚回过且无人追问。\n"
          + "只答 YES 或 NO。";

        const triageTimeout = AbortSignal.timeout(10_000);
        const triageSignal = signal
          ? AbortSignal.any([signal, triageTimeout])
          : triageTimeout;
        const triageUserContent = `#${channelName} 最近消息：\n${msgText}\n\n---\n[调度] 发送者=${agentId}。已有你的发言则勿为笼统「介绍一下」再自我介绍。`;

        const answer = await callProviderText({
          api,
          model,
          api_key,
          base_url,
          systemPrompt: triageSystem,
          messages: [{ role: "user", content: triageUserContent }],
          temperature: 0,
          max_tokens: 10,
          timeoutMs: 10_000,
          signal: triageSignal,
        });
        shouldReply = answer.trim().toUpperCase().includes("YES");
      } else {
        // utility_large 凭证不完整，跳过 triage：被 @ 倾向回复，否则仍尝试让全员参与（旧行为）
        shouldReply = true;
      }
    } catch (err) {
      // utility 模型未配置或 triage 调用失败 → 默认回复（让 agent 自己在 reply 阶段用 [NO_REPLY] 收口）
      console.warn(`[channel] triage 不可用，默认回复 (${agentId}/#${channelName}): ${err.message}`);
      shouldReply = true;
    }

    console.log(`\x1b[90m[channel] triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (@)" : ""}\x1b[0m`);
    debugLog()?.log("channel", `triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (mentioned)" : ""} (${newMessages.length} msgs)`);

    if (!shouldReply) {
      return { replied: false };
    }

    // ── Step 2: 两轮 Agent Session 生成回复 ──
    try {
      const replyText = await this._executeReply(agentId, channelName, msgText, { signal });

      if (!replyText) {
        console.log(`\x1b[90m[channel] ${agentId} 回复为空 (#${channelName})\x1b[0m`);
        return { replied: false };
      }

      // 超过字数则写入 _docs/*.md，频道内只发摘要 + 查看链接
      const { body: channelBody, fullMarkdown } = channelBodyWithOptionalDoc(
        engine.channelsDir,
        channelName,
        agentId,
        replyText,
      );

      // 写入频道文件
      const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
      appendMessage(channelFile, agentId, channelBody);

      const logLen = fullMarkdown ? `${fullMarkdown.length} chars (stub+doc)` : `${replyText.length} chars`;
      console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${logLen})\x1b[0m`);
      debugLog()?.log("channel", `${agentId} replied #${channelName} (${logLen})`);

      // WS 广播
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

      // 记忆摘要仍用完整正文，避免只摘要到 stub
      return { replied: true, replyContent: fullMarkdown ?? replyText };
    } catch (err) {
      console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
      return { replied: false };
    }
  }

  /**
   * 两轮 Agent Session 生成频道回复
   */
  async _executeReply(agentId, channelName, msgText, { signal } = {}) {
    const text = await runAgentSession(
      agentId,
      [
        {
          text: `#${channelName} 最近消息：\n\n${msgText}\n\n`
            + `内部思考轮（用户看不到）：可 search_memory。下一轮才是发到群里的内容。\n`
            + `若已致谢/对齐/存记忆车轱辘、或你已自我介绍过而无人新问你，下一轮输出 [NO_REPLY]。一条里不要两段重复自我介绍。`,
          capture: false,
        },
        {
          text: `发出到 #${channelName} 的最终回复（所有人可见）。\n\n`
            + `规则：默认短句（~30字）；要展开可长文（可到约1000字），用 Markdown 排版；超过约1000字才另存文档、群里只留摘要+查看链接。\n`
            + `直接输出正文，不要前缀/MOOD/代码块。勿复读他人或换说法重复客套（收到/记住了/对齐等）。\n`
            + `介绍/破冰每人一次：你上文已介绍过、或别人已接笼统「介绍一下」而无人单独 @ 你 → [NO_REPLY]。一条禁止两段重复自我介绍。\n`
            + `只写实发生过的事；无话则 [NO_REPLY]。`,
          capture: true,
        },
      ],
      { engine: this._engine, signal, sessionSuffix: "channel-temp" },
    );

    if (!text || text.includes("[NO_REPLY]")) {
      debugLog()?.log("channel", `${agentId}/#${channelName}: chose not to reply`);
      return null;
    }

    return text;
  }

  /**
   * 频道记忆摘要
   * 从 engine._channelMemorySummarize 搬入
   */
  async _memorySummarize(agentId, channelName, contextText) {
    const engine = this._engine;
    try {
      const { utility: model, api_key, base_url, api } = engine.resolveUtilityConfig();
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} 无 API 配置，跳过记忆摘要\x1b[0m`);
        return;
      }

      const summaryText = await callProviderText({
        api,
        model,
        api_key,
        base_url,
        systemPrompt: "将频道对话摘要为一条简短的记忆（一两句话），记录关键信息和结论。直接输出摘要，不要前缀。",
        messages: [{ role: "user", content: `频道 #${channelName}：\n${contextText.slice(0, 2000)}` }],
        temperature: 0.3,
        max_tokens: 200,
      });

      // 写入 agent 的 fact store
      const isCurrentAgent = (agentId === engine.currentAgentId);
      let factStore = null;
      let needClose = false;

      if (isCurrentAgent && engine.agent?.factStore) {
        factStore = engine.agent.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.js");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const now = new Date();
      try {
        factStore.add({
          fact: `[#${channelName}] ${summaryText}`,
          tags: ["频道", channelName],
          time: now.toISOString().slice(0, 16),
          session_id: `channel-${channelName}`,
        });
      } finally {
        if (needClose) factStore.close();
      }

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }
}
