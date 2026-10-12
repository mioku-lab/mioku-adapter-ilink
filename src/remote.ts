import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 5;

export interface RemoteFetchOptions {
  readonly maxBytes: number;
  readonly timeout: number;
  /** 是否拒绝内网与保留地址，默认 true；下载自家 CDN 时可关闭 */
  readonly guard?: boolean;
}

type Hop =
  | { readonly body: Buffer; readonly redirect?: undefined }
  | { readonly redirect: string; readonly body?: undefined };

const isBlockedV4 = (ip: string): boolean => {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
};

const toHextets = (ip: string): number[] => {
  let text = ip.split("%")[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const n = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${(((n[0] ?? 0) << 8) | (n[1] ?? 0)).toString(16)}:${(((n[2] ?? 0) << 8) | (n[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - left.length - right.length : 0;
  return [...left, ...Array<string>(Math.max(fill, 0)).fill("0"), ...right].map(
    (part) => Number.parseInt(part, 16),
  );
};

const embeddedV4 = (high: number, low: number): string =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

const isBlockedV6 = (ip: string): boolean => {
  const h = toHextets(ip);
  if (h.length !== 8 || h.some(Number.isNaN)) return true;
  const [h0 = 0, h1 = 0, h2 = 0, , , h5 = 0, h6 = 0, h7 = 0] = h;
  if (h.slice(0, 5).every((part) => part === 0)) {
    if (h5 === 0xffff) return isBlockedV4(embeddedV4(h6, h7));
    if (h5 === 0) return true;
  }
  if (h0 === 0x64 && h1 === 0xff9b) return isBlockedV4(embeddedV4(h6, h7));
  if (h0 === 0x2002) return isBlockedV4(embeddedV4(h1, h2));
  return (
    (h0 & 0xfe00) === 0xfc00 ||
    (h0 & 0xffc0) === 0xfe80 ||
    (h0 & 0xff00) === 0xff00
  );
};

export const isBlockedAddress = (ip: string): boolean => {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true;
};

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked || addresses.length === 0)
      return callback(
        new Error("拒绝访问内网或保留地址") as NodeJS.ErrnoException,
        "",
        0,
      );
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
};

const requestOnce = (
  rawUrl: string,
  options: RemoteFetchOptions,
): Promise<Hop> =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new Error("地址格式错误"));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error(`不支持的协议 ${url.protocol}`));
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const guard = options.guard !== false;
    if (guard && net.isIP(host) && isBlockedAddress(host)) {
      reject(new Error("拒绝访问内网或保留地址"));
      return;
    }
    const limit = Math.round(options.maxBytes / 1048576);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method: "GET",
        ...(guard ? { lookup: guardedLookup } : {}),
        signal: AbortSignal.timeout(options.timeout),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          res.destroy();
          reject(new Error(`文件超过 ${limit}MB`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            res.destroy();
            reject(new Error(`文件超过 ${limit}MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks, size) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });

export const fetchRemote = async (
  rawUrl: string,
  options: RemoteFetchOptions,
): Promise<Buffer> => {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await requestOnce(current, options);
    if (result.redirect === undefined) return result.body;
    current = new URL(result.redirect, current).toString();
  }
  throw new Error("重定向次数过多");
};
