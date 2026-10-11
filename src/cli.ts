#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import consola from "consola";

import { createUin, IlinkClient } from "./client";
import { resolveInstance } from "./config";
import { createFetchHttp } from "./http";
import { IlinkLoginError, loginWithQrcode } from "./login";
import { renderQrcode } from "./qrcode";
import { AccountStore } from "./store";
import { ILINK_BASE_URL } from "./types";
import { errorMessage } from "./util";

import type { ConfirmPromptOptions, TextPromptOptions } from "consola";

type ConfirmOpts = Omit<ConfirmPromptOptions, "type" | "required"> & {
  required?: boolean;
};
type TextOpts = Omit<TextPromptOptions, "type" | "required"> & {
  required?: boolean;
};

const confirm = async (
  message: string,
  options?: ConfirmOpts,
): Promise<boolean> =>
  (await consola.prompt(message, {
    type: "confirm",
    cancel: "reject",
    ...options,
  })) as boolean;

const input = async (message: string, options?: TextOpts): Promise<string> => {
  let result: string;
  do {
    result = (await consola.prompt(message, {
      type: "text",
      cancel: "reject",
      ...options,
    })) as string;
    if (options?.required && !result) continue;
    break;
  } while (true);
  return result.trim();
};

export interface IlinkCliContext {
  readonly cwd: string;
  readonly logger?: typeof consola;
}

export type IlinkInstanceInput = Record<string, unknown> & { name: string };

export interface IlinkCliConfig {
  instances: IlinkInstanceInput[];
}

export interface IlinkCliResult {
  readonly config: IlinkCliConfig;
  readonly scanners: string[];
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPackage = (cwd: string): Record<string, unknown> => {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return {};
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
};

const existingInstances = (pkg: Record<string, unknown>): IlinkInstanceInput[] => {
  const mioku = isRecord(pkg.mioku) ? pkg.mioku : {};
  const adapters = isRecord(mioku.adapters) ? mioku.adapters : {};
  const raw = adapters.ilink;
  if (!isRecord(raw)) return [];
  const list = Array.isArray(raw.instances) ? raw.instances : [raw];
  return list.filter(isRecord).map((item, index) => ({
    ...item,
    name:
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : `bot${index + 1}`,
  }));
};

const nextName = (names: readonly string[]): string => {
  let index = names.length + 1;
  while (names.includes(`bot${index}`)) index++;
  return `bot${index}`;
};

const loginInstance = async (
  log: typeof consola,
  dataRoot: string,
  instance: IlinkInstanceInput,
  index: number,
): Promise<{ ok: boolean; scanner?: string }> => {
  const resolved = resolveInstance(instance, index);
  const store = new AccountStore(dataRoot, resolved.name);
  const previous = store.loadAccount();
  const baseUrl = resolved.baseUrl ?? ILINK_BASE_URL;
  const client = new IlinkClient({
    http: createFetchHttp(),
    baseUrl,
    uin: previous?.uin ?? createUin(),
    routeTag: resolved.routeTag,
  });
  try {
    const result = await loginWithQrcode({
      client,
      baseUrl,
      localTokens: previous ? [previous.token] : [],
      hooks: {
        onQrcode: (content, count) => {
          log.info(`请使用手机微信扫描二维码（${count}/3）`);
          process.stdout.write(`${renderQrcode(content)}\n`);
          log.info(`若二维码无法显示，可访问以下链接继续: ${content}`);
        },
        onScanned: () => log.info("已扫码，请在手机上确认登录"),
        verifyCode: (retry) =>
          input(
            retry
              ? "数字不匹配，请重新输入手机微信上显示的数字"
              : "请输入手机微信上显示的数字",
            { required: true },
          ),
      },
    });
    store.saveAccount({
      accountId: result.accountId,
      token: result.token,
      uin: client.uin,
      baseUrl: result.baseUrl,
      userId: result.userId,
      savedAt: Date.now(),
    });
    log.success(`实例 ${resolved.name} 登录成功: ${result.accountId}`);
    return { ok: true, scanner: result.userId };
  } catch (err) {
    if (err instanceof IlinkLoginError && err.reason === "bound") {
      log.success(`实例 ${resolved.name} 已登录，原有凭据仍然有效`);
      return { ok: true, scanner: previous?.userId };
    }
    log.error(`实例 ${resolved.name} 登录失败: ${errorMessage(err)}`);
    return { ok: false };
  }
};

export const runWizard = async (ctx: IlinkCliContext): Promise<IlinkCliResult> => {
  const log = ctx.logger ?? consola;
  const dataRoot = path.join(ctx.cwd, "data", "ilink");
  const instances = existingInstances(readPackage(ctx.cwd));
  const scanners: string[] = [];
  log.info("正在配置 ilink 适配器（微信 ClawBot，仅支持私聊）");
  log.info("登录凭据保存在 data/ilink/<实例名>/，请勿提交到版本库");
  log.info("");

  let more = true;
  while (more) {
    const names = instances.map((item) => item.name);
    const pending = names.find(
      (name) => !new AccountStore(dataRoot, name).loadAccount(),
    );
    const suggested = pending ?? nextName(names);
    const name =
      (await input("实例名称（与已有实例同名则重新登录该实例）", {
        default: suggested,
        placeholder: suggested,
      })) || suggested;
    if (!NAME_PATTERN.test(name)) {
      log.error("实例名称只能包含字母、数字、- 和 _，最长 32 个字符");
      continue;
    }
    const index = names.indexOf(name);
    const instance = index >= 0 ? instances[index]! : { name };
    const result = await loginInstance(
      log,
      dataRoot,
      instance,
      index >= 0 ? index : instances.length,
    );
    if (index < 0) instances.push(instance);
    if (result.scanner && !scanners.includes(result.scanner))
      scanners.push(result.scanner);
    if (!result.ok)
      log.info("该实例未登录，启动机器人后会在日志中输出二维码，也可再次运行本向导");
    more = await confirm("是否继续添加或重新登录其他实例？", { initial: false });
    if (more) log.info("");
  }
  return { config: { instances }, scanners };
};

export const run = async (ctx: IlinkCliContext): Promise<IlinkCliConfig> =>
  (await runWizard(ctx)).config;

const isRunningAsMain = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
};

if (isRunningAsMain()) {
  void (async () => {
    const cwd = process.cwd();
    const pkgPath = path.join(cwd, "package.json");
    if (!fs.existsSync(pkgPath)) {
      consola.error("未找到 package.json，请在机器人项目根目录运行此向导");
      process.exit(1);
    }
    const { config, scanners } = await runWizard({ cwd });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      mioku?: Record<string, unknown>;
    };
    const mioku = (pkg.mioku = pkg.mioku ?? {});
    const adapters = (mioku.adapters as Record<string, unknown> | undefined) ?? {};
    mioku.adapters = { ...adapters, ilink: config };
    const owners = Array.isArray(mioku.owners) ? mioku.owners : [];
    const known = owners.map(String);
    const newcomers = scanners.filter((id) => !known.includes(id));
    if (
      newcomers.length > 0 &&
      (await confirm(`将扫码用户 ${newcomers.join("、")} 设为机器人主人？`, {
        initial: true,
      }))
    )
      mioku.owners = [...owners, ...newcomers];
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    consola.success("已写入 ilink 适配器配置");
  })();
}

export default run;
