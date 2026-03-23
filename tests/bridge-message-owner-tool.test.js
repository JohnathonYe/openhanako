import { describe, expect, it, vi } from "vitest";
import { createBridgeMessageOwnerTool } from "../lib/tools/bridge-message-owner-tool.js";

describe("bridge_message_owner tool", () => {
  it("returns friendly text when bridge unavailable", async () => {
    const tool = createBridgeMessageOwnerTool({
      getEngine: () => ({
        sendBridgeOwnerIm: vi.fn().mockResolvedValue({ ok: false, reason: "bridge_unavailable" }),
      }),
    });
    const out = await tool.execute("id", {
      platform: "telegram",
      user: "123",
      message: "hi",
    });
    expect(out.content[0].text).toMatch(/未就绪/);
  });

  it("reports success when sent", async () => {
    const tool = createBridgeMessageOwnerTool({
      getEngine: () => ({
        sendBridgeOwnerIm: vi.fn().mockResolvedValue({
          ok: true,
          sent: true,
          platform: "telegram",
          chatId: "c",
          sessionKey: "tg_dm_x",
        }),
      }),
    });
    const out = await tool.execute("id", {
      platform: "telegram",
      message: "hello",
    });
    expect(out.content[0].text).toMatch(/telegram/);
    expect(out.details?.platform).toBe("telegram");
  });
});
