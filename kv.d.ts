import { AvatarStore } from './avatar.js';
import { i as SlotState, j as SlotStore } from './slots-BakJ4fdg.js';
import './core-BNb_OG-w.js';
import './slack-CBVpZ3hd.js';

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
/** How a store reads and writes its records; override to keep an existing record's shape. */
interface SlotCodec {
    decode(raw: string): SlotState | undefined;
    encode(state: SlotState): string;
}
declare const JSON_CODEC: SlotCodec;
declare function kvStore(kv: KVLike, options?: {
    prefix?: string;
    codec?: SlotCodec;
}): SlotStore;
/** A Durable Object's `ctx.storage` (structured values, strongly consistent, single-writer). */
interface DurableStorageLike {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
}
/**
 * Slot state in Durable Object storage. Unlike KV it's strongly consistent, and the object serializes its own
 * requests, so no leases are needed (or offered) as long as every sync for a key runs inside that object.
 */
declare function durableObjectStore(storage: DurableStorageLike, options?: {
    prefix?: string;
}): SlotStore;
/** Hosted avatars in KV, one key per sha (`{type, data: base64}`). */
declare function kvAvatarStore(kv: KVLike, options?: {
    prefix?: string;
}): AvatarStore;

export { type DurableStorageLike, JSON_CODEC, type KVLike, type SlotCodec, durableObjectStore, kvAvatarStore, kvStore };
