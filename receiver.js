import {
  toMsg
} from "./chunk-ZJWW4GA7.js";
import "./chunk-YSTFV535.js";

// src/receiver.ts
var hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
function constantTimeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}
async function slackSignature(signingSecret, timestamp, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v0=${hex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`)))}`;
}
async function verifySlackSignature(input) {
  const { signingSecret, body, timestamp, signature, toleranceS = 300 } = input;
  if (!signingSecret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const ts = Number(timestamp);
  const nowS = input.nowS ?? Math.floor(Date.now() / 1e3);
  if (!Number.isInteger(ts) || Math.abs(nowS - ts) > toleranceS) return { ok: false, reason: "stale" };
  const expected = await slackSignature(signingSecret, timestamp, body);
  return constantTimeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "bad_signature" };
}
async function verifySlackRequest(request, signingSecret, options = {}) {
  const body = await request.text();
  const result = await verifySlackSignature({
    signingSecret,
    body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    ...options
  });
  return result.ok ? { ok: true, body } : result;
}
var isBlockActions = (p) => p.type === "block_actions";
var isViewSubmission = (p) => p.type === "view_submission";
var isMessageAction = (p) => p.type === "message_action";
var isShortcut = (p) => p.type === "shortcut";
function parseSlackBody(body, contentType) {
  try {
    return parseBody(body, contentType);
  } catch {
    return { kind: "unknown", raw: body };
  }
}
function parseBody(body, contentType) {
  if ((contentType ?? "").includes("application/json")) {
    const json2 = JSON.parse(body);
    if (json2["type"] === "url_verification") return { kind: "url_verification", challenge: String(json2["challenge"]) };
    if (json2["type"] === "event_callback") {
      return {
        kind: "event",
        event: json2["event"],
        eventId: String(json2["event_id"] ?? ""),
        teamId: String(json2["team_id"] ?? ""),
        raw: json2
      };
    }
    return { kind: "unknown", raw: json2 };
  }
  const form = Object.fromEntries(new URLSearchParams(body));
  if (form["payload"] !== void 0) return { kind: "interaction", payload: JSON.parse(form["payload"]) };
  if (form["command"] !== void 0) {
    return {
      kind: "command",
      command: {
        command: form["command"],
        text: form["text"] ?? "",
        userId: form["user_id"] ?? "",
        userName: form["user_name"] ?? "",
        channelId: form["channel_id"] ?? "",
        channelName: form["channel_name"] ?? "",
        teamId: form["team_id"] ?? "",
        triggerId: form["trigger_id"] ?? "",
        responseUrl: form["response_url"] ?? ""
      },
      raw: form
    };
  }
  return { kind: "unknown", raw: form };
}
function viewValues(payload, options = {}) {
  const out = {};
  for (const [blockId, block] of Object.entries(payload.view?.state?.values ?? {})) {
    for (const [actionId, raw] of Object.entries(block)) {
      const v = raw;
      out[options.by === "block" ? blockId : actionId] = v["value"] ?? v["selected_option"]?.value ?? v["selected_options"]?.map((o) => o.value) ?? v["selected_user"] ?? v["selected_users"] ?? v["selected_channel"] ?? v["selected_conversation"] ?? v["selected_date"] ?? v["selected_time"] ?? v["selected_date_time"] ?? null;
    }
  }
  return out;
}
async function respond(responseUrl, m, options = {}) {
  const { responseType = "ephemeral", replaceOriginal, deleteOriginal, threadTs, fetch: fetchImpl = globalThis.fetch } = options;
  const body = { response_type: responseType };
  if (m !== null) {
    const msg = toMsg(m);
    body["text"] = msg.text;
    if (msg.blocks !== void 0) body["blocks"] = msg.blocks;
  }
  if (replaceOriginal !== void 0) body["replace_original"] = replaceOriginal;
  if (deleteOriginal !== void 0) body["delete_original"] = deleteOriginal;
  if (threadTs !== void 0) body["thread_ts"] = threadTs;
  const r = await fetchImpl(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1e4)
  });
  if (!r.ok) throw new Error(`response_url: HTTP ${r.status}`);
}
var viewErrors = (errors) => ({ response_action: "errors", errors });
var ack = () => new Response(null, { status: 200 });
var json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
function slackHandler(options) {
  const { signingSecret, onEvent, onInteraction, onCommand, ignoreEventRetries = true, onError = (e) => console.error("slackHandler:", e) } = options;
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const contentType = request.headers.get("content-type");
    const verified = await verifySlackRequest(request, signingSecret, options.nowS ? { nowS: options.nowS() } : {});
    if (!verified.ok) return new Response(`invalid request (${verified.reason})
`, { status: 401 });
    const retryNum = Number(request.headers.get("x-slack-retry-num") ?? 0);
    const pending = [];
    const guard = (p) => p.catch((e) => onError(e));
    const ctx = {
      request,
      retryNum,
      retryReason: request.headers.get("x-slack-retry-reason"),
      waitUntil: (p) => options.waitUntil ? options.waitUntil(guard(p)) : void pending.push(guard(p))
    };
    const reply = (r) => r instanceof Response ? r : r ? json(r) : ack();
    const body = parseSlackBody(verified.body, contentType);
    let response;
    switch (body.kind) {
      case "url_verification":
        response = json({ challenge: body.challenge });
        break;
      case "event":
        if (onEvent && !(ignoreEventRetries && retryNum > 0)) ctx.waitUntil(Promise.resolve().then(() => onEvent(body, ctx)));
        response = ack();
        break;
      case "interaction":
        response = reply(onInteraction ? await onInteraction(body.payload, ctx) : void 0);
        break;
      case "command":
        response = reply(onCommand ? await onCommand(body.command, ctx) : void 0);
        break;
      default:
        response = new Response("unrecognized Slack request\n", { status: 400 });
    }
    await Promise.all(pending);
    return response;
  };
}
export {
  isBlockActions,
  isMessageAction,
  isShortcut,
  isViewSubmission,
  parseSlackBody,
  respond,
  slackHandler,
  slackSignature,
  verifySlackRequest,
  verifySlackSignature,
  viewErrors,
  viewValues
};
//# sourceMappingURL=receiver.js.map