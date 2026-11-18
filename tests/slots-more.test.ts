import { describe, expect, it } from "vitest";
import { msgHash } from "../src/core";
import { image, section } from "../src/mrkdwn";
import { importAnchor, memoryStore, partialOf, syncSlots, tagSlot, upsert, type SlotStore } from "../src/slots";
import { fakeChannel, timeoutError } from "./helpers";

const kinds = (r: { actions: Array<{ type: string; slot: string | null }> }) => r.actions.map((a) => [a.type, a.slot]);
const burst = (details: string) => ({ key: "b", parent: "head", slots: [{ slot: "details", msg: details }] });

describe("failed posts", () => {
  it("a post Slack refused clears `pending` (nothing landed), so the next run posts without scanning", async () => {
    let refuse = true;
    const { client, calls } = fakeChannel({
      intercept: ({ method }) => (method === "chat.postMessage" && refuse ? { body: { ok: false, error: "not_in_channel" } } : undefined),
    });
    const store = memoryStore();
    const e = await syncSlots(client, store, burst("/a")).catch((x) => x);
    refuse = false;
    const before = calls.length;
    const r = await syncSlots(client, store, burst("/a"));
    expect([e.code, (await store.get("b"))!.pending, kinds(r), calls.slice(before).map((c) => c.method)]).toEqual([
      "not_in_channel",
      undefined,
      [["POST", null], ["POST", "details"]],
      ["chat.postMessage", "chat.postMessage"],
    ]);
  });

  it("a post that timed out keeps `pending`: it may have landed, and the next run adopts it", async () => {
    let timeOutOnce = true;
    const { client, writes } = fakeChannel({
      intercept: ({ method, body }, messages) => {
        if (method !== "chat.postMessage" || !timeOutOnce) return undefined;
        timeOutOnce = false;
        // It lands on Slack's side (stamped "now"), but the reply never arrives.
        messages.push({ ts: "1000000.000000", text: body["text"] as string, bot_id: "B_BOT", metadata: body["metadata"] as never });
        throw timeoutError();
      },
    });
    const store = memoryStore();
    const now = () => 1_000_000_000;
    const e = await syncSlots(client, store, { key: "b", parent: "head" }, { now }).catch((x) => x);
    const pending = (await store.get("b"))!.pending;
    const r = await syncSlots(client, store, { key: "b", parent: "head" }, { now });
    expect([e.code, pending, kinds(r), r.ts, writes]).toEqual([
      "timeout",
      { slot: null, hash: msgHash(tagSlot("head", "b", null)), at: 1_000_000 },
      [["ADOPT", null], ["SKIP", null]],
      "1000000.000000",
      [],
    ]);
  });

  it("a pending post whose scan can't run: `scan` explains the missing scope, `scan-or-post` posts, `post` skips the scan", async () => {
    const seeded = () => memoryStore({ b: { channel: "C1", slots: {}, pending: { slot: null, hash: "x", at: 100 } } });
    const noHistory = () =>
      fakeChannel({ intercept: ({ method }) => (method === "conversations.history" ? { body: { ok: false, error: "missing_scope" } } : undefined) });
    const scan = await syncSlots(noHistory().client, seeded(), { key: "b", parent: "head" }).catch((x) => x.message);
    const lenient = await syncSlots(noHistory().client, seeded(), { key: "b", parent: "head" }, { recover: "scan-or-post" });
    const blind = noHistory();
    const posted = await syncSlots(blind.client, seeded(), { key: "b", parent: "head" }, { recover: "post" });
    expect([scan, kinds(lenient), kinds(posted), blind.calls.map((c) => c.method)]).toEqual([
      'syncSlots: can\'t check whether b\'s interrupted post landed (missing_scope); grant a history scope (channels:history / groups:history), or pass recover: "scan-or-post"',
      [["UNRESOLVED", null], ["POST", null]],
      [["POST", null]],
      ["chat.postMessage"],
    ]);
  });

  it("a rejected message falls back (an image Slack can't fetch yet), then upgrades once Slack accepts it", async () => {
    let imageOk = false;
    const { client, messages } = fakeChannel({
      intercept: ({ method, body }) =>
        (method === "chat.postMessage" || method === "chat.update") && !imageOk && JSON.stringify(body["blocks"] ?? []).includes('"image"')
          ? { body: { ok: false, error: "invalid_blocks" } }
          : undefined,
    });
    const store = memoryStore();
    const card = { text: "Plan 7", blocks: [section("*Plan 7*"), image("https://x/plan7.png", "plot")] };
    const bare = { text: "Plan 7", blocks: [section("*Plan 7*")] };
    const spec = { key: "plan:7", parent: card, parentFallback: bare };
    const first = await syncSlots(client, store, spec);
    const stillCold = await syncSlots(client, store, spec);
    imageOk = true;
    const warm = await syncSlots(client, store, spec);
    const again = await syncSlots(client, store, spec);
    expect([kinds(first), kinds(stillCold), kinds(warm), kinds(again), messages.map((m) => (m.blocks ?? []).length)]).toEqual([
      [["FALLBACK", null]],
      [["FALLBACK", null]],
      [["EDIT", null]],
      [["SKIP", null]],
      [2],
    ]);
  });
});

describe("parent modes", () => {
  it("`keep`: posted once, never edited (watchy's OP, whose content needs the replies' ts first)", async () => {
    const { client, writes } = fakeChannel();
    const store = memoryStore();
    const a = await syncSlots(client, store, { key: "w", parent: { keep: "Week of Nov 13" }, slots: [{ slot: "ev:1", msg: "push" }] });
    const b = await syncSlots(client, store, { key: "w", parent: { keep: "Week of Nov 13 (3 events)" } });
    expect([kinds(a), kinds(b), writes]).toEqual([
      [["POST", null], ["POST", "ev:1"]],
      [["SKIP", null]],
      [["post", "Week of Nov 13"], ["post", "push"]],
    ]);
  });

  it("`{ ts, msg }` / `upsert({ ts })`: edits an existing message, never posts one; gone → throws", async () => {
    const pinned = { ts: "40.000000", text: "old board", bot_id: "B_BOT" };
    const { client, messages, writes } = fakeChannel({ messages: [pinned] });
    const store = memoryStore();
    const a = await upsert(client, store, "board", "board v1", { ts: "40.000000" });
    const b = await upsert(client, store, "board", "board v1", { ts: "40.000000" });
    messages.splice(0);
    const gone = await upsert(client, store, "board", "board v2", { ts: "40.000000" }).catch((e) => e.code);
    expect([a, b, gone, writes]).toEqual([
      { status: "synced", ts: "40.000000", action: "EDIT" },
      { status: "synced", ts: "40.000000", action: "SKIP" },
      "message_not_found",
      [["edit", "board v1"]],
    ]);
  });

  it("`create: false` never posts a missing parent (fleet: nowhere to keep the ts → don't post hourly)", async () => {
    const { client, calls } = fakeChannel();
    expect([await upsert(client, memoryStore(), "fleet", "3 up", { create: false }), calls.length]).toEqual([{ status: "missing", ts: "", action: null }, 0]);
  });
});

describe("gone, force, channels", () => {
  it("onGone `forget` drops a deleted reply (GONE) and carries on; for the parent, the thread is `gone`", async () => {
    const { client, messages } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, { key: "b", parent: "head", slots: [{ slot: "a", msg: "1" }, { slot: "b", msg: "2" }] });
    messages.splice(1, 1); // reply "a" deleted by hand
    const r = await syncSlots(client, store, { key: "b", parent: "head", slots: [{ slot: "a", msg: "1!" }, { slot: "b", msg: "2!" }] }, { onGone: "forget" });
    messages.splice(0); // now the whole thread
    const t = await syncSlots(client, store, { key: "b", parent: "head!", slots: [] }, { onGone: "forget" });
    expect([kinds(r), r.slots, kinds(t), t.status, await store.get("b")]).toEqual([
      [["SKIP", null], ["GONE", "a"], ["EDIT", "b"]],
      { b: "103.000000" },
      [["GONE", null]],
      "gone",
      { slots: {} },
    ]);
  });

  it("onGone `throw` refuses to re-post", async () => {
    const { client, messages } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, { key: "b", parent: "head" });
    messages.splice(0);
    await expect(syncSlots(client, store, { key: "b", parent: "head!" }, { onGone: "throw" })).rejects.toMatchObject({ code: "message_not_found" });
  });

  it("`force` edits even when the stored hash matches (repair a hand-edited message)", async () => {
    const { client, writes } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, burst("/a"));
    const r = await syncSlots(client, store, burst("/a"), { force: true });
    expect([kinds(r), writes.slice(2)]).toEqual([[["EDIT", null], ["EDIT", "details"]], [["edit", "head"], ["edit", "/a"]]]);
  });

  it("a thread recorded in another channel starts fresh in this one, leaving the old one alone", async () => {
    const { client, messages } = fakeChannel();
    const store = memoryStore({ b: { channel: "C_OLD", parent: { ts: "9.000000", hash: "h" }, slots: { details: { ts: "9.000001", hash: "h" } } } });
    const r = await syncSlots(client, store, burst("/a"));
    expect([kinds(r), (await store.get("b"))!.channel, messages.length]).toEqual([[["POST", null], ["POST", "details"]], "C1", 2]);
  });

  it("importAnchor seeds messages posted before thrds (hash unknown: each edited once, then skipped)", async () => {
    const { client } = fakeChannel({ messages: [{ ts: "7.000000", text: "old", bot_id: "B_BOT" }, { ts: "7.000001", text: "old", thread_ts: "7.000000", bot_id: "B_BOT" }] });
    const store = memoryStore();
    await importAnchor(store, "b", { channel: "C1", parent: "7.000000", slots: { details: "7.000001" } });
    const once = await syncSlots(client, store, burst("/a"));
    const then = await syncSlots(client, store, burst("/a"));
    expect([kinds(once), kinds(then)]).toEqual([[["EDIT", null], ["EDIT", "details"]], [["SKIP", null], ["SKIP", "details"]]]);
  });
});

describe("leases, re-runs, partial results", () => {
  it("a run that loses the claim marks the key dirty, and the holder re-renders so the newer content lands", async () => {
    const { client, writes } = fakeChannel();
    const store = memoryStore();
    let version = 1;
    let renders = 0;
    const r = await syncSlots(
      client,
      store,
      {
        key: "b",
        render: async () => {
          renders++;
          if (renders === 1) {
            // Another isolate gets newer data and tries to sync while we hold the lease.
            version = 2;
            const busy = await syncSlots(client, store, { key: "b", parent: "head v2" }, { leaseS: 60 });
            expect(busy.status).toBe("busy");
          }
          return { parent: `head v${version === 2 && renders === 1 ? 1 : version}` };
        },
      },
      { leaseS: 60 },
    );
    expect([renders, kinds(r), writes]).toEqual([2, [["POST", null], ["EDIT", null]], [["post", "head v1"], ["edit", "head v2"]]]);
  });

  it("renews the lease before every Slack write", async () => {
    const base = memoryStore();
    const renewals: number[] = [];
    const store: SlotStore = { ...base, renew: async (k, l, s, at) => (renewals.push(at), base.renew(k, l, s, at)) };
    let t = 1000_000;
    const { client } = fakeChannel();
    await syncSlots(client, store, { key: "b", parent: "head", slots: [{ slot: "a", msg: "1" }, { slot: "b", msg: "2" }] }, { leaseS: 30, now: () => (t += 1000) });
    expect(renewals.length).toBe(3);
  });

  it("saves edited hashes once per run, not once per edit (posts still write ahead)", async () => {
    const { client } = fakeChannel();
    const base = memoryStore();
    let puts = 0;
    const store: SlotStore = { ...base, put: (k, s, l) => (puts++, base.put(k, s, l)) };
    const three = (v: string) => ({ key: "b", parent: "head", slots: ["a", "b", "c"].map((slot) => ({ slot, msg: `${slot}${v}` })) });
    await syncSlots(client, store, three("1"));
    const afterPosts = puts;
    await syncSlots(client, store, three("2"));
    expect([afterPosts, puts - afterPosts]).toEqual([8, 1]);
  });

  it("a failure carries what landed before it (`partialOf`)", async () => {
    const { client } = fakeChannel({
      intercept: ({ method, body }) => (method === "chat.postMessage" && body["text"] === "2" ? { body: { ok: false, error: "msg_too_long" } } : undefined),
    });
    const e = await syncSlots(client, memoryStore(), { key: "b", parent: "head", slots: [{ slot: "a", msg: "1" }, { slot: "b", msg: "2" }] }).catch((x) => x);
    expect([e.code, partialOf(e)]).toEqual([
      "msg_too_long",
      { status: "synced", ts: "101.000000", slots: { a: "102.000000" }, actions: [{ type: "POST", slot: null, ts: "101.000000" }, { type: "POST", slot: "a", ts: "102.000000" }] },
    ]);
  });
});

describe("hash contract", () => {
  // Stored hashes are compared across releases: changing `msgHash`, `stableStringify` or `tagSlot`'s field names
  // re-edits every stored message once. These pin the current values; change them only deliberately.
  it("pins msgHash of plain, rich and slot-tagged messages", () => {
    expect([
      msgHash("hi"),
      msgHash({ text: "hi", blocks: [section("*hi*")] }),
      msgHash(tagSlot("hi", "week:2026-11-13", "U_ANN")),
      msgHash(tagSlot("hi", "week:2026-11-13", null)),
    ]).toEqual(["0aa4ea458bcb35", "053e0fe8ffe92c", "16d1193f174e7a", "09d07535f2a73a"]);
  });
});
