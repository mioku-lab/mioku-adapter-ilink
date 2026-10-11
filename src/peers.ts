import type { Logger } from "mioku";
import type { AccountStore, StoredPeer } from "./store";

const SAVE_DELAY = 1_000;

const MAX_PEERS = 5_000;

export interface IlinkPeer {
  readonly user_id: string;
  readonly context_token?: string;
  readonly last_seen: number;
}

export class PeerBook {
  readonly #store: AccountStore;
  readonly #logger: Logger;
  #peers = new Map<string, StoredPeer>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: AccountStore, logger: Logger) {
    this.#store = store;
    this.#logger = logger;
  }

  get size(): number {
    return this.#peers.size;
  }

  load(): void {
    this.#cancel();
    this.#peers = this.#store.loadPeers();
  }

  touch(userId: string, contextToken?: string): void {
    const previous = this.#peers.get(userId);
    this.#peers.delete(userId);
    this.#peers.set(userId, {
      context_token: contextToken ?? previous?.context_token,
      last_seen: Date.now(),
    });
    if (this.#peers.size > MAX_PEERS) {
      const oldest = this.#peers.keys().next().value;
      if (oldest !== undefined) this.#peers.delete(oldest);
    }
    this.#schedule();
  }

  contextToken(userId: string): string | undefined {
    return this.#peers.get(userId)?.context_token;
  }

  get(userId: string): IlinkPeer | undefined {
    const peer = this.#peers.get(userId);
    return peer ? { user_id: userId, ...peer } : undefined;
  }

  list(): IlinkPeer[] {
    return Array.from(this.#peers, ([user_id, peer]) => ({
      user_id,
      ...peer,
    }));
  }

  flush(): void {
    this.#cancel();
    try {
      this.#store.savePeers(this.#peers);
    } catch (err) {
      this.#logger.warn(
        `保存会话信息失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, SAVE_DELAY);
    this.#timer.unref?.();
  }

  #cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
