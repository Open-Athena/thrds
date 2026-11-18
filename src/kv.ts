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

export function kvStore(kv: KVLike, options: { prefix?: string } = {}): SlotStore {
  const prefix = options.prefix ?? "thrds:slots:";
  return {
    async get(key) {
      const s = await kv.get(prefix + key);
      return s === null ? undefined : (JSON.parse(s) as SlotState);
    },
    async put(key, state, lease) {
      if (lease !== undefined) throw new TypeError("kvStore has no leases (KV can't compare-and-swap); use d1Store");
      await kv.put(prefix + key, JSON.stringify(state));
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
