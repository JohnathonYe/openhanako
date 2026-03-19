/**
 * fs.js — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在 ~/.hanako/ 和 desk 工作空间内。
 */

import fs from "fs";
import path from "path";
import { MAX_AUDIO_BYTES, MAX_VIDEO_BYTES, isAudioFilename, isVideoFilename } from "../../lib/media-limits.js";
import { t } from "../i18n.js";

/** 安全路径校验：resolved 必须在 allowedRoots 之一内部 */
function isSafePath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

export default async function fsRoute(app, { engine }) {
  const hanakoHome = path.resolve(engine.hanakoHome);

  // 收集允许的根目录
  function getAllowedRoots() {
    const roots = [hanakoHome];
    // desk 工作空间目录（用户可能配在 ~/.hanako 外面）
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(path.resolve(deskHome));
    return roots;
  }

  // GET /api/fs/read?path=... → UTF-8 文本
  app.get("/api/fs/read", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      reply.type("text/plain").send(content);
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });

  // GET /api/fs/read-base64?path=... → base64 编码
  app.get("/api/fs/read-base64", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return reply.code(404).send({ error: "file not found" });
      }
      const base = path.basename(filePath);
      if (isVideoFilename(base) && stat.size > MAX_VIDEO_BYTES) {
        return reply.code(413).send({ error: t("error.videoTooLarge") });
      }
      if (isAudioFilename(base) && stat.size > MAX_AUDIO_BYTES) {
        return reply.code(413).send({ error: t("error.audioTooLarge") });
      }
      const buf = fs.readFileSync(filePath);
      reply.type("text/plain").send(buf.toString("base64"));
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });
}
