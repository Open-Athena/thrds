import { AvatarStore } from './avatar.js';
import { v as SlotStore } from './slots-BtvdSGce.js';
import './core-C7X-hhBF.js';

/**
 * `@open-athena/thrds/d1`: Cloudflare D1 storage for slot state (with compare-and-swap leases) and hosted avatars.
 * Typed structurally (`D1Like`), so neither `@cloudflare/workers-types` nor this module is needed by non-D1 consumers.
 *
 * Create the tables with `SCHEMA` (or `slotsSchema(table)` / `avatarsSchema(table)`) in a migration.
 */

interface D1Statement {
    bind(...values: unknown[]): D1Statement;
    first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
    run(): Promise<{
        meta: {
            changes?: number;
        };
    }>;
}
interface D1Like {
    prepare(sql: string): D1Statement;
}
declare const slotsSchema: (table?: string) => string;
/** disky's `public_avatars` table, unchanged, so an existing table keeps working. */
declare const avatarsSchema: (table?: string) => string;
declare const SCHEMA: string;
/**
 * Slot state in D1, one row per thread key. `claim` is a compare-and-swap on the row's lease (free, or expired), and a
 * leased `put` only lands while the lease is still this run's, so concurrent isolates can't both post.
 */
declare function d1Store(db: D1Like, options?: {
    table?: string;
    now?: () => number;
}): Required<SlotStore>;
/** Hosted avatars in D1 (base64 in a TEXT column, as disky stores them). A missing table reads as empty. */
declare function d1AvatarStore(db: D1Like, options?: {
    table?: string;
}): AvatarStore;

export { type D1Like, type D1Statement, SCHEMA, avatarsSchema, d1AvatarStore, d1Store, slotsSchema };
