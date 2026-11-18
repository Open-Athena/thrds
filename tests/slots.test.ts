import { describe, expect, it } from "vitest";
import { msgHash } from "../src/core";
import { LeaseLostError, memoryStore, syncSlots, tagSlot, threadStore, upsert, type SlotStore } from "../src/slots";
import { fakeChannel } from "./helpers";

const burst = (details: string, errors?: string) => ({
  key: "burst:1",
  parent: "Ann · 3 views",
  slots: [{ slot: "details", msg: details }, ...(errors ? [{ slot: "kind:error", msg: errors }] : [])],
});
const kinds = (r: { actions: Array<{ type: string; slot: string | null }> }) => r.actions.map((a) => [a.type, a.slot]);

describe("syncSlots", () => {
  it("posts the parent then each slot under it, tags each with key + slot, and records them", async () => {
    const { client, messages } = fakeChannel();
    const store = memoryStore();
    const r = await syncSlots(client, store, burst("/a, /b", "boom"));
    const parent = tagSlot("Ann · 3 views", "burst:1", null);
    expect([
      kinds(r),
      r.ts,
      r.slots,
      messages.map((m) => [m.ts, m.thread_ts ?? null, m.text, m.metadata?.event_payload]),
      store.dump(),
    ]).toEqual([
      [["POST", null], ["POST", "details"], ["POST", "kind:error"]],
      "101.000000",
      { details: "102.000000", "kind:error": "103.000000" },
      [
        ["101.000000", null, "Ann · 3 views", { thrds_key: "burst:1", thrds_slot: "", thrds_hash: msgHash(parent) }],
        ["102.000000", "101.000000", "/a, /b", { thrds_key: "burst:1", thrds_slot: "details", thrds_hash: msgHash(tagSlot("/a, /b", "burst:1", "details")) }],
        ["103.000000", "101.000000", "boom", { thrds_key: "burst:1", thrds_slot: "kind:error", thrds_hash: msgHash(tagSlot("boom", "burst:1", "kind:error")) }],
      ],
      {
        "burst:1": {
          parent: { ts: "101.000000", hash: msgHash(parent) },
          slots: {
            details: { ts: "102.000000", hash: msgHash(tagSlot("/a, /b", "burst:1", "details")) },
            "kind:error": { ts: "103.000000", hash: msgHash(tagSlot("boom", "burst:1", "kind:error")) },
          },
        },
      },
    ]);
  });

  it("a re-run edits only what changed, without reading Slack", async () => {
    const { client, calls, writes } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, burst("/a, /b", "boom"));
    const before = calls.length;
    const r = await syncSlots(client, store, burst("/a, /b, /c", "boom"));
    expect([kinds(r), calls.slice(before).map((c) => c.method), writes]).toEqual([
      [["SKIP", null], ["EDIT", "details"], ["SKIP", "kind:error"]],
      ["chat.update"],
      [["post", "Ann · 3 views"], ["post", "/a, /b"], ["post", "boom"], ["edit", "/a, /b, /c"]],
    ]);
  });

  it("adopts a post that landed before a crash recorded it, instead of posting twice", async () => {
    const { client, writes } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, burst("/a"));
    // A second slot was posted, then the run died before recording it.
    const lost = tagSlot("boom", "burst:1", "kind:error");
    await client.post(lost, "101.000000");
    const state = (await store.get("burst:1"))!;
    await store.put("burst:1", { ...state, pending: { slot: "kind:error", hash: msgHash(lost), at: 0 } });
    const r = await syncSlots(client, store, burst("/a", "boom"));
    expect([kinds(r), r.slots, writes.length, (await store.get("burst:1"))!.pending]).toEqual([
      [["ADOPT", "kind:error"], ["SKIP", null], ["SKIP", "details"], ["SKIP", "kind:error"]],
      { details: "102.000000", "kind:error": "103.000000" },
      3,
      undefined,
    ]);
  });

  it("a pending parent post found in channel history is adopted too; one that never landed is posted", async () => {
    const landed = fakeChannel();
    const tagged = tagSlot("Ann · 3 views", "burst:1", null);
    await landed.client.post(tagged);
    const store = memoryStore({ "burst:1": { slots: {}, pending: { slot: null, hash: msgHash(tagged), at: 50 } } });
    const adopted = await syncSlots(landed.client, store, { key: "burst:1", parent: "Ann · 3 views" });

    const never = fakeChannel();
    const store2 = memoryStore({ "burst:1": { slots: {}, pending: { slot: null, hash: "x", at: 50 } } });
    const posted = await syncSlots(never.client, store2, { key: "burst:1", parent: "Ann · 3 views" });
    expect([kinds(adopted), adopted.ts, landed.writes.length, kinds(posted), never.writes]).toEqual([
      [["ADOPT", null], ["SKIP", null]],
      "101.000000",
      1,
      [["POST", null]],
      [["post", "Ann · 3 views"]],
    ]);
  });

  it("a parent deleted on Slack is re-posted, and its slots follow it to the new thread", async () => {
    const { client, messages } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, burst("/a"));
    messages.splice(0, messages.length);
    const r = await syncSlots(client, store, burst("/a, /b"));
    expect([kinds(r), r.ts, messages.map((m) => [m.ts, m.thread_ts ?? null, m.text])]).toEqual([
      [["REPOST", null], ["POST", "details"]],
      "103.000000",
      [["103.000000", null, "Ann · 3 views"], ["104.000000", "103.000000", "/a, /b"]],
    ]);
  });

  it("a new reply into a deleted thread re-posts the parent first", async () => {
    const { client, messages } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, burst("/a"));
    messages.splice(0, messages.length);
    const r = await syncSlots(client, store, burst("/a", "boom"));
    expect([kinds(r), messages.map((m) => [m.thread_ts ?? null, m.text]), (await store.get("burst:1"))!.pending]).toEqual([
      [["REPOST", null], ["POST", "details"], ["POST", "kind:error"]],
      [[null, "Ann · 3 views"], ["103.000000", "/a"], ["103.000000", "boom"]],
      undefined,
    ]);
  });

  it("an external parent that's gone can't be re-posted: thread_not_found", async () => {
    const { client } = fakeChannel();
    await expect(
      syncSlots(client, memoryStore(), { key: "k", parent: { ts: "9.000000" }, slots: [{ slot: "a", msg: "hi" }] }),
    ).rejects.toMatchObject({ name: "SlackApiError", code: "thread_not_found" });
  });

  it("prune deletes slots no longer desired; without it they stay", async () => {
    const { client, writes } = fakeChannel();
    const store = memoryStore();
    await syncSlots(client, store, burst("/a", "boom"));
    const kept = await syncSlots(client, store, burst("/a"));
    const pruned = await syncSlots(client, store, { ...burst("/a"), prune: true });
    expect([kinds(kept), kinds(pruned), writes.at(-1), Object.keys((await store.get("burst:1"))!.slots)]).toEqual([
      [["SKIP", null], ["SKIP", "details"]],
      [["SKIP", null], ["SKIP", "details"], ["DELETE", "kind:error"]],
      ["delete", "boom"],
      ["details"],
    ]);
  });

  it("replies under someone else's message without managing it (oa-ic: one echo per person under a prompt)", async () => {
    const prompt = { ts: "50.000000", text: "What did you do this week?", user: "U_ISAAC" };
    const { client, messages } = fakeChannel({ messages: [prompt] });
    const store = memoryStore();
    const echo = (text: string) => ({ key: "week:2026-11-13", parent: { ts: "50.000000" }, slots: [{ slot: "U_ANN", msg: { text, username: "Ann Lee" } }] });
    await syncSlots(client, store, echo("v1"));
    const r = await syncSlots(client, store, echo("v2"));
    expect([kinds(r), messages.map((m) => [m.ts, m.thread_ts ?? null, m.text, m.username ?? null]), (await store.get("week:2026-11-13"))!.parent]).toEqual([
      [["EDIT", "U_ANN"]],
      [["50.000000", null, "What did you do this week?", null], ["101.000000", "50.000000", "v2", "Ann Lee"]],
      undefined,
    ]);
  });

  it("dry run plans without writing anything", async () => {
    const { client, calls } = fakeChannel();
    const store = memoryStore();
    const r = await syncSlots(client, store, burst("/a", "boom"), { dryRun: true });
    expect([kinds(r), r.ts, r.slots, calls.length, store.dump()]).toEqual([
      [["POST", null], ["POST", "details"], ["POST", "kind:error"]],
      "<new>",
      { details: "<new>", "kind:error": "<new>" },
      0,
      {},
    ]);
  });

  it("rejects duplicate slot names", async () => {
    const { client } = fakeChannel();
    await expect(
      syncSlots(client, memoryStore(), { key: "k", parent: "p", slots: [{ slot: "a", msg: "1" }, { slot: "a", msg: "2" }] }),
    ).rejects.toThrow('syncSlots: duplicate slot "a"');
  });
});

describe("leases", () => {
  it("a held key is busy for another run until its lease expires", async () => {
    const store = memoryStore();
    const held = await store.claim!("burst:1", 60, 1000);
    const { client, calls } = fakeChannel();
    const busy = await syncSlots(client, store, burst("/a"), { leaseS: 60, now: () => 1030_000 });
    const after = await syncSlots(client, store, burst("/a"), { leaseS: 60, now: () => 1061_000 });
    expect([typeof held, busy, after.status, calls.filter((c) => c.method === "chat.postMessage").length]).toEqual([
      "string",
      { status: "busy", ts: "", slots: {}, actions: [] },
      "synced",
      2,
    ]);
  });

  it("a run whose lease is taken over stops at its next write", async () => {
    const base = memoryStore();
    let puts = 0;
    // Another run takes the key over right after this one's first save.
    const stealing: SlotStore = {
      ...base,
      async put(key, state, lease) {
        if (++puts === 2) await base.release!(key, lease!);
        if (puts === 2) await base.claim!(key, 60, 0);
        return base.put(key, state, lease);
      },
    };
    const { client } = fakeChannel();
    await expect(syncSlots(client, stealing, burst("/a"), { leaseS: 60, now: () => 0 })).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("a store without leases refuses `leaseS`", async () => {
    const { client } = fakeChannel();
    const { claim: _c, release: _r, ...noLeases } = memoryStore();
    await expect(syncSlots(client, noLeases, burst("/a"), { leaseS: 60 })).rejects.toThrow("`leaseS` needs a store with `claim`");
  });
});

describe("upsert", () => {
  it("posts once, then edits on change and skips otherwise (fleet's status message)", async () => {
    const { client, writes } = fakeChannel();
    const store = memoryStore();
    const results = [
      await upsert(client, store, "fleet", "3 nodes up"),
      await upsert(client, store, "fleet", "3 nodes up"),
      await upsert(client, store, "fleet", "2 nodes up"),
    ];
    expect([results, writes]).toEqual([
      [
        { status: "synced", ts: "101.000000", action: "POST" },
        { status: "synced", ts: "101.000000", action: "SKIP" },
        { status: "synced", ts: "101.000000", action: "EDIT" },
      ],
      [["post", "3 nodes up"], ["edit", "2 nodes up"]],
    ]);
  });
});

describe("threadStore (no database: state rebuilt from the thread's tags)", () => {
  const prompt = { ts: "50.000000", text: "What did you do this week?", user: "U_ISAAC" };
  const echo = (who: string, text: string) => ({ slot: who, msg: { text, username: who } });
  const week = (slots: ReturnType<typeof echo>[]) => ({ key: "week:2026-11-13", parent: { ts: "50.000000" }, slots });

  it("finds existing echoes on every run, editing in place and posting only new ones", async () => {
    const { client, messages, writes } = fakeChannel({ messages: [prompt] });
    const store = threadStore(client, "50.000000");
    await syncSlots(client, store, week([echo("U_ANN", "ann v1")]));
    const second = await syncSlots(client, store, week([echo("U_ANN", "ann v1"), echo("U_BOB", "bob v1")]));
    const third = await syncSlots(client, store, week([echo("U_ANN", "ann v2"), echo("U_BOB", "bob v1")]));
    expect([kinds(second), kinds(third), writes, messages.length]).toEqual([
      [["SKIP", "U_ANN"], ["POST", "U_BOB"]],
      [["EDIT", "U_ANN"], ["SKIP", "U_BOB"]],
      [["post", "ann v1"], ["post", "bob v1"], ["edit", "ann v2"]],
      3,
    ]);
  });

  it("ignores another key's slots and messages that aren't ours", async () => {
    const forged = { ts: "60.000000", text: "x", thread_ts: "50.000000", user: "U_EVE", metadata: { event_type: "thrds_slot", event_payload: { thrds_key: "week:2026-11-13", thrds_slot: "U_ANN", thrds_hash: "0" } } };
    const { client } = fakeChannel({ messages: [prompt, forged] });
    await syncSlots(client, memoryStore(), { key: "week:2026-11-06", parent: { ts: "50.000000" }, slots: [echo("U_ANN", "old week")] });
    expect(await threadStore(client, "50.000000").get("week:2026-11-13")).toEqual({ slots: {} });
  });
});
