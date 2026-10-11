import { randomBytes } from "node:crypto";
import { buildRoutes, createFriendRef } from "mioku";
import { quoteIdOf } from "./message";

import type { Message, MessageEvent } from "mioku";
import type { IlinkBot } from "./bot";
import type { IlinkMessage } from "./types";

export const messageIdOf = (raw: IlinkMessage): string =>
  raw.message_id?.trim() ||
  raw.item_list?.find((item) => item.msg_id?.trim())?.msg_id?.trim() ||
  `ilink:${raw.create_time_ms ?? Date.now()}:${randomBytes(4).toString("hex")}`;

export const buildMessageEvent = (params: {
  readonly bot: IlinkBot;
  readonly raw: IlinkMessage;
  readonly userId: string;
  readonly messageId: string;
  readonly message: Message;
}): MessageEvent => {
  const { bot, raw, userId, messageId, message } = params;
  const time = raw.create_time_ms ?? Date.now();
  const target = { type: "private", user_id: userId };
  return {
    kind: "message",
    type: "message",
    routes: buildRoutes(bot.adapter, "message", "private", "friend"),
    identity: {
      adapter: bot.adapter,
      bot_id: bot.bot_id,
      event_type: "message.private",
      message_id: messageId,
      timestamp: time,
    },
    self_id: bot.bot_id,
    bot,
    time,
    raw,
    message_type: "private",
    sub_type: "friend",
    user_id: userId,
    message_id: messageId,
    raw_message: message.raw_message ?? "",
    quote_id: quoteIdOf(raw.item_list ?? []),
    sender: { user_id: userId },
    friend: createFriendRef(bot, userId),
    message,
    is_to_me: true,
    reply: (input) => bot.sendMessage(target, input),
    recall: () => bot.recallMessage(messageId),
  };
};
