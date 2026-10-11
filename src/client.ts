import { randomBytes } from "node:crypto";
import { version } from "../package.json" with { type: "json" };
import {
  ERRCODE_TOKEN_EXPIRED,
  ILINK_BOT_TYPE,
  type GetConfigResp,
  type GetUpdatesResp,
  type GetUploadUrlReq,
  type GetUploadUrlResp,
  type IlinkMessage,
  type IlinkResult,
  type QrcodeResp,
  type QrcodeStatusResp,
  type SendMessageResp,
} from "./types";
import { errorMessage } from "./util";

import type { HttpClient, HttpResponse } from "mioku";

const APP_ID = "bot";

const BOT_AGENT = `mioku-adapter-ilink/${version}`;

const API_TIMEOUT = 15_000;

const LIGHT_TIMEOUT = 10_000;

const encodeClientVersion = (value: string): number => {
  const [major = 0, minor = 0, patch = 0] = value
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
};

const CLIENT_VERSION = String(encodeClientVersion(version));

const ID_FIELDS = /"(message_id|msg_id|svr_id)"(\s*):(\s*)(-?\d+)/g;

/** uint64 id 转为字符串，避免丢失精度 */
export const parseIlinkJson = <T>(text: string): T =>
  JSON.parse(text.replace(ID_FIELDS, '"$1"$2:$3"$4"')) as T;

export const createUin = (): string =>
  Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");

export const errorCodeOf = (result: IlinkResult): number => {
  if (typeof result.errcode === "number" && result.errcode !== 0)
    return result.errcode;
  if (typeof result.ret === "number" && result.ret !== 0) return result.ret;
  return 0;
};

export const isTokenExpired = (result: IlinkResult): boolean =>
  result.errcode === ERRCODE_TOKEN_EXPIRED ||
  result.ret === ERRCODE_TOKEN_EXPIRED;

export class IlinkApiError extends Error {
  readonly endpoint: string;
  readonly code: number;
  readonly status: number;

  constructor(endpoint: string, message: string, code = -1, status = 200) {
    super(`${endpoint}: ${message}${code === -1 ? "" : ` (code=${code})`}`);
    this.name = "IlinkApiError";
    this.endpoint = endpoint;
    this.code = code;
    this.status = status;
  }
}

export interface IlinkCredentials {
  readonly baseUrl: string;
  readonly uin: string;
  readonly token?: string;
}

export interface IlinkClientOptions extends IlinkCredentials {
  readonly http: HttpClient;
  readonly routeTag?: string;
}

export interface IlinkRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
  readonly raw?: boolean;
  readonly auth?: boolean;
}

const endpointName = (endpoint: string): string =>
  endpoint.split("?")[0]!.replace(/^ilink\/bot\//, "");

export class IlinkClient {
  readonly #http: HttpClient;
  readonly #routeTag: string | undefined;
  #credentials: IlinkCredentials;

  constructor(options: IlinkClientOptions) {
    this.#http = options.http;
    this.#routeTag = options.routeTag;
    this.#credentials = {
      baseUrl: options.baseUrl,
      uin: options.uin,
      token: options.token,
    };
  }

  get http(): HttpClient {
    return this.#http;
  }

  get baseUrl(): string {
    return this.#credentials.baseUrl;
  }

  get uin(): string {
    return this.#credentials.uin;
  }

  get token(): string | undefined {
    return this.#credentials.token;
  }

  update(next: Partial<IlinkCredentials>): void {
    this.#credentials = { ...this.#credentials, ...next };
  }

  #url(endpoint: string, baseUrl = this.#credentials.baseUrl): string {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(endpoint, base).toString();
  }

  #commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": APP_ID,
      "iLink-App-ClientVersion": CLIENT_VERSION,
    };
    if (this.#routeTag) headers.SKRouteTag = this.#routeTag;
    return headers;
  }

  async #send<T>(
    endpoint: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
    options: IlinkRequestOptions,
  ): Promise<T> {
    const name = endpointName(endpoint);
    let response: HttpResponse;
    try {
      response = await this.#http.request({
        method: init.method,
        url: this.#url(endpoint, options.baseUrl),
        headers: init.headers,
        body: init.body,
        timeout: options.timeout ?? API_TIMEOUT,
        signal: options.signal,
      });
    } catch (err) {
      throw new IlinkApiError(name, errorMessage(err), -1, 0);
    }
    const text = response.text();
    if (response.status < 200 || response.status >= 300)
      throw new IlinkApiError(
        name,
        `HTTP ${response.status} ${text.slice(0, 200)}`.trim(),
        -1,
        response.status,
      );
    let payload: T;
    try {
      payload = parseIlinkJson<T>(text || "{}");
    } catch {
      throw new IlinkApiError(name, "响应不是合法的 JSON", -1, response.status);
    }
    if (!options.raw) {
      const result = payload as IlinkResult;
      const code = errorCodeOf(result);
      if (code !== 0)
        throw new IlinkApiError(name, result.errmsg || "请求失败", code);
    }
    return payload;
  }

  post<T extends IlinkResult = IlinkResult>(
    endpoint: string,
    body: Readonly<Record<string, unknown>> = {},
    options: IlinkRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": this.#credentials.uin,
      ...this.#commonHeaders(),
    };
    const token = this.#credentials.token?.trim();
    if (token && options.auth !== false)
      headers.Authorization = `Bearer ${token}`;
    const payload = JSON.stringify({
      ...body,
      base_info: { channel_version: version, bot_agent: BOT_AGENT },
    });
    return this.#send<T>(
      endpoint,
      { method: "POST", headers, body: payload },
      options,
    );
  }

  get<T extends IlinkResult = IlinkResult>(
    endpoint: string,
    options: IlinkRequestOptions = {},
  ): Promise<T> {
    return this.#send<T>(
      endpoint,
      { method: "GET", headers: this.#commonHeaders() },
      options,
    );
  }

  getUpdates(
    buf: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<GetUpdatesResp> {
    return this.post<GetUpdatesResp>(
      "ilink/bot/getupdates",
      { get_updates_buf: buf },
      { timeout, signal, raw: true },
    );
  }

  sendMessage(msg: IlinkMessage): Promise<SendMessageResp> {
    return this.post<SendMessageResp>("ilink/bot/sendmessage", { msg });
  }

  getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.post<GetUploadUrlResp>("ilink/bot/getuploadurl", { ...req });
  }

  getConfig(userId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.post<GetConfigResp>(
      "ilink/bot/getconfig",
      { ilink_user_id: userId, context_token: contextToken },
      { timeout: LIGHT_TIMEOUT },
    );
  }

  async sendTyping(
    userId: string,
    typingTicket: string,
    status: number,
  ): Promise<void> {
    await this.post(
      "ilink/bot/sendtyping",
      { ilink_user_id: userId, typing_ticket: typingTicket, status },
      { timeout: LIGHT_TIMEOUT },
    );
  }

  notifyStart(): Promise<IlinkResult> {
    return this.post("ilink/bot/msg/notifystart", {}, {
      timeout: 5_000,
      raw: true,
    });
  }

  notifyStop(): Promise<IlinkResult> {
    return this.post("ilink/bot/msg/notifystop", {}, {
      timeout: 3_000,
      raw: true,
    });
  }

  getBotQrcode(
    localTokens: readonly string[],
    baseUrl?: string,
  ): Promise<QrcodeResp> {
    return this.post<QrcodeResp>(
      `ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`,
      { local_token_list: localTokens },
      { baseUrl, auth: false },
    );
  }

  getQrcodeStatus(
    qrcode: string,
    options: {
      readonly baseUrl?: string;
      readonly verifyCode?: string;
      readonly timeout: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<QrcodeStatusResp> {
    const query = new URLSearchParams({ qrcode });
    if (options.verifyCode) query.set("verify_code", options.verifyCode);
    return this.get<QrcodeStatusResp>(
      `ilink/bot/get_qrcode_status?${query.toString()}`,
      {
        baseUrl: options.baseUrl,
        timeout: options.timeout,
        signal: options.signal,
        raw: true,
      },
    );
  }
}
