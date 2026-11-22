/**
 * `@open-athena/thrds/d1`: Cloudflare D1 storage for slot state (with compare-and-swap leases) and hosted avatars.
 * Typed structurally (`D1Like`), so neither `@cloudflare/workers-types` nor this module is needed by non-D1 consumers.
 *
 * Create the tables with `SCHEMA` (or `slotsSchema(table)` / `avatarsSchema(table)`) in a migration.
 */
import { unbase64, base64, type AvatarStore } from "./avatar";
import type { RewriteOutcome, RewriteReceipts } from "./rewrite";
import type { SlotState, SlotStore } from "./slots";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name: string): string => {
  if (!IDENT.test(name)) throw new TypeError(`d1: bad table name ${JSON.stringify(name)}`);
  return name;
};

export const slotsSchema = (table = "thrds_slots"): string =>
  `CREATE TABLE IF NOT EXISTS ${ident(table)} (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lease TEXT,
  lease_until INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);`;

/** disky's `public_avatars` table, unchanged, so an existing table keeps working. */
export const avatarsSchema = (table = "public_avatars"): string =>
  `CREATE TABLE IF NOT EXISTS ${ident(table)} (
  sha256 TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`;

/** Bulk-rewrite receipts (`d1Receipts`): every outcome of a real apply, per plan. */
export const rewriteReceiptsSchema = (table = "thrds_rewrite_receipts"): string =>
  `CREATE TABLE IF NOT EXISTS ${ident(table)} (
  plan TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  new_ts TEXT,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ident(table)}_plan ON ${ident(table)} (plan, status);`;

export const SCHEMA = `${slotsSchema()}\n${avatarsSchema()}\n${rewriteReceiptsSchema()}\n`;

const EMPTY: SlotState = { slots: {} };
const nowS = (): number => Math.floor(Date.now() / 1000);

/**
 * Slot state in D1, one row per thread key. `claim` is a compare-and-swap on the row's lease (free, or expired), and a
 * leased `put` only lands while the lease is still this run's, so concurrent isolates can't both post.
 */
export function d1Store(db: D1Like, options: { table?: string; now?: () => number } = {}): Required<SlotStore> {
  const t = ident(options.table ?? "thrds_slots");
  const now = options.now ?? nowS;
  return {
    async get(key) {
      const row = await db.prepare(`SELECT state FROM ${t} WHERE key = ?`).bind(key).first<{ state: string }>();
      return row ? (JSON.parse(row.state) as SlotState) : undefined;
    },
    async put(key, state, lease) {
      const json = JSON.stringify(state);
      if (lease !== undefined) {
        const r = await db.prepare(`UPDATE ${t} SET state = ?, updated_at = ? WHERE key = ? AND lease = ?`).bind(json, now(), key, lease).run();
        return (r.meta.changes ?? 0) === 1;
      }
      await db
        .prepare(`INSERT INTO ${t} (key, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
        .bind(key, json, now())
        .run();
      return true;
    },
    async claim(key, leaseS, at) {
      const token = globalThis.crypto.randomUUID();
      await db.prepare(`INSERT OR IGNORE INTO ${t} (key, state, updated_at) VALUES (?, ?, ?)`).bind(key, JSON.stringify(EMPTY), at).run();
      const r = await db
        .prepare(`UPDATE ${t} SET lease = ?, lease_until = ? WHERE key = ? AND (lease IS NULL OR lease_until <= ?)`)
        .bind(token, at + leaseS, key, at)
        .run();
      return (r.meta.changes ?? 0) === 1 ? token : null;
    },
    async renew(key, lease, leaseS, at) {
      const r = await db.prepare(`UPDATE ${t} SET lease_until = ? WHERE key = ? AND lease = ?`).bind(at + leaseS, key, lease).run();
      return (r.meta.changes ?? 0) === 1;
    },
    async release(key, lease) {
      await db.prepare(`UPDATE ${t} SET lease = NULL, lease_until = NULL WHERE key = ? AND lease = ?`).bind(key, lease).run();
    },
    async markDirty(key) {
      await db.prepare(`UPDATE ${t} SET dirty = 1 WHERE key = ?`).bind(key).run();
    },
    async takeDirty(key, lease) {
      const r = await db.prepare(`UPDATE ${t} SET dirty = 0 WHERE key = ? AND lease = ? AND dirty = 1`).bind(key, lease).run();
      return (r.meta.changes ?? 0) === 1;
    },
  };
}

/** Hosted avatars in D1 (base64 in a TEXT column, as disky stores them). A missing table reads as empty. */
export function d1AvatarStore(db: D1Like, options: { table?: string } = {}): AvatarStore {
  const t = ident(options.table ?? "public_avatars");
  return {
    async put(sha, img, at) {
      await db.prepare(`INSERT OR IGNORE INTO ${t} (sha256, type, data, created_at) VALUES (?, ?, ?, ?)`).bind(sha, img.type, base64(img.bytes), at).run();
    },
    async get(sha) {
      let row: { type: string; data: string } | null;
      try {
        row = await db.prepare(`SELECT type, data FROM ${t} WHERE sha256 = ?`).bind(sha).first<{ type: string; data: string }>();
      } catch (e) {
        if (/no such table/.test(String((e as Error)?.message))) return null;
        throw e;
      }
      return row ? { type: row.type, bytes: unbase64(row.data) } : null;
    },
  };
}

/** A synchronous SQLite handle: `node:sqlite`'s `DatabaseSync`, or better-sqlite3's `Database`. */
export interface SqliteLike {
  prepare(sql: string): {
    all(...params: never[]): unknown[];
    run(...params: never[]): { changes: number | bigint };
  };
}

/**
 * A `D1Like` over a local SQLite database, so `d1Store` / `d1AvatarStore` (leases included) run on a Node host or in
 * tests: `d1Store(sqliteD1(new DatabaseSync("bot.db")))`. Create the tables with `SCHEMA` first.
 */
export function sqliteD1(db: SqliteLike): D1Like {
  const stmt = (sql: string, params: unknown[] = []): D1Statement => ({
    bind: (...args) => stmt(sql, args),
    async first<T>(column?: string) {
      const row = db.prepare(sql).all(...(params as never[]))[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? row[column] : { ...row }) as T;
    },
    async run() {
      return { meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } };
    },
  });
  return { prepare: (sql) => stmt(sql) };
}

/**
 * A bulk rewrite's receipts in D1, keyed by `plan` (any id naming the plan: its storage key, or a hash of it): each
 * real outcome is a row, and `done()` is the ts already `done` / `already`, so a re-run (or the next batch's request)
 * skips them.
 */
export function d1Receipts(db: D1Like, plan: string, options: { table?: string; now?: () => number } = {}): RewriteReceipts {
  const t = ident(options.table ?? "thrds_rewrite_receipts");
  const now = options.now ?? nowS;
  return {
    async done() {
      const row = await db
        .prepare(`SELECT group_concat(ts, ' ') AS tss FROM ${t} WHERE plan = ? AND status IN ('done', 'already')`)
        .bind(plan)
        .first<{ tss: string | null }>();
      return new Set(row?.tss ? row.tss.split(" ") : []);
    },
    async record(o: RewriteOutcome) {
      await db
        .prepare(`INSERT INTO ${t} (plan, ts, kind, status, new_ts, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(plan, o.ts, o.kind, o.status, o.new_ts ?? null, o.error ?? null, now())
        .run();
    },
  };
}
