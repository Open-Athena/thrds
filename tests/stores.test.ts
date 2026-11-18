import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA, d1AvatarStore, d1Store, type D1Like, type D1Statement } from "../src/d1";
import { kvAvatarStore, kvStore, type KVLike } from "../src/kv";
import { syncSlots } from "../src/slots";
import { fakeChannel } from "./helpers";

// Vite doesn't know `node:sqlite` as a builtin (it strips the prefix), so load it through Node's own require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncT };

/** An in-memory D1 over `node:sqlite`: the `prepare(sql).bind(...).first/run` surface the adapters use. */
function sqliteD1(schema = SCHEMA): { db: D1Like; raw: DatabaseSyncT } {
  const raw = new DatabaseSync(":memory:");
  if (schema) raw.exec(schema);
  const stmt = (sql: string, params: unknown[] = []): D1Statement => ({
    bind: (...args) => stmt(sql, args),
    async first<T>(col?: string) {
      const row = raw.prepare(sql).all(...(params as never[]))[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return (col ? row[col] : { ...row }) as T;
    },
    async run() {
      return { meta: { changes: Number(raw.prepare(sql).run(...(params as never[])).changes) } };
    },
  });
  return { db: { prepare: (sql) => stmt(sql) }, raw };
}

describe("d1Store", () => {
  it("round-trips state, one row per key", async () => {
    const { db, raw } = sqliteD1();
    const store = d1Store(db, { now: () => 7 });
    await store.put("a", { slots: { x: { ts: "1.0", hash: "h" } } });
    await store.put("a", { parent: { ts: "0.5", hash: "p" }, slots: {} });
    expect([await store.get("a"), await store.get("b"), raw.prepare("SELECT key, lease, updated_at FROM thrds_slots").all()]).toEqual([
      { parent: { ts: "0.5", hash: "p" }, slots: {} },
      undefined,
      [{ key: "a", lease: null, updated_at: 7 }],
    ]);
  });

  it("claim is compare-and-swap: one holder until release or expiry; a stale lease can't write", async () => {
    const { db } = sqliteD1();
    const store = d1Store(db);
    const a = await store.claim("k", 60, 1000);
    const b = await store.claim("k", 60, 1030);
    const aWrites = await store.put("k", { slots: {} }, a!);
    const c = await store.claim("k", 60, 1060);
    const aAfter = await store.put("k", { slots: {} }, a!);
    await store.release("k", c!);
    const d = await store.claim("k", 60, 1061);
    expect([typeof a, b, aWrites, typeof c, aAfter, typeof d, a === c]).toEqual(["string", null, true, "string", false, "string", false]);
  });

  it("drives syncSlots with a lease, end to end", async () => {
    const { db, raw } = sqliteD1();
    const { client } = fakeChannel();
    const r = await syncSlots(client, d1Store(db), { key: "week:2026-11-13", parent: "3 emoji added", slots: [{ slot: "2026-11-13", msg: ":a: :b: :c:" }] }, { leaseS: 30 });
    expect([r.actions.map((a) => a.type), raw.prepare("SELECT key, lease FROM thrds_slots").all(), JSON.parse((raw.prepare("SELECT state FROM thrds_slots").get() as { state: string }).state).slots]).toEqual([
      ["POST", "POST"],
      [{ key: "week:2026-11-13", lease: null }],
      { "2026-11-13": { ts: "102.000000", hash: expect.stringMatching(/^[0-9a-f]{14}$/) } },
    ]);
  });

  it("refuses an unsafe table name", () => {
    expect(() => d1Store(sqliteD1().db, { table: "x; DROP TABLE y" })).toThrow('d1: bad table name "x; DROP TABLE y"');
  });
});

describe("d1AvatarStore", () => {
  it("stores once by sha (disky's public_avatars schema), and reads a missing table as empty", async () => {
    const { db, raw } = sqliteD1();
    const store = d1AvatarStore(db);
    await store.put("ab", { type: "image/png", bytes: new Uint8Array([1, 2, 3]) }, 5);
    await store.put("ab", { type: "image/png", bytes: new Uint8Array([9]) }, 6);
    const noTable = d1AvatarStore(sqliteD1("").db);
    expect([await store.get("ab"), await store.get("cd"), raw.prepare("SELECT * FROM public_avatars").all(), await noTable.get("ab")]).toEqual([
      { type: "image/png", bytes: new Uint8Array([1, 2, 3]) },
      null,
      [{ sha256: "ab", type: "image/png", data: "AQID", created_at: 5 }],
      null,
    ]);
  });
});

describe("kv", () => {
  const fakeKv = (): KVLike & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
  };

  it("kvStore keeps state under a prefix and has no leases", async () => {
    const kv = fakeKv();
    const store = kvStore(kv);
    await store.put("a", { slots: {} });
    expect([await store.get("a"), [...kv.data.keys()], store.claim]).toEqual([{ slots: {} }, ["thrds:slots:a"], undefined]);
    await expect(store.put("a", { slots: {} }, "lease")).rejects.toThrow("kvStore has no leases");
  });

  it("kvAvatarStore stores once by sha", async () => {
    const kv = fakeKv();
    const store = kvAvatarStore(kv);
    await store.put("ab", { type: "image/png", bytes: new Uint8Array([1, 2, 3]) }, 0);
    await store.put("ab", { type: "image/png", bytes: new Uint8Array([9]) }, 0);
    expect([await store.get("ab"), await store.get("cd"), [...kv.data]]).toEqual([
      { type: "image/png", bytes: new Uint8Array([1, 2, 3]) },
      null,
      [["thrds:avatar:ab", '{"type":"image/png","data":"AQID"}']],
    ]);
  });
});
