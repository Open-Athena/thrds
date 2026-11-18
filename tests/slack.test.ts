import { describe, it, expect } from "vitest";
import { OrphanedRepliesError } from "../src/core";
import { SlackClient } from "../src/slack";

interface MockCall {
  url: string;
  method: string;
  body: unknown;
}

interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface MockOpts {
  routes: Record<string, MockResponseSpec | MockResponseSpec[]>;
  calls: MockCall[];
}

function makeMockFetch(opts: MockOpts): typeof fetch {
  const cursor: Record<string, number> = {};
  return async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET") as string;
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    opts.calls.push({ url, method, body });

    const endpoint = url.split("?")[0]!.replace(/^https:\/\/slack\.com\/api\//, "");
    const route = opts.routes[endpoint];
    if (route === undefined) {
      throw new Error(`unexpected endpoint: ${endpoint}`);
    }
    const spec = Array.isArray(route)
      ? route[cursor[endpoint] ?? 0]!
      : route;
    if (Array.isArray(route)) {
      cursor[endpoint] = (cursor[endpoint] ?? 0) + 1;
    }
    return new Response(
      typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body),
      {
        status: spec.status ?? 200,
        headers: spec.headers,
      },
    );
  };
}

function clientWith(routes: MockOpts["routes"]): {
  client: SlackClient;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const fetchImpl = makeMockFetch({ routes, calls });
  const client = new SlackClient({
    token: "xoxb-fake",
    channel: "C123",
    fetch: fetchImpl,
  });
  return { client, calls };
}

describe("SlackClient.list — editable detection", () => {
  it("marks own bot_message (user=null, bot_id=ours) as editable", async () => {
    const { client } = clientWith({
      "auth.test": { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [
            { ts: "1000.0", text: "from bot", user: null, bot_id: "B_BOT" },
          ],
        },
      },
    });
    const messages = await client.list("1000.0");
    expect(messages).toEqual([
      { id: "1000.0", content: "from bot", editable: true, botId: "B_BOT" },
    ]);
  });

  it("marks human reply as non-editable, keeps our OP editable", async () => {
    const { client } = clientWith({
      "auth.test": { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [
            { ts: "1000.0", text: "OP", user: null, bot_id: "B_BOT" },
            { ts: "1001.0", text: "hi", user: "U_HUMAN" },
          ],
        },
      },
    });
    const messages = await client.list("1000.0");
    expect(messages.map((m) => ({ id: m.id, editable: m.editable }))).toEqual([
      { id: "1000.0", editable: true },
      { id: "1001.0", editable: false },
    ]);
  });

  it("matches user_id for user-token posts", async () => {
    const { client } = clientWith({
      "auth.test": { body: { ok: true, user_id: "U_ME", bot_id: "B_BOT" } },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [{ ts: "1000.0", text: "as user", user: "U_ME" }],
        },
      },
    });
    const messages = await client.list("1000.0");
    expect(messages.map((m) => ({ id: m.id, editable: m.editable }))).toEqual([
      { id: "1000.0", editable: true },
    ]);
  });

  it("marks foreign bot (different bot_id) as non-editable", async () => {
    const { client } = clientWith({
      "auth.test": { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [
            { ts: "1000.0", text: "other", user: null, bot_id: "B_OTHER" },
          ],
        },
      },
    });
    const messages = await client.list("1000.0");
    expect(messages.map((m) => ({ id: m.id, editable: m.editable }))).toEqual([
      { id: "1000.0", editable: false },
    ]);
  });

  it("caches auth.test result across calls", async () => {
    const { client, calls } = clientWith({
      "auth.test": { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [{ ts: "1000.0", text: "x", user: null, bot_id: "B_BOT" }],
        },
      },
    });
    await client.list("1000.0");
    await client.list("1000.0");
    const authCalls = calls.filter((c) => c.url.includes("auth.test")).length;
    expect(authCalls).toBe(1);
  });
});

describe("SlackClient.delete — orphan guard", () => {
  it("blocks when message has replies", async () => {
    const { client, calls } = clientWith({
      "conversations.replies": {
        body: {
          ok: true,
          messages: [
            { ts: "1000.0", text: "parent" },
            { ts: "1001.0", text: "reply 1" },
            { ts: "1002.0", text: "reply 2" },
          ],
        },
      },
    });
    await expect(client.delete("1000.0")).rejects.toBeInstanceOf(
      OrphanedRepliesError,
    );
    const deleteCalls = calls.filter((c) => c.url.includes("chat.delete"));
    expect(deleteCalls).toEqual([]);
    try {
      await client.delete("1000.0");
    } catch (e) {
      expect(e).toBeInstanceOf(OrphanedRepliesError);
      expect((e as OrphanedRepliesError).messageId).toBe("1000.0");
      expect((e as OrphanedRepliesError).replyCount).toBe(2);
    }
  });

  it("proceeds when message has no replies", async () => {
    const { client, calls } = clientWith({
      "conversations.replies": {
        body: {
          ok: true,
          messages: [{ ts: "1000.0", text: "just me" }],
        },
      },
      "chat.delete": { body: { ok: true } },
    });
    await client.delete("1000.0");
    const deleteCalls = calls.filter((c) => c.url.includes("chat.delete"));
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]!.body).toEqual({ channel: "C123", ts: "1000.0" });
  });

  it("orphansOk: true skips the check", async () => {
    const { client, calls } = clientWith({
      "chat.delete": { body: { ok: true } },
    });
    await client.delete("1000.0", { orphansOk: true });
    const repliesCalls = calls.filter((c) =>
      c.url.includes("conversations.replies"),
    );
    expect(repliesCalls).toEqual([]);
    const deleteCalls = calls.filter((c) => c.url.includes("chat.delete"));
    expect(deleteCalls.length).toBe(1);
  });
});

describe("SlackClient.post — username & icon_emoji passthrough", () => {
  it("includes username and icon_emoji when set", async () => {
    const calls: MockCall[] = [];
    const fetchImpl = makeMockFetch({
      routes: {
        "chat.postMessage": { body: { ok: true, ts: "9.0" } },
      },
      calls,
    });
    const client = new SlackClient({
      token: "xoxb-fake",
      channel: "C123",
      username: "ctbk-bot",
      iconEmoji: ":bike:",
      fetch: fetchImpl,
    });
    await client.post("hello");
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toMatchObject({
      channel: "C123",
      text: "hello",
      username: "ctbk-bot",
      icon_emoji: ":bike:",
    });
  });

  it("omits username and icon_emoji when not set", async () => {
    const { client, calls } = clientWith({
      "chat.postMessage": { body: { ok: true, ts: "9.0" } },
    });
    await client.post("hello");
    const body = calls[0]!.body as Record<string, unknown>;
    expect("username" in body).toBe(false);
    expect("icon_emoji" in body).toBe(false);
  });
});

describe("SlackClient — 429 retry", () => {
  it("retries on 429 then succeeds", async () => {
    const { client, calls } = clientWith({
      "chat.postMessage": [
        { status: 429, headers: { "Retry-After": "0" }, body: "" },
        { body: { ok: true, ts: "9.0" } },
      ],
    });
    const result = await client.post("hi");
    expect(result.id).toBe("9.0");
    expect(calls.length).toBe(2);
  });
});

describe("SlackClient.permalink", () => {
  it("returns the permalink URL", async () => {
    const { client } = clientWith({
      "chat.getPermalink": {
        body: { ok: true, permalink: "https://slack.com/foo/p123" },
      },
    });
    expect(await client.permalink("123.0")).toBe(
      "https://slack.com/foo/p123",
    );
  });
});
