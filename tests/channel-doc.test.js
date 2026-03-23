import { describe, it, expect } from "vitest";
import {
  resolveChannelDocFile,
  isSafeDocId,
  channelBodyWithOptionalDoc,
  CHANNEL_DOC_CHAR_THRESHOLD,
} from "../lib/channels/channel-doc.js";
import fs from "fs";
import os from "os";
import path from "path";

describe("channel-doc", () => {
  it("rejects invalid docId", () => {
    const base = path.join(os.tmpdir(), "hana-chdoc-test");
    expect(resolveChannelDocFile(base, "ch_x", "../evil.md")).toBeNull();
    expect(resolveChannelDocFile(base, "ch_x", "not-a-valid-id.md")).toBeNull();
    expect(isSafeDocId("1730000000_ab12cd34.md")).toBe(true);
    expect(isSafeDocId("../../../etc/passwd")).toBe(false);
  });

  it("writes doc and returns stub when over threshold", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-chdoc-"));
    const channelsDir = path.join(base, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    const long = "x".repeat(CHANNEL_DOC_CHAR_THRESHOLD + 1);
    const { body, fullMarkdown, docId } = channelBodyWithOptionalDoc(
      channelsDir,
      "ch_test",
      "agent1",
      long,
    );
    expect(fullMarkdown).toBe(long);
    expect(docId).toMatch(/^\d+_[a-f0-9]{8}\.md$/);
    expect(body).toContain("hana-channel-doc:ch_test/");
    expect(body).toContain(docId);
    const file = resolveChannelDocFile(channelsDir, "ch_test", docId);
    expect(fs.readFileSync(file, "utf-8")).toContain(long);
  });

  it("passes through short body", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-chdoc-"));
    const channelsDir = path.join(base, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    const { body, fullMarkdown, docId } = channelBodyWithOptionalDoc(
      channelsDir,
      "ch_test",
      "agent1",
      "short",
    );
    expect(body).toBe("short");
    expect(fullMarkdown).toBeNull();
    expect(docId).toBeNull();
  });
});
