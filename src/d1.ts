/**
 * `@open-athena/thrds/d1`: Cloudflare D1 storage for slot state (with compare-and-swap leases) and hosted avatars.
 * Typed structurally (`D1Like`), so neither `@cloudflare/workers-types` nor this module is needed by non-D1 consumers.
 *
 * Create the tables with `SCHEMA` (or `slotsSchema(table)` / `avatarsSchema(table)`) in a migration.
 */
import { unbase64, base64, type AvatarStore } from "./avatar";
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

export const SCHEMA = `${slotsSchema()}\n${avatarsSchema()}\n`;

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
    async release(key, lease) {
      await db.prepare(`UPDATE ${t} SET lease = NULL, lease_until = NULL WHERE key = ? AND lease = ?`).bind(key, lease).run();
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
