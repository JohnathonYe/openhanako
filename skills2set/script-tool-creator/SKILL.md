---
name: script-tool-creator
description: "Create external script tools for the user. Use when the user asks to create a custom tool, a script-based tool, a small utility tool they can reuse (e.g. weather lookup, calculator, API wrapper), or wants to 'let the AI write a tool for me'. 当用户希望创建自定义工具、脚本形态的工具、可复用的的小工具（如查天气、计算器、API 封装），或说「帮我写一个工具给自己用」时使用。"
---

# Script Tool Creator

When the user wants **a custom tool they can reuse** (e.g. “帮我写一个查天气的工具”, “create a tool that calls my API”), use the **create_script_tool** tool to write a script into the user’s tool directory. New sessions will then load that tool automatically.

## When to use

- User asks to create a **tool**, **script tool**, or **custom tool** for their own use.
- User describes a small, reusable capability (weather, calc, API call, formatter, etc.) that should be available as a tool in future conversations.
- User says they want to “让 AI 给自己写一个工具” or similar.

## When not to use

- One-off automation or a single command: use existing tools (bash, write, etc.) instead.
- Installing a **skill** (SKILL.md): use **install_skill** instead.
- Complex workflows or multi-step pipelines: consider a skill or existing tools first.

## How to create a script tool

1. **Clarify** what the tool should do (name, inputs, output, errors).
2. **Implement** the logic and call **create_script_tool** with:
   - **tool_name**: file base name (e.g. `weather`, `my_calc`). Only letters, numbers, underscore, hyphen; no path.
   - **script_content**: full ESM module content (see format below).
   - **reason** (optional): short note for the user.

3. **Script format** (user-tools directory, loaded on next session):

   - File is saved as `user-tools/<tool_name>.mjs`.
   - **Do not use any npm imports.** Scripts are loaded from the user directory and cannot access the app’s node_modules (e.g. do not use `import from "@sinclair/typebox"`).
   - Must **export default** one object with:
     - **name**: string (tool id, e.g. `user_weather` or same as `tool_name`).
     - **description**: string (when to use, for the model).
     - **parameters**: plain **JSON Schema** object (e.g. `{ type: "object", properties: { query: { type: "string", description: "..." } }, required: ["query"], additionalProperties: false }`).
     - **execute**: async function `(toolCallId, params, signal, onUpdate, ctx) => { ... return { content: [{ type: "text", text: "..." }], details?: {} }; }`.

   Example skeleton (no npm imports; parameters = JSON Schema):

   ```javascript
   export default {
     name: "user_weather",
     description: "Get current weather for a city.",
     parameters: {
       type: "object",
       properties: {
         city: { type: "string", description: "City name" },
       },
       required: ["city"],
       additionalProperties: false,
     },
     execute: async (_toolCallId, params) => {
       // ... fetch or compute ...
       return {
         content: [{ type: "text", text: result }],
         details: { city: params.city },
       };
     },
   };
   ```

4. **Tell the user**: the tool was created under user-tools and will be available in **new sessions**; they can enable/disable it in **Settings → Tools**.

## Notes

- Scripts run with the same privileges as the app; keep them safe and simple.
- **No npm imports**: user-tools scripts are loaded via dynamic import from the user directory; only Node built-in modules (e.g. `fs`, `path`, `https`) can be used. Use plain JSON Schema for `parameters`.
- If the user wants to edit or remove a tool, they can edit or delete the `.mjs` file in the user-tools folder (path shown in the tool’s success message).
