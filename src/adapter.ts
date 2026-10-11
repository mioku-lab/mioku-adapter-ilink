import path from "node:path";
import {
  bindCapabilities,
  colors,
  defineAdapter,
  getDataDir,
  registerStatusProvider,
} from "mioku";
import { version as adapterVersion } from "../package.json" with { type: "json" };
import { createIlinkBot, type IlinkBot, type IlinkBotData } from "./bot";
import { MessageCache } from "./cache";
import { registerIlinkCapabilities } from "./capabilities";
import { createUin, IlinkClient } from "./client";
import { normalizeConfig, type IlinkAdapterConfig, type ResolvedIlinkInstance } from "./config";
import { buildMessageEvent, messageIdOf } from "./event";
import { IlinkGateway } from "./gateway";
import { IlinkMedia } from "./media";
import { buildInboundMessage, quoteIdOf, type InboundOptions } from "./message";
import { PeerBook } from "./peers";
import { createIlinkStatusProvider, type IlinkTraffic } from "./status";
import { AccountStore, type StoredAccount } from "./store";
import {
  ILINK_BASE_URL,
  MessageState,
  MessageType,
  type IlinkMediaKind,
  type IlinkMessage,
} from "./types";
import { TypingTickets } from "./typing";
import { errorMessage } from "./util";

import type { Adapter, AdapterContext, AdapterFactoryOptions, Logger } from "mioku";

const NAME = "ilink";

export const ILINK_DATA_DIR = "ilink";

const NO_DOWNLOAD: ReadonlySet<IlinkMediaKind> = new Set();

interface IlinkInstance {
  start(context: AdapterContext): Promise<void>;
  stop(reason?: string): Promise<void>;
}

const buildInstance = (
  cfg: ResolvedIlinkInstance,
  logger: Logger,
): IlinkInstance => {
  const label = cfg.name;
  const traffic: IlinkTraffic = { sent: 0, received: 0 };
  const data: IlinkBotData = {
    bot_id: "",
    adapter: NAME,
    nickname: cfg.nickname,
    online: false,
  };
  const cache = new MessageCache();
  const queues = new Map<string, Promise<void>>();
  const maxBytes = cfg.mediaMaxMB * 1024 * 1024;
  const autoDownload = new Set(cfg.autoDownload);
  let context: AdapterContext | undefined;
  let client: IlinkClient | undefined;
  let media: IlinkMedia | undefined;
  let peers: PeerBook | undefined;
  let typing: TypingTickets | undefined;
  let gateway: IlinkGateway | undefined;
  let bot: IlinkBot | undefined;
  let accountId: string | undefined;
  let disposers: Array<() => void> = [];

  const inbound = (download: boolean): InboundOptions => ({
    media: media!,
    logger,
    download: download ? autoDownload : NO_DOWNLOAD,
    maxBytes,
  });

  const setOnline = async (online: boolean, reason?: string): Promise<void> => {
    if (!bot || !context || data.online === online) return;
    data.online = online;
    if (online) data.connected_at = Date.now();
    try {
      await context.emitLifecycle(
        online
          ? { type: "bot:connected", bot }
          : { type: "bot:disconnected", bot, reason },
      );
    } catch (err) {
      logger.warn(`派发 bot 生命周期事件失败: ${errorMessage(err)}`);
    }
  };

  const teardown = async (reason: string): Promise<void> => {
    await setOnline(false, reason);
    for (const dispose of disposers.splice(0).reverse()) dispose();
    bot = undefined;
  };

  const onReady = async (account: StoredAccount): Promise<void> => {
    if (!context || !client || !media || !peers || !typing) return;
    if (bot && bot.bot_id !== account.accountId) await teardown("登录账号已变更");
    if (accountId !== account.accountId) {
      accountId = account.accountId;
      peers.load();
      cache.clear();
      typing.clear();
    }
    data.bot_id = account.accountId;
    data.owner_id = account.userId;
    if (!bot) {
      const created = bindCapabilities(
        createIlinkBot({
          data,
          client,
          media,
          peers,
          cache,
          typing,
          inbound: inbound(true),
          history: inbound(false),
          logger,
          onSend: () => traffic.sent++,
        }),
        context.getCapabilityRegistry(),
      );
      bot = created;
      disposers = [
        context.registerBot(created).unregister,
        ...registerIlinkCapabilities(context, created),
        registerStatusProvider(
          { adapter: NAME, bot_id: created.bot_id },
          createIlinkStatusProvider(created, traffic, peers),
        ),
      ];
    }
    logger.info(
      `已连接到 ${colors.cyan(label)}: ${colors.green(`${data.nickname}(${data.bot_id})`)}`,
    );
    await setOnline(true);
  };

  const remember = (raw: IlinkMessage, userId: string, messageId: string): void => {
    const items = raw.item_list ?? [];
    cache.put({
      message_id: messageId,
      peer_id: userId,
      sender_id: userId,
      time: raw.create_time_ms ?? Date.now(),
      items,
      self: false,
    });
    const quoteId = quoteIdOf(items);
    const quoted = items.find((item) => item.ref_msg)?.ref_msg?.message_item;
    if (quoteId && quoted && !cache.get(quoteId))
      cache.put({
        message_id: quoteId,
        peer_id: userId,
        time: quoted.create_time_ms ?? 0,
        items: [quoted],
        self: false,
      });
  };

  const handle = async (raw: IlinkMessage, userId: string): Promise<void> => {
    const current = bot;
    const ctx = context;
    if (!current || !ctx) return;
    const messageId = messageIdOf(raw);
    remember(raw, userId, messageId);
    const message = await buildInboundMessage(raw.item_list ?? [], inbound(true));
    logger.info(`[私:(${userId})] ${message.raw_message ?? ""}`);
    const event = buildMessageEvent({ bot: current, raw, userId, messageId, message });
    void ctx.dispatch(event).catch((err: unknown) => {
      logger.error(`处理消息事件失败: ${errorMessage(err)}`);
    });
  };

  const enqueue = (userId: string, task: () => Promise<void>): void => {
    const next = (queues.get(userId) ?? Promise.resolve())
      .then(task)
      .catch((err: unknown) => {
        logger.error(`解析消息失败: ${errorMessage(err)}`);
      });
    queues.set(userId, next);
    void next.then(() => {
      if (queues.get(userId) === next) queues.delete(userId);
    });
  };

  const onMessages = (messages: readonly IlinkMessage[]): void => {
    for (const raw of messages) {
      if (raw.message_type === MessageType.BOT) continue;
      if (raw.message_state === MessageState.GENERATING) continue;
      const userId = raw.from_user_id?.trim();
      if (!userId) continue;
      peers?.touch(userId, raw.context_token || undefined);
      traffic.received++;
      enqueue(userId, () => handle(raw, userId));
    }
  };

  return {
    async start(next: AdapterContext): Promise<void> {
      context = next;
      const http = next.getDriver().http;
      const store = new AccountStore(
        path.join(getDataDir(), ILINK_DATA_DIR),
        cfg.name,
      );
      const saved = store.loadAccount();
      client = new IlinkClient({
        http,
        baseUrl: cfg.baseUrl ?? saved?.baseUrl ?? ILINK_BASE_URL,
        uin: saved?.uin ?? createUin(),
        token: saved?.token,
        routeTag: cfg.routeTag,
      });
      media = new IlinkMedia({ http, client, cdnBaseUrl: cfg.cdnBaseUrl });
      peers = new PeerBook(store, logger);
      typing = new TypingTickets(client, peers);
      gateway = new IlinkGateway(
        {
          name: `${NAME}.${cfg.name}`,
          label,
          client,
          store,
          logger,
          autoLogin: cfg.autoLogin,
          baseUrl: cfg.baseUrl,
        },
        {
          onReady,
          onOnline: () => setOnline(true),
          onOffline: async (reason) => {
            peers?.flush();
            await setOnline(false, reason);
          },
          onMessages,
        },
      );
      logger.info(`>>> 正在启动 ${colors.cyan(label)}`);
      next.registerGateway(gateway);
    },
    async stop(reason = "stop"): Promise<void> {
      await gateway?.stop(reason);
      peers?.flush();
      await teardown(reason);
      queues.clear();
      cache.clear();
      gateway = undefined;
      context = undefined;
    },
  };
};

export const ilinkAdapterDefinition = defineAdapter<IlinkAdapterConfig>({
  name: NAME,
  version: adapterVersion,
  apiVersion: 1,
  validateConfig: normalizeConfig,
  create: (options: AdapterFactoryOptions<IlinkAdapterConfig>): Adapter => {
    const instances = options.config.instances.map((cfg) =>
      buildInstance(cfg, options.logger),
    );
    return {
      name: NAME,
      version: adapterVersion,
      impl: { name: "iLink" },
      async start(context: AdapterContext): Promise<void> {
        for (const instance of instances) await instance.start(context);
      },
      async stop(reason?: string): Promise<void> {
        for (const instance of [...instances].reverse())
          await instance.stop(reason);
      },
    };
  },
});
