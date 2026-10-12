import type { AdapterStatus } from "mioku";
import type { IlinkBot } from "./bot";
import type { PeerBook } from "./peers";

export interface IlinkTraffic {
  sent: number;
  received: number;
  blocked: number;
}

export const createIlinkStatusProvider =
  (bot: IlinkBot, traffic: IlinkTraffic, peers: PeerBook) =>
  (): AdapterStatus => ({
    adapter: bot.adapter,
    bot_id: bot.bot_id,
    impl: "iLink",
    protocol: "ilink",
    platform: "WeChat",
    stats: {
      friends: peers.size,
      groups: 0,
      sent: traffic.sent,
      received: traffic.received,
    },
    data: {
      owner_id: bot.owner_id,
      base_url: bot.client.baseUrl,
      blocked: traffic.blocked,
    },
  });
