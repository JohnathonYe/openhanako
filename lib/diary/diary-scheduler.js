/**
 * diary-scheduler.js — 逻辑日日界（默认 4:00）自动写日记
 *
 * 每 agent 独立：config.diary.auto_at_boundary
 * 状态文件：agentDir/memory/.auto-diary-ended-date（YYYY-MM-DD = 已处理「上一完整逻辑日」）
 */

import fs from "fs";
import path from "path";
import { getLastCompletedLogicalDay, getLogicalDayForJustEndedPeriod } from "../time-utils.js";
import { debugLog } from "../debug-log.js";

let _boundaryTimer = null;
let _catchupTimer = null;

function readEndedDate(agentDir) {
  const p = path.join(agentDir, "memory", ".auto-diary-ended-date");
  try {
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return "";
  }
}

function writeEndedDate(agentDir, isoDate) {
  const mem = path.join(agentDir, "memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, ".auto-diary-ended-date"), `${isoDate}\n`, "utf-8");
}

function msUntilNextBoundary(hour = 4) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

/**
 * @param {import('../../core/engine.js').HanaEngine} engine
 */
export async function runAutoDiaryForAllAgents(engine, opts = {}) {
  const { boundaryMoment = false } = opts;
  const now = new Date();
  const logicalDaySpec = boundaryMoment
    ? getLogicalDayForJustEndedPeriod(now)
    : getLastCompletedLogicalDay(now);
  const endedLogical = logicalDaySpec.logicalDate;

  for (const [agentId, ag] of engine.agents) {
    if (ag.config?.diary?.auto_at_boundary === false) continue;
    const last = readEndedDate(ag.agentDir);
    if (last === endedLogical) continue;

    try {
      const result = await engine.writeDiary({
        agentId,
        logicalDay: logicalDaySpec,
      });
      if (result?.error) {
        debugLog()?.warn("diary-auto", `${agentId}: ${result.error}`);
        continue;
      }
      writeEndedDate(ag.agentDir, endedLogical);
      debugLog()?.log("diary-auto", `${agentId} diary ok ended=${endedLogical}`);
    } catch (err) {
      debugLog()?.error("diary-auto", `${agentId}: ${err.message}`);
    }
  }
}

/**
 * @param {import('../../core/engine.js').HanaEngine} engine
 */
export function startDiaryAutoScheduler(engine) {
  stopDiaryAutoScheduler();

  const scheduleBoundary = () => {
    if (_boundaryTimer) clearTimeout(_boundaryTimer);
    _boundaryTimer = setTimeout(async () => {
      _boundaryTimer = null;
      await runAutoDiaryForAllAgents(engine, { boundaryMoment: true });
      scheduleBoundary();
    }, msUntilNextBoundary(4));
    if (_boundaryTimer.unref) _boundaryTimer.unref();
  };

  scheduleBoundary();

  _catchupTimer = setTimeout(() => {
    _catchupTimer = null;
    runAutoDiaryForAllAgents(engine, { boundaryMoment: false }).catch(() => {});
  }, 15_000);
  if (_catchupTimer.unref) _catchupTimer.unref();

  console.log("\x1b[90m[diary-auto] scheduler started (daily ~4:00 + catch-up in 15s)\x1b[0m");
}

export function stopDiaryAutoScheduler() {
  if (_boundaryTimer) {
    clearTimeout(_boundaryTimer);
    _boundaryTimer = null;
  }
  if (_catchupTimer) {
    clearTimeout(_catchupTimer);
    _catchupTimer = null;
  }
}
