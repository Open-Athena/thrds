/**
 * `@open-athena/thrds/receiver`: the inbound half of a Slack app (Events API, interactivity, slash commands), on Web
 * APIs only (`Request` / `Response` / `crypto.subtle`), so it serves from a Worker or Node alike.
 *
 * - `verifySlackSignature` / `verifySlackRequest`: v0 HMAC-SHA256 with a replay window and a constant-time compare.
 * - `parseSlackBody`: Events API JSON, interaction payloads and slash commands, as one tagged union.
 * - `respond`: reply through a `response_url`.
 * - `slackHandler`: verify, answer `url_verification`, dispatch, and ack, in one `fetch`-style handler.
 */
import { toMsg, type MsgLike } from "./core";

export interface VerifyInput {
  signingSecret: string;
  /** The raw request body, exactly as received. */
  body: string;
  /** `X-Slack-Request-Timestamp`. */
  timestamp: string | null;
  /** `X-Slack-Signature` (`v0=<hex>`). */
  signature: string | null;
  nowS?: number;
  /** Reject requests older (or newer) than this, against replays. Default 300 s, Slack's recommendation. */
  toleranceS?: number;
}

export type VerifyFailure = "missing_secret" | "missing_headers" | "stale" | "bad_signature";
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Equal strings, in time independent of where they differ. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret. */
export async function slackSignature(signingSecret: string, timestamp: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v0=${hex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`)))}`;
}

export async function verifySlackSignature(input: VerifyInput): Promise<VerifyResult> {
  const { signingSecret, body, timestamp, signature, toleranceS = 300 } = input;
  // A misconfigured (empty) secret fails closed, as a result rather than Web Crypto's zero-length-key throw.
  if (!signingSecret) return { ok: false, reason: "missing_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const ts = Number(timestamp);
  const nowS = input.nowS ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(nowS - ts) > toleranceS) return { ok: false, reason: "stale" };
  const expected = await slackSignature(signingSecret, timestamp, body);
  return constantTimeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Verify a `Request` from Slack; on success, its raw body (the request's body is consumed). */
export async function verifySlackRequest(
  request: Request,
  signingSecret: string,
  options: { nowS?: number; toleranceS?: number } = {},
): Promise<{ ok: true; body: string } | { ok: false; reason: VerifyFailure }> {
  const body = await request.text();
  const result = await verifySlackSignature({
    signingSecret,
    body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    ...options,
  });
  return result.ok ? { ok: true, body } : result;
}

export interface SlashCommand {
  command: string;
  text: string;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  teamId: string;
  triggerId: string;
  responseUrl: string;
}

export interface InteractionUser {
  id: string;
  username?: string;
  name?: string;
  team_id?: string;
}

export interface InteractionMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  [k: string]: unknown;
}

export interface ViewState {
  id: string;
  hash?: string;
  callback_id?: string;
  external_id?: string;
  private_metadata?: string;
  state?: { values: Record<string, Record<string, unknown>> };
  [k: string]: unknown;
}

export interface BlockAction {
  action_id: string;
  block_id?: string;
  value?: string;
  type: string;
  [k: string]: unknown;
}

/** An interaction payload (`block_actions`, `view_submission`, `view_closed`, `shortcut`, `message_action`, …). */
export interface Interaction {
  type: string;
  user?: InteractionUser;
  trigger_id?: string;
  response_url?: string;
  actions?: BlockAction[];
  view?: ViewState;
  callback_id?: string;
  channel?: { id: string; name?: string };
  message?: InteractionMessage;
  container?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A button / select click in a message or view. */
export interface BlockActionsPayload extends Interaction {
  type: "block_actions";
  user: InteractionUser;
  trigger_id: string;
  actions: BlockAction[];
}

export interface ViewSubmissionPayload extends Interaction {
  type: "view_submission";
  user: InteractionUser;
  view: ViewState;
}

/** A message shortcut ("…" menu on a message). */
export interface MessageActionPayload extends Interaction {
  type: "message_action";
  user: InteractionUser;
  callback_id: string;
  trigger_id: string;
  response_url: string;
  channel: { id: string; name?: string };
  message: InteractionMessage;
}

/** A global shortcut (lightning-bolt menu). */
export interface ShortcutPayload extends Interaction {
  type: "shortcut";
  user: InteractionUser;
  callback_id: string;
  trigger_id: string;
}

export const isBlockActions = (p: Interaction): p is BlockActionsPayload => p.type === "block_actions";
export const isViewSubmission = (p: Interaction): p is ViewSubmissionPayload => p.type === "view_submission";
export const isMessageAction = (p: Interaction): p is MessageActionPayload => p.type === "message_action";
export const isShortcut = (p: Interaction): p is ShortcutPayload => p.type === "shortcut";

export type SlackBody =
  | { kind: "url_verification"; challenge: string }
  | { kind: "event"; event: Record<string, unknown> & { type: string }; eventId: string; teamId: string; raw: Record<string, unknown> }
  | { kind: "interaction"; payload: Interaction }
  | { kind: "command"; command: SlashCommand; raw: Record<string, string> }
  | { kind: "unknown"; raw: unknown };

/** Parse a (verified) request body by its content type; a malformed one is `unknown`, never a throw. */
export function parseSlackBody(body: string, contentType: string | null): SlackBody {
  try {
    return parseBody(body, contentType);
  } catch {
    return { kind: "unknown", raw: body };
  }
}

function parseBody(body: string, contentType: string | null): SlackBody {
  if ((contentType ?? "").includes("application/json")) {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (json["type"] === "url_verification") return { kind: "url_verification", challenge: String(json["challenge"]) };
    if (json["type"] === "event_callback") {
      return {
        kind: "event",
        event: json["event"] as Record<string, unknown> & { type: string },
        eventId: String(json["event_id"] ?? ""),
        teamId: String(json["team_id"] ?? ""),
        raw: json,
      };
    }
    return { kind: "unknown", raw: json };
  }
  const form = Object.fromEntries(new URLSearchParams(body));
  if (form["payload"] !== undefined) return { kind: "interaction", payload: JSON.parse(form["payload"]) as Interaction };
  if (form["command"] !== undefined) {
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
        responseUrl: form["response_url"] ?? "",
      },
      raw: form,
    };
  }
  return { kind: "unknown", raw: form };
}

/**
 * A view submission's input values, flattened (text, selects, dates, checkboxes): by `action_id` (default), or by
 * `block_id` when every input shares one action id and blocks tell them apart.
 */
export function viewValues<T extends Record<string, unknown> = Record<string, unknown>>(
  payload: Interaction,
  options: { by?: "action" | "block" } = {},
): T {
  const out: Record<string, unknown> = {};
  for (const [blockId, block] of Object.entries(payload.view?.state?.values ?? {})) {
    for (const [actionId, raw] of Object.entries(block)) {
      const v = raw as Record<string, unknown>;
      out[options.by === "block" ? blockId : actionId] =
        v["value"] ??
        (v["selected_option"] as { value?: string } | undefined)?.value ??
        (v["selected_options"] as Array<{ value: string }> | undefined)?.map((o) => o.value) ??
        v["selected_user"] ??
        v["selected_users"] ??
        v["selected_channel"] ??
        v["selected_conversation"] ??
        v["selected_date"] ??
        v["selected_time"] ??
        v["selected_date_time"] ??
        null;
    }
  }
  return out as T;
}

export interface RespondOptions {
  /** Default `ephemeral` (only the user who acted sees it). */
  responseType?: "ephemeral" | "in_channel";
  replaceOriginal?: boolean;
  deleteOriginal?: boolean;
  threadTs?: string;
  fetch?: typeof fetch;
}

/** Reply through an interaction's or command's `response_url` (valid 30 min, up to 5 times). */
export async function respond(responseUrl: string, m: MsgLike | null, options: RespondOptions = {}): Promise<void> {
  const { responseType = "ephemeral", replaceOriginal, deleteOriginal, threadTs, fetch: fetchImpl = globalThis.fetch } = options;
  const body: Record<string, unknown> = { response_type: responseType };
  if (m !== null) {
    const msg = toMsg(m);
    body["text"] = msg.text;
    if (msg.blocks !== undefined) body["blocks"] = msg.blocks;
  }
  if (replaceOriginal !== undefined) body["replace_original"] = replaceOriginal;
  if (deleteOriginal !== undefined) body["delete_original"] = deleteOriginal;
  if (threadTs !== undefined) body["thread_ts"] = threadTs;
  const r = await fetchImpl(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`response_url: HTTP ${r.status}`);
}

/** A view submission's field errors (keyed by block id): Slack shows them inline instead of closing the modal. */
export const viewErrors = (errors: Record<string, string>): Record<string, unknown> => ({ response_action: "errors", errors });

export interface HandlerContext {
  /** The request (its body is already read: use the parsed payload). */
  request: Request;
  /** Slack's delivery retry (`X-Slack-Retry-Num`), or 0 for a first delivery. */
  retryNum: number;
  retryReason: string | null;
  /** Run work after the ack (a Worker's `ctx.waitUntil`); awaited inline when none was given. */
  waitUntil(p: Promise<unknown>): void;
}

/** What an interaction / command handler returns: nothing (plain ack), a `Response`, or a JSON body. */
export type HandlerReply = void | undefined | Response | Record<string, unknown>;

export interface SlackHandlerOptions {
  signingSecret: string;
  /** Events API callbacks. Acked immediately; the handler runs after (via `waitUntil` when given). */
  onEvent?: (body: Extract<SlackBody, { kind: "event" }>, ctx: HandlerContext) => Promise<void> | void;
  /** Must finish within Slack's 3 s; defer slow work with `ctx.waitUntil` and reply via `respond`. */
  onInteraction?: (payload: Interaction, ctx: HandlerContext) => Promise<HandlerReply> | HandlerReply;
  onCommand?: (command: SlashCommand, ctx: HandlerContext) => Promise<HandlerReply> | HandlerReply;
  /**
   * Run work after the ack: a Worker's `ctx.waitUntil`, or Next.js's `after` from `next/server`. Without one, deferred
   * work is awaited before the response is returned, which on Node can blow Slack's 3 s ack budget.
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Drop Events API retries (Slack re-sends when an ack is late). Default true: handlers needn't be idempotent. */
  ignoreEventRetries?: boolean;
  nowS?: () => number;
  /** Failures in deferred work (default `console.error`: never swallowed silently). */
  onError?: (e: unknown) => void;
}

const ack = (): Response => new Response(null, { status: 200 });
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });

/** A `fetch`-style handler for one Slack request URL (events, interactivity and commands can share it). */
export function slackHandler(options: SlackHandlerOptions): (request: Request) => Promise<Response> {
  const { signingSecret, onEvent, onInteraction, onCommand, ignoreEventRetries = true, onError = (e: unknown) => console.error("slackHandler:", e) } = options;
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const contentType = request.headers.get("content-type");
    const verified = await verifySlackRequest(request, signingSecret, options.nowS ? { nowS: options.nowS() } : {});
    if (!verified.ok) return new Response(`invalid request (${verified.reason})\n`, { status: 401 });
    const retryNum = Number(request.headers.get("x-slack-retry-num") ?? 0);
    const pending: Promise<unknown>[] = [];
    const guard = (p: Promise<unknown>): Promise<unknown> => p.catch((e) => onError(e));
    const ctx: HandlerContext = {
      request,
      retryNum,
      retryReason: request.headers.get("x-slack-retry-reason"),
      waitUntil: (p) => (options.waitUntil ? options.waitUntil(guard(p)) : void pending.push(guard(p))),
    };
    const reply = (r: HandlerReply): Response => (r instanceof Response ? r : r ? json(r) : ack());
    const body = parseSlackBody(verified.body, contentType);
    let response: Response;
    switch (body.kind) {
      case "url_verification":
        response = json({ challenge: body.challenge });
        break;
      case "event":
        if (onEvent && !(ignoreEventRetries && retryNum > 0)) ctx.waitUntil(Promise.resolve().then(() => onEvent(body, ctx)));
        response = ack();
        break;
      case "interaction":
        response = reply(onInteraction ? await onInteraction(body.payload, ctx) : undefined);
        break;
      case "command":
        response = reply(onCommand ? await onCommand(body.command, ctx) : undefined);
        break;
      default:
        response = new Response("unrecognized Slack request\n", { status: 400 });
    }
    await Promise.all(pending);
    return response;
  };
}
