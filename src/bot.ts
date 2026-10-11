import { randomBytes } from "node:crypto";
import { IlinkApiError } from "./client";
import {
  buildInboundMessage,
  buildOutbound,
  describeOutbound,
  flattenForward,
  type InboundOptions,
  type OutboundUnit,
} from "./message";
import { extensionOf, sniffMime, toCdnMedia } from "./media";
import {
  ERRCODE_RATE_LIMITED,
  ItemType,
  MessageState,
  MessageType,
  TypingStatus,
  UploadMediaType,
  type IlinkMessageItem,
} from "./types";
import { sleep } from "./util";

import type {
  AdapterBotBase,
  BotBase,
  BotStatusResult,
  ForwardSendNode,
  FriendInfo,
  GroupInfo,
  HistoryMessage,
  Logger,
  MessageGetResult,
  MessageInput,
  MessageSegment,
  MessageTarget,
  PlatformId,
  SentMessage,
} from "mioku";
import type { CachedMessage, MessageCache } from "./cache";
import type { IlinkClient } from "./client";
import type { IlinkMedia, IlinkMediaRef } from "./media";
import type { PeerBook } from "./peers";
import type { TypingTickets } from "./typing";

export interface IlinkBotData {
  bot_id: string;
  readonly adapter: "ilink";
  nickname: string;
  online: boolean;
  connected_at?: number;
  owner_id?: string;
}

export type IlinkBot = BotBase & {
  readonly adapter: "ilink";
  readonly client: IlinkClient;
  readonly owner_id?: string;
  sendApi<T = unknown>(
    action: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  sendTyping(userId: PlatformId, typing?: boolean): Promise<void>;
  downloadMedia(seg: MessageSegment): Promise<Buffer>;
};

export type IlinkBotBase = AdapterBotBase<IlinkBot>;

declare module "mioku" {
  interface AdapterBotMap {
    ilink: IlinkBot;
  }
}

export interface IlinkBotParams {
  readonly data: IlinkBotData;
  readonly client: IlinkClient;
  readonly media: IlinkMedia;
  readonly peers: PeerBook;
  readonly cache: MessageCache;
  readonly typing: TypingTickets;
  readonly inbound: InboundOptions;
  readonly history: InboundOptions;
  readonly logger: Logger;
  readonly onSend?: () => void;
}

const SEND_ATTEMPTS = 3;

const HISTORY_LIMIT = 100;

export const peerOf = (target: MessageTarget): string => {
  if (target.type !== "private" && target.type !== "direct")
    throw new Error(`iLink 仅支持私聊，无法发送到 ${target.type}`);
  const id = target.user_id ?? target.id;
  if (id == null || String(id).trim() === "")
    throw new Error("私聊目标缺少 user_id");
  return String(id).trim();
};

const endpointOf = (action: string): string =>
  action.includes("/") ? action.replace(/^\/+/, "") : `ilink/bot/${action}`;

const decodeDataUrl = (value: string): Buffer | undefined => {
  const match = /^data:[^,]*;base64,/.exec(value);
  return match ? Buffer.from(value.slice(match[0].length), "base64") : undefined;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const mediaRefOf = (value: unknown): IlinkMediaRef | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const ref: IlinkMediaRef = {
    encrypt_query_param: optionalString(raw.encrypt_query_param),
    full_url: optionalString(raw.full_url),
    aes_key: optionalString(raw.aes_key),
    aeskey: optionalString(raw.aeskey),
  };
  return ref.encrypt_query_param || ref.full_url ? ref : undefined;
};

export const createIlinkBot = (params: IlinkBotParams): IlinkBotBase => {
  const { data, client, media, peers, cache, typing, logger, onSend } = params;

  const post = async (userId: string, item: IlinkMessageItem): Promise<SentMessage> => {
    const clientId = `mioku-ilink:${Date.now()}-${randomBytes(4).toString("hex")}`;
    const contextToken = peers.contextToken(userId);
    if (!contextToken)
      logger.debug(`用户 ${userId} 暂无 context_token，消息可能无法送达`);
    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await client.sendMessage({
          from_user_id: "",
          to_user_id: userId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: contextToken,
        });
        const messageId = resp.message_id?.trim() || clientId;
        const sentAt = Date.now();
        cache.put({
          message_id: messageId,
          peer_id: userId,
          sender_id: data.bot_id,
          time: sentAt,
          items: [item],
          self: true,
        });
        onSend?.();
        return { message_id: messageId, sent_at: sentAt };
      } catch (err) {
        const limited =
          err instanceof IlinkApiError && err.code === ERRCODE_RATE_LIMITED;
        if (!limited || attempt >= SEND_ATTEMPTS) throw err;
        await sleep(attempt * 1_000);
      }
    }
  };

  const itemOf = async (
    unit: OutboundUnit,
    userId: string,
  ): Promise<IlinkMessageItem> => {
    if (unit.kind === "text")
      return { type: ItemType.TEXT, text_item: { text: unit.text } };
    const source = await media.read(unit.segment);
    if (unit.kind === "image") {
      const uploaded = await media.upload(source.data, UploadMediaType.IMAGE, userId);
      return {
        type: ItemType.IMAGE,
        image_item: { media: toCdnMedia(uploaded), mid_size: uploaded.cipherSize },
      };
    }
    if (unit.kind === "video") {
      const uploaded = await media.upload(source.data, UploadMediaType.VIDEO, userId);
      return {
        type: ItemType.VIDEO,
        video_item: { media: toCdnMedia(uploaded), video_size: uploaded.cipherSize },
      };
    }
    const fallback = unit.segment.type === "record" ? "voice" : "file";
    const name =
      source.name || `${fallback}${extensionOf(sniffMime(source.data))}`;
    const uploaded = await media.upload(source.data, UploadMediaType.FILE, userId);
    return {
      type: ItemType.FILE,
      file_item: {
        media: toCdnMedia(uploaded),
        file_name: name,
        len: String(uploaded.rawSize),
      },
    };
  };

  const toResult = async (
    entry: CachedMessage,
    options: InboundOptions,
  ): Promise<HistoryMessage> => ({
    message_id: entry.message_id,
    time: entry.time,
    user_id: entry.sender_id,
    message: await buildInboundMessage(entry.items, options),
    source: entry,
  });

  const bot = {
    get bot_id() {
      return data.bot_id;
    },
    adapter: data.adapter,
    get nickname() {
      return data.nickname;
    },
    get online() {
      return data.online;
    },
    get connected_at() {
      return data.connected_at;
    },
    get owner_id() {
      return data.owner_id;
    },
    client,
    async sendMessage(
      target: MessageTarget,
      message: MessageInput,
    ): Promise<SentMessage> {
      const userId = peerOf(target);
      const { units, dropped } = buildOutbound(message);
      if (dropped.length > 0)
        logger.warn(`iLink 不支持发送以下消息段，已忽略: ${dropped.join(", ")}`);
      if (units.length === 0) throw new Error("消息内容为空或均不受支持");
      let sent: SentMessage = {};
      for (const unit of units) sent = await post(userId, await itemOf(unit, userId));
      logger.info(`[>>>:私:(${userId})] ${describeOutbound(units)}`);
      return sent;
    },
    async sendForward(
      target: MessageTarget,
      nodes: readonly ForwardSendNode[],
    ): Promise<SentMessage> {
      return bot.sendMessage(target, flattenForward(nodes));
    },
    async getMessage(messageId: PlatformId): Promise<MessageGetResult | null> {
      const entry = cache.get(String(messageId));
      if (!entry) return null;
      const result = await toResult(entry, params.inbound);
      return {
        ...result,
        raw_message: result.message.raw_message,
        sender: { user_id: entry.sender_id },
        raw: entry,
      };
    },
    async getHistory(
      target: MessageTarget,
      before?: string,
      limit = 20,
    ): Promise<HistoryMessage[]> {
      const size = Math.min(Math.max(Math.trunc(limit) || 1, 1), HISTORY_LIMIT);
      const entries = cache.history(peerOf(target), before, size);
      return Promise.all(entries.map((entry) => toResult(entry, params.history)));
    },
    async getFriendList(): Promise<FriendInfo[]> {
      return peers.list().map((peer) => ({
        user_id: peer.user_id,
        last_seen: peer.last_seen,
      }));
    },
    async getFriendInfo(userId: PlatformId): Promise<FriendInfo | null> {
      const peer = peers.get(String(userId));
      return peer ? { user_id: peer.user_id, last_seen: peer.last_seen } : null;
    },
    async getGroupList(): Promise<GroupInfo[]> {
      return [];
    },
    async getAvatar(): Promise<string | null> {
      return null;
    },
    async getStatus(): Promise<BotStatusResult> {
      return {
        online: data.online,
        app_name: "iLink",
        account_id: data.bot_id,
        owner_id: data.owner_id,
      };
    },
    async sendApi<T = unknown>(
      action: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      return (await client.post(endpointOf(action), params)) as T;
    },
    async sendTyping(userId: PlatformId, active = true): Promise<void> {
      const id = String(userId);
      const ticket = await typing.get(id);
      if (!ticket) throw new Error(`暂时无法获取用户 ${id} 的 typing_ticket`);
      await client.sendTyping(
        id,
        ticket,
        active ? TypingStatus.TYPING : TypingStatus.CANCEL,
      );
    },
    async downloadMedia(seg: MessageSegment): Promise<Buffer> {
      const url = typeof seg.data.url === "string" ? seg.data.url : undefined;
      const inline = url ? decodeDataUrl(url) : undefined;
      if (inline) return inline;
      const ref = mediaRefOf(seg.data.media);
      if (!ref) throw new Error(`${seg.type} 消息段不包含 iLink 媒体信息`);
      return media.download(ref);
    },
    as<T extends object = Record<string, unknown>>(): T {
      return this as unknown as T;
    },
  } satisfies IlinkBotBase;
  return bot;
};
