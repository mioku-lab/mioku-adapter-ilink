import { normalizeBaseUrl } from "./login";
import { ILINK_CDN_BASE_URL, MEDIA_KINDS, type IlinkMediaKind } from "./types";

export interface IlinkInstanceConfig {
  name?: string;
  nickname?: string;
  autoLogin?: boolean;
  baseUrl?: string;
  cdnBaseUrl?: string;
  routeTag?: string;
  autoDownload?: IlinkMediaKind[];
  mediaMaxMB?: number;
}

export interface ResolvedIlinkInstance {
  readonly name: string;
  readonly nickname: string;
  readonly autoLogin: boolean;
  readonly baseUrl?: string;
  readonly cdnBaseUrl: string;
  readonly routeTag?: string;
  readonly autoDownload: readonly IlinkMediaKind[];
  readonly mediaMaxMB: number;
}

export interface IlinkAdapterConfig {
  readonly instances: readonly ResolvedIlinkInstance[];
}

export const DEFAULT_INSTANCE = {
  autoLogin: true,
  cdnBaseUrl: ILINK_CDN_BASE_URL,
  autoDownload: ["image", "record"] as readonly IlinkMediaKind[],
  mediaMaxMB: 20,
} as const;

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown, field: string): string | undefined => {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  throw new Error(`${field} 必须是字符串`);
};

const flag = (value: unknown, fallback: boolean, field: string): boolean => {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} 必须是布尔值`);
};

const url = (value: unknown, field: string): string | undefined => {
  const raw = optionalText(value, field);
  if (raw === undefined) return undefined;
  const normalized = normalizeBaseUrl(raw)!;
  try {
    new URL(normalized);
  } catch {
    throw new Error(`${field} 不是合法的 URL`);
  }
  return normalized;
};

const mediaKinds = (value: unknown, field: string): IlinkMediaKind[] => {
  if (value == null) return [...DEFAULT_INSTANCE.autoDownload];
  if (value === true) return [...MEDIA_KINDS];
  if (value === false) return [];
  if (!Array.isArray(value))
    throw new Error(`${field} 必须是数组，可选值 ${MEDIA_KINDS.join(" / ")}`);
  for (const item of value)
    if (!MEDIA_KINDS.includes(item as IlinkMediaKind))
      throw new Error(`${field} 包含未知类型 ${String(item)}`);
  return Array.from(new Set(value as IlinkMediaKind[]));
};

export const resolveInstance = (
  raw: unknown,
  index: number,
): ResolvedIlinkInstance => {
  const at = (field: string): string => `ilink.instances[${index}].${field}`;
  if (!isRecord(raw)) throw new Error(`ilink.instances[${index}] 必须是对象`);
  const name = optionalText(raw.name, at("name")) ?? `bot${index + 1}`;
  if (!NAME_PATTERN.test(name))
    throw new Error(`${at("name")} 只能包含字母、数字、- 和 _，最长 32 个字符`);
  const mediaMaxMB = raw.mediaMaxMB ?? DEFAULT_INSTANCE.mediaMaxMB;
  if (typeof mediaMaxMB !== "number" || !(mediaMaxMB > 0))
    throw new Error(`${at("mediaMaxMB")} 必须是正数`);
  return {
    name,
    nickname: optionalText(raw.nickname, at("nickname")) ?? name,
    autoLogin: flag(raw.autoLogin, DEFAULT_INSTANCE.autoLogin, at("autoLogin")),
    baseUrl: url(raw.baseUrl, at("baseUrl")),
    cdnBaseUrl: url(raw.cdnBaseUrl, at("cdnBaseUrl")) ?? DEFAULT_INSTANCE.cdnBaseUrl,
    routeTag: optionalText(
      typeof raw.routeTag === "number" ? String(raw.routeTag) : raw.routeTag,
      at("routeTag"),
    ),
    autoDownload: mediaKinds(raw.autoDownload, at("autoDownload")),
    mediaMaxMB,
  };
};

export const normalizeConfig = (input: unknown): IlinkAdapterConfig => {
  const raw = input ?? {};
  if (!isRecord(raw)) throw new Error("ilink 配置必须是对象");
  const list = raw.instances === undefined ? [raw] : raw.instances;
  if (!Array.isArray(list)) throw new Error("ilink.instances 必须是数组");
  if (list.length === 0) throw new Error("ilink.instances 至少需要配置一个实例");
  const instances = list.map(resolveInstance);
  const names = new Set<string>();
  for (const instance of instances) {
    if (names.has(instance.name))
      throw new Error(`ilink 实例名重复: ${instance.name}`);
    names.add(instance.name);
  }
  return { instances };
};
