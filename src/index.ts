export { ilinkAdapterDefinition, ILINK_DATA_DIR } from "./adapter";
export { createIlinkBot, peerOf } from "./bot";
export type { IlinkBot, IlinkBotBase, IlinkBotData } from "./bot";
export {
  IlinkApiError,
  IlinkClient,
  createUin,
  errorCodeOf,
  isTokenExpired,
  parseIlinkJson,
} from "./client";
export type {
  IlinkClientOptions,
  IlinkCredentials,
  IlinkRequestOptions,
} from "./client";
export { DEFAULT_INSTANCE, normalizeConfig, resolveInstance } from "./config";
export type {
  IlinkAdapterConfig,
  IlinkInstanceConfig,
  ResolvedIlinkInstance,
} from "./config";
export { IlinkLoginError, loginWithQrcode } from "./login";
export type {
  IlinkLoginFailure,
  IlinkLoginHooks,
  IlinkLoginOptions,
  IlinkLoginResult,
} from "./login";
export { IlinkMedia, decryptAesEcb, encryptAesEcb } from "./media";
export type { IlinkMediaRef, UploadedMedia } from "./media";
export { buildInboundMessage, buildOutbound, splitText } from "./message";
export type { InboundOptions, OutboundUnit } from "./message";
export { syncManagedOwner } from "./owners";
export type { OwnerSyncOptions } from "./owners";
export type { IlinkPeer } from "./peers";
export type { StoredAccount } from "./store";
export * from "./types";
export { ilinkAdapterDefinition as default } from "./adapter";

declare module "mioku" {
  interface AdapterBotMap {
    ilink: import("./bot").IlinkBot;
  }
}
