/**
 * diary-memory-followup.js — 日记完成后的记忆整理
 *
 * 1. 从日记正文抽取可检索的元事实 → FactStore（带 diary 标签）
 * 2. 跑 memory-ticker.tick()：compile + assemble + deep-memory（与每日任务一致）
 */

import { callProviderText } from "../llm/provider-client.js";
import { getLocale } from "../../server/i18n.js";

/**
 * @param {object} opts
 * @param {import('../../core/agent.js').Agent} opts.agent
 * @param {import('../model-manager.js').ModelManager} opts.resolveModel - (bareId, cfg) => resolved
 * @param {string} opts.diaryContent
 * @param {string} opts.logicalDate
 * @param {(phase: string) => void} [opts.onProgress]
 */
export async function runDiaryMemoryFollowup(opts) {
  const { agent, resolveModel, diaryContent, logicalDate, onProgress } = opts;

  const cfg = agent.config || {};
  const bareId = cfg.models?.compiler || cfg.models?.chat || agent.memoryModel;
  if (!bareId) {
    onProgress?.("memory_tick");
    const mt = agent.memoryTicker;
    if (mt?.tickDiaryFollowup) await mt.tickDiaryFollowup();
    else await mt?.tick?.();
    return { factsAdded: 0, tick: true };
  }

  const resolved = resolveModel(bareId, cfg);
  const isZh = getLocale().startsWith("zh");

  onProgress?.("memory_extract");
  let factsAdded = 0;
  try {
    const raw = await callProviderText({
      api: resolved.api,
      model: resolved.model,
      api_key: resolved.api_key,
      base_url: resolved.base_url,
      systemPrompt: isZh
        ? "你是记忆整理助手。从给定的助手日记中抽取可长期保留的事实性信息（偏好、约定、人物关系、未决事项、重要情绪节点）。忽略流水账复述。不要包含手机号、地址、证件、银行卡等隐私。"
        : "You extract durable, retrievable facts from an assistant diary (preferences, agreements, people, open threads, emotional beats). Skip fluff. No PII.",
      messages: [{
        role: "user",
        content: [
          isZh ? `逻辑日：${logicalDate}` : `Logical day: ${logicalDate}`,
          "",
          "---",
          "",
          diaryContent.slice(0, 24_000),
          "",
          "---",
          "",
          isZh
            ? "只输出一个 JSON 对象，不要 markdown 围栏。格式：{\"facts\":[{\"fact\":\"一句中文事实\",\"tags\":[\"diary\"]}]}，facts 最多 12 条，可少于 12。若无值得入库的内容则 {\"facts\":[]}。"
            : "Output a single JSON object only, no markdown fence. Format: {\"facts\":[{\"fact\":\"one English sentence\",\"tags\":[\"diary\"]}]}, max 12 entries. Use {\"facts\":[]} if nothing worth storing.",
        ].join("\n"),
      }],
      temperature: 0.2,
      max_tokens: 2048,
      timeoutMs: 120_000,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    const store = agent.factStore;
    if (store && facts.length) {
      const batch = [];
      for (const f of facts) {
        const text = typeof f?.fact === "string" ? f.fact.trim() : "";
        if (!text || text.length > 800) continue;
        const tags = Array.isArray(f.tags) ? f.tags : ["diary"];
        if (!tags.includes("diary")) tags.push("diary");
        batch.push({ fact: text, tags, time: logicalDate, session_id: `diary:${logicalDate}` });
      }
      if (batch.length) {
        store.addBatch(batch);
        factsAdded = batch.length;
      }
    }
  } catch (err) {
    console.warn(`[diary-memory-followup] extract facts skipped: ${err.message}`);
  }

  onProgress?.("memory_tick");
  try {
    const mt = agent.memoryTicker;
    if (mt?.tickDiaryFollowup) await mt.tickDiaryFollowup();
    else await mt?.tick?.();
  } catch (err) {
    console.error(`[diary-memory-followup] memory tick failed: ${err.message}`);
  }

  return { factsAdded, tick: true };
}
