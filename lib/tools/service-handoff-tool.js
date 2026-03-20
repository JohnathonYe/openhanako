/**
 * service-handoff-tool.js — 切换服务对象 / 频道转交
 *
 * 同一对话框内允许多个 agent 轮流服务；切换后新 agent 独立气泡回复。
 *
 * - 主聊天（桌面会话）：排队在本轮 assistant 结束后切换 primary agent，
 *   以新身份独立气泡回复转交任务
 * - 频道内：向当前频道发帖并 @ 目标 agent，触发 triage
 * - 临时会话（runAgentSession）：不切换桌面，提示改用 ask_agent
 */

import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { appendMessage } from "../channels/channel-store.js";
import { channelBodyWithOptionalDoc } from "../channels/channel-doc.js";
import { getToolInvocationContext } from "./tool-invocation-context.js";

/**
 * 解析「3号」「一号」等中文序号。
 * @param {string} ref
 * @returns {number|null} 1-based 序号
 */
export function parseAssistantOrdinal(ref) {
  const t = String(ref || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d+)号$/);
  if (m) return parseInt(m[1], 10);
  const cm = t.match(/^([一二三四五六七八九十]+)号$/);
  if (!cm) return null;
  const s = cm[1];
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === "十") return 10;
  if (s.length === 1) return d[s] ?? null;
  if (s.length === 2 && s[0] === "十") return 10 + (d[s[1]] ?? 0);
  if (s.length === 2 && s[1] === "十") return (d[s[0]] ?? 0) * 10;
  return null;
}

/**
 * 按 id、展示名或「N号」解析目标 agent。
 * @param {Array<{id: string, name: string}>} agents
 * @param {string} ref - id、展示名、或「N号」
 * @param {{ orderedIds?: string[] }} [options]
 */
export function resolveAgentRef(agents, ref, options = {}) {
  const { orderedIds = [] } = options;
  const t = String(ref || "").trim();
  if (!t) return null;

  const ord = parseAssistantOrdinal(t);
  if (ord != null && orderedIds.length > 0 && ord >= 1 && ord <= orderedIds.length) {
    const id = orderedIds[ord - 1];
    const hit = agents.find(a => a.id === id);
    if (hit) return hit;
  }

  const byId = agents.find(a => a.id === t);
  if (byId) return byId;
  const lower = t.toLowerCase();
  const byName = agents.find(a => (a.name || "").toLowerCase() === lower);
  if (byName) return byName;
  return agents.find(a => a.id.toLowerCase() === lower) || null;
}

/**
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {() => Array<{id: string, name: string}>} opts.listAgents
 * @param {() => import('../../core/engine.js').HanaEngine|null} opts.getEngine
 * @param {string|null} [opts.channelsDir]
 * @param {(channelName: string, senderId: string) => void} [opts.onChannelPost]
 */
export function createServiceHandoffTool({ agentId, listAgents, getEngine, channelsDir, onChannelPost }) {
  return {
    name: "handoff_service",
    label: "切换服务对象",
    description:
      "将当前对话交给另一位助手接续处理。调用后对方会以独立身份（独立消息气泡）直接对用户回复。\n" +
      "在主聊天窗口中：对方会在你结束后接管对话，以自己的身份回复用户。\n" +
      "在频道群聊中：向当前频道发一条 @对方 的消息并带上任务。\n" +
      "参数 target：可为目标 id、config 展示名、或「几号」——与设置里助手卡片从左到右顺序一致。\n" +
      "用户说「让 3 号来」「找二号」时，应使用本工具，target 填「3号」或「二号」。\n" +
      "task 写清要对方做什么，第三人称客观描述。\n" +
      "⚠ 调用本工具后，你必须立即结束回复（只允许一句简短过渡语），不要在后续文本中复述任务或替对方回答。",
    parameters: Type.Object({
      target: Type.String({ description: "目标助手 id、名称、或「N号」" }),
      task: Type.String({ description: "转交事项：客观描述对方需要完成什么" }),
    }),

    execute: async (_toolCallId, params) => {
      const engine = getEngine?.();
      if (!engine) {
        return { content: [{ type: "text", text: "handoff_service 失败：引擎未就绪" }] };
      }

      if (params.target === agentId) {
        return { content: [{ type: "text", text: "不能转交给自己" }] };
      }

      const agents = listAgents();
      const orderedIds = agents.map(a => a.id);
      const target = resolveAgentRef(agents, params.target, { orderedIds });
      if (!target) {
        const ids = agents.map(a => `${a.id}（${a.name}）`).join("，");
        return {
          content: [{ type: "text", text: `找不到助手「${params.target}」。当前可用：${ids || "（无）"}` }],
        };
      }

      const ctx = getToolInvocationContext();
      const channelName = ctx?.channelName;

      // ── 频道模式：@ 目标并触发 triage ──
      if (channelName && channelsDir) {
        const channelFile = path.join(channelsDir, `${channelName}.md`);
        if (!fs.existsSync(channelFile)) {
          return { content: [{ type: "text", text: `频道 #${channelName} 不存在` }] };
        }

        const body =
          `@${target.id} ${params.task}\n\n` +
          `（由 ${agentId} 转交）`;
        const { body: storedBody } = channelBodyWithOptionalDoc(
          channelsDir,
          channelName,
          agentId,
          body,
        );
        appendMessage(channelFile, agentId, storedBody);
        try { onChannelPost?.(channelName, agentId); } catch {}
        try {
          await engine.triggerChannelTriage(channelName, { mentionedAgents: [target.id] });
        } catch {}

        return {
          content: [{
            type: "text",
            text: `已在 #${channelName} 中 @${target.name}（${target.id}），对方将按频道调度回复。`,
          }],
          details: { mode: "channel", channel: channelName, to: target.id },
        };
      }

      // ── 临时隔离会话：不支持切换桌面主助手 ──
      if (ctx?.ephemeral) {
        return {
          content: [{
            type: "text",
            text:
              "当前处于临时隔离会话（如私信子轮次），无法切换桌面主助手。" +
              "请使用 ask_agent 或在主聊天窗口使用本工具。",
          }],
          details: { mode: "ephemeral_skipped" },
        };
      }

      // ── 主聊天模式：排队切换，新 agent 以独立气泡回复 ──
      const self = agents.find(a => a.id === agentId);
      engine.setPendingServiceHandoff?.({
        agentId: target.id,
        task: params.task,
        fromAgentId: agentId,
        fromAgentName: self?.name || agentId,
      });
      return {
        content: [{
          type: "text",
          text:
            `转交成功。${target.name} 将以独立身份接续对话。` +
            "请立即结束当前回复，不要继续输出内容。",
        }],
        details: { mode: "desktop_pending", to: target.id, toName: target.name },
      };
    },
  };
}
