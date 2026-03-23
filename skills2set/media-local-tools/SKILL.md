---
name: media-local-tools
description: "When the chat model does not natively accept video/audio (or inline multimodal fails), handle local media via tools: read_file paths, bash + ffmpeg, or external transcription APIs. 当模型不原生支持视频/语音或内联多模态失败时，用 read_file、终端 ffmpeg、第三方转写等处理本地文件。Triggers: 用户附了音视频但模型读不到、需要转文字、要抽帧/转码、models.json 未声明 video/audio、API 报错多模态 | user attached audio video path transcribe ffmpeg whisper."
---

# 本地媒体走工具（不猜 provider）

Hanako **不会**根据 Google/OpenRouter 等名字自动改 `model.input`。真实能力以 **`~/.hanako/models.json`** 里该模型的 **`input`** 为准（`text` / `image` / `video` / `audio`）。收藏同步写入的新模型默认四类都带上；若某端实际不支持，可在该数组里**手动删减**对应项。

若用户把文件以 **`[附件] 路径`** 发在消息里，或文件已在书桌/工作区：

## 推荐做法

1. **`read_file`**（或项目里等价的读文件工具）读取用户给出的路径；二进制/过大时按工具说明截断或只读元信息。
2. **音频要语义理解**：在终端用本机已安装的 **ffmpeg** 转成 wav/pcm，或调用用户配置的 **Whisper / 云 STT**（需用户 API key），把**转写文本**再交给模型推理。
3. **视频**：可用 ffmpeg 抽关键帧为图片再描述，或只处理音轨同上。
4. **不要**假装已经「看见」用户未提供的媒体；缺路径或工具失败时要说明并让用户补充。

## 与聊天内联附件的关系

用户打开「发给模型」时，附件会以 Base64 走 Pi 的多模态通道；若上游拒绝，可建议用户改为 **关闭多模态、只发文件路径**，再走本技能的 `read_file` + 脚本流程。
