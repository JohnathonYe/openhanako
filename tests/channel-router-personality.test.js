import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRouter } from "../hub/channel-router.js";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn() }),
  previewForLog: (t, n) => String(t ?? "").slice(0, n ?? 400),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/channels/channel-store.js", () => ({
  formatMessagesForLLM: (msgs) =>
    msgs.map(m => `${m.sender}: ${m.body ?? m.text ?? ""}`).join("\n"),
  appendMessage: vi.fn(),
  getRecentMessages: vi.fn(() => []),
}));

vi.mock("../lib/memory/config-loader.js", () => ({
  loadConfig: vi.fn(() => ({ agent: { name: "FallbackAgent" } })),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentSession: vi.fn(),
}));

function createRouter() {
  return new ChannelRouter({
    hub: {
      engine: {
        agentsDir: "/fake/agents",
        channelsDir: "/fake/channels",
        userDir: "/fake/user",
        agents: new Map([["hana", {
          config: { agent: { name: "Hana", yuan: "hanako" } },
          personality: "我是 Hana。",
        }]]),
        resolveUtilityConfig: () => ({
          utility: "test-model",
          api_key: "test-key",
          base_url: "https://test.api",
          api: "openai-completions",
        }),
      },
      eventBus: { emit: vi.fn() },
    },
  });
}

describe("ChannelRouter._executeCheck reply pipeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getRecentMessages } = await import("../lib/channels/channel-store.js");
    getRecentMessages.mockReturnValue([]);
  });

  it("刚发过言且无人追问时，快速抑制重复回复", async () => {
    const { getRecentMessages } = await import("../lib/channels/channel-store.js");
    const { runAgentSession } = await import("../hub/agent-executor.js");
    getRecentMessages.mockReturnValueOnce([
      { sender: "hana", timestamp: "2099-01-01 10:00:00", body: "我建议先拆分需求优先级。" },
      { sender: "user", timestamp: "2099-01-01 10:00:20", body: "好的" },
    ]);
    const router = createRouter();

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "好的" }],
      [],
    );

    expect(result.replied).toBe(false);
    expect(runAgentSession).not.toHaveBeenCalled();
  });

  it("普通场景下模型返回 [NO_REPLY] 时不落盘", async () => {
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    const { runAgentSession } = await import("../hub/agent-executor.js");
    runAgentSession.mockResolvedValueOnce("[NO_REPLY]");
    const router = createRouter();

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "收到，没别的了" }],
      [],
    );

    expect(result.replied).toBe(false);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("被 @ 时即便模型给 [NO_REPLY] 也会回退可见回复", async () => {
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    const { runAgentSession } = await import("../hub/agent-executor.js");
    runAgentSession.mockResolvedValueOnce("[NO_REPLY]");
    const router = createRouter();

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "@hana 你来拍板吧" }],
      [],
      { mentionedAgents: ["hana"] },
    );

    expect(result.replied).toBe(true);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0][2]).toMatch(/在的|收到/);
  });

  it("定时 cycle：unread 里无用户发言且未 @ 本 agent 时不调用模型", async () => {
    const { runAgentSession } = await import("../hub/agent-executor.js");
    const router = createRouter();

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "other", text: "闲聊" }],
      [],
      {
        isScheduledCycle: true,
        unreadSinceBookmark: [{ sender: "other", body: "我刚发了一句" }],
      },
    );

    expect(result.replied).toBe(false);
    expect(runAgentSession).not.toHaveBeenCalled();
  });

  it("未点名时模型输出敷衍短句不落盘", async () => {
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    const { runAgentSession } = await import("../hub/agent-executor.js");
    runAgentSession.mockResolvedValueOnce("嗯嗯");
    const router = createRouter();

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "频道里近况如何" }],
      [],
    );

    expect(result.replied).toBe(false);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
