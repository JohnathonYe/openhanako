import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

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
  SettingsManager: {
    inMemory: () => ({}),
  },
}));

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("applies session memory before creating the agent session", async () => {
    let sessionMemoryEnabled = true;
    const buildTools = vi.fn(async () => ({ tools: [], customTools: [] }));
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      refreshSystemPrompt: vi.fn(),
    };

    const resourceLoader = {
      getSystemPrompt: () => (sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF"),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(false);
    expect(agent.refreshSystemPrompt).toHaveBeenCalledOnce();
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(buildTools).toHaveBeenCalledWith("/tmp/workspace", null, { workspace: "/tmp/workspace" });
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: "default-model" } },
        tools: [],
        refreshSystemPrompt: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model" },
        availableModels: [{ id: "default-model" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
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
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("delegate task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("refreshes system prompt when switching cached session within same agent", async () => {
    const targetPath = "/tmp/same-agent-session.jsonl";
    const session = {
      isStreaming: false,
      sessionManager: { getSessionFile: () => targetPath },
    };
    const agent = {
      setMemoryEnabled: vi.fn(),
      refreshSystemPrompt: vi.fn(),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: async () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    coordinator.sessions.set(targetPath, {
      session,
      agentId: "hana",
      memoryEnabled: true,
      lastTouchedAt: Date.now() - 1_000,
      unsub: vi.fn(),
    });

    await coordinator.switchSession(targetPath);

    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(true);
    expect(agent.refreshSystemPrompt).toHaveBeenCalledOnce();
  });
});
