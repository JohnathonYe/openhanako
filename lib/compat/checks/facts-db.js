/**
 * facts-db.js — facts.db 健康检查
 *
 * 尝试打开 facts.db 并执行简单查询。
 * 如果打不开或表结构损坏，备份原文件并让 FactStore 重建空库。
 */

import fs from "fs";
import path from "path";
import { t } from "../../../server/i18n.js";
import { FatalCompatError } from "../errors.js";

/** better-sqlite3 原生绑定未加载（架构/ABI 不匹配等），不是 SQLite 文件损坏 */
function isNativeBindingLoadError(err) {
  if (!err) return false;
  if (err.code === "ERR_DLOPEN_FAILED") return true;
  const msg = String(err.message || "");
  if (/incompatible architecture/i.test(msg)) return true;
  if (/wrong ELF class/i.test(msg)) return true;
  if (/was compiled against a different Node\.js version/i.test(msg)) return true;
  if (/NODE_MODULE_VERSION/i.test(msg)) return true;
  return false;
}

export async function checkFactsDb({ agentDir, log }) {
  const dbPath = path.join(agentDir, "memory", "facts.db");
  if (!fs.existsSync(dbPath)) return; // 新 agent，没有 db 很正常

  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return; // Electron 环境外可能加载不了 native module，跳过
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    // 验证核心表存在且可查询
    db.prepare("SELECT COUNT(*) FROM facts").get();
    db.close();
  } catch (err) {
    if (isNativeBindingLoadError(err)) {
      const hint = "npm run rebuild";
      let msg = t("error.compatNativeModuleMismatch", { hint });
      if (!msg || msg === "error.compatNativeModuleMismatch") {
        msg = `better-sqlite3 native module does not match this process architecture or Node ABI. From the project root run: ${hint}`;
      }
      throw new FatalCompatError(msg, { cause: err });
    }
    // 数据库损坏，备份后让 FactStore 重建
    const backupPath = dbPath + `.bak-${Date.now()}`;
    try {
      fs.renameSync(dbPath, backupPath);
      // 同时备份 WAL/SHM 文件
      for (const ext of ["-wal", "-shm"]) {
        const walPath = dbPath + ext;
        if (fs.existsSync(walPath)) {
          fs.renameSync(walPath, backupPath + ext);
        }
      }
    } catch {}

    (log || console.log)(`  [compat] facts.db 损坏 (${err.message})，已备份到 ${path.basename(backupPath)}`);
    return { fixed: true, message: t("error.compatFactsCorrupted") };
  }
}
