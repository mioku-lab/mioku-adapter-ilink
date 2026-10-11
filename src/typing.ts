import type { IlinkClient } from "./client";
import type { PeerBook } from "./peers";

const TICKET_TTL = 12 * 60 * 60_000;

const RETRY_AFTER = 60_000;

const MAX_ENTRIES = 1_000;

export class TypingTickets {
  readonly #client: IlinkClient;
  readonly #peers: PeerBook;
  readonly #cache = new Map<string, { ticket: string; expires: number }>();

  constructor(client: IlinkClient, peers: PeerBook) {
    this.#client = client;
    this.#peers = peers;
  }

  async get(userId: string): Promise<string | undefined> {
    const now = Date.now();
    const hit = this.#cache.get(userId);
    if (hit && hit.expires > now) return hit.ticket || undefined;
    try {
      const resp = await this.#client.getConfig(
        userId,
        this.#peers.contextToken(userId),
      );
      const ticket = resp.typing_ticket ?? "";
      this.#remember(userId, ticket, now + (ticket ? TICKET_TTL : RETRY_AFTER));
      return ticket || undefined;
    } catch (err) {
      this.#remember(userId, "", now + RETRY_AFTER);
      throw err;
    }
  }

  #remember(userId: string, ticket: string, expires: number): void {
    this.#cache.delete(userId);
    this.#cache.set(userId, { ticket, expires });
    if (this.#cache.size > MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }

  clear(): void {
    this.#cache.clear();
  }
}
