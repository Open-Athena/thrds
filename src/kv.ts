/**
 * `@open-athena/thrds/kv`: Cloudflare KV (or any get/put JSON store) for slot state and hosted avatars.
 *
 * KV is eventually consistent and has no compare-and-swap, so `kvStore` offers no leases: use it where runs are already
 * serialized (one cron, a queue consumer), and `d1Store` where isolates race.
 */
import { base64, unbase64, type AvatarStore } from "./avatar";
import type { SlotState, SlotStore } from "./slots";

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
}

/** How a store reads and writes its records; override to keep an existing record's shape. */
export interface SlotCodec {
  decode(raw: string): SlotState | undefined;
  encode(state: SlotState): string;
}

export const JSON_CODEC: SlotCodec = { decode: (raw) => JSON.parse(raw) as SlotState, encode: (state) => JSON.stringify(state) };

export function kvStore(kv: KVLike, options: { prefix?: string; codec?: SlotCodec } = {}): SlotStore {
  const prefix = options.prefix ?? "thrds:slots:";
  const codec = options.codec ?? JSON_CODEC;
  return {
    async get(key) {
      const s = await kv.get(prefix + key);
      return s === null ? undefined : codec.decode(s);
    },
    async put(key, state, lease) {
      if (lease !== undefined) throw new TypeError("kvStore has no leases (KV can't compare-and-swap); use d1Store");
      await kv.put(prefix + key, codec.encode(state));
      return true;
    },
  };
}

/** A Durable Object's `ctx.storage` (structured values, strongly consistent, single-writer). */
export interface DurableStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

/**
 * Slot state in Durable Object storage. Unlike KV it's strongly consistent, and the object serializes its own
 * requests, so no leases are needed (or offered) as long as every sync for a key runs inside that object.
 */
export function durableObjectStore(storage: DurableStorageLike, options: { prefix?: string } = {}): SlotStore {
  const prefix = options.prefix ?? "slots/";
  return {
    async get(key) {
      return storage.get<SlotState>(prefix + key);
    },
    async put(key, state, lease) {
      if (lease !== undefined) throw new TypeError("durableObjectStore has no leases: the object already runs one request at a time");
      await storage.put(prefix + key, state);
      return true;
    },
  };
}

/** Hosted avatars in KV, one key per sha (`{type, data: base64}`). */
export function kvAvatarStore(kv: KVLike, options: { prefix?: string } = {}): AvatarStore {
  const prefix = options.prefix ?? "thrds:avatar:";
  return {
    async put(sha, img) {
      if ((await kv.get(prefix + sha)) !== null) return;
      await kv.put(prefix + sha, JSON.stringify({ type: img.type, data: base64(img.bytes) }));
    },
    async get(sha) {
      const s = await kv.get(prefix + sha);
      if (s === null) return null;
      const { type, data } = JSON.parse(s) as { type: string; data: string };
      return { type, bytes: unbase64(data) };
    },
  };
}
