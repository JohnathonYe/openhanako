/**
 * 模型选择无 fallback 测试
 *
 * 验证所有模型选择路径在找不到指定模型时抛错，而非静默 fallback。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Pi SDK ──

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

// ── Helpers ──

function makeModels(list = []) {
  return {
    authStorage: {},
    modelRegistry: {},
    defaultModel: list[0] || null,
    availableModels: list,
    resolveExecutionModel: (m) => m,
    resolveThinkingLevel: () => "medium",
    inferModelProvider: () => null,
  };
}

function makeCoordinator(tempDir, { agentConfig = {}, models = makeModels() } = {}) {
  sessionManagerCreateMock.mockReturnValue({ getCwd: () => tempDir });
  createAgentSessionMock.mockResolvedValue({
    session: {
      sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
      subscribe: vi.fn(() => vi.fn()),
      abort: vi.fn(),
    },
  });

  return new SessionCoordinator({
    agentsDir: tempDir,
    getAgent: () => ({
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "test-agent",
      config: agentConfig,
      tools: [],
    }),
    getActiveAgentId: () => "test",
    getModels: () => models,
    getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
    getSkills: () => ({ getSkillsForAgent: () => [] }),
    buildTools: async () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: (id) => ({
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: id,
      config: agentConfig,
      tools: [],
    }),
    listAgents: () => [],
  });
}

// ── Tests ──

describe("模型选择无 fallback", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-nofallback-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ────── resolveModel (createSessionContext) ──────

  describe("resolveModel", () => {
    it("找到指定模型时正常返回", () => {
      const models = makeModels([
        { id: "qwen3.5-plus", provider: "dashscope" },
        { id: "gpt-5", provider: "openai" },
      ]);
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: "qwen3.5-plus" } },
        models,
      });
      const ctx = coord.createSessionContext();
      const result = ctx.resolveModel({ models: { chat: "qwen3.5-plus" } });
      expect(result).toEqual({ id: "qwen3.5-plus", provider: "dashscope" });
    });

    it("models.chat 未配置且无默认模型时抛错", () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([]),
      });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({})).toThrow("未指定 models.chat");
      expect(() => ctx.resolveModel({ models: {} })).toThrow("未指定 models.chat");
    });

    it("models.chat 未配置时回退到全局默认模型", () => {
      const models = makeModels([{ id: "some-model", provider: "x" }]);
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      expect(ctx.resolveModel({})).toEqual({ id: "some-model", provider: "x" });
      expect(ctx.resolveModel({ models: {} })).toEqual({ id: "some-model", provider: "x" });
    });

    it("指定的模型不在 availableModels 中且无默认模型时抛错", () => {
      const models = {
        authStorage: {},
        modelRegistry: {},
        defaultModel: null,
        availableModels: [
          { id: "gpt-5", provider: "openai" },
          { id: "MiniMax-M2", provider: "minimax" },
        ],
        resolveExecutionModel: (m) => m,
        resolveThinkingLevel: () => "medium",
        inferModelProvider: () => null,
      };
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({ models: { chat: "qwen3.5-plus" } }))
        .toThrow('模型 "qwen3.5-plus" 不在可用列表中');
    });

    it("指定的模型不在 availableModels 中时回退到全局默认模型", () => {
      const models = makeModels([
        { id: "gpt-5", provider: "openai" },
        { id: "MiniMax-M2", provider: "minimax" },
      ]);
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      expect(ctx.resolveModel({ models: { chat: "qwen3.5-plus" } })).toEqual({
        id: "gpt-5",
        provider: "openai",
      });
    });

    it("availableModels 为空时抛错", () => {
      const coord = makeCoordinator(tempDir, { models: makeModels([]) });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({ models: { chat: "qwen3.5-plus" } }))
        .toThrow('模型 "qwen3.5-plus" 不在可用列表中');
    });
  });

  // ────── executeIsolated ──────

  describe("executeIsolated", () => {
    it("agent 未配置 models.chat 且无全局默认模型时抛错", async () => {
      const base = makeModels([{ id: "some-model", provider: "x" }]);
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: { ...base, defaultModel: null, currentModel: null },
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toContain("未指定 models.chat");
    });

    it("agent 未配置 models.chat 时可用当前会话模型（主界面切换，不写 config）", async () => {
      const sharedAgent = {
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: {},
        tools: [],
      };
      const sessionModel = { id: "pill-only", provider: "x" };
      const base = makeModels([sessionModel]);
      const models = { ...base, defaultModel: null, currentModel: sessionModel };
      sessionManagerCreateMock.mockReturnValue({ getCwd: () => tempDir });
      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
          prompt: vi.fn(),
        },
      });
      const coord = new SessionCoordinator({
        agentsDir: tempDir,
        getAgent: () => sharedAgent,
        getActiveAgentId: () => "test",
        getModels: () => models,
        getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
        getSkills: () => ({ getSkillsForAgent: () => [] }),
        buildTools: async () => ({ tools: [], customTools: [] }),
        emitEvent: () => {},
        getHomeCwd: () => tempDir,
        agentIdFromSessionPath: () => null,
        switchAgentOnly: async () => {},
        getConfig: () => ({}),
        getPrefs: () => ({ getThinkingLevel: () => "medium" }),
        getAgents: () => new Map(),
        getActivityStore: () => null,
        getAgentById: () => sharedAgent,
        listAgents: () => [],
      });
      const result = await coord.executeIsolated("hello", { agentId: "test" });
      expect(result.error).toBeFalsy();
      expect(createAgentSessionMock.mock.calls[0][0].model).toEqual(sessionModel);
    });

    it("agent 未配置 models.chat 时回退到全局默认模型", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([{ id: "fallback-id", provider: "x" }]),
      });
      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toBeFalsy();
      expect(createAgentSessionMock.mock.calls[0][0].model).toEqual({
        id: "fallback-id",
        provider: "x",
      });
    });

    it("配置的模型不在可用列表中时抛错", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: "nonexistent-model" } },
        models: makeModels([{ id: "gpt-5", provider: "openai" }]),
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toContain('模型 "nonexistent-model" 不在可用列表中');
    });

    it("模型匹配成功时正常执行", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: "qwen3.5-plus" } },
        models: makeModels([{ id: "qwen3.5-plus", provider: "dashscope" }]),
      });

      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });

      const result = await coord.executeIsolated("hello");
      expect(result.error).toBeFalsy();
      expect(createAgentSessionMock).toHaveBeenCalledOnce();
      expect(createAgentSessionMock.mock.calls[0][0].model).toEqual({
        id: "qwen3.5-plus",
        provider: "dashscope",
      });
    });

    it("通过 opts.model 显式传入模型时跳过 config 查找", async () => {
      const explicitModel = { id: "explicit", provider: "test" };
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},  // 没有 models.chat
        models: makeModels([explicitModel]),
      });

      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });

      const result = await coord.executeIsolated("hello", { model: explicitModel });
      expect(result.error).toBeFalsy();
    });
  });

  // ────── resolveUtilityConfig ──────

  describe("resolveUtilityConfig", () => {
    // 直接测试 ModelManager 的 resolveUtilityConfig 方法
    let ModelManager;

    beforeEach(async () => {
      const mod = await import("../core/model-manager.js");
      ModelManager = mod.ModelManager;
    });

    it("utility 未配置时抛错", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      expect(() => mm.resolveUtilityConfig({}, {}, {}))
        .toThrow("未配置 utility 模型");
    });

    it("utility_large 未配置时抛错", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      expect(() => mm.resolveUtilityConfig({}, { utility: "some-model" }, {}))
        .toThrow("未配置 utility_large 模型");
    });

    it("utility 和 utility_large 都配置时正常返回", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      // 用不存在于全局 providers.yaml 的 provider，避免读到真实凭证
      mm._availableModels = [
        { id: "util-model", provider: "test-provider" },
        { id: "large-model", provider: "test-provider" },
      ];
      const result = mm.resolveUtilityConfig(
        {
          providers: {
            "test-provider": {
              api_key: "sk-test",
              base_url: "https://test.example.com/v1",
              api: "openai-completions",
            },
          },
        },
        { utility: "util-model", utility_large: "large-model" },
        {},
      );
      expect(result.utility).toBe("util-model");
      expect(result.utility_large).toBe("large-model");
      expect(result.api_key).toBe("sk-test");
      expect(result.api).toBe("openai-completions");
    });

    it("utility_api 与模型 provider 不一致时直接报错", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      mm._availableModels = [
        { id: "util-model", provider: "test-provider" },
        { id: "large-model", provider: "test-provider" },
      ];
      expect(() => mm.resolveUtilityConfig(
        {
          providers: {
            "test-provider": {
              api_key: "sk-test",
              base_url: "https://test.example.com/v1",
              api: "openai-completions",
            },
          },
        },
        { utility: "util-model", utility_large: "large-model" },
        { provider: "openai", api_key: "sk-test", base_url: "https://api.openai.com/v1" },
      )).toThrow('utility_api.provider 必须与模型 "util-model" 的 provider 一致');
    });

    it("不再接受 hardcoded fallback 模型名", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      // 以前会 fallback 到 "doubao-seed-2-0-mini-260215"，现在应该抛错
      expect(() => mm.resolveUtilityConfig({}, {}, {}))
        .toThrow("未配置 utility 模型");
    });
  });
});
