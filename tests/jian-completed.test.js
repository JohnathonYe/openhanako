import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  extractCompletedFromSession,
  extractCompletedFromReply,
  extractFailedFromReply,
  markCompletedInJian,
  markFailedInJian,
  normalizeJianContent,
  pruneCompletedFromJian,
} from "../lib/desk/jian-completed.js";

describe("jian-completed", () => {
  it("extractCompletedFromSession 从 session 文件提取 todo 已完成项", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-session-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "任务A", done: false }] } } }) + "\n",
      JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "任务A", done: true }, { id: 2, text: "任务B", done: true }] } } }) + "\n",
    ];
    fs.writeFileSync(sessionPath, lines.join(""), "utf-8");
    const got = extractCompletedFromSession(sessionPath);
    expect(got).toEqual(["任务A", "任务B"]);
    fs.rmSync(dir, { recursive: true });
  });

  it("extractCompletedFromReply 解析 <COMPLETED> 块", () => {
    const reply = "已完成。\n<COMPLETED>整理文档\n更新 README</COMPLETED>";
    const got = extractCompletedFromReply(reply);
    expect(got).toEqual(["整理文档", "更新 README"]);
  });

  it("extractFailedFromReply 解析 <FAILED> 块", () => {
    const reply = "部分失败。\n<FAILED>发送邮件\n部署上线</FAILED>";
    const got = extractFailedFromReply(reply);
    expect(got).toEqual(["发送邮件", "部署上线"]);
  });

  it("extractFailedFromReply 无失败项返回空数组", () => {
    expect(extractFailedFromReply("一切顺利")).toEqual([]);
    expect(extractFailedFromReply(null)).toEqual([]);
  });

  // ── markCompletedInJian (✅) ──

  it("markCompletedInJian 将匹配行标记为 ✅", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-md-"));
    const jianPath = path.join(dir, "jian.md");
    const content = "# 待办\n- [ ] 整理文档\n- [ ] 更新 README\n";
    fs.writeFileSync(jianPath, content, "utf-8");
    const updated = markCompletedInJian(jianPath, ["整理文档"]);
    expect(updated).toBe(true);
    const after = fs.readFileSync(jianPath, "utf-8");
    expect(after).toContain("✅ 整理文档");
    expect(after).toContain("- [ ] 更新 README");
    expect(after).not.toContain("[x]");
    fs.rmSync(dir, { recursive: true });
  });

  // ── markFailedInJian (❌) ──

  it("markFailedInJian 将匹配行标记为 ❌", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-fail-"));
    const jianPath = path.join(dir, "jian.md");
    const content = "- [ ] 发送邮件\n- [ ] 写报告\n";
    fs.writeFileSync(jianPath, content, "utf-8");
    const updated = markFailedInJian(jianPath, ["发送邮件"]);
    expect(updated).toBe(true);
    const after = fs.readFileSync(jianPath, "utf-8");
    expect(after).toContain("❌ 发送邮件");
    expect(after).toContain("- [ ] 写报告");
    fs.rmSync(dir, { recursive: true });
  });

  // ── normalizeJianContent ──

  it("normalizeJianContent 将纯文本行加上 - [ ] 前缀", () => {
    const input = "买牛奶\n整理文档\n";
    const out = normalizeJianContent(input);
    expect(out).toBe("- [ ] 买牛奶\n- [ ] 整理文档\n");
  });

  it("normalizeJianContent 保留已有 checkbox 行", () => {
    const input = "- [ ] 任务A\n- [x] 任务B\n新任务C\n";
    const out = normalizeJianContent(input);
    expect(out).toBe("- [ ] 任务A\n- [x] 任务B\n- [ ] 新任务C\n");
  });

  it("normalizeJianContent 保留 ✅ 和 ❌ 行", () => {
    const input = "✅ 完成项\n❌ 失败项\n新任务\n";
    const out = normalizeJianContent(input);
    expect(out).toBe("✅ 完成项\n❌ 失败项\n- [ ] 新任务\n");
  });

  it("normalizeJianContent 保留空行和 markdown 标题", () => {
    const input = "# 今日任务\n\n买牛奶\n\n# 明日\n写报告\n";
    const out = normalizeJianContent(input);
    expect(out).toBe("# 今日任务\n\n- [ ] 买牛奶\n\n# 明日\n- [ ] 写报告\n");
  });

  it("normalizeJianContent 处理空内容", () => {
    expect(normalizeJianContent("")).toBe("");
    expect(normalizeJianContent(null)).toBe("");
  });

  // ── pruneCompletedFromJian ──

  it("pruneCompletedFromJian 移除 ✅ 行", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-prune-"));
    const jianPath = path.join(dir, "jian.md");
    fs.writeFileSync(jianPath, "# 任务\n✅ 已完成\n- [ ] 待做\n✅ 也完成了\n", "utf-8");
    const result = pruneCompletedFromJian(jianPath);
    expect(result).toEqual({ pruned: true, count: 2, reverted: 0 });
    const after = fs.readFileSync(jianPath, "utf-8");
    expect(after).toContain("- [ ] 待做");
    expect(after).not.toContain("✅");
    fs.rmSync(dir, { recursive: true });
  });

  it("pruneCompletedFromJian ❌ 行回退为 - [ ]", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-revert-"));
    const jianPath = path.join(dir, "jian.md");
    fs.writeFileSync(jianPath, "✅ 完成\n❌ 失败项\n- [ ] 待做\n", "utf-8");
    const result = pruneCompletedFromJian(jianPath);
    expect(result).toEqual({ pruned: true, count: 1, reverted: 1 });
    const after = fs.readFileSync(jianPath, "utf-8");
    expect(after).toContain("- [ ] 失败项");
    expect(after).toContain("- [ ] 待做");
    expect(after).not.toContain("✅");
    expect(after).not.toContain("❌");
    fs.rmSync(dir, { recursive: true });
  });

  it("pruneCompletedFromJian 兼容旧 - [x] 格式", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-legacy-"));
    const jianPath = path.join(dir, "jian.md");
    fs.writeFileSync(jianPath, "- [x] 旧完成\n- [ ] 待做\n", "utf-8");
    const result = pruneCompletedFromJian(jianPath);
    expect(result.pruned).toBe(true);
    expect(result.count).toBe(1);
    const after = fs.readFileSync(jianPath, "utf-8");
    expect(after).not.toContain("[x]");
    expect(after).toContain("- [ ] 待做");
    fs.rmSync(dir, { recursive: true });
  });

  it("pruneCompletedFromJian 全部完成时删除文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-prune-all-"));
    const jianPath = path.join(dir, "jian.md");
    fs.writeFileSync(jianPath, "✅ 完成A\n✅ 完成B\n", "utf-8");
    const result = pruneCompletedFromJian(jianPath);
    expect(result).toEqual({ pruned: true, count: 2, reverted: 0 });
    expect(fs.existsSync(jianPath)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("pruneCompletedFromJian 无已完成项时不修改", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-prune-noop-"));
    const jianPath = path.join(dir, "jian.md");
    const content = "- [ ] 任务A\n- [ ] 任务B\n";
    fs.writeFileSync(jianPath, content, "utf-8");
    const result = pruneCompletedFromJian(jianPath);
    expect(result).toEqual({ pruned: false, count: 0, reverted: 0 });
    expect(fs.readFileSync(jianPath, "utf-8")).toBe(content);
    fs.rmSync(dir, { recursive: true });
  });

  it("pruneCompletedFromJian 合并多余空行", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jian-prune-gaps-"));
    const jianPath = path.join(dir, "jian.md");
    fs.writeFileSync(jianPath, "# 任务\n\n✅ 完成\n\n- [ ] 待做\n", "utf-8");
    const result = pruneCompletedFromJian(jianPath);
    expect(result.pruned).toBe(true);
    const after = fs.readFileSync(jianPath, "utf-8");
    expect(after).not.toMatch(/\n{3,}/);
    expect(after).toContain("- [ ] 待做");
    fs.rmSync(dir, { recursive: true });
  });
});
