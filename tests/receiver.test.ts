import { describe, expect, it } from "vitest";
import {
  parseSlackBody,
  respond,
  slackHandler,
  slackSignature,
  verifySlackSignature,
  viewErrors,
  viewValues,
  type Interaction,
} from "../src/receiver";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_794_940_661;

async function signed(body: string, contentType: string, headers: Record<string, string> = {}, ts = NOW): Promise<Request> {
  return new Request("https://bot.example.org/slack", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": await slackSignature(SECRET, String(ts), body),
      ...headers,
    },
    body,
  });
}

describe("verifySlackSignature", () => {
  // Slack's documented example (api.slack.com/authentication/verifying-requests-from-slack).
  it("matches Slack's published test vector", async () => {
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    expect(await slackSignature(SECRET, "1531420618", body)).toBe("v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");
  });

  it("rejects missing headers, a stale timestamp, and a wrong signature", async () => {
    const sig = await slackSignature(SECRET, String(NOW), "x");
    const check = (o: Partial<Parameters<typeof verifySlackSignature>[0]>) =>
      verifySlackSignature({ signingSecret: SECRET, body: "x", timestamp: String(NOW), signature: sig, nowS: NOW, ...o });
    expect([
      await check({}),
      await check({ signature: null }),
      await check({ nowS: NOW + 301 }),
      await check({ timestamp: "soon" }),
      await check({ body: "y" }),
      await check({ signature: sig.slice(0, -1) }),
    ]).toEqual([
      { ok: true },
      { ok: false, reason: "missing_headers" },
      { ok: false, reason: "stale" },
      { ok: false, reason: "stale" },
      { ok: false, reason: "bad_signature" },
      { ok: false, reason: "bad_signature" },
    ]);
  });
});

describe("parseSlackBody", () => {
  it("events, url_verification, interactions, commands", () => {
    const payload = { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "approve", value: "42", type: "button" }] };
    expect([
      parseSlackBody('{"type":"url_verification","challenge":"c1"}', "application/json"),
      parseSlackBody('{"type":"event_callback","team_id":"T1","event_id":"Ev1","event":{"type":"reaction_added","reaction":"white_check_mark"}}', "application/json"),
      parseSlackBody(`payload=${encodeURIComponent(JSON.stringify(payload))}`, "application/x-www-form-urlencoded"),
      parseSlackBody("command=%2Fpoll&text=lunch%3F&user_id=U1&user_name=ann&channel_id=C1&channel_name=eng&team_id=T1&trigger_id=tr1&response_url=https%3A%2F%2Fhooks%2Fr", "application/x-www-form-urlencoded"),
    ]).toEqual([
      { kind: "url_verification", challenge: "c1" },
      {
        kind: "event",
        event: { type: "reaction_added", reaction: "white_check_mark" },
        eventId: "Ev1",
        teamId: "T1",
        raw: { type: "event_callback", team_id: "T1", event_id: "Ev1", event: { type: "reaction_added", reaction: "white_check_mark" } },
      },
      { kind: "interaction", payload },
      {
        kind: "command",
        command: { command: "/poll", text: "lunch?", userId: "U1", userName: "ann", channelId: "C1", channelName: "eng", teamId: "T1", triggerId: "tr1", responseUrl: "https://hooks/r" },
        raw: { command: "/poll", text: "lunch?", user_id: "U1", user_name: "ann", channel_id: "C1", channel_name: "eng", team_id: "T1", trigger_id: "tr1", response_url: "https://hooks/r" },
      },
    ]);
  });

  it("viewValues flattens a submission's inputs", () => {
    const payload: Interaction = {
      type: "view_submission",
      view: {
        id: "V1",
        state: {
          values: {
            b1: { did: { type: "plain_text_input", value: "shipped disky" } },
            b2: { who: { type: "users_select", selected_user: "U2" } },
            b3: { tags: { type: "multi_static_select", selected_options: [{ value: "infra" }, { value: "auth" }] } },
            b4: { when: { type: "datepicker", selected_date: "2026-11-13" } },
            b5: { empty: { type: "plain_text_input", value: null } },
          },
        },
      },
    };
    expect(viewValues(payload)).toEqual({ did: "shipped disky", who: "U2", tags: ["infra", "auth"], when: "2026-11-13", empty: null });
  });
});

describe("slackHandler", () => {
  it("answers url_verification, rejects bad signatures, and acks events without waiting on them", async () => {
    const ran: string[] = [];
    const later: Promise<unknown>[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const handler = slackHandler({
      signingSecret: SECRET,
      nowS: () => NOW,
      waitUntil: (p) => void later.push(p),
      onEvent: async (b) => {
        await gate;
        ran.push(String(b.event["type"]));
      },
    });
    const challenge = await handler(await signed('{"type":"url_verification","challenge":"c1"}', "application/json"));
    const forged = await handler(await signed("{}", "application/json", { "x-slack-signature": "v0=00" }));
    const ev = '{"type":"event_callback","event_id":"E1","team_id":"T1","event":{"type":"app_mention"}}';
    const event = await handler(await signed(ev, "application/json"));
    const ranAtAck = [...ran];
    open();
    await Promise.all(later);
    const retry = await handler(await signed(ev, "application/json", { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" }));
    await Promise.all(later);
    expect([
      [challenge.status, await challenge.json()],
      [forged.status, await forged.text()],
      event.status,
      ranAtAck,
      ran,
      retry.status,
    ]).toEqual([[200, { challenge: "c1" }], [401, "invalid request (bad_signature)\n"], 200, [], ["app_mention"], 200]);
  });

  it("returns an interaction handler's JSON reply (view errors), and acks an empty one", async () => {
    const handler = slackHandler({
      signingSecret: SECRET,
      nowS: () => NOW,
      onInteraction: (p) => (p.type === "view_submission" ? viewErrors({ b1: "Required" }) : undefined),
      onCommand: (c) => ({ response_type: "ephemeral", text: `got ${c.text}` }),
    });
    const form = (o: unknown) => `payload=${encodeURIComponent(JSON.stringify(o))}`;
    const submit = await handler(await signed(form({ type: "view_submission", view: { id: "V1" } }), "application/x-www-form-urlencoded"));
    const click = await handler(await signed(form({ type: "block_actions" }), "application/x-www-form-urlencoded"));
    const cmd = await handler(await signed("command=%2Fx&text=hi", "application/x-www-form-urlencoded"));
    expect([await submit.json(), [click.status, await click.text()], await cmd.json()]).toEqual([
      { response_action: "errors", errors: { b1: "Required" } },
      [200, ""],
      { response_type: "ephemeral", text: "got hi" },
    ]);
  });
});

describe("respond", () => {
  it("POSTs to the response_url", async () => {
    const seen: Array<[string, unknown]> = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      seen.push([String(url), JSON.parse(init.body as string)]);
      return new Response("ok");
    }) as typeof fetch;
    await respond("https://hooks.slack.com/actions/T/1/x", { text: "Done", blocks: [] }, { replaceOriginal: true, fetch: fetchImpl });
    await respond("https://hooks.slack.com/actions/T/1/x", null, { deleteOriginal: true, fetch: fetchImpl });
    expect(seen).toEqual([
      ["https://hooks.slack.com/actions/T/1/x", { response_type: "ephemeral", text: "Done", blocks: [], replace_original: true }],
      ["https://hooks.slack.com/actions/T/1/x", { response_type: "ephemeral", delete_original: true }],
    ]);
  });
});
