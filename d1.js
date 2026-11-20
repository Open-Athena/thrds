import {
  base64,
  unbase64
} from "./chunk-VQVZ7N35.js";
import "./chunk-3ZH5IQC7.js";

// src/d1.ts
var IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
var ident = (name) => {
  if (!IDENT.test(name)) throw new TypeError(`d1: bad table name ${JSON.stringify(name)}`);
  return name;
};
var slotsSchema = (table = "thrds_slots") => `CREATE TABLE IF NOT EXISTS ${ident(table)} (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lease TEXT,
  lease_until INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);`;
var avatarsSchema = (table = "public_avatars") => `CREATE TABLE IF NOT EXISTS ${ident(table)} (
  sha256 TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`;
var SCHEMA = `${slotsSchema()}
${avatarsSchema()}
`;
var EMPTY = { slots: {} };
var nowS = () => Math.floor(Date.now() / 1e3);
function d1Store(db, options = {}) {
  const t = ident(options.table ?? "thrds_slots");
  const now = options.now ?? nowS;
  return {
    async get(key) {
      const row = await db.prepare(`SELECT state FROM ${t} WHERE key = ?`).bind(key).first();
      return row ? JSON.parse(row.state) : void 0;
    },
    async put(key, state, lease) {
      const json = JSON.stringify(state);
      if (lease !== void 0) {
        const r = await db.prepare(`UPDATE ${t} SET state = ?, updated_at = ? WHERE key = ? AND lease = ?`).bind(json, now(), key, lease).run();
        return (r.meta.changes ?? 0) === 1;
      }
      await db.prepare(`INSERT INTO ${t} (key, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).bind(key, json, now()).run();
      return true;
    },
    async claim(key, leaseS, at) {
      const token = globalThis.crypto.randomUUID();
      await db.prepare(`INSERT OR IGNORE INTO ${t} (key, state, updated_at) VALUES (?, ?, ?)`).bind(key, JSON.stringify(EMPTY), at).run();
      const r = await db.prepare(`UPDATE ${t} SET lease = ?, lease_until = ? WHERE key = ? AND (lease IS NULL OR lease_until <= ?)`).bind(token, at + leaseS, key, at).run();
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
    }
  };
}
function d1AvatarStore(db, options = {}) {
  const t = ident(options.table ?? "public_avatars");
  return {
    async put(sha, img, at) {
      await db.prepare(`INSERT OR IGNORE INTO ${t} (sha256, type, data, created_at) VALUES (?, ?, ?, ?)`).bind(sha, img.type, base64(img.bytes), at).run();
    },
    async get(sha) {
      let row;
      try {
        row = await db.prepare(`SELECT type, data FROM ${t} WHERE sha256 = ?`).bind(sha).first();
      } catch (e) {
        if (/no such table/.test(String(e?.message))) return null;
        throw e;
      }
      return row ? { type: row.type, bytes: unbase64(row.data) } : null;
    }
  };
}
function sqliteD1(db) {
  const stmt = (sql, params = []) => ({
    bind: (...args) => stmt(sql, args),
    async first(column) {
      const row = db.prepare(sql).all(...params)[0];
      if (!row) return null;
      return column ? row[column] : { ...row };
    },
    async run() {
      return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
    }
  });
  return { prepare: (sql) => stmt(sql) };
}
export {
  SCHEMA,
  avatarsSchema,
  d1AvatarStore,
  d1Store,
  slotsSchema,
  sqliteD1
};
//# sourceMappingURL=d1.js.map