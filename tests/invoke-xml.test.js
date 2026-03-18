/**
 * core/llm-utils.js 中 XML <invoke>/<parameter> 解析与 content 归一化
 */
import { describe, it, expect } from "vitest";
import {
  parseInvokeXml,
  normalizeToolCallContent,
  isToolCallBlock,
  getToolArgs,
} from "../core/llm-utils.js";

describe("parseInvokeXml", () => {
  it("解析单条 invoke，单 parameter", () => {
    const text = `<invoke name="cdp_local_browser">
<parameter name="action">list</parameter>
</invoke>`;
    const out = parseInvokeXml(text);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("cdp_local_browser");
    expect(out[0].input).toEqual({ action: "list" });
  });

  it("解析单条 invoke，多 parameter", () => {
    const text = `<invoke name="my_tool">
<parameter name="a">1</parameter>
<parameter name="b">true</parameter>
<parameter name="c">hello</parameter>
</invoke>`;
    const out = parseInvokeXml(text);
    expect(out).toHaveLength(1);
    expect(out[0].input).toEqual({ a: 1, b: true, c: "hello" });
  });

  it("无 invoke 返回空数组", () => {
    expect(parseInvokeXml("plain text")).toEqual([]);
    expect(parseInvokeXml("")).toEqual([]);
  });

  it("多条 invoke 均解析", () => {
    const text = `<invoke name="tool_a"><parameter name="x">1</parameter></invoke>
<invoke name="tool_b"><parameter name="y">2</parameter></invoke>`;
    const out = parseInvokeXml(text);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("tool_a");
    expect(out[0].input).toEqual({ x: 1 });
    expect(out[1].name).toBe("tool_b");
    expect(out[1].input).toEqual({ y: 2 });
  });
});

describe("normalizeToolCallContent", () => {
  it("字符串中含 invoke 转为 tool_use 块并剥离 XML 文本", () => {
    const content = `before
<invoke name="cdp_local_browser">
<parameter name="action">list</parameter>
</invoke>
after`;
    const out = normalizeToolCallContent(content);
    expect(Array.isArray(out)).toBe(true);
    const toolBlocks = out.filter(isToolCallBlock);
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0].name).toBe("cdp_local_browser");
    expect(getToolArgs(toolBlocks[0])).toEqual({ action: "list" });
    const textBlocks = out.filter(b => b.type === "text");
    expect(textBlocks.map(b => b.text).join("")).toMatch(/before/);
    expect(textBlocks.map(b => b.text).join("")).toMatch(/after/);
    expect(textBlocks.some(b => b.text.includes("invoke"))).toBe(false);
  });

  it("已是 tool_use 块则保留", () => {
    const content = [{ type: "tool_use", name: "existing", input: { k: "v" } }];
    const out = normalizeToolCallContent(content);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool_use");
    expect(out[0].name).toBe("existing");
    expect(out[0].input).toEqual({ k: "v" });
  });

  it("无 invoke 的字符串变为单 text 块", () => {
    const out = normalizeToolCallContent("hello");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect(out[0].text).toBe("hello");
  });
});
