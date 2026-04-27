/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FileSnapshotStore } from "../lib/tools/file-change-snapshot-store.js";

describe("FileSnapshotStore", () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fs-test-"));
    dbPath = path.join(tmpDir, "snap.sqlite");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("append + loadTurn + deleteTurn", () => {
    const evicted = [];
    const s = new FileSnapshotStore(dbPath, {
      maxSnapshots: 100,
      onTurnEvicted: (tid) => evicted.push(tid),
    });
    s.append("t1", "/a/x.txt", "hello");
    s.append("t1", "/a/y.txt", null);
    expect(s.loadTurn("t1")).toEqual([
      { path: "/a/x.txt", oldContent: "hello" },
      { path: "/a/y.txt", oldContent: null },
    ]);
    expect(s.getTurnInfo("t1").count).toBe(2);
    s.deleteTurn("t1");
    expect(s.loadTurn("t1")).toEqual([]);
    s.close();
  });

  it("evicts oldest full turn when multiple turns exceed max", () => {
    const evicted = [];
    const s = new FileSnapshotStore(dbPath, {
      maxSnapshots: 5,
      onTurnEvicted: (tid) => evicted.push(tid),
    });
    for (let i = 0; i < 3; i++) s.append("old", `/f${i}.txt`, `c${i}`);
    for (let i = 0; i < 3; i++) s.append("new", `/g${i}.txt`, `d${i}`);
    expect(s.loadTurn("old").length).toBe(0);
    expect(s.loadTurn("new").length).toBeGreaterThan(0);
    expect(evicted).toContain("old");
    s.close();
  });

  it("evicts oldest rows when a single turn exceeds max", () => {
    const evicted = [];
    const s = new FileSnapshotStore(dbPath, {
      maxSnapshots: 4,
      onTurnEvicted: (tid) => evicted.push(tid),
    });
    for (let i = 0; i < 6; i++) s.append("solo", `/s${i}.txt`, `x${i}`);
    const rows = s.loadTurn("solo");
    expect(rows.length).toBe(4);
    expect(rows[0].path).toBe("/s2.txt");
    expect(evicted.length).toBeGreaterThan(0);
    s.close();
  });
});
