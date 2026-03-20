import { describe, expect, it } from "vitest";
import { parseAssistantOrdinal, resolveAgentRef } from "../lib/tools/service-handoff-tool.js";

describe("parseAssistantOrdinal", () => {
  it("parses Arabic digits", () => {
    expect(parseAssistantOrdinal("3号")).toBe(3);
    expect(parseAssistantOrdinal("12号")).toBe(12);
  });

  it("parses Chinese ordinals", () => {
    expect(parseAssistantOrdinal("三号")).toBe(3);
    expect(parseAssistantOrdinal("十一号")).toBe(11);
  });
});

describe("resolveAgentRef", () => {
  const agents = [
    { id: "butter", name: "Butter" },
    { id: "hana", name: "花子" },
    { id: "sanhao", name: "3号" },
  ];

  it("matches id", () => {
    expect(resolveAgentRef(agents, "butter")?.id).toBe("butter");
  });

  it("matches display name case-insensitively", () => {
    expect(resolveAgentRef(agents, "butter")?.id).toBe("butter");
    expect(resolveAgentRef(agents, "花子")?.id).toBe("hana");
  });

  it("resolves N号 by list order", () => {
    const orderedIds = ["hana", "butter", "sanhao"];
    expect(resolveAgentRef(agents, "1号", { orderedIds })?.id).toBe("hana");
    expect(resolveAgentRef(agents, "2号", { orderedIds })?.id).toBe("butter");
    expect(resolveAgentRef(agents, "3号", { orderedIds })?.id).toBe("sanhao");
  });

  it("returns null when not found", () => {
    expect(resolveAgentRef(agents, "nope")).toBeNull();
  });
});
