---
name: desk-required-rules
description: "Write or update Hanako desk Required Rules (.rules/*.md) ONLY after the user explicitly asks to save/write/update 必读规则 or equivalent. Do not use for routine file edits. Triggers: 用户明确说写入/保存/更新必读规则、书桌规则、Required Rules、把规则记到必读、sync rules to desk | user explicitly requests required rules write."
---

# 书桌必读规则（按需写入）

## 何时遵守本技能

**仅当用户明确请求**把内容写入/保存/更新 **Hanako 书桌的「必读规则」** 时，才按下面步骤创建或修改规则文件。

视为「明确请求」的示例（非穷尽）：

- 中文：「写入必读规则」「保存到必读规则」「更新书桌必读规则」「记到必读规则里」
- 英文：`save to required rules`, `update desk rules`, `write this to required rules`

**以下情况不要**主动新建或修改 `.rules/` 下的文件（除非用户在上文同一句或紧邻对话里明确要求）：

- 普通改代码、写文档、用户只说了「写个规则文件」但未指向必读规则 / Required Rules
- 用户把 `.mdc` 放在书桌根目录 — 若未要求写入必读规则，不要擅自搬进 `.rules/`

## 写入位置与格式

- 路径：当前会话工作目录（书桌 cwd）下的 **`.rules/`** 目录。
- 文件：**仅使用 `.md` 扩展名**（例如 `coding-style.md`）。Hanako **不会**把书桌根目录的 `.mdc` 当作必读规则读入。
- 使用 **`write`** 或 **`edit`** 工具写入；若目录不存在，工具创建 `.rules/` 与文件即可（在沙盒允许的路径内）。
- 从 Cursor **`.cursor/rules/*.mdc`** 导入时：去掉 YAML frontmatter（`---` 包裹的元数据块），只保留正文 Markdown。

## 与系统行为的关系

必读规则会在后续对话的 system prompt 中注入；**同一会话内**若刚写入，模型侧缓存可能略滞后，属正常现象。

## 沙盒提示

书桌目录应在设置的主文件夹（`home_folder`）之下，否则 `write` 可能被拒绝。若失败，可请用户调整主文件夹/书桌，或通过应用内书桌 UI 的「必读规则」编辑保存。
