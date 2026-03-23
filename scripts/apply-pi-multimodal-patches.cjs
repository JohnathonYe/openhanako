/**
 * 幂等补丁（npm install 后）：
 * 1) pi-coding-agent：models.json 的 model.input 允许 "video" / "audio"
 * 2) pi-ai openai-completions：按 model.input 过滤 image_url（历史用户消息 + 工具结果图）
 */
const fs = require("fs");
const path = require("path");

function read(rel) {
  const p = path.join(__dirname, "..", "node_modules", rel);
  if (!fs.existsSync(p)) {
    console.warn(`[pi-multimodal-patch] missing ${rel}`);
    return null;
  }
  return { p, s: fs.readFileSync(p, "utf8") };
}

function write(p, s) {
  fs.writeFileSync(p, s, "utf8");
}

// ── pi-coding-agent model-registry.js ──
const regPath = path.join("@mariozechner", "pi-coding-agent", "dist", "core", "model-registry.js");
const reg = read(regPath);
if (reg && !reg.s.includes('Type.Literal("video")')) {
  const next = reg.s.replace(
    /Type\.Union\(\[Type\.Literal\("text"\), Type\.Literal\("image"\)\]\)/g,
    'Type.Union([Type.Literal("text"), Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")])',
  );
  if (next !== reg.s) {
    write(reg.p, next);
    console.log(`[pi-multimodal-patch] updated ${regPath}`);
  }
}

// ── pi-ai openai-completions.js ──
const oaPath = path.join("@mariozechner", "pi-ai", "dist", "providers", "openai-completions.js");
const oa = read(oaPath);
if (oa && !oa.s.includes("isDataUrlAllowedByModelInput")) {
  let t = oa.s;
  const anchor = `function mapReasoningEffort(effort, reasoningEffortMap) {
    return reasoningEffortMap[effort] ?? effort;
}`;
  const helper = `${anchor}
/** Hanako: 按 model.input 保留 image / video / audio（均走 image_url + data: URL） */
function isDataUrlAllowedByModelInput(model, dataUrl) {
    const input = model.input || ["text"];
    const m = dataUrl.match(/^data:([^;,]+)/);
    const mime = (m ? m[1] : "").toLowerCase();
    if (mime.startsWith("video/"))
        return input.includes("video");
    if (mime.startsWith("audio/"))
        return input.includes("audio");
    if (mime.startsWith("image/"))
        return input.includes("image");
    return input.includes("image");
}`;
  if (!t.includes(anchor)) {
    console.warn("[pi-multimodal-patch] openai-completions: anchor not found, skip");
  } else {
    t = t.replace(anchor, helper);
  }

  const oldUser = `                const filteredContent = !model.input.includes("image")
                    ? content.filter((c) => c.type !== "image_url")
                    : content;
                if (filteredContent.length === 0)
                    continue;
                params.push({
                    role: "user",
                    content: filteredContent,
                });`;

  const newUser = `                const filteredContent = content.filter((c) => {
                    if (c.type === "text")
                        return true;
                    if (c.type === "image_url") {
                        const url = c.image_url?.url || "";
                        return isDataUrlAllowedByModelInput(model, url);
                    }
                    return false;
                });
                if (filteredContent.length === 0) {
                    params.push({
                        role: "user",
                        content: sanitizeSurrogates("（历史消息中的媒体已被省略：当前模型不支持该类型。）"),
                    });
                    lastRole = "user";
                    continue;
                }
                params.push({
                    role: "user",
                    content: filteredContent,
                });`;

  if (t.includes(oldUser)) t = t.replace(oldUser, newUser);

  const oldTool = `                if (hasImages && model.input.includes("image")) {
                    for (const block of toolMsg.content) {
                        if (block.type === "image") {
                            imageBlocks.push({
                                type: "image_url",
                                image_url: {
                                    url: \`data:\${block.mimeType};base64,\${block.data}\`,
                                },
                            });
                        }
                    }
                }`;

  const newTool = `                if (hasImages) {
                    for (const block of toolMsg.content) {
                        if (block.type === "image") {
                            const url = \`data:\${block.mimeType};base64,\${block.data}\`;
                            if (isDataUrlAllowedByModelInput(model, url)) {
                                imageBlocks.push({
                                    type: "image_url",
                                    image_url: { url },
                                });
                            }
                        }
                    }
                }`;

  if (t.includes(oldTool)) t = t.replace(oldTool, newTool);

  if (t !== oa.s) {
    write(oa.p, t);
    console.log(`[pi-multimodal-patch] updated ${oaPath}`);
  }
}
