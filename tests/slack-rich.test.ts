import { describe, expect, it } from "vitest";
import { msgHash } from "../src/core";
import { section } from "../src/mrkdwn";
import { AUTH, client } from "./helpers";

const NO_UNFURL = { unfurl_links: false, unfurl_media: false };

describe("post: senders", () => {
  it("a message's sender overrides the client's; icon_url wins over icon_emoji; reply_broadcast only in a thread", async () => {
    const { client: c, calls } = client(
      { "chat.postMessage": { body: { ok: true, ts: "5.0" } } },
      { username: "bot", iconEmoji: ":robot_face:" },
    );
    await c.post("plain");
    await c.post({ text: "as ann", username: "Ann", iconUrl: "https://x/a.png", iconEmoji: ":smile:" }, "1.0");
    await c.post({ text: "broadcast", replyBroadcast: true }, "1.0");
    await c.post({ text: "top-level, no broadcast", replyBroadcast: true });
    expect(calls.map((c) => c.body)).toEqual([
      { channel: "C1", text: "plain", ...NO_UNFURL, username: "bot", icon_emoji: ":robot_face:" },
      { channel: "C1", text: "as ann", ...NO_UNFURL, username: "Ann", icon_url: "https://x/a.png", thread_ts: "1.0" },
      { channel: "C1", text: "broadcast", ...NO_UNFURL, username: "bot", icon_emoji: ":robot_face:", thread_ts: "1.0", reply_broadcast: true },
      { channel: "C1", text: "top-level, no broadcast", ...NO_UNFURL, username: "bot", icon_emoji: ":robot_face:" },
    ]);
  });

  it("parse / link_names apply to posts and edits", async () => {
    const { client: c, calls } = client(
      { "chat.postMessage": { body: { ok: true, ts: "5.0" } }, "chat.update": { body: { ok: true } } },
      { parse: "none", linkNames: false, suppressUnfurls: false },
    );
    await c.post("a");
    await c.edit("5.0", "b");
    expect(calls.map((c) => c.body)).toEqual([
      { channel: "C1", text: "a", unfurl_links: true, unfurl_media: true, parse: "none", link_names: false },
      { channel: "C1", text: "b", unfurl_links: true, unfurl_media: true, parse: "none", link_names: false, ts: "5.0" },
    ]);
  });
});

describe("rich messages (blocks / metadata)", () => {
  const blocks = [section("*hi*")];
  const rich = { text: "hi", blocks, metadata: { event_type: "digest", event_payload: { week: "2026-11-13" } } };
  const h = msgHash(rich);

  it("stamps a content hash into the metadata it sends", async () => {
    const { client: c, calls } = client({ "chat.postMessage": { body: { ok: true, ts: "5.0" } } });
    const sent = await c.post(rich);
    expect([sent, calls[0]!.body]).toEqual([
      { id: "5.0", content: "hi", key: `thrds:${h}` },
      {
        channel: "C1",
        text: "hi",
        ...NO_UNFURL,
        blocks,
        metadata: { event_type: "digest", event_payload: { week: "2026-11-13", thrds_hash: h } },
      },
    ]);
  });

  it("blocks without metadata get a `thrds` event to carry the hash", async () => {
    const { client: c, calls } = client({ "chat.postMessage": { body: { ok: true, ts: "5.0" } } });
    await c.post({ text: "hi", blocks });
    expect(calls[0]!.body["metadata"]).toEqual({ event_type: "thrds", event_payload: { thrds_hash: msgHash({ text: "hi", blocks }) } });
  });

  it("the hash ignores the sender and the stamp itself", () => {
    expect([
      msgHash({ ...rich, username: "Ann", iconUrl: "https://x/a.png" }),
      msgHash({ ...rich, metadata: { event_type: "digest", event_payload: { week: "2026-11-13", thrds_hash: "stale" } } }),
      msgHash({ ...rich, text: "changed" }) === h,
    ]).toEqual([h, h, false]);
  });

  it("sync skips an unchanged rich message and edits a changed one, by stamped hash (Slack rewrites blocks)", async () => {
    const live = (text: string, hash: string) => ({
      ts: text === "OP" ? "1.0" : "2.0",
      text,
      bot_id: "B_BOT",
      blocks: [{ type: "section", block_id: "slack-added", text: { type: "mrkdwn", text, verbatim: false } }],
      metadata: { event_type: "thrds", event_payload: { thrds_hash: hash } },
    });
    const op = { text: "OP", blocks: [section("OP")] };
    const reply = { text: "reply v2", blocks: [section("reply v2")] };
    const { client: c, calls } = client({
      "auth.test": AUTH,
      "conversations.replies": { body: { ok: true, messages: [live("OP", msgHash(op)), live("reply v1", "old")] } },
      "chat.update": { body: { ok: true } },
    });
    const result = await c.sync({ messages: [op, reply] }, { threadTs: "1.0" });
    expect([result.actions.map((a) => [a.type, a.messageId]), calls.map((c) => c.method)]).toEqual([
      [["SKIP", "1.0"], ["EDIT", "2.0"]],
      ["auth.test", "conversations.replies", "chat.update"],
    ]);
  });
});

describe("list", () => {
  it("reads every page with metadata, and what Slack says about each message", async () => {
    const { client: c, calls } = client({
      "auth.test": AUTH,
      "conversations.replies": (call) =>
        call.body["cursor"] === undefined
          ? {
              body: {
                ok: true,
                messages: [{ ts: "1.0", text: "OP", bot_id: "B_BOT", username: "Week of Nov 13", reply_count: 2, thread_ts: "1.0" }],
                response_metadata: { next_cursor: "p2" },
              },
            }
          : {
              body: {
                ok: true,
                messages: [
                  { ts: "2.0", text: "hi", user: "U_ANN", reactions: [{ name: "white_check_mark", count: 1, users: ["U_ANN"] }], thread_ts: "1.0" },
                  { ts: "3.0", text: "", subtype: "bot_message", bot_id: "B_OTHER", bot_profile: { name: "Other" }, thread_ts: "1.0" },
                ],
              },
            },
    });
    expect([await c.list("1.0"), calls.slice(1).map((c) => [c.http, c.body])]).toEqual([
      [
        { id: "1.0", content: "OP", editable: true, botId: "B_BOT", username: "Week of Nov 13", threadTs: "1.0", replyCount: 2 },
        { id: "2.0", content: "hi", editable: false, user: "U_ANN", threadTs: "1.0", reactions: [{ name: "white_check_mark", count: 1, users: ["U_ANN"] }] },
        { id: "3.0", content: "", editable: false, botId: "B_OTHER", username: "Other", subtype: "bot_message", threadTs: "1.0" },
      ],
      [
        ["GET", { channel: "C1", ts: "1.0", include_all_metadata: "true", limit: "200" }],
        ["GET", { channel: "C1", ts: "1.0", include_all_metadata: "true", limit: "200", cursor: "p2" }],
      ],
    ]);
  });

  it("findByMetadata scans history for a tagged message", async () => {
    const { client: c } = client({
      "auth.test": AUTH,
      "conversations.history": {
        body: {
          ok: true,
          messages: [
            { ts: "9.0", text: "other week", bot_id: "B_BOT", metadata: { event_type: "weekly_prompt", event_payload: { week: "2026-11-06" } } },
            { ts: "8.0", text: "this week", bot_id: "B_BOT", metadata: { event_type: "weekly_prompt", event_payload: { week: "2026-11-13" } } },
          ],
        },
      },
    });
    const hit = await c.findByMetadata("weekly_prompt", (p) => p["week"] === "2026-11-13");
    const miss = await c.findByMetadata("weekly_prompt", (p) => p["week"] === "2026-11-20");
    expect([hit?.id, miss]).toEqual(["8.0", null]);
  });
});

describe("users", () => {
  const ann = {
    ok: true,
    user: { id: "U_ANN", name: "ann", is_bot: false, tz: "America/New_York", profile: { real_name: "Ann Lee", display_name: "", email: "ann@x.org", image_48: "https://img/48", image_192: "https://img/192" } },
  };

  it("caches found users for an hour and misses for a minute; errors aren't cached", async () => {
    let now = 0;
    let lookups = 0;
    const { client: c } = client(
      {
        "users.lookupByEmail": (call) => {
          lookups++;
          return call.body["email"] === "ann@x.org" ? { body: ann } : { body: { ok: false, error: "users_not_found" } };
        },
      },
      { now: () => now },
    );
    const first = await c.userByEmail("Ann@X.org");
    await c.userByEmail("ann@x.org");
    expect(await c.userByEmail("nobody@x.org")).toBe(null);
    await c.userByEmail("nobody@x.org");
    const afterMinute = lookups;
    now = 61_000;
    await c.userByEmail("nobody@x.org");
    await c.userByEmail("ann@x.org");
    expect([first, afterMinute, lookups]).toEqual([
      { id: "U_ANN", name: "ann", realName: "Ann Lee", email: "ann@x.org", image: "https://img/192", images: { "48": "https://img/48", "192": "https://img/192" }, tz: "America/New_York", isBot: false, deleted: false },
      // Ann once (the mixed-case lookup normalizes), nobody once (cached as a miss).
      2,
      // A minute on: the miss expired and is looked up again; Ann is still cached.
      3,
    ]);
  });

  it("senderFor: the person's name and photo, suffixed and capped", async () => {
    const { client: c } = client({ "users.info": { body: ann } });
    expect([
      await c.senderFor("U_ANN"),
      await c.senderFor("U_ANN", { suffix: " (weekly update)", iconUrl: "https://bot/a/abc.png" }),
    ]).toEqual([
      { username: "Ann Lee", iconUrl: "https://img/192" },
      { username: "Ann Lee (weekly update)", iconUrl: "https://bot/a/abc.png" },
    ]);
  });

  it("scopes come from auth.test's header", async () => {
    const { client: c } = client({ "auth.test": { headers: { "x-oauth-scopes": "chat:write, chat:write.customize,users:read" }, body: { ok: true } } });
    expect([[...(await c.scopes())], await c.canCustomizeSender()]).toEqual([["chat:write", "chat:write.customize", "users:read"], true]);
  });
});

describe("channels, DMs, reactions, views", () => {
  it("channelId passes ids through and resolves names once", async () => {
    const { client: c, calls } = client({
      "conversations.list": { body: { ok: true, channels: [{ id: "C_ENG", name: "eng" }, { id: "G_OPS", name: "ops" }] } },
    });
    const got = [await c.channelId("C0884476QSC"), await c.channelId("#eng"), await c.channelId("ops")];
    const missing = await c.channelId("nope").catch((e) => e.code);
    expect([got, missing, calls.length]).toEqual([["C0884476QSC", "C_ENG", "G_OPS"], "channel_not_found", 1]);
  });

  it("in(channel) re-targets and shares caches", async () => {
    const { client: c, calls } = client({ "auth.test": AUTH, "chat.postMessage": { body: { ok: true, ts: "1.0" } } });
    await c.botIds();
    const dm = c.in("D_ANN");
    await dm.botIds();
    await dm.post("hi");
    expect(calls.map((c) => [c.method, c.body["channel"]])).toEqual([["auth.test", undefined], ["chat.postMessage", "D_ANN"]]);
  });

  it("openDm, react (idempotent), updateView", async () => {
    const { client: c, calls } = client({
      "conversations.open": { body: { ok: true, channel: { id: "D1" } } },
      "reactions.add": { body: { ok: false, error: "already_reacted" } },
      "views.update": { body: { ok: true, view: { id: "V1", hash: "h2" } } },
    });
    const dm = await c.openDm(["U1", "U2"]);
    await c.react("1.0", ":white_check_mark:");
    const view = await c.updateView({ type: "modal" }, { viewId: "V1", hash: "h1" });
    expect([dm, view, calls.map((c) => [c.method, c.body])]).toEqual([
      "D1",
      { id: "V1", hash: "h2" },
      [
        ["conversations.open", { users: "U1,U2" }],
        ["reactions.add", { channel: "C1", timestamp: "1.0", name: "white_check_mark" }],
        ["views.update", { view: { type: "modal" }, view_id: "V1", hash: "h1" }],
      ],
    ]);
  });
});
