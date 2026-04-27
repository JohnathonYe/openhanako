/**
 * file-change-snapshot-store.js — 撤销用文件内容快照（SQLite 持久化）
 *
 * - 默认启用；环境变量 HANA_FILE_SNAPSHOTS=0 可关闭
 * - HANA_FILE_SNAPSHOT_MAX 覆盖默认上限（文件条数，默认 1000）
 * - 淘汰策略：优先按「整轮 turn」从最早创建的快照开始删，避免在可能的情况下拆轮；
 *   若仍超限（例如单轮快照过多）再按行删最旧记录
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

export class FileSnapshotStore {
  /**
   * @param {string} dbPath
   * @param {object} [opts]
   * @param {number} [opts.maxSnapshots=1000] 全局「文件快照」条数上限
   * @param {(turnId: string) => void} [opts.onTurnEvicted] 某 turn 在库中被删掉（整轮或部分）时回调，用于同步内存 Map
   */
  constructor(dbPath, opts = {}) {
    this.maxSnapshots = Math.max(1, Number(opts.maxSnapshots) || 1000);
    this.onTurnEvicted = typeof opts.onTurnEvicted === "function" ? opts.onTurnEvicted : () => {};

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        old_content TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(turn_id, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_fs_turn ON file_snapshots(turn_id);
      CREATE INDEX IF NOT EXISTS idx_fs_created ON file_snapshots(created_at);
    `);

    this._insert = this.db.prepare(`
      INSERT OR IGNORE INTO file_snapshots (turn_id, file_path, old_content, created_at)
      VALUES (@turnId, @filePath, @oldContent, @createdAt)
    `);
    this._countAll = this.db.prepare(`SELECT COUNT(*) AS n FROM file_snapshots`);
    this._selectByTurn = this.db.prepare(`
      SELECT file_path AS file_path, old_content AS old_content
      FROM file_snapshots WHERE turn_id = ? ORDER BY id ASC
    `);
    this._deleteByTurn = this.db.prepare(`DELETE FROM file_snapshots WHERE turn_id = ?`);
    this._oldestTurn = this.db.prepare(`
      SELECT turn_id AS turn_id FROM file_snapshots
      GROUP BY turn_id
      ORDER BY MIN(created_at) ASC, MIN(id) ASC
      LIMIT 1
    `);
    this._selectOldestRows = this.db.prepare(`
      SELECT id AS id, turn_id AS turn_id FROM file_snapshots
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `);
    this._deleteById = this.db.prepare(`DELETE FROM file_snapshots WHERE id = ?`);
    this._distinctTurnCount = this.db.prepare(`SELECT COUNT(DISTINCT turn_id) AS c FROM file_snapshots`);
  }

  _totalCount() {
    return this._countAll.get().n;
  }

  /**
   * @param {string} turnId
   * @param {string} filePath
   * @param {string|null} oldContent null = 写入前文件不存在
   */
  append(turnId, filePath, oldContent) {
    const tid = String(turnId);
    const row = {
      turnId: tid,
      filePath,
      oldContent: oldContent === null ? null : oldContent,
      createdAt: Date.now(),
    };
    const tx = this.db.transaction(() => {
      const info = this._insert.run(row);
      if (info.changes === 0) return;
      this._evictIfOverLimit();
    });
    tx();
  }

  _evictIfOverLimit() {
    let n = this._totalCount();
    while (n > this.maxSnapshots) {
      const distinctTurns = this._distinctTurnCount.get().c;
      if (distinctTurns > 1) {
        const trow = this._oldestTurn.get();
        if (!trow?.turn_id) {
          this._evictOldestRows(n - this.maxSnapshots);
          break;
        }
        const del = this._deleteByTurn.run(trow.turn_id);
        if (del.changes === 0) {
          this._evictOldestRows(n - this.maxSnapshots);
          break;
        }
        n -= del.changes;
        this.onTurnEvicted(String(trow.turn_id));
      } else {
        this._evictOldestRows(n - this.maxSnapshots);
        break;
      }
    }
    n = this._totalCount();
    if (n > this.maxSnapshots) {
      this._evictOldestRows(n - this.maxSnapshots);
    }
  }

  _evictOldestRows(howMany) {
    const k = Math.max(0, Math.floor(howMany));
    if (k === 0) return;
    const rows = this._selectOldestRows.all(k);
    if (!rows.length) return;
    const affectedTurns = new Set();
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        this._deleteById.run(r.id);
        affectedTurns.add(String(r.turn_id));
      }
    });
    tx();
    for (const tid of affectedTurns) {
      this.onTurnEvicted(tid);
    }
  }

  /**
   * @param {string} turnId
   * @returns {Array<{ path: string, oldContent: string|null }>}
   */
  loadTurn(turnId) {
    return this._selectByTurn.all(String(turnId)).map((r) => ({
      path: r.file_path,
      oldContent: r.old_content == null ? null : r.old_content,
    }));
  }

  /**
   * @param {string} turnId
   * @returns {{ count: number, files: string[] } | null}
   */
  getTurnInfo(turnId) {
    const rows = this._selectByTurn.all(String(turnId));
    if (!rows.length) return null;
    return { count: rows.length, files: rows.map((r) => r.file_path) };
  }

  deleteTurn(turnId) {
    this._deleteByTurn.run(String(turnId));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
