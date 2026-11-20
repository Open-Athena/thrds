import { describe, expect, it } from "vitest";
import { THRDS_HASH, contentKey, msgHash } from "../src/core";
import { section } from "../src/mrkdwn";
import { FilesNotAttachedError } from "../src/slack";
import { memoryStore, tagSlot, upsert } from "../src/slots";
import { fakeChannel, timeoutError } from "./helpers";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("upload", () => {
  it("unshared by default: get an upload URL, send the bytes, complete without a channel, wait until processed", async () => {
    const { client, calls, files, messages } = fakeChannel();
    const id = await client.upload("fleet.png", bytes("PNG!"), { altText: "fleet" });
    expect([id, calls, [...files.values()], messages]).toEqual([
      "F101",
      [
        { method: "files.getUploadURLExternal", http: "POST", body: { filename: "fleet.png", length: "4", alt_txt: "fleet" } },
        { method: "upload_url", http: "POST", body: { file: "F101" }, bytes: bytes("PNG!") },
        { method: "files.completeUploadExternal", http: "POST", body: { files: [{ id: "F101", title: "fleet.png" }] } },
        { method: "files.info", http: "GET", body: { file: "F101" } },
      ],
      [{ id: "F101", name: "fleet.png", title: "fleet.png", mimetype: "image/png", bytes: bytes("PNG!") }],
      [],
    ]);
  });

  it("shares into a channel (a file message) with a comment, in a thread; strings go as UTF-8", async () => {
    const { client, calls, messages } = fakeChannel({ messages: [{ ts: "1.000000", text: "parent" }] });
    await client.upload("notes.txt", "héllo", { channel: "C1", initialComment: "notes", threadTs: "1.000000", title: "Notes", processed: false });
    expect([calls.map((c) => c.bytes?.byteLength ?? c.body), messages]).toEqual([
      [
        { filename: "notes.txt", length: "6" },
        6,
        { files: [{ id: "F101", title: "Notes" }], channel_id: "C1", initial_comment: "notes", thread_ts: "1.000000" },
      ],
      [
        { ts: "1.000000", text: "parent" },
        { ts: "101.000000", text: "notes", bot_id: "B_BOT", files: [{ id: "F101", name: "notes.txt" }], thread_ts: "1.000000" },
      ],
    ]);
  });

  it("polls files.info until Slack reports a mimetype (by default), and times out with a bound", async () => {
    const { client, calls } = fakeChannel({ processedAfter: 2 });
    const { sleep, waits } = { waits: [] as number[], sleep: async (ms: number) => void waits.push(ms) };
    let t = 0;
    const timed = client.with({ sleep: async (ms) => void (t += ms, sleep(ms)), now: () => t });
    const id = await timed.upload("a.png", bytes("A"));
    const slow = fakeChannel({ processedAfter: 99 });
    let t2 = 0;
    const e = await slow.client
      .with({ sleep: async (ms) => void (t2 += ms), now: () => t2 })
      .upload("b.png", bytes("B"), { processed: { timeoutMs: 2500, intervalMs: 1000 } })
      .catch((x) => x);
    expect([
      id,
      calls.filter((c) => c.method === "files.info").length,
      waits,
      [e.code, e.kind, e.method, slow.calls.filter((c) => c.method === "files.info").length, t2],
    ]).toEqual(["F101", 3, [1000, 1000], ["timeout", "timeout", "files.info", 3, 2000]]);
  });

  it("an upload URL that fails is an http error naming it", async () => {
    const { client } = fakeChannel({ intercept: ({ method }) => (method === "upload_url" ? { status: 500, body: "" } : undefined) });
    const e = await client.upload("a.png", bytes("A")).catch((x) => x);
    expect([e.message, e.kind, e.definite]).toEqual(["upload_url: http_500", "http", false]);
  });

  it("a transport failure is surfaced as a timeout", async () => {
    const { client } = fakeChannel({
      intercept: ({ method }) => {
        if (method === "upload_url") throw timeoutError();
        return undefined;
      },
    });
    expect((await client.upload("a.png", bytes("A")).catch((x) => x)).message).toBe("upload_url: timeout");
  });
});

describe("attached files", () => {
  it("edit sends `file_ids` only when `files` is given; `[]` detaches", async () => {
    const { client, calls, messages } = fakeChannel({ messages: [{ ts: "1.000000", text: "card", bot_id: "B_BOT" }] });
    const a = await client.upload("a.png", bytes("A"));
    const b = await client.upload("b.png", bytes("B"));
    const fileIds = () => calls.filter((c) => c.method === "chat.update").map((c) => c.body["file_ids"] ?? null);
    const seen: unknown[] = [];
    await client.edit("1.000000", { text: "card", files: [a] });
    seen.push(messages[0]!.files);
    await client.edit("1.000000", { text: "card", files: [b] });
    seen.push(messages[0]!.files);
    await client.edit("1.000000", "card, text only");
    seen.push(messages[0]!.files);
    await client.edit("1.000000", { text: "card", files: [] });
    seen.push(messages[0]!.files);
    expect([fileIds(), seen]).toEqual([
      [["F101"], ["F102"], null, []],
      [[{ id: "F101", name: "a.png" }], [{ id: "F102", name: "b.png" }], [{ id: "F102", name: "b.png" }], undefined],
    ]);
  });

  it("files make a message rich: hashed, and a different file is a different hash", () => {
    const plain = { text: "card" };
    expect([
      msgHash({ ...plain, files: ["F1"] }) === msgHash({ ...plain, files: ["F2"] }),
      msgHash({ ...plain, files: [] }) === msgHash(plain),
      contentKey({ ...plain, files: ["F1"] }) === "card",
    ]).toEqual([false, false, false]);
  });

  it("post with files: post stamped without them, then an edit attaches them and re-stamps", async () => {
    const { client, calls, messages } = fakeChannel();
    const f = await client.upload("a.png", bytes("A"));
    const msg = { text: "fleet", blocks: [section("*fleet*")], files: [f] };
    const sent = await client.post(msg);
    const writes = calls.filter((c) => c.method.startsWith("chat.")).map((c) => [c.method, c.body["file_ids"] ?? null, (c.body["metadata"] as { event_payload: Record<string, unknown> }).event_payload[THRDS_HASH]]);
    const { files: _files, ...bare } = msg;
    expect([sent, writes, messages[0]!.files]).toEqual([
      { id: "101.000000", content: "fleet", key: contentKey(msg) },
      [
        ["chat.postMessage", null, msgHash(bare)],
        ["chat.update", [f], msgHash(msg)],
      ],
      [{ id: f, name: "a.png" }],
    ]);
  });

  it("an attach that fails after the post landed throws FilesNotAttachedError; upsert adopts and attaches next run", async () => {
    let failAttach = true;
    const { client, messages } = fakeChannel({
      intercept: ({ method }) => (method === "chat.update" && failAttach ? { status: 503, body: "" } : undefined),
    });
    const store = memoryStore();
    const f = await client.upload("a.png", bytes("A"));
    const card = { text: "fleet", files: [f] };
    const now = () => 101_000;
    const e = await upsert(client, store, "fleet", card, { now }).catch((x) => x);
    const afterFail = [e instanceof FilesNotAttachedError, e.ts, e.cause.code, messages[0]!.files];
    failAttach = false;
    const r = await upsert(client, store, "fleet", card, { now });
    expect([afterFail, r, messages.map((m) => [m.ts, m.files]), (await store.get("fleet"))!.parent!.hash]).toEqual([
      [true, "101.000000", "http_503", undefined],
      { status: "synced", ts: "101.000000", action: "EDIT" },
      [["101.000000", [{ id: f, name: "a.png" }]]],
      msgHash(tagSlot(card, "fleet", null)),
    ]);
  });
});

describe("deleteFile", () => {
  it("deletes, and a file that's already gone is fine", async () => {
    const { client, files, calls } = fakeChannel();
    const f = await client.upload("a.png", bytes("A"));
    await client.deleteFile(f);
    await client.deleteFile(f);
    expect([files.size, calls.filter((c) => c.method === "files.delete")]).toEqual([
      0,
      [
        { method: "files.delete", http: "POST", body: { file: "F101" } },
        { method: "files.delete", http: "POST", body: { file: "F101" } },
      ],
    ]);
  });

  it("other failures throw", async () => {
    const { client } = fakeChannel({ intercept: ({ method }) => (method === "files.delete" ? { body: { ok: false, error: "cant_delete_file" } } : undefined) });
    expect((await client.deleteFile("F1").catch((x) => x)).code).toBe("cant_delete_file");
  });
});
