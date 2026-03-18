---
name: cdp-browser-guide
description: "When the user wants to control their local Chrome browser (multi-tab, get page data, automate browsing) but the cdp_local_browser tool fails or returns '无法连接' / '请先启动 Chrome 远程调试' / 'cannot connect to Chrome', use this skill to guide them to enable Chrome remote debugging. Also use when user asks how to let the AI control their browser, open Chrome for automation, or enable CDP. 当用户希望用 AI 控制本机 Chrome（多标签、获取页面数据、自动浏览）但 cdp_local_browser 工具报错或提示无法连接、请先启动 Chrome 远程调试时，使用本技能逐步引导用户开启 Chrome 远程调试。用户询问如何让 AI 控制浏览器、如何为自动化打开 Chrome、如何开启 CDP 时也应触发。\n  MANDATORY TRIGGERS: 无法连接 Chrome, 浏览器控制不可用, 远程调试, 怎么让 AI 控制浏览器, 怎么开启 CDP, Chrome 未开启, cdp_local_browser 失败, single_use_browser 失败, 操作失败, 工具不可用 引导用户"
compatibility: "Requires cdp_local_browser tool. User must have Google Chrome installed (default browser)."
---

# CDP 本地浏览器功能引导

当 **cdp_local_browser** 或 **single_use_browser** 报错（如「操作失败」「无法连接本机 Chrome」「Tool ... not found」）时，按本技能排查并引导。

**前置条件（必读）**：  
- 在 Hanako **桌面端** 需先开启 **「操作电脑」** 开关，否则 `cdp_local_browser` 与 `single_use_browser` 不会出现在可用工具中，调用会显示「操作失败」或「Tool not found」。请先确认开关已开启再继续。  
- 若开关已开启仍失败，则多为 Chrome 未以远程调试方式启动，按下方步骤配置。

默认 **Chrome**，端口 **9222**。Chrome 136+ 须使用 **非默认用户数据目录**（`--user-data-dir`），否则调试端口不会监听。

**自动启动**：助手默认会检测端口 9222；若未监听则**自动执行启动命令**拉起 Chrome（与下方手动命令一致），无需用户先开终端。若需禁用自动启动，可在助手配置中设置 `cdp.auto_launch: false`。  
**复用同一浏览器**：工具会尽量复用已连接的 Chrome 与当前 Tab 的 CDP 会话，同一工具实例最多只会自动启动一次 Chrome，避免频繁创建新浏览器；优先使用 connect/tabs/activate 操作已有 Tab，而非反复要求用户重开浏览器。

---

## 1. 简要说明

向用户说明：

- 要控制本机 Chrome 并读取页面内容，需要以「远程调试」方式启动 Chrome。
- 在终端执行一条命令即可；会单独开一个用于 AI 控制的 Chrome 窗口，与日常使用的 Chrome 互不干扰（macOS/Windows 推荐方式）。

---

## 2. 按操作系统执行

### macOS

打开 **终端（Terminal）**，执行：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-9222
```

- 会新开一个 Chrome 窗口（临时配置，无书签/登录），专用于 AI 控制；**无需**先关掉平时用的 Chrome。
- 若不想看终端里的 updater/SSL 等日志，可改为：  
  `... --user-data-dir=/tmp/chrome-cdp-9222 2>/dev/null`

**验证**：在另一终端执行 `curl http://127.0.0.1:9222/json`，能返回 JSON 即表示 9222 已监听。

---

### Windows

**方式 A（推荐，Chrome 136+）** — 单独调试用窗口，无需关闭现有 Chrome：

在 **PowerShell** 或 **命令提示符** 中执行（按实际安装路径二选一）：

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-cdp-9222
```

若 Chrome 在用户目录：

```cmd
"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-cdp-9222
```

**方式 B** — 先完全关闭 Chrome（含托盘），再执行上述命令并去掉 `--user-data-dir=...` 部分（旧版 Chrome 可能可用，136+ 建议用方式 A）。

**验证**：浏览器访问 `http://127.0.0.1:9222/json` 或另一终端执行 `curl http://127.0.0.1:9222/json`。

---

### Linux

终端执行（Chrome 或 Chromium 二选一，Chrome 136+ 建议加 `--user-data-dir`）：

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-9222
# 或
chromium-browser --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-9222
```

**验证**：`curl http://127.0.0.1:9222/json` 返回 JSON 即成功。

---

## 3. 使用说明与安全

- **调试用窗口**：使用 `--user-data-dir` 时，该窗口为独立配置（无书签/登录），用完后直接关闭即可；下次需要时再执行同一命令。
- **安全**：端口 9222 仅监听本机（127.0.0.1），外网无法访问。用完后关闭该 Chrome 即可。

---

## 4. 仍无法连接时

请用户逐项确认：

1. **Chrome 136+**：macOS/Windows 必须带 `--user-data-dir`（见上文命令），否则 9222 不会监听。
2. 是否**从终端/命令行**执行了上述命令（而非从桌面图标或 Spotlight 打开 Chrome）。
3. 执行 `curl http://127.0.0.1:9222/json` 或浏览器打开 `http://127.0.0.1:9222/json`：有 JSON 即表示端口已开。
4. **换端口**：若 9222 被占用，可在助手配置中设置 `cdp.port`（如 9223），并将启动命令中的端口改为 `--remote-debugging-port=9223`（保留 `--user-data-dir`）。

---

## 5. 话术示例

- “要使用本机 Chrome 控制功能，需要先用「远程调试」方式启动 Chrome。请在终端执行：……”（接着给出**当前系统**的完整命令）。
- “当前无法连接到 Chrome。请按下面做：1）在终端执行我给出的命令；2）等 Chrome 窗口出现后，再试一次你的需求。”
- 用户完成后：“Chrome 已用远程调试方式启动。请再说一次你想让我在浏览器里帮你做什么。”

始终只给出**用户当前系统**的命令，并说明：用完后关闭该 Chrome 即可；下次需要时再执行同一命令。
