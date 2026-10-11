import {
  avatarGet,
  botStatus,
  conversationGetHistory,
  forwardSend,
  friendGetInfo,
  friendGetList,
  groupGetList,
  messageGet,
  messageSend,
} from "mioku";

import type { AdapterContext } from "mioku";
import type { IlinkBot } from "./bot";

const required = <T>(value: T | null, label: string): T => {
  if (value == null) throw new Error(`${label}不存在或已过期`);
  return value;
};

export const registerIlinkCapabilities = (
  context: AdapterContext,
  bot: IlinkBot,
): Array<() => void> => {
  const target = { adapter: bot.adapter, bot_id: bot.bot_id };
  return [
    context.registerCapability(messageSend, target, (req) =>
      bot.sendMessage(req.target, req.message),
    ),
    context.registerCapability(messageGet, target, async (req) =>
      required(await bot.getMessage(req.message_id), "消息"),
    ),
    context.registerCapability(forwardSend, target, (req) =>
      bot.sendForward(req.target, req.nodes, req),
    ),
    context.registerCapability(conversationGetHistory, target, (req) =>
      bot.getHistory(
        req.target,
        req.before == null ? undefined : String(req.before),
        req.limit,
      ),
    ),
    context.registerCapability(friendGetList, target, () =>
      bot.getFriendList(),
    ),
    context.registerCapability(friendGetInfo, target, async (req) =>
      required(await bot.getFriendInfo(req.user_id), "用户"),
    ),
    context.registerCapability(groupGetList, target, () => bot.getGroupList()),
    context.registerCapability(avatarGet, target, () => bot.getAvatar()),
    context.registerCapability(botStatus, target, () => bot.getStatus()),
  ];
};
