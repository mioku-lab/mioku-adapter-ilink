import { asMessage, createMessage, segment } from "mioku";
import { md5Hex, mimeOfName, sniffMime, type IlinkMediaRef } from "./media";
import {
  ItemType,
  type IlinkCdnMedia,
  type IlinkMediaKind,
  type IlinkMessageItem,
} from "./types";
import { errorMessage } from "./util";

import type {
  Attachment,
  ForwardSendNode,
  Logger,
  Message,
  MessageInput,
  MessageSegment,
} from "mioku";
import type { IlinkMedia } from "./media";

export const TEXT_LIMIT = 4_000;

export interface InboundOptions {
  readonly media: IlinkMedia;
  readonly logger: Logger;
  readonly download: ReadonlySet<IlinkMediaKind>;
  readonly maxBytes: number;
}

const SUMMARY: Readonly<Record<IlinkMediaKind, string>> = {
  image: "[图片]",
  record: "[语音]",
  video: "[视频]",
  file: "[文件]",
};

const VOICE_MIME: Readonly<Record<number, string>> = {
  5: "audio/amr",
  6: "audio/silk",
  7: "audio/mpeg",
  8: "audio/ogg",
};

const refOf = (
  media: IlinkCdnMedia | undefined,
  aeskey?: string,
): IlinkMediaRef | undefined => {
  if (!media?.encrypt_query_param && !media?.full_url) return undefined;
  return aeskey ? { ...media, aeskey } : { ...media };
};

const numberOf = (value: unknown): number | undefined => {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) && num > 0
    ? num
    : undefined;
};

interface MediaDraft {
  readonly kind: IlinkMediaKind;
  readonly ref?: IlinkMediaRef;
  readonly size?: number;
  readonly mime?: string;
  readonly name?: string;
  readonly data: Record<string, unknown>;
}

const draftOf = (item: IlinkMessageItem): MediaDraft | undefined => {
  switch (item.type) {
    case ItemType.IMAGE: {
      const image = item.image_item ?? {};
      return {
        kind: "image",
        ref: refOf(image.media, image.aeskey),
        size: numberOf(image.hd_size) ?? numberOf(image.mid_size),
        data: {},
      };
    }
    case ItemType.VOICE: {
      const voice = item.voice_item ?? {};
      return {
        kind: "record",
        ref: refOf(voice.media),
        mime: VOICE_MIME[voice.encode_type ?? 6],
        data: {
          text: voice.text || undefined,
          duration:
            voice.playtime == null ? undefined : voice.playtime / 1_000,
          encode_type: voice.encode_type,
        },
      };
    }
    case ItemType.FILE: {
      const file = item.file_item ?? {};
      return {
        kind: "file",
        ref: refOf(file.media),
        size: numberOf(file.len),
        name: file.file_name,
        mime: mimeOfName(file.file_name),
        data: { name: file.file_name, md5: file.md5 || undefined },
      };
    }
    case ItemType.VIDEO: {
      const video = item.video_item ?? {};
      return {
        kind: "video",
        ref: refOf(video.media),
        size: numberOf(video.video_size),
        mime: "video/mp4",
        data: {
          duration: video.play_length,
          md5: video.video_md5 || undefined,
        },
      };
    }
    default:
      return undefined;
  }
};

const compact = (data: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );

const buildMediaSegment = async (
  draft: MediaDraft,
  options: InboundOptions,
): Promise<MessageSegment> => {
  const data: Record<string, unknown> = { ...draft.data };
  let mime = draft.mime;
  let size = draft.size;
  const wanted =
    draft.ref !== undefined &&
    options.download.has(draft.kind) &&
    (size === undefined || size <= options.maxBytes);
  if (wanted && draft.ref) {
    try {
      const buffer = await options.media.download(draft.ref);
      if (buffer.length > options.maxBytes)
        throw new Error(`超过 ${Math.round(options.maxBytes / 1048576)}MB 上限`);
      mime = sniffMime(buffer) ?? mime ?? "application/octet-stream";
      size = buffer.length;
      data.url = `data:${mime};base64,${buffer.toString("base64")}`;
      data.md5 ??= md5Hex(buffer);
    } catch (err) {
      options.logger.warn(
        `下载${SUMMARY[draft.kind]}失败: ${errorMessage(err)}`,
      );
    }
  }
  data.size = size;
  if (draft.ref) data.media = draft.ref;
  const attachment: Attachment = compact({
    mime,
    size,
    name: draft.name,
  });
  return segment.raw(draft.kind, compact(data), attachment);
};

export const quoteIdOf = (
  items: readonly IlinkMessageItem[],
): string | undefined => {
  const ref = items.find((item) => item.ref_msg)?.ref_msg;
  return ref?.svr_id?.trim() || ref?.message_item?.msg_id?.trim() || undefined;
};

export const buildInboundMessage = async (
  items: readonly IlinkMessageItem[],
  options: InboundOptions,
): Promise<Message> => {
  const segments: MessageSegment[] = [];
  const summary: string[] = [];
  const quoteId = quoteIdOf(items);
  if (quoteId) segments.push(segment.reply(quoteId));
  for (const item of items) {
    if (item.type === ItemType.TEXT) {
      const text = item.text_item?.text ?? "";
      if (!text) continue;
      segments.push(segment.text(text));
      summary.push(text);
      continue;
    }
    const draft = draftOf(item);
    if (!draft) continue;
    segments.push(await buildMediaSegment(draft, options));
    summary.push(
      draft.kind === "file" && draft.name
        ? `${SUMMARY.file}${draft.name}`
        : SUMMARY[draft.kind],
    );
  }
  return createMessage(segments, summary.join(""));
};

export type OutboundUnit =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image" | "video" | "file";
      readonly segment: MessageSegment;
    };

const SILENT_DROPS = new Set(["reply", "at"]);

export interface OutboundResult {
  readonly units: OutboundUnit[];
  readonly dropped: string[];
}

export const splitText = (text: string, limit = TEXT_LIMIT): string[] => {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    const end = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
};

const nodeContentOf = (seg: MessageSegment): MessageInput =>
  (seg.data.content ?? "") as MessageInput;

export const flattenForward = (
  nodes: readonly Pick<ForwardSendNode, "nickname" | "content">[],
): MessageSegment[] => {
  const labelled = new Set(nodes.map((node) => node.nickname)).size > 1;
  const segments: MessageSegment[] = [];
  nodes.forEach((node, index) => {
    if (index > 0) segments.push(segment.text("\n\n"));
    if (labelled && node.nickname)
      segments.push(segment.text(`${node.nickname}：\n`));
    segments.push(...asMessage(node.content));
  });
  return segments;
};

export const buildOutbound = (input: MessageInput): OutboundResult => {
  const units: OutboundUnit[] = [];
  const dropped = new Set<string>();
  let text = "";
  const flush = (): void => {
    if (!text.trim()) {
      text = "";
      return;
    }
    for (const chunk of splitText(text)) units.push({ kind: "text", text: chunk });
    text = "";
  };
  const visit = (segments: readonly MessageSegment[]): void => {
    const nodes = segments.filter((seg) => seg.type === "node");
    if (nodes.length > 0 && nodes.length === segments.length) {
      visit(
        flattenForward(
          nodes.map((seg) => ({
            nickname: String(seg.data.nickname ?? ""),
            content: nodeContentOf(seg),
          })),
        ),
      );
      return;
    }
    for (const seg of segments) {
      switch (seg.type) {
        case "text":
          text += String(seg.data.text ?? "");
          break;
        case "markdown":
          text += String(seg.data.content ?? "");
          break;
        case "image":
        case "video":
        case "file":
          flush();
          units.push({ kind: seg.type, segment: seg });
          break;
        case "record":
          flush();
          units.push({ kind: "file", segment: seg });
          break;
        case "node":
          visit(asMessage(nodeContentOf(seg)));
          break;
        default:
          if (!SILENT_DROPS.has(seg.type)) dropped.add(seg.type);
      }
    }
  };
  visit(asMessage(input));
  flush();
  return { units, dropped: Array.from(dropped) };
};

export const describeOutbound = (units: readonly OutboundUnit[]): string =>
  units
    .map((unit) => {
      if (unit.kind === "text") return unit.text;
      if (unit.segment.type === "record") return SUMMARY.record;
      return SUMMARY[unit.kind];
    })
    .join("");
