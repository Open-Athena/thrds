import { AvatarStore } from './avatar.js';
import { v as SlotStore } from './slots-BtvdSGce.js';
import './core-C7X-hhBF.js';

/**
 * `@open-athena/thrds/kv`: Cloudflare KV (or any get/put JSON store) for slot state and hosted avatars.
 *
 * KV is eventually consistent and has no compare-and-swap, so `kvStore` offers no leases: use it where runs are already
 * serialized (one cron, a queue consumer), and `d1Store` where isolates race.
 */

interface KVLike {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: {
        metadata?: unknown;
        expirationTtl?: number;
    }): Promise<void>;
}
declare function kvStore(kv: KVLike, options?: {
    prefix?: string;
}): SlotStore;
/** Hosted avatars in KV, one key per sha (`{type, data: base64}`). */
declare function kvAvatarStore(kv: KVLike, options?: {
    prefix?: string;
}): AvatarStore;

export { type KVLike, kvAvatarStore, kvStore };
