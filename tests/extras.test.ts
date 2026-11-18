import { describe, expect, it } from "vitest";
import { badgedAvatarUrl, BADGES, memoryAvatarStore, serviceIconPng } from "../src/avatar";
import { durableObjectStore, kvStore, type KVLike } from "../src/kv";
import { bound, datePicker, fitsPrivateMetadata, image, input, link, modal, plainTextInput, rich, section, staticSelect, withoutImages } from "../src/mrkdwn";
import { parsePermalink, permalinksIn, withoutPermalinks } from "../src/permalink";
import { isBlockActions, parseSlackBody, slackHandler, slackSignature, verifySlackSignature, viewValues, type Interaction } from "../src/receiver";
import { syncSlots } from "../src/slots";
import { fakeChannel } from "./helpers";

describe("receiver hardening", () => {
  it("an empty signing secret fails closed as `missing_secret`, not a Web Crypto throw", async () => {
    expect(await verifySlackSignature({ signingSecret: "", body: "x", timestamp: "1", signature: "v0=00" })).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("a malformed payload is `unknown` (400), not a 500", async () => {
    const body = "payload=%7Bnot-json";
    const parsed = parseSlackBody(body, "application/x-www-form-urlencoded");
    const handler = slackHandler({ signingSecret: "s", nowS: () => 100, onInteraction: () => undefined });
    const r = await handler(
      new Request("https://x/slack", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": "100", "x-slack-signature": await slackSignature("s", "100", body) },
        body,
      }),
    );
    expect([parsed, r.status]).toEqual([{ kind: "unknown", raw: body }, 400]);
  });

  it("deferred failures are reported, by default to console.error", async () => {
    const errors: unknown[] = [];
    const body = '{"type":"event_callback","event_id":"E","team_id":"T","event":{"type":"x"}}';
    const handler = slackHandler({ signingSecret: "s", nowS: () => 100, onEvent: () => Promise.reject(new Error("boom")), onError: (e) => errors.push((e as Error).message) });
    await handler(
      new Request("https://x/slack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-slack-request-timestamp": "100", "x-slack-signature": await slackSignature("s", "100", body) },
        body,
      }),
    );
    expect(errors).toEqual(["boom"]);
  });

  it("viewValues by block (when every input shares an action id); typed payload guards", () => {
    const p: Interaction = {
      type: "view_submission",
      view: { id: "V", state: { values: { name: { v: { type: "plain_text_input", value: "Ann" } }, role: { v: { type: "static_select", selected_option: { value: "eng" } } } } } },
    };
    expect([viewValues(p), viewValues<{ name: string; role: string }>(p, { by: "block" }), isBlockActions(p)]).toEqual([{ v: "eng" }, { name: "Ann", role: "eng" }, false]);
  });
});

describe("builders", () => {
  it("bound at a line break; link encodes `<`; private_metadata fit check", () => {
    expect([
      bound("line one\nline two\nline three", 20, { atLine: true }),
      bound("no breaks here at all", 10, { atLine: true }),
      link("https://x/<a>", "x"),
      fitsPrivateMetadata({ a: "x".repeat(2990) }),
      fitsPrivateMetadata({ a: "x".repeat(3000) }),
    ]).toEqual(["line one\nline two\n…", "no breaks…", "<https://x/%3Ca%3E|x>", true, false]);
  });

  it("withoutImages drops image blocks and image accessories", () => {
    const msg = { text: "t", blocks: [section("a", { accessory: { type: "image", image_url: "u", alt_text: "x" } }), image("u", "x"), section("b")] };
    expect(withoutImages(msg)).toEqual({ text: "t", blocks: [{ type: "section", text: { type: "mrkdwn", text: "a" } }, { type: "section", text: { type: "mrkdwn", text: "b" } }] });
  });

  it("modal inputs", () => {
    expect(
      modal({
        title: "Weekly update for the week of",
        submit: "Send",
        callbackId: "weekly",
        blocks: [
          input({ label: "What did you do?", blockId: "did", element: plainTextInput({ actionId: "v", multiline: true }) }),
          input({ label: "Team", blockId: "team", optional: true, element: staticSelect({ actionId: "v", options: [["Eng", "eng"], ["Ops", "ops"]], initial: "ops" }) }),
          input({ label: "When", blockId: "when", element: datePicker({ actionId: "v", initial: "2026-11-13" }) }),
        ],
      }),
    ).toEqual({
      type: "modal",
      title: { type: "plain_text", text: "Weekly update for the w…", emoji: true },
      blocks: [
        { type: "input", label: { type: "plain_text", text: "What did you do?", emoji: true }, element: { type: "plain_text_input", action_id: "v", multiline: true }, block_id: "did" },
        {
          type: "input",
          label: { type: "plain_text", text: "Team", emoji: true },
          element: {
            type: "static_select",
            action_id: "v",
            options: [{ text: { type: "plain_text", text: "Eng", emoji: true }, value: "eng" }, { text: { type: "plain_text", text: "Ops", emoji: true }, value: "ops" }],
            initial_option: { text: { type: "plain_text", text: "Ops", emoji: true }, value: "ops" },
          },
          block_id: "team",
          optional: true,
        },
        { type: "input", label: { type: "plain_text", text: "When", emoji: true }, element: { type: "datepicker", action_id: "v", initial_date: "2026-11-13" }, block_id: "when" },
      ],
      submit: { type: "plain_text", text: "Send", emoji: true },
      callback_id: "weekly",
    });
  });

  it("rich_text: literal emoji inside links, real lists", () => {
    expect(rich.block(rich.section(rich.link("https://gh/pr/1", "⭐ PR #1", { bold: true }), " by ", rich.user("U1")), rich.list([rich.section("a"), rich.section(rich.emoji(":bell:"), "b")]))).toEqual({
      type: "rich_text",
      elements: [
        { type: "rich_text_section", elements: [{ type: "link", url: "https://gh/pr/1", text: "⭐ PR #1", style: { bold: true } }, { type: "text", text: " by " }, { type: "user", user_id: "U1" }] },
        {
          type: "rich_text_list",
          style: "bullet",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "a" }] },
            { type: "rich_text_section", elements: [{ type: "emoji", name: "bell" }, { type: "text", text: "b" }] },
          ],
        },
      ],
    });
  });
});

describe("permalinks in text", () => {
  const p1 = "https://openathena.slack.com/archives/C1/p1700000000123456";
  it("parse tolerates prose punctuation, mrkdwn `&amp;`, and slack-gov.com", () => {
    expect([
      parsePermalink(`${p1}.`),
      parsePermalink(`${p1}?thread_ts=1700000000.000100&amp;cid=C1`),
      parsePermalink("https://agency.slack-gov.com/archives/C2/p1700000000123456"),
    ]).toEqual([
      { channel: "C1", ts: "1700000000.123456" },
      { channel: "C1", ts: "1700000000.123456", threadTs: "1700000000.000100" },
      { channel: "C2", ts: "1700000000.123456" },
    ]);
  });

  it("permalinksIn finds bare and `<url|label>` links once each; withoutPermalinks strips them", () => {
    const text = `move <${p1}|this> and ${p1}. also https://example.org/x`;
    expect([permalinksIn(text), withoutPermalinks(text)]).toEqual([
      [{ channel: "C1", ts: "1700000000.123456", url: p1 }],
      "move and . also https://example.org/x",
    ]);
  });
});

describe("stores", () => {
  it("durableObjectStore keeps structured state, no leases", async () => {
    const data = new Map<string, unknown>();
    const store = durableObjectStore({ get: async (k) => data.get(k) as never, put: async (k, v) => void data.set(k, v) });
    const { client } = fakeChannel();
    await syncSlots(client, store, { key: "week:1", parent: "3 emoji" });
    expect([[...data.keys()], (data.get("slots/week:1") as { parent: { ts: string } }).parent.ts]).toEqual([["slots/week:1"], "101.000000"]);
    await expect(syncSlots(client, store, { key: "week:1", parent: "x" }, { leaseS: 5 })).rejects.toThrow("`leaseS` needs a store with `claim`");
  });

  it("kvStore with a codec reads an existing record's shape (fleet's `{channel, ts}`)", async () => {
    const data = new Map<string, string>([["fleet:msg", '{"channel":"C1","ts":"9.000000"}']]);
    const kv: KVLike = { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
    const store = kvStore(kv, {
      prefix: "",
      codec: {
        decode: (raw) => {
          const { channel, ts, hash = "" } = JSON.parse(raw);
          return { channel, parent: { ts, hash }, slots: {} };
        },
        encode: (s) => JSON.stringify({ channel: s.channel, ts: s.parent?.ts, hash: s.parent?.hash }),
      },
    });
    expect(await store.get("fleet:msg")).toEqual({ channel: "C1", parent: { ts: "9.000000", hash: "" }, slots: {} });
  });
});

describe("avatar memo for byte faces", () => {
  it("memoKey lets an identicon face render once", async () => {
    let renders = 0;
    const opts = { store: memoryAvatarStore(), origin: "https://x.org", rasterize: () => (renders++, serviceIconPng(16)), memo: new Map<string, string>(), memoKey: "id:ann@x.org" };
    const face = { type: "image/png", bytes: serviceIconPng(8) };
    const a = await badgedAvatarUrl(face, BADGES.staged, opts);
    const b = await badgedAvatarUrl(face, BADGES.staged, opts);
    expect([a === b, renders]).toEqual([true, 1]);
  });
});
