import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../core/agent.js";

describe("Agent required rules prompt", () => {
  const tempRoots = [];

  afterEach(() => {
    for (const dir of tempRoots) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it("injects cwd .rules/*.md into system prompt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-rules-"));
    tempRoots.push(root);

    const agentDir = path.join(root, "agent");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");
    const cwdDir = path.join(root, "workspace");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(cwdDir, ".rules"), { recursive: true });

    fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Yuan", "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "Identity", "utf-8");
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "Ishiki", "utf-8");
    fs.writeFileSync(path.join(userDir, "user.md"), "User", "utf-8");
    fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "", "utf-8");
    fs.writeFileSync(path.join(cwdDir, ".rules", "alpha.md"), "# Alpha\nRule A", "utf-8");
    fs.writeFileSync(path.join(cwdDir, "必读规则.md"), "ROOT FILE SHOULD NOT BE READ", "utf-8");

    const agent = new Agent({
      agentDir,
      productDir,
      userDir,
      hanakoHome: root,
    });
    agent._config = { locale: "zh", agent: { yuan: "hanako" } };
    agent._engine = { cwd: cwdDir, homeCwd: path.join(root, "fallback") };

    const prompt = agent.buildSystemPrompt();
    expect(prompt).toContain("# 必读规则");
    expect(prompt).toContain("## alpha.md");
    expect(prompt).toContain("Rule A");
    expect(prompt).not.toContain("ROOT FILE SHOULD NOT BE READ");
  });
});
