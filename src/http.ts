import type { HttpClient, HttpRequestOptions, HttpResponse } from "mioku";

const decoder = new TextDecoder();

const serializeBody = (
  body: HttpRequestOptions["body"],
): string | Uint8Array<ArrayBuffer> | undefined => {
  if (body == null || typeof body === "string") return body;
  if (body instanceof Uint8Array) return new Uint8Array(body);
  return JSON.stringify(body);
};

export const createFetchHttp = (): HttpClient => ({
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: serializeBody(options.body),
        signal,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers,
        body,
        text: () => decoder.decode(body),
        json: <T>() => JSON.parse(decoder.decode(body)) as T,
        arrayBuffer: () =>
          body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
});
