import { AvatarStore } from './avatar.js';
import { o as RewriteReceipts } from './rewrite-CcsNOGJR.js';
import { j as SlotStore } from './slots-CrmBIIZI.js';
import './core-BNb_OG-w.js';
import './slack-DsYQB40e.js';

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
/** Bulk-rewrite receipts (`d1Receipts`): every outcome of a real apply, per plan. */
declare const rewriteReceiptsSchema: (table?: string) => string;
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
/** A synchronous SQLite handle: `node:sqlite`'s `DatabaseSync`, or better-sqlite3's `Database`. */
interface SqliteLike {
    prepare(sql: string): {
        all(...params: never[]): unknown[];
        run(...params: never[]): {
            changes: number | bigint;
        };
    };
}
/**
 * A `D1Like` over a local SQLite database, so `d1Store` / `d1AvatarStore` (leases included) run on a Node host or in
 * tests: `d1Store(sqliteD1(new DatabaseSync("bot.db")))`. Create the tables with `SCHEMA` first.
 */
declare function sqliteD1(db: SqliteLike): D1Like;
/**
 * A bulk rewrite's receipts in D1, keyed by `plan` (any id naming the plan: its storage key, or a hash of it): each
 * real outcome is a row, and `done()` is the ts already `done` / `already`, so a re-run (or the next batch's request)
 * skips them.
 */
declare function d1Receipts(db: D1Like, plan: string, options?: {
    table?: string;
    now?: () => number;
}): RewriteReceipts;

export { type D1Like, type D1Statement, SCHEMA, type SqliteLike, avatarsSchema, d1AvatarStore, d1Receipts, d1Store, rewriteReceiptsSchema, slotsSchema, sqliteD1 };
