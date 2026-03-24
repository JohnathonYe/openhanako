/**
 * diary.js — 日记 REST API
 *
 * 写日记请走 WebSocket：{ type: "diary_write" }（避免 HTTP 长时间阻塞/超时）
 * GET  /api/diary/list  — 列出已有日记
 */

import fs from "fs";
import { resolveDiaryDir } from "../../lib/diary/diary-writer.js";

export default async function diaryRoute(app, { engine }) {

  /** GET /api/diary/list — 列出已有日记文件 */
  app.get("/api/diary/list", async (_req, reply) => {
    const cwd = engine.homeCwd || process.cwd();
    const diaryDir = resolveDiaryDir(cwd);
    try {
      const files = fs.readdirSync(diaryDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse();
      return reply.send({ files });
    } catch {
      return reply.send({ files: [] });
    }
  });
}
