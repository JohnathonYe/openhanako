/**
 * 全局偏好设置路由（跨 agent 共享）
 *
 * GET  /api/preferences/models  — 读取全局模型 + 搜索配置
 * PUT  /api/preferences/models  — 更新全局模型 + 搜索配置
 * DELETE /api/preferences/tools/:id — 删除用户脚本工具（仅 user_script，并删除对应文件）
 */

import fs from "fs";
import { debugLog } from "../../lib/debug-log.js";
import { getUserScriptToolFilePath } from "../../lib/tools/registry.js";

export default async function preferencesRoute(app, { engine }) {

  const mask = (key) => {
    if (!key) return "";
    if (key.length < 8) return "****";
    return key.slice(0, 4) + "..." + key.slice(-4);
  };

  // 读取全局模型 + 搜索配置
  app.get("/api/preferences/models", async (req, reply) => {
    try {
      const models = engine.getSharedModels();
      const search = engine.getSearchConfig();
      const utilityApi = engine.getUtilityApi();

      return {
        models,
        search: {
          provider: search.provider || "",
          api_key: mask(search.api_key),
        },
        utility_api: {
          provider: utilityApi.provider || "",
          base_url: utilityApi.base_url || "",
          api_key: mask(utilityApi.api_key),
        },
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 更新全局模型 + 搜索配置
  app.put("/api/preferences/models", async (req, reply) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") {
        reply.code(400);
        return { error: "invalid JSON body" };
      }

      const sections = [];
      let needsModelSync = false;
      // 共享模型（utility / utility_large）
      if (body.models) {
        engine.setSharedModels(body.models);
        sections.push("models");
        needsModelSync = true;
      }

      // 搜索配置
      if (body.search) {
        engine.setSearchConfig(body.search);
        sections.push("search");
      }

      // utility API 配置
      if (body.utility_api) {
        engine.setUtilityApi(body.utility_api);
        sections.push("utility_api");
      }

      if (needsModelSync) {
        try { await engine.syncModelsAndRefresh(); } catch (e) {
          debugLog()?.warn("api", `syncModelsAndRefresh after preferences change: ${e.message}`);
        }
      }

      debugLog()?.log("api", `PUT /api/preferences/models sections=[${sections.join(",")}]`);
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/preferences/models failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 工具开关（全局 preferences.tools_disabled）──
  app.get("/api/preferences/tools", async (req, reply) => {
    try {
      const tools = engine.getToolRegistry();
      const disabled = engine.getToolsDisabled();
      return { tools, disabled };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/preferences/tools", async (req, reply) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") {
        reply.code(400);
        return { error: "invalid JSON body" };
      }
      const disabled = Array.isArray(body.disabled) ? body.disabled : [];
      engine.setToolsDisabled(disabled);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 避免 GET /api/preferences/tools/:id 被误用时返回 404；明确返回 405
  app.get("/api/preferences/tools/:id", async (req, reply) => {
    reply.code(405);
    reply.header("Allow", "DELETE");
    return { error: "Method not allowed. Use DELETE to remove a user script tool." };
  });

  app.delete("/api/preferences/tools/:id", async (req, reply) => {
    try {
      const { id } = req.params;
      if (!id || !id.startsWith("user_")) {
        reply.code(400);
        return { error: "Only user script tools can be deleted" };
      }
      const filePath = getUserScriptToolFilePath(engine.hanakoHome, id);
      if (filePath) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          reply.code(500);
          return { error: err.message };
        }
      }
      const disabled = engine.getToolsDisabled().filter((x) => x !== id);
      engine.setToolsDisabled(disabled);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });
}
