import { sleep } from "./util";

import type { IlinkClient } from "./client";
import type { QrcodeResp, QrcodeStatusResp } from "./types";

const STATUS_TIMEOUT = 40_000;

const LOGIN_TIMEOUT = 8 * 60_000;

const MAX_QRCODES = 3;

export interface IlinkLoginResult {
  readonly accountId: string;
  readonly token: string;
  readonly baseUrl: string;
  readonly userId?: string;
}

export type IlinkLoginFailure =
  | "expired"
  | "timeout"
  | "verify"
  | "blocked"
  | "bound"
  | "invalid"
  | "aborted";

export class IlinkLoginError extends Error {
  readonly reason: IlinkLoginFailure;

  constructor(reason: IlinkLoginFailure, message: string) {
    super(message);
    this.name = "IlinkLoginError";
    this.reason = reason;
  }
}

export interface IlinkLoginHooks {
  onQrcode(content: string, index: number): void | Promise<void>;
  onScanned?(): void;
  verifyCode?(retry: boolean): Promise<string | undefined>;
}

export interface IlinkLoginOptions {
  readonly client: IlinkClient;
  readonly baseUrl: string;
  readonly hooks: IlinkLoginHooks;
  readonly localTokens?: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export const normalizeBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const url = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};

const requireQrcode = (
  resp: QrcodeResp,
): { qrcode: string; content: string } => {
  if (!resp.qrcode || !resp.qrcode_img_content)
    throw new IlinkLoginError("invalid", "获取登录二维码失败：响应缺少二维码");
  return { qrcode: resp.qrcode, content: resp.qrcode_img_content };
};

export const loginWithQrcode = async (
  options: IlinkLoginOptions,
): Promise<IlinkLoginResult> => {
  const { client, hooks, signal } = options;
  const deadline = Date.now() + (options.timeout ?? LOGIN_TIMEOUT);
  const localTokens = options.localTokens ?? [];
  const aborted = (): IlinkLoginError =>
    new IlinkLoginError("aborted", "登录已取消");

  let issued = 0;
  let current = { qrcode: "", content: "" };
  let pollBase = options.baseUrl;
  let verifyCode: string | undefined;
  let scanned = false;

  const issue = async (reason: IlinkLoginFailure): Promise<void> => {
    if (issued >= MAX_QRCODES)
      throw new IlinkLoginError(
        reason,
        reason === "blocked"
          ? "验证码多次输入错误，登录已停止"
          : "二维码多次过期，登录已停止",
      );
    issued += 1;
    current = requireQrcode(
      await client.getBotQrcode(localTokens, options.baseUrl),
    );
    scanned = false;
    await hooks.onQrcode(current.content, issued);
  };

  await issue("expired");
  while (Date.now() < deadline) {
    if (signal?.aborted) throw aborted();
    let status: QrcodeStatusResp;
    try {
      status = await client.getQrcodeStatus(current.qrcode, {
        baseUrl: pollBase,
        verifyCode,
        timeout: STATUS_TIMEOUT,
        signal,
      });
    } catch {
      if (signal?.aborted) throw aborted();
      await sleep(1_000, signal);
      continue;
    }
    switch (status.status) {
      case "scaned":
        verifyCode = undefined;
        if (!scanned) hooks.onScanned?.();
        scanned = true;
        break;
      case "need_verifycode": {
        if (!hooks.verifyCode)
          throw new IlinkLoginError(
            "verify",
            "服务端要求输入手机上显示的数字，请运行配置向导完成登录",
          );
        const code = (await hooks.verifyCode(verifyCode !== undefined))?.trim();
        if (!code)
          throw new IlinkLoginError("verify", "未输入验证数字，登录已取消");
        verifyCode = code;
        continue;
      }
      case "verify_code_blocked":
        verifyCode = undefined;
        await issue("blocked");
        continue;
      case "expired":
        await issue("expired");
        continue;
      case "scaned_but_redirect":
        if (status.redirect_host) pollBase = `https://${status.redirect_host}`;
        break;
      case "binded_redirect":
        throw new IlinkLoginError(
          "bound",
          "该微信 bot 已在本地登录，原有凭据仍然有效",
        );
      case "confirmed":
        if (!status.ilink_bot_id || !status.bot_token)
          throw new IlinkLoginError("invalid", "登录确认响应缺少 bot 凭据");
        return {
          accountId: status.ilink_bot_id,
          token: status.bot_token,
          baseUrl: normalizeBaseUrl(status.baseurl) ?? options.baseUrl,
          userId: status.ilink_user_id || undefined,
        };
      default:
        break;
    }
    await sleep(1_000, signal);
  }
  throw new IlinkLoginError("timeout", "等待扫码超时");
};
