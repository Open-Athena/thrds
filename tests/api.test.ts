import { describe, expect, it } from "vitest";
import { SlackApiError, collect, paginate, slackApi, type RetryInfo } from "../src/api";
import { fakeSleep, fakeSlack } from "./helpers";

const errorOf = async (p: Promise<unknown>): Promise<SlackApiError> => {
  try {
    await p;
  } catch (e) {
    return e as SlackApiError;
  }
  throw new Error("expected a rejection");
};
const fields = (e: SlackApiError) => ({ name: e.name, message: e.message, method: e.method, code: e.code, status: e.status });

describe("slackApi", () => {
  it("POSTs JSON with the bearer token, and GETs read methods as query parameters", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(input), method: init.method!, headers: init.headers as Record<string, string>, body: init.body });
      return new Response(JSON.stringify({ ok: true, ts: "1.0" }));
    }) as typeof fetch;
    await slackApi("xoxb-t", "chat.postMessage", { channel: "C1", text: "hi" }, { fetch: fetchImpl });
    await slackApi("xoxb-t", "users.lookupByEmail", { email: "a@b.org", skip: undefined, n: 2, o: { x: 1 } }, { fetch: fetchImpl, get: true });
    expect(seen).toEqual([
      {
        url: "https://slack.com/api/chat.postMessage",
        method: "POST",
        headers: { Authorization: "Bearer xoxb-t", "Content-Type": "application/json; charset=utf-8" },
        body: '{"channel":"C1","text":"hi"}',
      },
      {
        url: "https://slack.com/api/users.lookupByEmail?email=a%40b.org&n=2&o=%7B%22x%22%3A1%7D",
        method: "GET",
        headers: { Authorization: "Bearer xoxb-t" },
        body: undefined,
      },
    ]);
  });

  it("waits out HTTP 429 per Retry-After, then succeeds", async () => {
    const { fetch } = fakeSlack({
      "chat.postMessage": [
        { status: 429, headers: { "Retry-After": "7" }, body: "" },
        { body: { ok: true, ts: "1.0" } },
      ],
    });
    const { sleep, waits } = fakeSleep();
    const retries: RetryInfo[] = [];
    const json = await slackApi("t", "chat.postMessage", {}, { fetch, sleep, onRetry: (r) => retries.push(r) });
    expect([json, waits, retries]).toEqual([
      { ok: true, ts: "1.0" },
      [7000],
      [{ method: "chat.postMessage", attempt: 1, waitMs: 7000, reason: "http_429" }],
    ]);
  });

  it("retries an `ok:false, error:ratelimited` body (no header: 30s, then 60s)", async () => {
    const { fetch } = fakeSlack({
      "emoji.list": [
        { body: { ok: false, error: "ratelimited" } },
        { body: { ok: false, error: "ratelimited" } },
        { body: { ok: true, emoji: {} } },
      ],
    });
    const { sleep, waits } = fakeSleep();
    expect([await slackApi("t", "emoji.list", {}, { fetch, sleep }), waits]).toEqual([{ ok: true, emoji: {} }, [30000, 60000]]);
  });

  it("gives up after `retries`, as a ratelimited SlackApiError", async () => {
    const { fetch, calls } = fakeSlack({ "chat.update": { status: 429, headers: { "Retry-After": "0" }, body: "" } });
    const { sleep } = fakeSleep();
    const e = await errorOf(slackApi("t", "chat.update", {}, { fetch, sleep, retries: 2 }));
    expect([fields(e), calls.length]).toEqual([
      { name: "SlackApiError", message: "chat.update: ratelimited", method: "chat.update", code: "ratelimited", status: 429 },
      3,
    ]);
  });

  it("throws Slack's error code, keeping the response", async () => {
    const { fetch } = fakeSlack({ "chat.postMessage": { body: { ok: false, error: "channel_not_found" } } });
    const e = await errorOf(slackApi("t", "chat.postMessage", {}, { fetch }));
    expect([fields(e), e.response]).toEqual([
      { name: "SlackApiError", message: "chat.postMessage: channel_not_found", method: "chat.postMessage", code: "channel_not_found", status: 200 },
      { ok: false, error: "channel_not_found" },
    ]);
  });

  it("doesn't retry a 5xx by default (a write may have landed)", async () => {
    const { fetch, calls } = fakeSlack({ "chat.postMessage": { status: 502, body: "bad gateway" } });
    const e = await errorOf(slackApi("t", "chat.postMessage", {}, { fetch }));
    expect([e.code, calls.length]).toEqual(["http_502", 1]);
  });

  it("retries a 5xx with exponential backoff when asked", async () => {
    const { fetch } = fakeSlack({
      "conversations.history": [
        { status: 503, body: "" },
        { status: 500, body: "" },
        { body: { ok: true, messages: [] } },
      ],
    });
    const { sleep, waits } = fakeSleep();
    await slackApi("t", "conversations.history", {}, { fetch, sleep, retryServerErrors: true });
    expect(waits).toEqual([1000, 2000]);
  });
});

describe("paginate", () => {
  it("follows next_cursor until it's empty", async () => {
    const { fetch, calls } = fakeSlack({
      "users.list": (call) =>
        call.body["cursor"] === undefined
          ? { body: { ok: true, members: [{ id: "U1" }, { id: "U2" }], response_metadata: { next_cursor: "c2" } } }
          : { body: { ok: true, members: [{ id: "U3" }], response_metadata: { next_cursor: "" } } },
    });
    const items = await collect(
      paginate((cursor) => slackApi("t", "users.list", cursor ? { cursor } : {}, { fetch, get: true }), "members"),
    );
    expect([items, calls.map((c) => c.body)]).toEqual([[{ id: "U1" }, { id: "U2" }, { id: "U3" }], [{}, { cursor: "c2" }]]);
  });
});
