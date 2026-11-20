import { describe, expect, it } from "vitest";
import { THRDS_HASH, contentKey, msgHash } from "../src/core";
import { hash53Bytes } from "../src/hash";
import { FileNotProcessedError, FileSwapError, FilesNotAttachedError, isProcessed } from "../src/slack";
import { FILE_HASH, memoryStore, tagSlot, upsert, upsertFile } from "../src/slots";
import { image, section, versionedUrl } from "../src/mrkdwn";
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
      [e instanceof FileNotProcessedError, e.message, e.fileId, e.waitedMs, e.deleted],
      [slow.calls.filter((c) => c.method === "files.info").length, t2, slow.files.size],
    ]).toEqual([
      "F101",
      3,
      [500, 500],
      [true, "Slack hadn't processed file F101 after 2 s (deleted it)", "F101", 2000, true],
      [3, 2000, 0],
    ]);
  });

  it("a fake sleep (a clock that never advances) still stops after timeoutMs / intervalMs polls", async () => {
    const { client, calls } = fakeChannel({ processedAfter: 99 });
    const e = await client.upload("a.png", bytes("A"), { processed: { timeoutMs: 2000, intervalMs: 500 } }).catch((x) => x);
    expect([e.name, calls.filter((c) => c.method === "files.info").length]).toEqual(["FileNotProcessedError", 5]);
  });

  it("an image is processed once it has a mimetype and thumbnails; other files need only the mimetype", () => {
    expect([
      isProcessed({ mimetype: "" }),
      isProcessed({ mimetype: "image/png" }),
      isProcessed({ mimetype: "image/png", thumb_64: "u", thumb_360: "u" }),
      isProcessed({ mimetype: "image/png", thumb_tiny: "x" }),
      isProcessed({ mimetype: "text/plain" }),
    ]).toEqual([false, false, true, false, true]);
  });

  it("the bytes POST retries a 5xx / 429 / timeout (safe before completeUploadExternal), but not a 4xx", async () => {
    const replies = [{ status: 504, body: "" }, { status: 429, headers: { "Retry-After": "2" }, body: "" }];
    const retries: unknown[] = [];
    const { client, calls } = fakeChannel({
      intercept: ({ method }) => (method === "upload_url" ? replies.shift() : undefined),
      clientOptions: { onRetry: (info) => void retries.push(info) },
    });
    const id = await client.upload("a.png", bytes("A"));
    const refused = fakeChannel({ intercept: ({ method }) => (method === "upload_url" ? { status: 413, body: "" } : undefined) });
    const e = await refused.client.upload("a.png", bytes("A")).catch((x) => x);
    expect([
      id,
      calls.filter((c) => c.method === "upload_url").length,
      retries,
      [e.message, refused.calls.filter((c) => c.method === "upload_url").length],
    ]).toEqual([
      "F101",
      3,
      [
        { method: "upload_url", attempt: 1, waitMs: 1000, reason: "server_error" },
        { method: "upload_url", attempt: 2, waitMs: 2000, reason: "http_429" },
      ],
      ["upload_url: http_413", 1],
    ]);
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

describe("replaceFile", () => {
  it("uploads, edits with only the new file attached, then deletes the files the message had", async () => {
    const { client, messages, files, writes } = fakeChannel({ messages: [{ ts: "1.000000", text: "card", bot_id: "B_BOT" }] });
    const old = await client.upload("old.png", bytes("old"));
    await client.edit("1.000000", { text: "card", files: [old] });
    const swap = await client.replaceFile("1.000000", { name: "new.png", data: bytes("new") }, "card v2");
    expect([swap, messages[0]!.files, [...files.keys()], writes.slice(1)]).toEqual([
      { fileId: "F102", deleted: [old], undeleted: [] },
      [{ id: "F102", name: "new.png" }],
      ["F102"],
      [["edit", "card v2"], ["delete_file", old]],
    ]);
  });

  it("an edit Slack refused deletes the new upload; one that may have landed keeps it; neither touches the old file", async () => {
    const run = async (reply: () => never | { body: unknown; status?: number }) => {
      const { client, files } = fakeChannel({
        messages: [{ ts: "1.000000", text: "card", bot_id: "B_BOT" }],
        intercept: ({ method, body }) => (method === "chat.update" && (body["file_ids"] as string[])[0] === "F102" ? reply() : undefined),
      });
      const old = await client.upload("old.png", bytes("old"));
      await client.edit("1.000000", { text: "card", files: [old] });
      const e = await client.replaceFile("1.000000", { name: "new.png", data: bytes("new") }, "card v2").catch((x) => x);
      return [e instanceof FileSwapError, e.message, e.fileId, e.deleted, e.cause.code, [...files.keys()]];
    };
    expect([
      await run(() => ({ body: { ok: false, error: "msg_too_long" } })),
      await run(() => {
        throw timeoutError();
      }),
    ]).toEqual([
      [true, "attaching file F102 failed (deleted the upload)", "F102", true, "msg_too_long", ["F101"]],
      [true, "attaching file F102 failed (kept the upload: the write may have landed)", "F102", false, "timeout", ["F101", "F102"]],
    ]);
  });

  it("a replaced file that's already gone is fine; other delete failures are reported, not thrown", async () => {
    const { client } = fakeChannel({
      messages: [{ ts: "1.000000", text: "card", bot_id: "B_BOT" }],
      intercept: ({ method, body }) => (method === "files.delete" && body["file"] === "F9" ? { body: { ok: false, error: "cant_delete_file" } } : undefined),
    });
    const swap = await client.replaceFile("1.000000", { name: "a.png", data: bytes("A") }, "card", { previous: ["F8", "F9"] });
    expect([swap.fileId, swap.deleted, swap.undeleted.map((u) => [u.id, (u.error as { code: string }).code])]).toEqual([
      "F101",
      ["F8"],
      [["F9", "cant_delete_file"]],
    ]);
  });
});

describe("upsertFile", () => {
  it("posts with the file, skips unchanged bytes without uploading, swaps changed bytes and deletes the old file", async () => {
    const { client, calls, messages, files } = fakeChannel();
    const store = memoryStore();
    const card = (n: number) => ({ text: "Fleet", blocks: [section(`*Fleet* run ${n}`)] });
    const methods = (from: number) => calls.slice(from).map((c) => c.method);
    const r1 = await upsertFile(client, store, "fleet", card(1), { name: "fleet.png", data: bytes("png-1") });
    let n = calls.length;
    const r2 = await upsertFile(client, store, "fleet", card(1), { name: "fleet.png", data: bytes("png-1") });
    const skipped = methods(n);
    n = calls.length;
    const r3 = await upsertFile(client, store, "fleet", card(1), { name: "fleet.png", data: bytes("png-2") });
    const swapped = methods(n);
    expect([
      [r1.action, r1.fileId, r1.deleted],
      [r2.action, r2.fileId, skipped],
      [r3.action, r3.fileId, r3.deleted, swapped],
      messages.map((m) => [m.ts, m.files]),
      [...files.keys()],
      (await store.get("fleet"))!.parent!.files,
      (messages[0]!.metadata!.event_payload as Record<string, unknown>)[FILE_HASH],
    ]).toEqual([
      ["POST", "F101", []],
      ["SKIP", "F101", []],
      ["EDIT", "F102", ["F101"], ["files.getUploadURLExternal", "upload_url", "files.completeUploadExternal", "files.info", "chat.update", "files.delete"]],
      [["101.000000", [{ id: "F102", name: "fleet.png" }]]],
      ["F102"],
      ["F102"],
      hash53Bytes(bytes("png-2")),
    ]);
  });

  it("a changed message with the same bytes still re-uploads and swaps (only an unchanged pair skips)", async () => {
    const { client, files } = fakeChannel();
    const store = memoryStore();
    await upsertFile(client, store, "fleet", "Fleet 1", { name: "f.png", data: bytes("same") });
    const r = await upsertFile(client, store, "fleet", "Fleet 2", { name: "f.png", data: bytes("same") });
    expect([r.action, r.fileId, r.deleted, [...files.keys()]]).toEqual(["EDIT", "F102", ["F101"], ["F102"]]);
  });

  it("with create: false and no record, posts nothing and uploads nothing", async () => {
    const { client, calls } = fakeChannel();
    const r = await upsertFile(client, memoryStore(), "fleet", "Fleet", { name: "f.png", data: bytes("x") }, { create: false });
    expect([r, calls.map((c) => c.method)]).toEqual([
      { status: "missing", ts: "", action: null, fileId: null, deleted: [], undeleted: [] },
      [],
    ]);
  });
});

describe("image blocks", () => {
  it("by URL, by Slack file id or URL; versionedUrl sets a cache-busting query param", () => {
    expect([
      image("https://x.test/fleet.png?sig=abc", "fleet"),
      image({ slackFile: "F1" }, "fleet"),
      image({ slackFileUrl: "https://files.slack.com/files-pri/T1-F1/f.png" }, "fleet", "Fleet"),
      versionedUrl("https://x.test/fleet.png?sig=abc", "2026-11-20T01"),
      versionedUrl("https://x.test/fleet.png?v=1", 2),
    ]).toEqual([
      { type: "image", alt_text: "fleet", image_url: "https://x.test/fleet.png?sig=abc" },
      { type: "image", alt_text: "fleet", slack_file: { id: "F1" } },
      { type: "image", alt_text: "fleet", slack_file: { url: "https://files.slack.com/files-pri/T1-F1/f.png" }, title: { type: "plain_text", text: "Fleet", emoji: true } },
      "https://x.test/fleet.png?sig=abc&v=2026-11-20T01",
      "https://x.test/fleet.png?v=2",
    ]);
  });
});
