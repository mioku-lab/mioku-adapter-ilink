import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HttpClient, HttpResponse, MessageSegment } from "mioku";
import type { IlinkClient } from "./client";
import type { IlinkCdnMedia, UploadMediaTypeValue } from "./types";
import { fetchRemote } from "./remote";
import { errorMessage } from "./util";

const TRANSFER_TIMEOUT = 120_000;

const UPLOAD_ATTEMPTS = 3;

const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

export interface IlinkMediaRef extends IlinkCdnMedia {
  readonly aeskey?: string;
}

export interface UploadedMedia {
  readonly downloadParam: string;
  readonly aeskey: Buffer;
  readonly rawSize: number;
  readonly cipherSize: number;
}

export const encryptAesEcb = (plain: Buffer, key: Buffer): Buffer => {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

export const decryptAesEcb = (data: Buffer, key: Buffer): Buffer => {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
};

export const aesPaddedSize = (size: number): number =>
  Math.ceil((size + 1) / 16) * 16;

export const md5Hex = (data: Buffer): string =>
  createHash("md5").update(data).digest("hex");

const HEX_KEY = /^[0-9a-f]{32}$/i;

/** aes_key 可能是 base64(原始 key) 或 base64(hex) */
export const resolveAesKey = (ref: IlinkMediaRef): Buffer | undefined => {
  if (ref.aeskey && HEX_KEY.test(ref.aeskey))
    return Buffer.from(ref.aeskey, "hex");
  if (!ref.aes_key) return undefined;
  const decoded = Buffer.from(ref.aes_key, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (HEX_KEY.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error(`无法解析 aes_key（解码后 ${decoded.length} 字节）`);
};

export const toCdnMedia = (uploaded: UploadedMedia): IlinkCdnMedia => ({
  encrypt_query_param: uploaded.downloadParam,
  aes_key: Buffer.from(uploaded.aeskey.toString("hex")).toString("base64"),
  encrypt_type: 1,
});

const ascii = (data: Buffer, start: number, end: number): string =>
  data.subarray(start, end).toString("latin1");

export const sniffMime = (data: Buffer): string | undefined => {
  if (data.length < 4) return undefined;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (ascii(data, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(data, 0, 4) === "GIF8") return "image/gif";
  if (ascii(data, 0, 4) === "RIFF") {
    const kind = ascii(data, 8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
  }
  if (ascii(data, 0, 2) === "BM") return "image/bmp";
  if (ascii(data, 4, 8) === "ftyp") {
    const brand = ascii(data, 8, 12);
    return ["heic", "heix", "mif1", "msf1"].includes(brand)
      ? "image/heic"
      : "video/mp4";
  }
  if (ascii(data, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(data, 0, 5) === "#!AMR") return "audio/amr";
  if (ascii(data, 0, 10).includes("#!SILK")) return "audio/silk";
  if (ascii(data, 0, 3) === "ID3") return "audio/mpeg";
  if (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii(data, 0, 4) === "%PDF") return "application/pdf";
  return undefined;
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/amr": ".amr",
  "audio/silk": ".silk",
  "audio/mpeg": ".mp3",
  "application/pdf": ".pdf",
};

export const extensionOf = (mime: string | undefined): string =>
  (mime && EXTENSIONS[mime]) || ".bin";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
  ),
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const mimeOfName = (name: string | undefined): string | undefined =>
  name ? MIME_BY_EXTENSION[path.extname(name).toLowerCase()] : undefined;

const toBuffer = (data: Uint8Array): Buffer =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength);

const stringValues = (seg: MessageSegment): string[] =>
  [
    seg.data.file,
    seg.data.url,
    seg.data.path,
    seg.attachment?.file,
    seg.attachment?.url,
  ].filter((value): value is string => typeof value === "string" && !!value);

const decodeDataUrl = (value: string): Buffer => {
  const comma = value.indexOf(",");
  if (comma < 0) throw new Error("data URL 格式错误");
  const meta = value.slice(5, comma);
  const body = value.slice(comma + 1);
  return meta.endsWith(";base64")
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body));
};

const localPathOf = (value: string): string => {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value.replace(/^file:\/+/, process.platform === "win32" ? "" : "/");
  }
};

const nameFromSource = (value: string): string | undefined => {
  if (value.startsWith("base64://") || value.startsWith("data:"))
    return undefined;
  const tail = value.split(/[?#]/)[0]!.split(/[\\/]/).pop();
  if (!tail) return undefined;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
};

export interface MediaSource {
  readonly data: Buffer;
  readonly name?: string;
}

export class IlinkMedia {
  readonly #http: HttpClient;
  readonly #client: IlinkClient;
  readonly #cdnBaseUrl: string;

  constructor(options: {
    readonly http: HttpClient;
    readonly client: IlinkClient;
    readonly cdnBaseUrl: string;
  }) {
    this.#http = options.http;
    this.#client = options.client;
    this.#cdnBaseUrl = options.cdnBaseUrl.replace(/\/+$/, "");
  }

  /** 下载并解密 CDN 媒体；maxBytes 在下载过程中生效，不会先读满内存 */
  async download(
    ref: IlinkMediaRef,
    maxBytes = MAX_TRANSFER_BYTES,
  ): Promise<Buffer> {
    const full = ref.full_url?.trim();
    const url =
      full ||
      (ref.encrypt_query_param
        ? `${this.#cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(ref.encrypt_query_param)}`
        : undefined);
    if (!url) throw new Error("媒体缺少下载地址");
    let data: Buffer;
    try {
      data = await fetchRemote(url, {
        maxBytes,
        timeout: TRANSFER_TIMEOUT,
        // full_url 由服务端下发，按不可信地址校验；cdnBaseUrl 由使用者配置
        guard: Boolean(full),
      });
    } catch (err) {
      throw new Error(`CDN 下载失败: ${errorMessage(err)}`);
    }
    const key = resolveAesKey(ref);
    return key ? decryptAesEcb(data, key) : data;
  }

  async upload(
    data: Buffer,
    mediaType: UploadMediaTypeValue,
    toUserId: string,
  ): Promise<UploadedMedia> {
    const aeskey = randomBytes(16);
    const filekey = randomBytes(16).toString("hex");
    const cipherSize = aesPaddedSize(data.length);
    const target = await this.#client.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: data.length,
      rawfilemd5: md5Hex(data),
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    });
    const url =
      target.upload_full_url?.trim() ||
      (target.upload_param
        ? `${this.#cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(target.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : undefined);
    if (!url) throw new Error("getuploadurl 未返回上传地址");
    const downloadParam = await this.#postCdn(url, encryptAesEcb(data, aeskey));
    return { downloadParam, aeskey, rawSize: data.length, cipherSize };
  }

  async #postCdn(url: string, body: Buffer): Promise<string> {
    let lastError: Error = new Error("CDN 上传失败");
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      let response: HttpResponse;
      try {
        response = await this.#http.request({
          method: "POST",
          url,
          headers: { "Content-Type": "application/octet-stream" },
          body,
          timeout: TRANSFER_TIMEOUT,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      const reason = response.headers["x-error-message"] ?? "";
      if (response.status >= 400 && response.status < 500)
        throw new Error(`CDN 上传失败: HTTP ${response.status} ${reason}`.trim());
      if (response.status !== 200) {
        lastError = new Error(
          `CDN 上传失败: HTTP ${response.status} ${reason}`.trim(),
        );
        continue;
      }
      const param = response.headers["x-encrypted-param"];
      if (param) return param;
      lastError = new Error("CDN 上传响应缺少 x-encrypted-param");
    }
    throw lastError;
  }

  async read(seg: MessageSegment): Promise<MediaSource> {
    const named =
      typeof seg.data.name === "string" && seg.data.name
        ? seg.data.name
        : seg.attachment?.name;
    if (seg.attachment?.data)
      return { data: toBuffer(seg.attachment.data), name: named };
    const source = stringValues(seg)[0];
    if (!source) throw new Error(`${seg.type} 消息段缺少文件来源`);
    const name = named ?? nameFromSource(source);
    if (source.startsWith("base64://"))
      return { data: Buffer.from(source.slice(9), "base64"), name };
    if (source.startsWith("data:"))
      return { data: decodeDataUrl(source), name };
    if (/^https?:\/\//i.test(source))
      return { data: await this.#fetchRemote(source), name };
    return { data: await fs.readFile(localPathOf(source)), name };
  }

  async #fetchRemote(url: string): Promise<Buffer> {
    try {
      return await fetchRemote(url, {
        maxBytes: MAX_TRANSFER_BYTES,
        timeout: TRANSFER_TIMEOUT,
      });
    } catch (err) {
      throw new Error(`下载远程文件失败: ${errorMessage(err)}`);
    }
  }
}
