import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { d1Receipts, rewriteReceiptsSchema, sqliteD1 } from "../src/d1";
import {
  apply,
  contentHash,
  findHistory,
  findIds,
  findThread,
  memoryReceipts,
  plan,
  postRewrite,
  fallbackText,
  rewriteHandler,
  sameContent,
  sectionBlocks,
  sendable,
  substitute,
  verifyPlan,
  type Desired,
  type RewriteContent,
  type RewriteFound,
  type RewritePlan,
  type RewriteSender,
  type Skip,
} from "../src/index";
import { fakeChannel, type FakeMessage } from "./helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncT };

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

const DIGEST: RewriteSender = { username: "Digest", icon_url: null, icon_emoji: ":bar_chart:" };
const SECTION = { type: "section", text: { type: "mrkdwn", text: ":old: build" } };
const RICH = { type: "rich_text", block_id: "r1", elements: [{ type: "rich_text_section", elements: [{ type: "emoji", name: "old" }] }] };

const ours = (ts: string, text: string, extra: Partial<FakeMessage> = {}): FakeMessage => ({ ts, text, bot_id: "B_BOT", ...extra });
const theirs = (ts: string, text: string, extra: Partial<FakeMessage> = {}): FakeMessage => ({ ts, text, user: "U_PERSON", ...extra });

/** The Python tests' `ch` fixture (`tests/test_rewrite.py` on `py`). */
const channel = (more: FakeMessage[] = []) =>
  fakeChannel({
    messages: [
      ours("1.0", ":old: one"),
      ours("2.0", ":old: two", { thread_ts: "2.0", blocks: [RICH] }),
      ours("2.1", ":old: reply", { thread_ts: "2.0" }),
      theirs("2.2", "a person's reply :old:", { thread_ts: "2.0" }),
      ours("3.0", "nothing to change"),
      ours("4.0", "fallback :old:", { blocks: [{ block_id: "s0", ...SECTION }] }),
      theirs("5.0", "a person :old:"),
      ...more,
    ],
  });

// Two paragraphs of 30 lines × 70 chars: 4,260 chars, over the 4,000 on `text`; each paragraph fits a section
// (`LONG` in Python's `tests/test_rewrite.py`).
const LONG_ROWS = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, "0")} ${"p".repeat(67)}`);
const LONG = `${LONG_ROWS.slice(0, 30).join("\n")}\n\n${LONG_ROWS.slice(30).join("\n")}`;
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const LONG_SECTIONS = [section(LONG_ROWS.slice(0, 30).join("\n")), section(LONG_ROWS.slice(30).join("\n"))];
const LONG_FALLBACK = `${LONG_ROWS.slice(0, 30).join("\n")}\n\n${LONG_ROWS.slice(30, 56).join("\n")}\n…`;
const LONG_IMAGE = { type: "image", image_url: "https://example.com/plot.png", alt_text: "plot" };
const LONG_MANY = Array.from({ length: 51 }, () => "q".repeat(2999)).join("\n\n");
const LONG_LINE = `${"x".repeat(3001)}\n${"y".repeat(1500)}`;

const view = (fs: RewriteFound[]) => fs.map((f) => [f.ts, f.threadTs, f.ours, f.last, f.replyCount]);
const kinds = (p: RewritePlan) => p.actions.map((a) => [a.ts, a.kind, a.reason]);
const statuses = (os: Array<{ ts: string; status: string }>) => os.map((o) => [o.ts, o.status]);
const sub = substitute({ ":old:": ":new:" });

describe("parity with Python thrds.rewrite", () => {
  it("hashes content as Python's `Content.hash` does", async () => {
    const cases = fixture("rewrite-hashes.json") as Array<{ content: RewriteContent; hash: string }>;
    expect(await Promise.all(cases.map((c) => contentHash(c.content)))).toEqual(cases.map((c) => c.hash));
  });

  it("verifies a Python plan's hashes, and plans the same channel identically", async () => {
    const py = fixture("rewrite-plan.json");
    const verified = await verifyPlan(py);
    const { client } = fakeChannel({
      messages: [
        ours("1.0", ":old: one 🚀"),
        ours("2.0", ":old: two", { thread_ts: "2.0", blocks: [RICH] }),
        ours("2.1", ":old: reply", { thread_ts: "2.0" }),
        theirs("2.2", "a person's reply :old:", { thread_ts: "2.0" }),
        ours("3.0", "nothing to change"),
        ours("4.0", "fallback :old:", { blocks: [{ block_id: "s0", ...SECTION }] }),
        theirs("5.0", "a person :old:"),
        ours("6.0", "card :old:", { metadata: { event_type: "fleet", event_payload: { id: 1 } } }),
        ours("7.0", "short"),
        ours("7.1", "short"),
        ours("7.2", "short"),
      ],
    });
    const long: Record<string, Desired> = {
      "7.0": { text: LONG },
      "7.1": { text: LONG, blocks: [...LONG_SECTIONS, LONG_IMAGE] },
      "7.2": { text: LONG_LINE },
    };
    const render = (f: RewriteFound): Desired | Skip => {
      if (f.ts in long) return long[f.ts]!;
      const d = sub(f) as Desired;
      return f.ts === "6.0" ? { ...d, sender: DIGEST } : d;
    };
    expect(await plan(await findHistory(client, { includeReplies: true, includeForeign: true }), render)).toEqual(verified);

    const tampered = structuredClone(py) as RewritePlan;
    tampered.actions.find((a) => a.ts === "5.0")!.old.text = "edited by hand";
    await expect(verifyPlan(tampered)).rejects.toThrow(/^plan action 5\.0: recorded hash \w+ doesn't match its old content \(\w+\)$/);
  });

  it("compares content as Python's `same_content` does", () => {
    const cases = fixture("rewrite-same.json") as Array<{ live: RewriteContent; want: RewriteContent; same: boolean }>;
    expect(cases.map((c) => sameContent(c.live, c.want))).toEqual(cases.map((c) => c.same));
  });
});

describe("text over Slack's 4,000, as Python's `post` / `edit` send it", () => {
  it("caps the fallback text at a line", () => {
    expect(fallbackText("short")).toBe("short");
    expect(fallbackText("x".repeat(4000))).toBe("x".repeat(4000));
    expect([fallbackText(LONG), fallbackText(LONG).length]).toEqual([LONG_FALLBACK, 3978]);
    expect(fallbackText("y".repeat(5000))).toBe(`${"y".repeat(3999)}…`);
    // Counted in code points, as Python counts: 4,000 emoji fit.
    expect(fallbackText("🚀".repeat(4000))).toBe("🚀".repeat(4000));
  });

  it("splits sections at paragraphs, or with `lines` at line breaks", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, "0")}${"r".repeat(97)}`);
    const para = rows.join("\n");
    expect(() => sectionBlocks(para)).toThrow(
      /^Message body has a paragraph over Slack's 3000-char section limit \(3999 chars\); break it with a blank line or shorten it$/,
    );
    const head = "h".repeat(100);
    const tail = "t".repeat(100);
    expect(sectionBlocks([head, para, tail].join("\n\n"), { lines: true })).toEqual([
      section(head),
      section(rows.slice(0, 30).join("\n")),
      section(`${rows.slice(30).join("\n")}\n\n${tail}`),
    ]);
    expect(sectionBlocks(LONG)).toEqual(LONG_SECTIONS);
    expect(() => sectionBlocks(`ok\n${"x".repeat(3001)}`, { lines: true })).toThrow(
      /^Message body has a line over Slack's 3000-char section limit \(3001 chars\)$/,
    );
  });

  it("`sendable`: capped beside blocks, sections when text-only", () => {
    expect(sendable("short", null)).toEqual({ text: "short", blocks: null });
    expect(sendable(LONG, [...LONG_SECTIONS, LONG_IMAGE])).toEqual({ text: LONG_FALLBACK, blocks: [...LONG_SECTIONS, LONG_IMAGE] });
    expect(sendable(LONG, null)).toEqual({ text: LONG_FALLBACK, blocks: LONG_SECTIONS });
    expect(() => sendable(LONG_LINE, null)).toThrow(/^Message body has a line over Slack's 3000-char section limit \(3001 chars\)$/);
    expect(() => sendable(LONG_MANY, null)).toThrow(/^new text is 153049 chars, 51 sections over Slack's 50 blocks$/);
  });

  it("plans a message already sent that way as a noop, and edits one that isn't", async () => {
    const { client, calls } = fakeChannel({
      messages: [
        ours("1.0", LONG_FALLBACK, { blocks: [...LONG_SECTIONS, LONG_IMAGE].map((b, i) => ({ block_id: `b${i}`, ...b })) }),
        ours("2.0", "short"),
        ours("3.0", "short"),
      ],
    });
    const want: Record<string, Desired> = {
      "1.0": { text: LONG, blocks: [...LONG_SECTIONS, LONG_IMAGE] },
      "2.0": { text: LONG },
      "3.0": { text: LONG_MANY },
    };
    const p = await plan(await findIds(client, ["1.0", "2.0", "3.0"]), (f) => want[f.ts]!);
    expect(kinds(p)).toEqual([
      ["1.0", "noop", null],
      ["2.0", "edit", null],
      ["3.0", "blocked", "new text is 153049 chars, 51 sections over Slack's 50 blocks"],
    ]);
    expect(p.actions[1]!.new).toEqual({ text: LONG_FALLBACK, blocks: LONG_SECTIONS, sender: p.actions[1]!.old.sender, files: [] });
    expect(statuses(await apply(p, client, { dryRun: false, paceMs: 0 }))).toEqual([["2.0", "done"]]);
    expect(chatCalls(calls)).toEqual([["chat.update", { channel: "C1", ts: "2.0", text: LONG_FALLBACK, blocks: LONG_SECTIONS }]]);
    expect(statuses(await apply(p, client, { dryRun: false, paceMs: 0 }))).toEqual([["2.0", "already"]]);
  });
});

describe("content as Slack stores it", () => {
  // r2's November digest OP (the first `rewrite-same.json` case): Slack stored `&amp;`, a one-line fallback,
  // `verbatim: false` and the image's measured fields; the digest renders `&`, newlines and none of those.
  const [r2] = fixture("rewrite-same.json") as Array<{ live: RewriteContent; want: RewriteContent }>;
  const r2Channel = () => fakeChannel({ messages: [ours("1.0", r2!.live.text, { blocks: r2!.live.blocks! })] });

  it("plans a noop when only Slack's storage differs, and `already` after a real edit", async () => {
    const { client, messages } = r2Channel();
    const same = await plan(await findIds(client, ["1.0"]), () => ({ text: r2!.want.text, blocks: r2!.want.blocks! }));
    expect(kinds(same)).toEqual([["1.0", "noop", null]]);

    const [section, image] = r2!.want.blocks! as Array<Record<string, unknown>>;
    const moved = [section!, { ...image!, image_url: (image!["image_url"] as string).replace("78c8fa4d", "c5fbca09") }];
    const p = await plan(await findIds(client, ["1.0"]), () => ({ text: r2!.want.text, blocks: moved }));
    expect(kinds(p)).toEqual([["1.0", "edit", null]]);
    expect(statuses(await apply(p, client, { dryRun: false, paceMs: 0 }))).toEqual([["1.0", "done"]]);
    // Slack stores the edit escaped.
    const m = messages[0]!;
    m.text = m.text.replaceAll("&", "&amp;");
    expect(statuses(await apply(p, client, { dryRun: false, paceMs: 0 }))).toEqual([["1.0", "already"]]);
  });
});

describe("find", () => {
  it("lists the app's messages with their thread positions", async () => {
    const { client } = channel();
    expect(view(await findHistory(client))).toEqual([
      ["4.0", null, true, false, 0],
      ["3.0", null, true, false, 0],
      ["2.0", null, true, false, 2],
      ["1.0", null, true, false, 0],
    ]);
    expect(view(await findHistory(client, { includeReplies: true, includeForeign: true }))).toEqual([
      ["5.0", null, false, true, 0],
      ["4.0", null, true, false, 0],
      ["3.0", null, true, false, 0],
      ["2.0", null, true, false, 2],
      ["2.1", "2.0", true, false, 0],
      ["2.2", "2.0", false, true, 0],
      ["1.0", null, true, false, 0],
    ]);
    // Bounded by `latest`: the newest in range isn't the channel's newest.
    expect(view(await findHistory(client, { latest: "4.5" }))).toEqual([
      ["4.0", null, true, false, 0],
      ["3.0", null, true, false, 0],
      ["2.0", null, true, false, 2],
      ["1.0", null, true, false, 0],
    ]);
  });

  it("reads one thread, or exact ids", async () => {
    const { client } = channel();
    expect(view(await findThread(client, "2.0"))).toEqual([
      ["2.0", null, true, false, 2],
      ["2.1", "2.0", true, false, 0],
    ]);
    expect(view(await findIds(client, ["2.2", "5.0", "2.1"]))).toEqual([
      ["2.2", "2.0", false, true, 0],
      ["5.0", null, false, true, 0],
      ["2.1", "2.0", true, false, 0],
    ]);
    await expect(findIds(client, ["9.0"])).rejects.toThrow(/^no message 9\.0 in C1$/);
  });
});

describe("plan", () => {
  it("substitutes: edits, noops, and blocks others' messages", async () => {
    const { client } = channel();
    const p = await plan(await findHistory(client, { includeReplies: true, includeForeign: true }), sub);
    expect(kinds(p)).toEqual([
      ["5.0", "blocked", "another app's or a person's message"],
      ["4.0", "edit", null],
      ["3.0", "noop", null],
      ["2.0", "edit", null],
      ["2.1", "edit", null],
      ["2.2", "blocked", "another app's or a person's message"],
      ["1.0", "edit", null],
    ]);
    const byTs = Object.fromEntries(p.actions.map((a) => [a.ts, a]));
    expect(byTs["4.0"]!.new!.blocks).toEqual([{ block_id: "s0", type: "section", text: { type: "mrkdwn", text: ":new: build" } }]);
    expect(byTs["2.0"]!.new!.blocks).toBe(null);
  });

  it("renames emoji elements in non-rich_text blocks", () => {
    const f = {
      content: { text: ":old:", blocks: [{ type: "context", elements: [{ type: "emoji", name: "old" }, { type: "mrkdwn", text: ":old:" }] }], sender: DIGEST, files: [] },
    } as unknown as RewriteFound;
    expect(sub(f)).toEqual({ text: ":new:", blocks: [{ type: "context", elements: [{ type: "emoji", name: "new" }, { type: "mrkdwn", text: ":new:" }] }] });
  });

  it("reposts a sender change only where Slack allows", async () => {
    const { client } = channel([ours("6.0", "newest", { files: [{ id: "F1", name: "a.png" }] }), ours("6.1", "last reply", { thread_ts: "2.0" })]);
    const render = (f: RewriteFound): Desired | Skip =>
      f.ts === "3.0" ? { skip: "not a digest" } : { text: f.content.text, blocks: f.content.blocks, sender: DIGEST };
    expect(kinds(await plan(await findHistory(client, { includeReplies: true }), render))).toEqual([
      ["6.0", "blocked", "the sender changes to an override, and Slack shows no files on those"],
      ["4.0", "blocked", "the sender changes, and a repost would move it to the end of its channel"],
      ["3.0", "skip", "not a digest"],
      ["2.0", "blocked", "the sender changes, and a repost would orphan its 3 replies"],
      ["2.1", "blocked", "the sender changes, and a repost would move it to the end of its thread"],
      ["6.1", "repost", null],
      ["1.0", "blocked", "the sender changes, and a repost would move it to the end of its channel"],
    ]);
    const reorder = await plan(await findHistory(client), render, { reorderOk: true });
    expect(reorder.actions.map((a) => [a.ts, a.kind])).toEqual([
      ["6.0", "blocked"],
      ["4.0", "repost"],
      ["3.0", "skip"],
      ["2.0", "blocked"],
      ["1.0", "repost"],
    ]);
  });
});

const chatCalls = (calls: Array<{ method: string; body: Record<string, unknown> }>) =>
  calls.filter((c) => c.method.startsWith("chat.")).map((c) => [c.method, c.body]);

describe("apply", () => {
  it("dry-runs, applies a selection with receipts, and skips them on a re-run", async () => {
    const { client, calls, messages } = channel();
    const p = await plan(await findHistory(client, { includeReplies: true }), sub);
    expect(statuses(await apply(p, client, { paceMs: 0 }))).toEqual([
      ["4.0", "pending"],
      ["2.0", "pending"],
      ["2.1", "pending"],
      ["1.0", "pending"],
    ]);
    expect(chatCalls(calls)).toEqual([]);

    const receipts = memoryReceipts();
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    expect(await apply(p, client, { dryRun: false, receipts, only: ["4.0", "2.0"], sleep })).toEqual([
      { ts: "4.0", kind: "edit", status: "done" },
      { ts: "2.0", kind: "edit", status: "done" },
    ]);
    expect(waits).toEqual([1200]);
    expect(chatCalls(calls)).toEqual([
      ["chat.update", { channel: "C1", ts: "4.0", text: "fallback :new:", blocks: [{ block_id: "s0", type: "section", text: { type: "mrkdwn", text: ":new: build" } }] }],
      ["chat.update", { channel: "C1", ts: "2.0", text: ":new: two", blocks: [] }],
    ]);
    expect(messages.find((m) => m.ts === "2.0")).toEqual({ ts: "2.0", text: ":new: two", bot_id: "B_BOT", thread_ts: "2.0", blocks: [] });

    calls.length = 0;
    expect(statuses(await apply(p, client, { dryRun: false, receipts, paceMs: 0 }))).toEqual([
      ["4.0", "receipt"],
      ["2.0", "receipt"],
      ["2.1", "done"],
      ["1.0", "done"],
    ]);
    expect(receipts.outcomes.map((o) => o.ts)).toEqual(["4.0", "2.0", "2.1", "1.0"]);
    // Without receipts, a re-run sees the new content already there.
    expect(statuses(await apply(p, client, { dryRun: false, paceMs: 0 }))).toEqual([
      ["4.0", "already"],
      ["2.0", "already"],
      ["2.1", "already"],
      ["1.0", "already"],
    ]);
  });

  it("refuses stale and gone messages, and a plan whose hash doesn't match", async () => {
    const { client, calls, messages } = channel();
    const p = await plan(await findHistory(client), sub);
    messages.find((m) => m.ts === "4.0")!.text = "someone edited this";
    messages.splice(messages.findIndex((m) => m.ts === "1.0"), 1);
    p.actions.find((a) => a.ts === "2.0")!.old.text = "tampered";
    expect(await apply(p, client, { dryRun: false, paceMs: 0 })).toEqual([
      { ts: "4.0", kind: "edit", status: "stale", error: "changed since planning" },
      { ts: "2.0", kind: "edit", status: "failed", error: "the plan's hash doesn't match its old content" },
      { ts: "1.0", kind: "edit", status: "gone" },
    ]);
    expect(chatCalls(calls)).toEqual([]);
  });

  it("reposts: posts, re-attaches files, then deletes, keeping metadata", async () => {
    const { client, calls, messages, files } = fakeChannel({
      messages: [
        ours("1.0", "card", { subtype: "bot_message", username: "Fleet", metadata: { event_type: "fleet", event_payload: {} }, files: [{ id: "F1", name: "a.png" }] }),
      ],
    });
    files.set("F1", { id: "F1", name: "a.png", title: "a.png", mimetype: "image/png" });
    const p = await plan(await findHistory(client), () => ({ text: "card", sender: { username: null, icon_url: null, icon_emoji: null } }));
    expect(kinds(p)).toEqual([["1.0", "repost", null]]);
    expect(await apply(p, client, { dryRun: false, paceMs: 0 })).toEqual([{ ts: "1.0", kind: "repost", status: "done", new_ts: "101.000000" }]);
    expect(chatCalls(calls)).toEqual([
      ["chat.postMessage", { channel: "C1", text: "card", unfurl_links: false, unfurl_media: false, metadata: { event_type: "fleet", event_payload: {} } }],
      ["chat.update", { channel: "C1", ts: "101.000000", text: "card", file_ids: ["F1"] }],
      ["chat.delete", { channel: "C1", ts: "1.0" }],
    ]);
    expect(messages).toEqual([
      { ts: "101.000000", text: "card", bot_id: "B_BOT", metadata: { event_type: "fleet", event_payload: {} }, files: [{ id: "F1", name: "a.png" }] },
    ]);
  });

  it("leaves the old message when the repost's file re-attach fails: a failure, never a loss", async () => {
    const { client, messages } = fakeChannel({ messages: [ours("1.0", "card", { subtype: "bot_message", username: "Fleet", files: [{ id: "F9", name: "gone.png" }] })] });
    const p = await plan(await findHistory(client), () => ({ text: "card", sender: { username: null, icon_url: null, icon_emoji: null } }));
    expect(await apply(p, client, { dryRun: false, paceMs: 0 })).toEqual([{ ts: "1.0", kind: "repost", status: "failed", error: "file_not_found" }]);
    expect(messages.map((m) => m.ts)).toEqual(["1.0", "101.000000"]);
  });

  it("reposts a reply under the app's own sender, then deletes the old one", async () => {
    const { client, calls, messages } = fakeChannel({
      messages: [
        ours("1.0", "status", { metadata: { event_type: "fleet", event_payload: { id: 1 } } }),
        ours("1.1", "panels", { thread_ts: "1.0" }),
        ours("1.2", "latest", { thread_ts: "1.0", subtype: "bot_message", username: "Old" }),
      ],
    });
    const render = (f: RewriteFound): Desired =>
      f.ts === "1.0" ? { text: "status", sender: DIGEST } : f.ts === "1.2" ? { text: "latest", sender: { username: null, icon_url: null, icon_emoji: null } } : { text: f.content.text };
    const p = await plan(await findThread(client, "1.0"), render);
    expect(kinds(p)).toEqual([
      ["1.0", "blocked", "the sender changes, and a repost would orphan its 2 replies"],
      ["1.1", "noop", null],
      ["1.2", "repost", null],
    ]);
    expect(await apply(p, client, { dryRun: false, paceMs: 0 })).toEqual([{ ts: "1.2", kind: "repost", status: "done", new_ts: "101.000000" }]);
    expect(chatCalls(calls)).toEqual([
      ["chat.postMessage", { channel: "C1", text: "latest", unfurl_links: false, unfurl_media: false, thread_ts: "1.0" }],
      ["chat.delete", { channel: "C1", ts: "1.2" }],
    ]);
    expect(messages.map((m) => m.ts)).toEqual(["1.0", "1.1", "101.000000"]);
  });

  it("turns a repost stale once it's no longer the newest; an override needs a bot token", async () => {
    const { client, messages } = fakeChannel({ messages: [ours("1.0", "card")] });
    const p = await plan(await findHistory(client), () => ({ text: "card", sender: DIGEST }));
    expect(kinds(p)).toEqual([["1.0", "repost", null]]);
    messages.push(theirs("2.0", "someone posted after"));
    expect(await apply(p, client, { dryRun: false, paceMs: 0 })).toEqual([
      { ts: "1.0", kind: "repost", status: "stale", error: "no longer the newest; a repost would move it" },
    ]);

    const user = fakeChannel({ messages: [ours("1.0", "card")], clientOptions: { token: "xoxp-t" } });
    const q = await plan(await findHistory(user.client), () => ({ text: "card", sender: DIGEST }));
    expect(await apply(q, user.client, { dryRun: false, paceMs: 0 })).toEqual([
      { ts: "1.0", kind: "repost", status: "failed", error: "a sender override needs a bot token (xoxb-…)" },
    ]);
  });
});

describe("d1Receipts", () => {
  it("records outcomes per plan, and reports the done ones", async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(rewriteReceiptsSchema());
    const db = sqliteD1(raw);
    const a = d1Receipts(db, "plan-a", { now: () => 1700 });
    const b = d1Receipts(db, "plan-b", { now: () => 1700 });
    expect(await a.done()).toEqual(new Set());
    await a.record({ ts: "1.0", kind: "edit", status: "done" });
    await a.record({ ts: "2.0", kind: "edit", status: "stale", error: "changed since planning" });
    await a.record({ ts: "3.0", kind: "repost", status: "undeleted", new_ts: "9.0", error: "cant_delete_message" });
    await a.record({ ts: "4.0", kind: "edit", status: "already" });
    await b.record({ ts: "5.0", kind: "edit", status: "done" });
    expect(await a.done()).toEqual(new Set(["1.0", "4.0"]));
    expect(await b.done()).toEqual(new Set(["5.0"]));
    expect(raw.prepare("SELECT * FROM thrds_rewrite_receipts WHERE plan = 'plan-a' ORDER BY ts").all()).toEqual([
      { plan: "plan-a", ts: "1.0", kind: "edit", status: "done", new_ts: null, error: null, at: 1700 },
      { plan: "plan-a", ts: "2.0", kind: "edit", status: "stale", new_ts: null, error: "changed since planning", at: 1700 },
      { plan: "plan-a", ts: "3.0", kind: "repost", status: "undeleted", new_ts: "9.0", error: "cant_delete_message", at: 1700 },
      { plan: "plan-a", ts: "4.0", kind: "edit", status: "already", new_ts: null, error: null, at: 1700 },
    ]);
  });
});

describe("rewriteHandler / postRewrite", () => {
  const ORIGIN = "https://disky.example";
  const setup = async () => {
    const ch = channel();
    const p = await plan(await findHistory(ch.client, { includeReplies: true, includeForeign: true }), sub);
    const receipts = memoryReceipts();
    const handle = (req: Request) => rewriteHandler(req, { plan: async () => p, client: () => ch.client, name: "march digest", receipts, maxBatch: 2, paceMs: 0 });
    const post = (op: string, body: unknown, headers: Record<string, string> = {}) =>
      handle(new Request(`${ORIGIN}/api/rewrite/${op}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) }));
    return { ...ch, p, receipts, handle, post };
  };

  it("serves the plan, checks and applies selected ids", async () => {
    const { p, handle, post, receipts } = await setup();
    const res = await handle(new Request(`${ORIGIN}/api/rewrite/plan`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "march digest", plan: { ...p, counts: { edit: 4, repost: 0, noop: 1, skip: 0, blocked: 2 } } });

    const check = await post("check", { ids: ["4.0", "1.0"] });
    expect(await check.json()).toEqual({ outcomes: [{ ts: "4.0", kind: "edit", status: "pending" }, { ts: "1.0", kind: "edit", status: "pending" }] });
    expect(receipts.outcomes).toEqual([]);
    const applied = await post("apply", { ids: ["4.0"] });
    expect(await applied.json()).toEqual({ outcomes: [{ ts: "4.0", kind: "edit", status: "done" }] });
    expect(receipts.outcomes).toEqual([{ ts: "4.0", kind: "edit", status: "done" }]);
  });

  it("refuses what it shouldn't run", async () => {
    const { post, handle } = await setup();
    const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];
    expect(await refusal(await post("apply", { ids: ["4.0"] }, { "Content-Type": "text/plain" }))).toEqual([415, "expected Content-Type: application/json"]);
    expect(await refusal(await post("apply", { ids: ["4.0"] }, { Origin: "https://evil.example" }))).toEqual([403, "cross-origin request from https://evil.example"]);
    expect(await refusal(await post("apply", { ids: "4.0" }))).toEqual([400, "bad request: ids must be a list of ts strings"]);
    expect(await refusal(await post("apply", { ids: ["3.0", "5.0"] }))).toEqual([400, "not edits or reposts in this plan: 3.0, 5.0"]);
    expect(await refusal(await post("apply", { ids: ["4.0", "2.0", "1.0"] }))).toEqual([413, "3 ids; at most 2 per request"]);
    expect(await refusal(await handle(new Request(`${ORIGIN}/api/rewrite/nope`)))).toEqual([404, "not found: GET /api/rewrite/nope"]);
  });

  it("postRewrite sends the selection in batches", async () => {
    const { handle } = await setup();
    const bodies: unknown[] = [];
    const seen: string[][] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return handle(new Request(new URL(String(input), ORIGIN), { ...init, headers: { ...(init!.headers as Record<string, string>), Origin: ORIGIN } }));
    }) as typeof fetch;
    const outcomes = await postRewrite("/api/rewrite/apply", ["4.0", "2.0", "2.1", "1.0"], { batch: 2, fetch: f, onOutcomes: (os) => seen.push(os.map((o) => o.ts)) });
    expect(bodies).toEqual([{ ids: ["4.0", "2.0"] }, { ids: ["2.1", "1.0"] }]);
    expect(seen).toEqual([["4.0", "2.0"], ["2.1", "1.0"]]);
    expect(statuses(outcomes)).toEqual([
      ["4.0", "done"],
      ["2.0", "done"],
      ["2.1", "done"],
      ["1.0", "done"],
    ]);
    await expect(postRewrite("/api/rewrite/apply", ["3.0"], { fetch: f })).rejects.toThrow(/^not edits or reposts in this plan: 3\.0$/);
  });
});
