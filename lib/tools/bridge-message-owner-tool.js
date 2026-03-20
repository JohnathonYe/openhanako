/**
 * bridge-message-owner-tool.js — 通过已对接的社交平台给本人发消息
 *
 * 依赖设置中的 bridge.owner 与对应平台已连接；未配置或未连接时不发送。
 */

import { Type } from "@sinclair/typebox";

const REASON_TEXT = {
  owner_not_configured: "未在设置中绑定该平台「本人」账号（bridge owner），未发送",
  user_mismatch: "参数 user 与设置中的本人 ID 不一致，未发送（省略 user 即可使用设置中的本人）",
  platform_disabled: "该平台在设置中未启用，未发送",
  not_connected: "该平台当前未连接，未发送",
  empty_message: "消息为空，未发送",
  unknown_platform: "不支持的平台",
  bridge_unavailable: "桥接未就绪，未发送",
};

/**
 * @param {object} opts
 * @param {() => import('../../core/engine.js').HanaEngine|null} opts.getEngine
 */
export function createBridgeMessageOwnerTool({ getEngine }) {
  return {
    name: "bridge_message_owner",
    label: "社交平台私信本人",
    description:
      "通过已对接的外部 IM（Telegram / 飞书 / QQ）向用户本人发一条消息。\n" +
      "本人账号从设置（bridge owner）自动读取，不要向用户索要 QQ 号等平台 ID；只需传 platform 与 message 即可。\n" +
      "可选参数 user 仅在与设置不一致时需显式校验时使用；一般省略。\n" +
      "若未配置或未连接，工具会说明原因且不会发送。",
    parameters: Type.Object({
      platform: Type.Union(
        [Type.Literal("telegram"), Type.Literal("feishu"), Type.Literal("qq")],
        { description: "社交平台：telegram、feishu、qq" },
      ),
      user: Type.Optional(
        Type.String({ description: "可选；省略时自动使用设置中的「本人」ID" }),
      ),
      message: Type.String({ description: "要发送的文本内容" }),
    }),

    execute: async (_toolCallId, params) => {
      const engine = getEngine?.();
      if (!engine) {
        return { content: [{ type: "text", text: "bridge_message_owner 失败：引擎未就绪" }] };
      }

      const userArg = params.user != null && String(params.user).trim() !== "" ? params.user : undefined;
      const result = await engine.sendBridgeOwnerIm(params.platform, userArg, params.message);

      if (result.ok && result.sent) {
        return {
          content: [{ type: "text", text: `已通过 ${result.platform} 发送给本人` }],
          details: { platform: result.platform, chatId: result.chatId, sessionKey: result.sessionKey },
        };
      }

      const reason = result.reason;
      const human = reason
        ? (REASON_TEXT[reason] || reason)
        : (result.error || "发送失败");
      return {
        content: [{ type: "text", text: human }],
        details: { sent: false, reason, error: result.error },
      };
    },
  };
}
