import { errorCodeOf, isTokenExpired } from "./client";
import { loginWithQrcode } from "./login";
import { renderQrcode } from "./qrcode";
import { ILINK_BASE_URL } from "./types";
import { errorMessage, sleep } from "./util";

import type { AdapterGateway, Logger } from "mioku";
import type { IlinkClient } from "./client";
import type { AccountStore, StoredAccount } from "./store";
import type { GetUpdatesResp, IlinkMessage } from "./types";

const POLL_TIMEOUT = 35_000;
const POLL_MARGIN = 10_000;
const RETRY_DELAY = 2_000;
const BACKOFF_DELAY = 30_000;
const MAX_FAILURES = 3;
const RELOGIN_DELAY = 60 * 60_000;
const STORE_CHECK_INTERVAL = 30_000;

const WIZARD_HINT = "在项目目录运行 bunx mioku-adapter-ilink 扫码登录";

export interface IlinkGatewayOptions {
  readonly name: string;
  readonly label: string;
  readonly client: IlinkClient;
  readonly store: AccountStore;
  readonly logger: Logger;
  readonly autoLogin: boolean;
  readonly baseUrl?: string;
}

export interface IlinkGatewayHandlers {
  onReady(account: StoredAccount): Promise<void>;
  onOnline(): Promise<void>;
  onOffline(reason: string): Promise<void>;
  onMessages(messages: readonly IlinkMessage[]): void;
}

export class IlinkGateway implements AdapterGateway {
  readonly name: string;
  readonly #options: IlinkGatewayOptions;
  readonly #handlers: IlinkGatewayHandlers;
  #controller = new AbortController();
  #task: Promise<void> | undefined;
  #stopped = true;
  #active = false;
  #expiredToken: string | undefined;

  constructor(options: IlinkGatewayOptions, handlers: IlinkGatewayHandlers) {
    this.name = options.name;
    this.#options = options;
    this.#handlers = handlers;
  }

  start(): void {
    if (this.#task) return;
    this.#stopped = false;
    this.#controller = new AbortController();
    this.#task = this.#run()
      .catch((err: unknown) => {
        this.#options.logger.error(
          `${this.#options.label} 会话异常退出: ${errorMessage(err)}`,
        );
      })
      .finally(() => {
        this.#task = undefined;
      });
  }

  async stop(reason = "stop"): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#controller.abort(reason);
    await this.#task;
    if (this.#active) {
      this.#active = false;
      await this.#notify("stop");
    }
  }

  get #signal(): AbortSignal {
    return this.#controller.signal;
  }

  async #run(): Promise<void> {
    const { client, logger, label } = this.#options;
    while (!this.#stopped) {
      const account = await this.#acquire();
      if (!account || this.#stopped) return;
      client.update({
        token: account.token,
        uin: account.uin,
        baseUrl: this.#options.baseUrl ?? account.baseUrl ?? ILINK_BASE_URL,
      });
      await this.#notify("start");
      this.#active = true;
      await this.#handlers.onReady(account);
      if ((await this.#poll()) === "stopped") return;
      this.#active = false;
      this.#expiredToken = account.token;
      logger.error(`${label} 登录凭据已失效 (errcode -14)，需要重新扫码登录`);
      await this.#handlers.onOffline("登录凭据已失效");
    }
  }

  async #acquire(): Promise<StoredAccount | undefined> {
    const { store, logger, label, autoLogin } = this.#options;
    while (!this.#stopped) {
      const stored = store.loadAccount();
      if (stored && stored.token !== this.#expiredToken) {
        this.#expiredToken = undefined;
        return stored;
      }
      if (autoLogin) {
        const account = await this.#login();
        if (account || this.#stopped) return account;
        logger.warn(`${label} 将在 1 小时后重新发起扫码，也可${WIZARD_HINT}`);
      } else if (stored) {
        logger.warn(`${label} 请${WIZARD_HINT}，1 小时后将重试原有凭据`);
      } else {
        logger.warn(`${label} 尚未登录，请${WIZARD_HINT}`);
      }
      const changed = await this.#waitForAccount(
        autoLogin || stored ? RELOGIN_DELAY : Infinity,
      );
      if (!changed) this.#expiredToken = undefined;
    }
    return undefined;
  }

  async #waitForAccount(ms: number): Promise<boolean> {
    const { store } = this.#options;
    const before = store.loadAccount()?.token;
    const deadline = Date.now() + ms;
    while (!this.#stopped && Date.now() < deadline) {
      await sleep(
        Math.min(STORE_CHECK_INTERVAL, deadline - Date.now()),
        this.#signal,
      );
      const token = store.loadAccount()?.token;
      if (token && token !== before && token !== this.#expiredToken)
        return true;
    }
    return false;
  }

  async #login(): Promise<StoredAccount | undefined> {
    const { client, store, logger, label } = this.#options;
    try {
      const result = await loginWithQrcode({
        client,
        baseUrl: this.#options.baseUrl ?? ILINK_BASE_URL,
        signal: this.#signal,
        hooks: {
          onQrcode: (content, index) => {
            logger.warn(
              `${label} 请使用微信扫描二维码登录（${index}/3）\n${renderQrcode(content)}\n若二维码无法显示，可访问以下链接继续: ${content}`,
            );
          },
          onScanned: () => logger.info(`${label} 已扫码，请在手机上确认登录`),
        },
      });
      const account: StoredAccount = {
        accountId: result.accountId,
        token: result.token,
        uin: client.uin,
        baseUrl: result.baseUrl,
        userId: result.userId,
        savedAt: Date.now(),
      };
      store.saveAccount(account);
      logger.info(
        `${label} 登录成功: ${result.accountId}${result.userId ? `，扫码用户 ${result.userId}` : ""}`,
      );
      return account;
    } catch (err) {
      if (!this.#stopped)
        logger.error(`${label} 扫码登录失败: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async #poll(): Promise<"expired" | "stopped"> {
    const { client, store, logger, label } = this.#options;
    let buf = store.loadSyncBuf();
    let timeout = POLL_TIMEOUT;
    let failures = 0;
    let online = true;
    while (!this.#stopped) {
      let resp: GetUpdatesResp;
      try {
        resp = await client.getUpdates(buf, timeout + POLL_MARGIN, this.#signal);
      } catch (err) {
        if (this.#stopped) break;
        failures += 1;
        online = await this.#degrade(
          failures,
          online,
          `拉取消息失败: ${errorMessage(err)}`,
        );
        continue;
      }
      if (isTokenExpired(resp)) return "expired";
      const code = errorCodeOf(resp);
      if (code !== 0) {
        failures += 1;
        online = await this.#degrade(
          failures,
          online,
          `拉取消息失败: ${resp.errmsg || "未知错误"} (code=${code})`,
        );
        continue;
      }
      failures = 0;
      if (!online) {
        online = true;
        logger.info(`${label} 已恢复连接`);
        await this.#handlers.onOnline();
      }
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0)
        timeout = resp.longpolling_timeout_ms;
      if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
        buf = resp.get_updates_buf;
        try {
          store.saveSyncBuf(buf);
        } catch (err) {
          logger.warn(`${label} 保存同步游标失败: ${errorMessage(err)}`);
        }
      }
      if (resp.msgs?.length) this.#handlers.onMessages(resp.msgs);
    }
    return "stopped";
  }

  async #degrade(
    failures: number,
    online: boolean,
    reason: string,
  ): Promise<boolean> {
    const { logger, label } = this.#options;
    if (failures < MAX_FAILURES) {
      logger.warn(`${label} ${reason}，${RETRY_DELAY / 1_000} 秒后重试`);
      await sleep(RETRY_DELAY, this.#signal);
      return online;
    }
    logger.error(
      `${label} ${reason}，已连续失败 ${failures} 次，${BACKOFF_DELAY / 1_000} 秒后重试`,
    );
    if (online) await this.#handlers.onOffline("网络异常");
    await sleep(BACKOFF_DELAY, this.#signal);
    return false;
  }

  async #notify(kind: "start" | "stop"): Promise<void> {
    const { client, logger, label } = this.#options;
    try {
      const resp =
        kind === "start" ? await client.notifyStart() : await client.notifyStop();
      const code = errorCodeOf(resp);
      if (code !== 0)
        logger.debug(`${label} notify${kind} 返回 code=${code} ${resp.errmsg ?? ""}`);
    } catch (err) {
      logger.debug(`${label} notify${kind} 失败: ${errorMessage(err)}`);
    }
  }
}
