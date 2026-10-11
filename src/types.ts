export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export const ILINK_BOT_TYPE = "3";

export const ERRCODE_TOKEN_EXPIRED = -14;

export const ERRCODE_RATE_LIMITED = -2;

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const ItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export type UploadMediaTypeValue =
  (typeof UploadMediaType)[keyof typeof UploadMediaType];

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export type IlinkMediaKind = "image" | "record" | "video" | "file";

export const MEDIA_KINDS: readonly IlinkMediaKind[] = [
  "image",
  "record",
  "video",
  "file",
];

export interface IlinkBaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export interface IlinkResult {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface IlinkCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface IlinkTextItem {
  text?: string;
}

export interface IlinkImageItem {
  media?: IlinkCdnMedia;
  thumb_media?: IlinkCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface IlinkVoiceItem {
  media?: IlinkCdnMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface IlinkFileItem {
  media?: IlinkCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface IlinkVideoItem {
  media?: IlinkCdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: IlinkCdnMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface IlinkRefMessage {
  message_item?: IlinkMessageItem;
  title?: string;
  svr_id?: string;
}

export interface IlinkMessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: IlinkRefMessage;
  text_item?: IlinkTextItem;
  image_item?: IlinkImageItem;
  voice_item?: IlinkVoiceItem;
  file_item?: IlinkFileItem;
  video_item?: IlinkVideoItem;
}

export interface IlinkMessage {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  /** 回复该用户时必须原样带回 */
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResp extends IlinkResult {
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp extends IlinkResult {
  message_id?: string;
}

export interface GetUploadUrlReq {
  filekey: string;
  media_type: UploadMediaTypeValue;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
}

export interface GetUploadUrlResp extends IlinkResult {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface GetConfigResp extends IlinkResult {
  typing_ticket?: string;
}

export interface QrcodeResp extends IlinkResult {
  qrcode?: string;
  qrcode_img_content?: string;
}

export type QrcodeStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrcodeStatusResp extends IlinkResult {
  status?: QrcodeStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}
