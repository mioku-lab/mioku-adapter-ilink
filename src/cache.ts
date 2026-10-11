import type { IlinkMessageItem } from "./types";

export interface CachedMessage {
  readonly message_id: string;
  readonly peer_id: string;
  readonly sender_id?: string;
  readonly time: number;
  readonly items: readonly IlinkMessageItem[];
  readonly self: boolean;
}

export class MessageCache {
  readonly #limit: number;
  readonly #entries = new Map<string, CachedMessage>();

  constructor(limit = 1_000) {
    this.#limit = limit;
  }

  put(entry: CachedMessage): void {
    this.#entries.delete(entry.message_id);
    this.#entries.set(entry.message_id, entry);
    if (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  get(messageId: string): CachedMessage | undefined {
    return this.#entries.get(messageId);
  }

  history(peerId: string, before?: string, limit = 20): CachedMessage[] {
    if (before != null && !this.#entries.has(before)) return [];
    const result: CachedMessage[] = [];
    let skipping = before != null;
    const entries = Array.from(this.#entries.values());
    for (let i = entries.length - 1; i >= 0 && result.length < limit; i--) {
      const entry = entries[i]!;
      if (skipping) {
        if (entry.message_id === before) skipping = false;
        continue;
      }
      if (entry.peer_id === peerId) result.push(entry);
    }
    return result.reverse();
  }

  clear(): void {
    this.#entries.clear();
  }
}
