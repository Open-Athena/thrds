import { describe, expect, it } from "vitest";
import { SlackApiError, slackApi } from "../src/api";
import { msgHash } from "../src/core";
import { section } from "../src/mrkdwn";
import { SlackClient, webClientTransport } from "../src/slack";
import { AUTH, client, fakeSleep, fakeSlack, timeoutError } from "./helpers";

const fields = (e: SlackApiError) => ({ message: e.message, code: e.code, kind: e.kind, definite: e.definite, slackCode: e.slackCode, retryAfterS: e.retryAfterS });

describe("transport", () => {
  it("never retries a write that may have landed (5xx / timeout on chat.postMessage), even with retryServerErrors", async () => {
    const { fetch, calls } = fakeSlack({
      "chat.postMessage": { status: 503, body: "" },
      "chat.update": [{ status: 503, body: "" }, { body: { ok: true } }],
    });
    const { sleep } = fakeSleep();
    const post = await slackApi("t", "chat.postMessage", {}, { fetch, sleep, retryServerErrors: true }).catch((e) => e.code);
    await slackApi("t", "chat.update", {}, { fetch, sleep, retryServerErrors: true });
    expect([post, calls.map((c) => c.method)]).toEqual(["http_503", ["chat.postMessage", "chat.update", "chat.update"]]);
  });

  it("caps retry waits (maxRetryWaitMs) and total time (deadlineMs), surfacing Retry-After", async () => {
    const { fetch } = fakeSlack({ "chat.update": { status: 429, headers: { "Retry-After": "120" }, body: "" } });
    const { sleep, waits } = fakeSleep();
    const capped = await slackApi("t", "chat.update", {}, { fetch, sleep, maxRetryWaitMs: 10_000 }).catch((e) => fields(e));
    let t = 0;
    const { fetch: f2 } = fakeSlack({ "emoji.list": { body: { ok: false, error: "ratelimited" } } });
    const deadline = await slackApi("t", "emoji.list", {}, { fetch: f2, sleep: async (ms) => void (t += ms), now: () => t, deadlineMs: 45_000 }).catch((e) => e.code);
    expect([capped, waits, deadline, t]).toEqual([
      { message: "chat.update: ratelimited", code: "ratelimited", kind: "slack", definite: true, slackCode: undefined, retryAfterS: 120 },
      [],
      "ratelimited",
      30_000,
    ]);
  });

  it("classifies failures, and keeps unexpected error strings out of messages", async () => {
    const { fetch } = fakeSlack({
      "a.refused": { body: { ok: false, error: "not_in_channel" } },
      "a.weird": { body: { ok: false, error: "<script>bad stuff</script>" } },
      "a.server": { status: 502, body: "" },
      "a.client": { status: 404, body: "" },
      "a.slow": () => {
        throw timeoutError();
      },
      "a.net": () => {
        throw new TypeError("fetch failed");
      },
    });
    const fail = (m: string) => slackApi("t", m, {}, { fetch }).catch((e) => fields(e));
    expect(await Promise.all(["a.refused", "a.weird", "a.server", "a.client", "a.slow", "a.net"].map(fail))).toEqual([
      { message: "a.refused: not_in_channel", code: "not_in_channel", kind: "slack", definite: true, slackCode: "not_in_channel", retryAfterS: undefined },
      { message: "a.weird: unknown_error", code: "<script>bad stuff</script>", kind: "slack", definite: true, slackCode: undefined, retryAfterS: undefined },
      { message: "a.server: http_502", code: "http_502", kind: "http", definite: false, slackCode: undefined, retryAfterS: undefined },
      { message: "a.client: http_404", code: "http_404", kind: "http", definite: true, slackCode: undefined, retryAfterS: undefined },
      { message: "a.slow: timeout", code: "timeout", kind: "timeout", definite: false, slackCode: undefined, retryAfterS: undefined },
      { message: "a.net: transport_error", code: "transport_error", kind: "transport", definite: false, slackCode: undefined, retryAfterS: undefined },
    ]);
  });

  it("beforeCall can veto a call (a channel blocklist); form bodies; a per-call token", async () => {
    const seen: Array<[string, string | null, string]> = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const h = init.headers as Record<string, string>;
      seen.push([String(input), h["Content-Type"] ?? null, `${h["Authorization"]} ${init.body}`]);
      return new Response('{"ok":true}');
    }) as typeof fetch;
    const beforeCall = (method: string, body: Record<string, unknown>) => {
      if (method.startsWith("chat.") && body["channel"] === "C_OUTSIDERS") throw new Error(`refusing ${method} to C_OUTSIDERS`);
    };
    const blocked = await slackApi("t", "chat.postMessage", { channel: "C_OUTSIDERS" }, { fetch: fetchImpl, beforeCall }).catch((e) => e.message);
    await slackApi("t", "usergroups.users.update", { usergroup: "S1", users: "U1,U2" }, { fetch: fetchImpl, form: true, beforeCall });
    await slackApi("bot", "chat.delete", { channel: "C1", ts: "1.0" }, { fetch: fetchImpl, token: "xoxp-user" });
    expect([blocked, seen]).toEqual([
      "refusing chat.postMessage to C_OUTSIDERS",
      [
        ["https://slack.com/api/usergroups.users.update", "application/x-www-form-urlencoded", "Bearer t usergroup=S1&users=U1%2CU2"],
        ["https://slack.com/api/chat.delete", "application/json; charset=utf-8", 'Bearer xoxp-user {"channel":"C1","ts":"1.0"}'],
      ],
    ]);
  });
});

describe("messages", () => {
  it("unfurl: client default, `omit`, per-message override; attachments; `stamp: false`; username capped at 80", async () => {
    const { client: c, calls } = client({ "chat.postMessage": { body: { ok: true, ts: "5.0" } } }, { unfurl: "omit" });
    await c.post({ text: "a", unfurl: { links: false } });
    await c.post({ text: "b", attachments: [{ color: "#f00", text: "x" }], stamp: false });
    await c.post({ text: "c", username: "x".repeat(90) });
    await c.with({ unfurl: true }).post("d");
    expect(calls.map((c) => c.body)).toEqual([
      { channel: "C1", text: "a", unfurl_links: false },
      { channel: "C1", text: "b", attachments: [{ color: "#f00", text: "x" }] },
      { channel: "C1", text: "c", username: "x".repeat(80) },
      { channel: "C1", text: "d", unfurl_links: true, unfurl_media: true },
    ]);
  });

  it("a client-wide `stamp: false` sends a caller's metadata untouched (a message's own `stamp` wins)", async () => {
    const { client: c, calls } = client({ "chat.postMessage": { body: { ok: true, ts: "5.0" } } }, { stamp: false });
    const metadata = { event_type: "staged_plan", event_payload: { plan: 7 } };
    await c.post({ text: "a", blocks: [], metadata });
    await c.post({ text: "b", blocks: [], stamp: true });
    expect(calls.map((x) => x.body["metadata"])).toEqual([metadata, { event_type: "thrds", event_payload: { thrds_hash: msgHash({ text: "b", blocks: [], stamp: true }) } }]);
  });

  it("attachments make a message rich (hash-stamped), so sync compares them", () => {
    expect([msgHash({ text: "a", attachments: [1] }) === msgHash({ text: "a", attachments: [2] })]).toEqual([false]);
  });

  it("ephemerals carry no metadata (they can't be read back)", async () => {
    const { client: c, calls } = client({ "chat.postEphemeral": { body: { ok: true, message_ts: "6.0" } } });
    await c.postEphemeral("U1", { text: "preview", blocks: [section("*x*")], metadata: { event_type: "e", event_payload: {} } });
    expect(calls[0]!.body).toEqual({ channel: "C1", text: "preview", unfurl_links: false, unfurl_media: false, blocks: [section("*x*")], user: "U1" });
  });

  it("a post reply without a ts throws (recording it would double-post next run)", async () => {
    const { client: c } = client({ "chat.postMessage": { body: { ok: true } } });
    expect(await c.post("x").catch((e) => [e.code, e.kind])).toEqual(["invalid_response", "http"]);
  });

  it("message(ts) reads one message cheaply; null once it's gone", async () => {
    const { client: c, calls } = client({
      "auth.test": AUTH,
      "conversations.replies": ({ body }) =>
        body["ts"] === "1.0"
          ? { body: { ok: true, messages: [{ ts: "1.0", text: "plan", bot_id: "B_BOT", reply_count: 4, reactions: [{ name: "white_check_mark", count: 1, users: ["U1"] }] }] } }
          : { body: { ok: false, error: "thread_not_found" } },
    });
    expect([await c.message("1.0"), await c.message("2.0"), calls[0]!.body]).toEqual([
      { id: "1.0", content: "plan", editable: true, botId: "B_BOT", replyCount: 4, reactions: [{ name: "white_check_mark", count: 1, users: ["U1"] }] },
      null,
      { channel: "C1", ts: "1.0", limit: "1", include_all_metadata: "true" },
    ]);
  });

  it("delete's orphan check explains a token without history scope", async () => {
    const { client: c } = client({ "conversations.replies": { body: { ok: false, error: "missing_scope" } } });
    expect(await c.delete("1.0").catch((e) => e.message)).toBe(
      "delete: the orphaned-replies check (conversations.replies) needs a history scope on this token; check replyCount() with a client that has one, then pass { orphansOk: true }",
    );
  });

  it("minIntervalMs spaces writes across sibling clients, not reads", async () => {
    let t = 0;
    const { client: c } = client(
      { "chat.postMessage": { body: { ok: true, ts: "1.0" } }, "users.info": { body: { ok: true, user: { id: "U1" } } } },
      { minIntervalMs: 400, now: () => t, sleep: async (ms) => void (t += ms) },
    );
    await c.post("a");
    await c.in("C2").post("b");
    await c.userInfo("U1");
    await c.post("c");
    expect(t).toBe(800);
  });
});

describe("people and channels", () => {
  const ann = { ok: true, user: { id: "U_ANN", name: "ann", deleted: true, profile: { real_name: "Ann", email: "ann@x.org", image_192: "https://img/192", image_512: "https://img/512" } } };

  it("concurrent lookups share one request; `fresh` bypasses the cache", async () => {
    let n = 0;
    const { client: c } = client({ "users.info": () => (n++, { body: ann }) });
    await Promise.all([c.userInfo("U_ANN"), c.userInfo("U_ANN"), c.userInfo("U_ANN")]);
    await c.userInfo("U_ANN");
    await c.userInfo("U_ANN", { fresh: true });
    expect(n).toBe(2);
  });

  it("senderFor: by email too; deactivated users only on request; a chosen image size", async () => {
    const { client: c } = client({ "users.lookupByEmail": { body: ann }, "users.info": { body: ann } });
    expect([await c.senderFor("U_ANN"), await c.senderFor("ann@x.org", { includeDeleted: true, imageSize: "512" })]).toEqual([
      null,
      { username: "Ann", iconUrl: "https://img/512" },
    ]);
  });

  it("usergroupMembers by handle or id", async () => {
    const { client: c, calls } = client({
      "usergroups.list": { body: { ok: true, usergroups: [{ id: "S_LEADS", handle: "eng-leads" }] } },
      "usergroups.users.list": { body: { ok: true, users: ["U1", "U2"] } },
    });
    expect([await c.usergroupMembers("@eng-leads"), await c.usergroupMembers("S0OTHER"), await c.usergroupMembers("nope").catch((e) => e.code), calls.map((x) => [x.method, x.body["usergroup"] ?? null])]).toEqual([
      ["U1", "U2"],
      ["U1", "U2"],
      "no_such_subteam",
      [["usergroups.list", null], ["usergroups.users.list", "S_LEADS"], ["usergroups.users.list", "S0OTHER"], ["usergroups.list", null]],
    ]);
  });

  it("channelId: cached for an hour, re-listed after (or on `refresh` / `invalidateChannels`), archived on request", async () => {
    let t = 0;
    let lists = 0;
    const { client: c, calls } = client(
      { "conversations.list": () => (lists++, { body: { ok: true, channels: [{ id: `C_REC${lists}`, name: "recruiting" }] } }) },
      { now: () => t },
    );
    const a = await c.channelId("#recruiting");
    const cached = await c.channelId("recruiting");
    t = 3_600_001;
    const relisted = await c.channelId("recruiting");
    c.invalidateChannels();
    const afterInvalidate = await c.channelId("recruiting");
    await c.channelId("recruiting", { includeArchived: true });
    expect([[a, cached, relisted, afterInvalidate], calls.map((x) => x.body["exclude_archived"])]).toEqual([
      ["C_REC1", "C_REC1", "C_REC2", "C_REC3"],
      ["true", "true", "true", "false"],
    ]);
  });
});

describe("webClientTransport (Bolt)", () => {
  it("runs SlackClient over a WebClient: results, scopes from response_metadata, errors as SlackApiError", async () => {
    const calls: Array<[string, unknown]> = [];
    const web = {
      async apiCall(method: string, args?: Record<string, unknown>) {
        calls.push([method, args]);
        if (method === "auth.test") return { ok: true, user_id: "U_BOT", bot_id: "B_BOT", response_metadata: { scopes: ["chat:write", "chat:write.customize"] } };
        if (method === "chat.postMessage") return { ok: true, ts: "9.0" };
        throw Object.assign(new Error("An API error occurred: not_in_channel"), { data: { ok: false, error: "not_in_channel" } });
      },
    };
    const c = new SlackClient({ token: "unused", channel: "C1", transport: webClientTransport(web) });
    const posted = await c.post("hi");
    const can = await c.canCustomizeSender();
    const err = await c.react("9.0", "eyes").catch((e) => [e instanceof SlackApiError, e.code, e.definite]);
    expect([posted, can, err, calls.map(([m]) => m)]).toEqual([{ id: "9.0", content: "hi" }, true, [true, "not_in_channel", true], ["chat.postMessage", "auth.test", "reactions.add"]]);
  });
});
