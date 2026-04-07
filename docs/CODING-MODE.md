# Coding Mode — 实现设计文档

> 参考：claude-code-sourcemap（Anthropic CLI）架构

## 概要

Coding Mode 是一个专用的软件工程辅助模式。开启后，OpenHanako 切换为面向代码的
system prompt、精简的工具集、并注入项目上下文（cwd / git / 目录结构 / 项目规则文件），
使 LLM 以高效、简洁的 coding agent 方式工作。

## 与 Plan Mode 的关系

- Coding Mode 开启时自动确保 Plan Mode = ON（需要 write/edit/bash 等全量 built-in 工具）
- 关闭 Coding Mode 后 Plan Mode 恢复到用户之前的设定
- 两者在 `ConfigCoordinator` 中各自维护独立标志

## 改动清单

| 文件 | 改动 |
|------|------|
| `lib/tools/project-context.js` | **新增** — 收集 cwd/git/目录结构/规则文件 |
| `core/config-coordinator.js` | 新增 `_codingMode`、工具白名单、`setCodingMode`、`applyCodingModeToolsToSession` |
| `core/agent.js` | 新增 `_codingMode` 标志、`buildCodingSystemPrompt()` |
| `core/engine.js` | 新增 `setCodingMode` facade、`codingMode` getter、init 同步 |
| `server/index.js` | 新增 `GET/POST /api/coding-mode` |
| `server/routes/chat.js` | 无需改动（WS 广播已由 EventBus `coding_mode` 事件覆盖） |
| `desktop/src/react/services/ws-message-handler.ts` | 处理 `coding_mode` WS 事件 |
| `desktop/src/react/components/InputArea.tsx` | 新增 `CodingModeButton` + 状态管理 |
| `desktop/src/styles.css` | 新增 `.coding-mode-btn` 样式 |
| `desktop/src/locales/*.json` | 新增翻译 key |

## Coding Mode 专用 System Prompt 设计

开启 Coding Mode 后，`agent.buildSystemPrompt()` 返回精简的 coding-focused prompt：

1. **Identity**：简洁的 coding agent 身份（无人格/yuan/ishiki）
2. **项目上下文**：`<context>` 块（cwd、git 状态、目录结构、README 摘要）
3. **工作流指引**：搜索→实现→验证→lint 四步工作法
4. **工具策略**：并行只读调用、搜索优先用 delegate、不主动 commit
5. **项目规则**：扫描 cwd 下的 `CLAUDE.md`、`.rules/*.md`、`.cursor/rules/*.mdc`
6. **记忆**：保留 pinned memory（项目相关笔记），但移除人格化记忆规则
7. **Skills**：仅保留与 coding 相关的 skills

## 工具集（Coding Mode）

| 工具 | 类型 | 说明 |
|------|------|------|
| read, write, edit, bash, grep, find, ls | built-in | 全部开放 |
| search_memory | custom | 搜索项目相关记忆 |
| todo | custom | 任务管理 |
| web_search, web_fetch | custom | 查文档 |
| delegate | custom | 子 agent 搜索（类似 Claude Code AgentTool） |
| present_files | custom | 文件呈现 |
| create_artifact | custom | 代码预览 |

**隐藏的工具**（减少 token、避免干扰）：
- browser 系列（cdp_local_browser, single_use_browser）
- channel, message_agent, dm
- notify, update_settings, service_handoff, bridge_message_owner
- cron, install_skill, create_script_tool

## API

```
GET  /api/coding-mode       → { enabled: boolean, cwd: string | null }
POST /api/coding-mode       ← { enabled: boolean, cwd?: string }
                            → { ok: true, enabled: boolean }
```

## WS 事件

```json
{ "type": "coding_mode", "enabled": true }
```
前端监听后更新 `InputArea` 状态。
