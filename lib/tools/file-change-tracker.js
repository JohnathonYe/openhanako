/**
 * file-change-tracker.js — Per-turn file change tracking for rollback
 *
 * Records file state before modifications so changes can be reverted.
 * Keyed by turnId (streamId from chat.js).
 */

import { readFile, writeFile, unlink } from "fs/promises";

const MAX_TURNS = 30;

/** @type {Map<string, Array<{path: string, oldContent: string|null, timestamp: number}>>} */
const _turns = new Map();

/** @type {string|null} */
let _activeTurnId = null;

export function setActiveTurn(turnId) {
  _activeTurnId = turnId;
  if (!_turns.has(turnId)) {
    _turns.set(turnId, []);
  }
  if (_turns.size > MAX_TURNS) {
    const oldest = _turns.keys().next().value;
    _turns.delete(oldest);
  }
}

export function getActiveTurnId() {
  return _activeTurnId;
}

/**
 * Record a file's content before modification.
 * @param {string} absolutePath
 * @param {string|null} oldContent — null means file didn't exist (was created)
 */
export function recordFileChange(absolutePath, oldContent) {
  if (!_activeTurnId) return;
  const turn = _turns.get(_activeTurnId);
  if (!turn) return;
  if (turn.some(c => c.path === absolutePath)) return;
  turn.push({ path: absolutePath, oldContent, timestamp: Date.now() });
}

/**
 * Get info about a turn's file changes.
 * @param {number} turnId
 * @returns {{ count: number, files: string[] } | null}
 */
export function getTurnInfo(turnId) {
  const turn = _turns.get(turnId);
  if (!turn || turn.length === 0) return null;
  return { count: turn.length, files: turn.map(c => c.path) };
}

/**
 * Rollback all file changes from a specific turn.
 * @param {number} turnId
 * @returns {Promise<{ok: boolean, count: number, error?: string}>}
 */
export async function rollbackTurn(turnId) {
  const turn = _turns.get(turnId);
  if (!turn || turn.length === 0) {
    return { ok: false, count: 0, error: "No changes found for this turn" };
  }

  let restored = 0;
  const errors = [];

  for (const { path: filePath, oldContent } of turn) {
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

  _turns.delete(turnId);

  if (errors.length > 0) {
    return { ok: restored > 0, count: restored, error: errors.join("; ") };
  }
  return { ok: true, count: restored };
}
