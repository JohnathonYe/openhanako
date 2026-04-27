/**
 * file-change-tracker.js — Per-turn file change tracking for rollback
 *
 * Records file state before modifications so changes can be reverted.
 * Keyed by turnId (streamId from chat.js).
 *
 * 工具在 SessionCoordinator.runWithSessionPath 下执行，故用 sessionPath→streamId
 * 映射记录变更；避免多会话并发时全局 _activeTurnId 被后发起的会话覆盖导致撤销失效。
 *
 * 默认将快照持久化到 HANA_HOME 下 SQLite（见 initFileChangeSnapshotPersistence）；
 * HANA_FILE_SNAPSHOTS=0 关闭；HANA_FILE_SNAPSHOT_MAX 覆盖默认 1000 条文件快照上限。
 */

import path from "path";
import { readFile, writeFile, unlink } from "fs/promises";
import { getExecutingSessionPath } from "./session-path-context.js";
import { FileSnapshotStore } from "./file-change-snapshot-store.js";

const MAX_TURNS = 30;

/** @type {Map<string, Array<{path: string, oldContent: string|null, timestamp: number}>>} */
const _turns = new Map();

/** 最后一次 beginSessionStream 的 streamId（无 sessionPath 时的回退） */
let _activeTurnId = null;

/** sessionPath → 当前这一轮 prompt 的 streamId */
const _sessionActiveTurn = new Map();

/** @type {FileSnapshotStore|null} */
let _snapshotStore = null;

function pruneSessionTurnRefs(removedTurnId) {
  for (const [sp, tid] of [..._sessionActiveTurn.entries()]) {
    if (tid === removedTurnId) _sessionActiveTurn.delete(sp);
  }
}

/**
 * 启动时由 server/index.js 调用；未调用则仅内存（与旧行为一致）。
 * @param {string} hanakoHome
 * @param {object} [opts]
 * @param {number} [opts.maxSnapshots]
 */
export function initFileChangeSnapshotPersistence(hanakoHome, opts = {}) {
  _snapshotStore?.close();
  _snapshotStore = null;
  if (!hanakoHome || String(process.env.HANA_FILE_SNAPSHOTS).trim() === "0") {
    return;
  }
  const envMax = parseInt(String(process.env.HANA_FILE_SNAPSHOT_MAX || "").trim(), 10);
  const maxSnapshots =
    Number.isFinite(envMax) && envMax > 0 ? envMax : (opts.maxSnapshots ?? 1000);
  const dbPath = path.join(hanakoHome, "file-change-snapshots.sqlite");
  _snapshotStore = new FileSnapshotStore(dbPath, {
    maxSnapshots,
    onTurnEvicted: (turnId) => {
      const id = String(turnId);
      _turns.delete(id);
      pruneSessionTurnRefs(id);
    },
  });
}

export function closeFileChangeSnapshotStore() {
  try {
    _snapshotStore?.close();
  } finally {
    _snapshotStore = null;
  }
}

/**
 * WebSocket 发消息时调用：绑定本会话本轮 streamId。
 * @param {string|null|undefined} sessionPath
 * @param {string} turnId
 */
export function setActiveTurnForPrompt(sessionPath, turnId) {
  const id = String(turnId);
  if (sessionPath) {
    _sessionActiveTurn.set(sessionPath, id);
  }
  _activeTurnId = id;
  if (!_turns.has(id)) {
    _turns.set(id, []);
  }
  if (_turns.size > MAX_TURNS) {
    const oldest = _turns.keys().next().value;
    _turns.delete(oldest);
    pruneSessionTurnRefs(oldest);
  }
}

/** @deprecated 使用 setActiveTurnForPrompt(sessionPath, turnId)，否则多会话下记录会串台 */
export function setActiveTurn(turnId) {
  setActiveTurnForPrompt(null, turnId);
}

export function getActiveTurnId() {
  return _activeTurnId;
}

function resolveRecordingTurnId() {
  const sp = getExecutingSessionPath();
  if (sp) {
    const tid = _sessionActiveTurn.get(sp);
    if (tid) return tid;
  }
  return _activeTurnId;
}

/**
 * Record a file's content before modification.
 * @param {string} absolutePath
 * @param {string|null} oldContent — null means file didn't exist (was created)
 */
export function recordFileChange(absolutePath, oldContent) {
  const turnId = resolveRecordingTurnId();
  if (!turnId) return;
  let turn = _turns.get(turnId);
  if (!turn) {
    turn = [];
    _turns.set(turnId, turn);
  }
  if (turn.some((c) => c.path === absolutePath)) return;
  turn.push({ path: absolutePath, oldContent, timestamp: Date.now() });
  try {
    _snapshotStore?.append(turnId, absolutePath, oldContent);
  } catch (e) {
    console.error("[file-change-tracker] snapshot persist failed:", e?.message || e);
  }
}

/**
 * Get info about a turn's file changes.
 * @param {string} turnId
 * @returns {{ count: number, files: string[] } | null}
 */
export function getTurnInfo(turnId) {
  const id = String(turnId);
  const mem = _turns.get(id);
  if (mem?.length) {
    return { count: mem.length, files: mem.map((c) => c.path) };
  }
  return _snapshotStore?.getTurnInfo(id) ?? null;
}

/**
 * Rollback all file changes from a specific turn.
 * @param {string} turnId
 * @returns {Promise<{ok: boolean, count: number, error?: string}>}
 */
export async function rollbackTurn(turnId) {
  const id = String(turnId);
  let entries = _turns.get(id);
  if (!entries?.length) {
    entries = _snapshotStore ? _snapshotStore.loadTurn(id) : [];
  }
  if (!entries.length) {
    return { ok: false, count: 0, error: "No changes found for this turn" };
  }

  let restored = 0;
  const errors = [];

  for (const { path: filePath, oldContent } of entries) {
    try {
      if (oldContent === null) {
        await unlink(filePath).catch(() => {});
      } else {
        await writeFile(filePath, oldContent, "utf-8");
      }
      restored++;
    } catch (err) {
      errors.push(`${filePath}: ${err.message}`);
    }
  }

  _turns.delete(id);
  pruneSessionTurnRefs(id);
  try {
    _snapshotStore?.deleteTurn(id);
  } catch (e) {
    console.error("[file-change-tracker] snapshot delete after rollback failed:", e?.message || e);
  }

  if (errors.length > 0) {
    return { ok: restored > 0, count: restored, error: errors.join("; ") };
  }
  return { ok: true, count: restored };
}
