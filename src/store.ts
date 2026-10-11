import fs from "node:fs";
import path from "node:path";

export interface StoredAccount {
  readonly accountId: string;
  readonly token: string;
  readonly uin: string;
  readonly baseUrl?: string;
  readonly userId?: string;
  readonly savedAt: number;
}

export interface StoredPeer {
  readonly context_token?: string;
  readonly last_seen: number;
}

const ACCOUNT_FILE = "account.json";
const SYNC_FILE = "sync.json";
const PEERS_FILE = "peers.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class AccountStore {
  readonly dir: string;

  constructor(root: string, name: string) {
    this.dir = path.join(root, name);
  }

  #path(file: string): string {
    return path.join(this.dir, file);
  }

  #read(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.#path(file), "utf-8"));
    } catch {
      return undefined;
    }
  }

  #write(file: string, value: unknown, secret = false): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.#path(file);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), {
      encoding: "utf-8",
      mode: secret ? 0o600 : 0o644,
    });
    fs.renameSync(temp, target);
  }

  #remove(file: string): void {
    fs.rmSync(this.#path(file), { force: true });
  }

  loadAccount(): StoredAccount | undefined {
    const raw = this.#read(ACCOUNT_FILE);
    if (!isRecord(raw)) return undefined;
    const accountId = text(raw.accountId);
    const token = text(raw.token);
    const uin = text(raw.uin);
    if (!accountId || !token || !uin) return undefined;
    return {
      accountId,
      token,
      uin,
      baseUrl: text(raw.baseUrl),
      userId: text(raw.userId),
      savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    };
  }

  saveAccount(account: StoredAccount): void {
    const previous = this.loadAccount();
    if (previous && previous.accountId !== account.accountId) {
      this.#remove(SYNC_FILE);
      this.#remove(PEERS_FILE);
    }
    this.#write(ACCOUNT_FILE, account, true);
  }

  loadSyncBuf(): string {
    const raw = this.#read(SYNC_FILE);
    return isRecord(raw) && typeof raw.get_updates_buf === "string"
      ? raw.get_updates_buf
      : "";
  }

  saveSyncBuf(buf: string): void {
    this.#write(SYNC_FILE, { get_updates_buf: buf });
  }

  loadPeers(): Map<string, StoredPeer> {
    const peers = new Map<string, StoredPeer>();
    const raw = this.#read(PEERS_FILE);
    if (!isRecord(raw)) return peers;
    for (const [userId, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      peers.set(userId, {
        context_token: text(value.context_token),
        last_seen: typeof value.last_seen === "number" ? value.last_seen : 0,
      });
    }
    return peers;
  }

  savePeers(peers: ReadonlyMap<string, StoredPeer>): void {
    this.#write(PEERS_FILE, Object.fromEntries(peers), true);
  }
}
