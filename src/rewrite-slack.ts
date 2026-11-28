/**
 * Bulk rewrite's Slack half: find the messages in scope, plan them, apply a plan, and serve one to `PlanView` from a
 * Worker / Pages Function (`rewriteHandler`). Types and content helpers: `./rewrite`.
 */
import { SlackApiError } from "./api.js";
import type { Block } from "./mrkdwn.js";
import {
  DEFAULT_BATCH,
  DEFAULT_PACE_MS,
  PLAN_VERSION,
  POST_SUBTYPES,
  contentHash,
  contentOf,
  foundOf,
  isOverride,
  planCounts,
  sameContent,
  sameSender,
  writes,
  type BotIds,
  type PlannedAction,
  type RawSlackMessage,
  type Render,
  type RewriteContent,
  type RewriteFound,
  type RewriteKind,
  type RewriteOutcome,
  type RewritePlan,
  type RewriteReceipts,
  type RewriteStatus,
} from "./rewrite.js";
import { SLACK_BLOCKS_LIMIT, SLACK_MESSAGE_LIMIT, codePoints, fallbackText, sectionBlocks, type SlackClient } from "./slack.js";

/**
 * A rendered `text` / `blocks` as Python's `SlackClient.post` / `edit` send it, under Slack's 4,000 on `text`. Text
 * over `SLACK_MESSAGE_LIMIT` beside blocks becomes its `fallbackText`; text-only over it goes out as
 * `sectionBlocks(text, { lines: true })` with that fallback. Throws when Slack can't take it: a line over the section
 * limit, or more than `SLACK_BLOCKS_LIMIT` blocks. Python's `thrds.rewrite.sendable`.
 */
export function sendable(text: string, blocks: Block[] | null): { text: string; blocks: Block[] | null } {
  const n = codePoints(text);
  if (n <= SLACK_MESSAGE_LIMIT) return { text, blocks };
  if (blocks !== null && blocks.length > 0) return { text: fallbackText(text), blocks };
  const sections = sectionBlocks(text, { lines: true });
  if (sections.length > SLACK_BLOCKS_LIMIT) {
    throw new Error(`new text is ${n} chars, ${sections.length} sections over Slack's ${SLACK_BLOCKS_LIMIT} blocks`);
  }
  return { text: fallbackText(text), blocks: sections };
}

// --- find ---------------------------------------------------------------

const keep = (f: RewriteFound, includeForeign: boolean): boolean =>
  includeForeign || (f.ours && POST_SUBTYPES.includes(f.subtype));

async function newestTopLevel(client: SlackClient, channel: string): Promise<string | null> {
  const r = await client.api("conversations.history", { channel, limit: 1 }, { get: true });
  const messages = (r["messages"] ?? []) as RawSlackMessage[];
  return messages[0]?.ts ?? null;
}

async function threadRaw(client: SlackClient, channel: string, threadTs: string): Promise<RawSlackMessage[]> {
  const out: RawSlackMessage[] = [];
  for await (const m of client.paginate<RawSlackMessage>(
    "conversations.replies",
    { channel, ts: threadTs, include_all_metadata: true, limit: 200 },
    "messages",
    { get: true },
  )) out.push(m);
  return out;
}

async function threadReplies(client: SlackClient, channel: string, threadTs: string, ids: BotIds): Promise<RewriteFound[]> {
  const replies = (await threadRaw(client, channel, threadTs)).filter((r) => r.ts !== threadTs);
  const last = replies.at(-1)?.ts;
  return replies.map((r) => foundOf(r, channel, ids, r.ts === last));
}

export interface FindOptions {
  /** Default: the client's channel. */
  channel?: string;
  /** Include others' messages (they plan as `blocked`). */
  includeForeign?: boolean;
}

/** The app's messages in the channel's history (newest first; `oldest` / `latest` bound it); with `includeReplies`,
 *  each thread's replies follow its parent (oldest first). */
export async function findHistory(
  client: SlackClient,
  options: FindOptions & { oldest?: string; latest?: string; includeReplies?: boolean } = {},
): Promise<RewriteFound[]> {
  const channel = options.channel ?? client.channel;
  const includeForeign = options.includeForeign ?? false;
  const ids = await client.botIds();
  const params: Record<string, unknown> = { channel, include_all_metadata: true, limit: 200 };
  if (options.oldest !== undefined) params["oldest"] = options.oldest;
  if (options.latest !== undefined) params["latest"] = options.latest;
  let newest: string | null | undefined;
  const out: RewriteFound[] = [];
  const seen = new Set<string>();
  for await (const m of client.paginate<RawSlackMessage>("conversations.history", params, "messages", { get: true })) {
    if (newest === undefined) newest = options.latest === undefined ? m.ts : await newestTopLevel(client, channel);
    if (!seen.has(m.ts)) {
      seen.add(m.ts);
      const f = foundOf(m, channel, ids, m.ts === newest);
      if (keep(f, includeForeign)) out.push(f);
    }
    if (options.includeReplies && typeof m["reply_count"] === "number" && m["reply_count"] > 0) {
      for (const f of await threadReplies(client, channel, m.ts, ids)) {
        if (!seen.has(f.ts) && keep(f, includeForeign)) out.push(f);
        seen.add(f.ts);
      }
    }
  }
  return out;
}

/** The app's messages in one thread: its parent, then its replies. */
export async function findThread(client: SlackClient, threadTs: string, options: FindOptions = {}): Promise<RewriteFound[]> {
  const channel = options.channel ?? client.channel;
  const includeForeign = options.includeForeign ?? false;
  const ids = await client.botIds();
  const raw = await threadRaw(client, channel, threadTs);
  const out: RewriteFound[] = [];
  if (raw[0]?.ts === threadTs) {
    const parent = foundOf(raw[0], channel, ids, (await newestTopLevel(client, channel)) === threadTs);
    if (keep(parent, includeForeign)) out.push(parent);
  }
  const last = raw.filter((r) => r.ts !== threadTs).at(-1)?.ts;
  for (const r of raw) {
    if (r.ts === threadTs) continue;
    const f = foundOf(r, channel, ids, r.ts === last);
    if (keep(f, includeForeign)) out.push(f);
  }
  return out;
}

/** One message by ts (a reply's ts reads the reply), or null when it's gone. */
export async function readMessage(client: SlackClient, channel: string, ts: string): Promise<RawSlackMessage | null> {
  let r;
  try {
    r = await client.api("conversations.replies", { channel, ts, limit: 1, include_all_metadata: true }, { get: true });
  } catch (e) {
    if (e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found")) return null;
    throw e;
  }
  const m = ((r["messages"] ?? []) as RawSlackMessage[])[0];
  return m !== undefined && m.ts === ts ? m : null;
}

async function isLast(client: SlackClient, channel: string, ts: string, threadTs: string | null): Promise<boolean> {
  if (threadTs === null) return (await newestTopLevel(client, channel)) === ts;
  const replies = (await threadRaw(client, channel, threadTs)).filter((r) => r.ts !== threadTs);
  return replies.at(-1)?.ts === ts;
}

/** Exactly these messages (top-level or replies), in order; others' messages included (they plan as `blocked`).
 *  Throws on one that's gone. */
export async function findIds(client: SlackClient, tss: readonly string[], options: { channel?: string } = {}): Promise<RewriteFound[]> {
  const channel = options.channel ?? client.channel;
  const ids = await client.botIds();
  const out: RewriteFound[] = [];
  for (const ts of tss) {
    const m = await readMessage(client, channel, ts);
    if (m === null) throw new Error(`no message ${ts} in ${channel}`);
    const parent = m["thread_ts"];
    const threadTs = typeof parent === "string" && parent !== ts ? parent : null;
    out.push(foundOf(m, channel, ids, await isLast(client, channel, ts, threadTs)));
  }
  return out;
}

// --- plan ---------------------------------------------------------------

/** One action per found message; no Slack calls. A sender change is a `repost`, `blocked` when the message has replies
 *  (they'd orphan), when it isn't the newest in its container (`reorderOk` allows it), or when it has files and the new
 *  sender is an override (Slack shows no files on those). `render` runs only on this app's own posts. */
export async function plan(
  found: Iterable<RewriteFound>,
  render: Render,
  options: { reorderOk?: boolean } = {},
): Promise<RewritePlan> {
  const actions: PlannedAction[] = [];
  for (const f of found) {
    const hash = await contentHash(f.content);
    const action = (kind: RewriteKind, extra: { new?: RewriteContent; reason?: string; metadata?: unknown } = {}): PlannedAction => {
      const a: PlannedAction = {
        kind,
        channel: f.channel,
        ts: f.ts,
        thread_ts: f.threadTs,
        hash,
        old: f.content,
        new: extra.new ?? null,
        reason: extra.reason ?? null,
      };
      if (f.subtype === "thread_broadcast") a.broadcast = true;
      if (extra.metadata !== undefined && extra.metadata !== null) a.metadata = extra.metadata;
      return a;
    };
    if (!f.ours) {
      actions.push(action("blocked", { reason: "another app's or a person's message" }));
      continue;
    }
    if (!POST_SUBTYPES.includes(f.subtype)) {
      actions.push(action("blocked", { reason: `a ${f.subtype} message` }));
      continue;
    }
    const r = await render(f);
    if ("skip" in r) {
      actions.push(action("skip", { reason: r.skip }));
      continue;
    }
    const sender = r.sender ?? f.content.sender;
    let sent: { text: string; blocks: Block[] | null };
    try {
      sent = sendable(r.text, r.blocks ?? null);
    } catch (e) {
      const asRendered: RewriteContent = { text: r.text, blocks: r.blocks ?? null, sender, files: f.content.files };
      actions.push(action("blocked", { new: asRendered, reason: (e as Error).message }));
      continue;
    }
    const next: RewriteContent = { ...sent, sender, files: f.content.files };
    if (sameContent(f.content, next)) {
      actions.push(action("noop", { new: next }));
      continue;
    }
    if (sameSender(next.sender, f.content.sender)) {
      actions.push(action("edit", { new: next }));
      continue;
    }
    const where = f.threadTs === null ? "channel" : "thread";
    let reason: string | null = null;
    if (f.replyCount > 0) reason = `the sender changes, and a repost would orphan its ${f.replyCount} replies`;
    else if (!f.last && !options.reorderOk) reason = `the sender changes, and a repost would move it to the end of its ${where}`;
    else if (next.files.length > 0 && isOverride(next.sender)) reason = "the sender changes to an override, and Slack shows no files on those";
    // The repost carries the message's metadata (apps find their posts by it).
    actions.push(reason === null ? action("repost", { new: next, metadata: f.metadata }) : action("blocked", { new: next, reason }));
  }
  return { thrds_rewrite_plan: PLAN_VERSION, actions };
}

// --- apply --------------------------------------------------------------

export interface ApplyOptions {
  /** Default true: check each action against its message, write nothing. */
  dryRun?: boolean;
  /** Just these ts. */
  only?: Iterable<string>;
  receipts?: RewriteReceipts;
  paceMs?: number;
  jitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onOutcome?: (o: RewriteOutcome) => void | Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function updatePayload(a: PlannedAction, next: RewriteContent): Record<string, unknown> {
  return { channel: a.channel, ts: a.ts, text: next.text, blocks: next.blocks ?? [] };
}

function postPayload(a: PlannedAction, next: RewriteContent): Record<string, unknown> {
  const data: Record<string, unknown> = { channel: a.channel, text: next.text, unfurl_links: false, unfurl_media: false };
  if (next.blocks && next.blocks.length > 0) data["blocks"] = next.blocks;
  if (a.thread_ts !== null) {
    data["thread_ts"] = a.thread_ts;
    if (a.broadcast) data["reply_broadcast"] = true;
  }
  const s = next.sender;
  if (s.username !== null) data["username"] = s.username;
  if (s.icon_url !== null) data["icon_url"] = s.icon_url;
  else if (s.icon_emoji !== null) data["icon_emoji"] = s.icon_emoji;
  if (a.metadata !== undefined && a.metadata !== null) data["metadata"] = a.metadata;
  return data;
}

const outcome = (a: PlannedAction, status: RewriteStatus, extra: { new_ts?: string; error?: string } = {}): RewriteOutcome => ({
  ts: a.ts,
  kind: a.kind,
  status,
  ...extra,
});

const errorCode = (e: unknown): string => (e instanceof SlackApiError ? e.code : e instanceof Error ? e.message : String(e));

async function applyOne(client: SlackClient, a: PlannedAction, dryRun: boolean): Promise<RewriteOutcome> {
  const next = a.new!;
  if ((await contentHash(a.old)) !== a.hash) return outcome(a, "failed", { error: "the plan's hash doesn't match its old content" });
  const m = await readMessage(client, a.channel, a.ts);
  if (m === null) return outcome(a, "gone");
  const live = contentOf(m);
  if (sameContent(live, next)) return outcome(a, "already");
  if ((await contentHash(live)) !== a.hash) return outcome(a, "stale", { error: "changed since planning" });
  if (a.kind === "repost") {
    const replies = typeof m["reply_count"] === "number" ? m["reply_count"] : 0;
    if (replies > 0) return outcome(a, "stale", { error: `now has ${replies} replies` });
    if (!(await isLast(client, a.channel, a.ts, a.thread_ts))) return outcome(a, "stale", { error: "no longer the newest; a repost would move it" });
    if (isOverride(next.sender) && client.token.startsWith("xoxp-")) return outcome(a, "failed", { error: "a sender override needs a bot token (xoxb-…)" });
  }
  if (dryRun) return outcome(a, "pending");
  let newTs: string;
  try {
    if (a.kind === "edit") {
      await client.api("chat.update", updatePayload(a, next));
      return outcome(a, "done");
    }
    newTs = (await client.api("chat.postMessage", postPayload(a, next)))["ts"] as string;
    if (next.files.length > 0) {
      await client.api("chat.update", { channel: a.channel, ts: newTs, text: next.text, file_ids: next.files });
    }
  } catch (e) {
    return outcome(a, "failed", { error: errorCode(e) });
  }
  try {
    await client.api("chat.delete", { channel: a.channel, ts: a.ts });
  } catch (e) {
    return outcome(a, "undeleted", { new_ts: newTs, error: errorCode(e) });
  }
  return outcome(a, "done", { new_ts: newTs });
}

/**
 * Carry out the plan's `edit` / `repost` actions in order. A dry run by default: each action is still checked against
 * its message (`pending` / `stale` / `gone` / `already`), but nothing is written. A repost posts the new message
 * before deleting the old one, so a failed delete leaves a duplicate (`undeleted`), never a loss.
 */
export async function apply(p: RewritePlan, client: SlackClient, options: ApplyOptions = {}): Promise<RewriteOutcome[]> {
  const { dryRun = true, receipts, paceMs = DEFAULT_PACE_MS, jitterMs = 0, sleep = defaultSleep, onOutcome } = options;
  const selected = options.only === undefined ? null : new Set(options.only);
  const done = receipts === undefined ? new Set<string>() : await receipts.done();
  const out: RewriteOutcome[] = [];
  let wrote = false;
  for (const a of p.actions) {
    if (!writes(a) || (selected !== null && !selected.has(a.ts))) continue;
    let o: RewriteOutcome;
    if (done.has(a.ts)) o = outcome(a, "receipt");
    else {
      if (wrote && paceMs > 0) await sleep(paceMs + Math.random() * jitterMs);
      o = await applyOne(client, a, dryRun);
      wrote = o.status === "done" || o.status === "undeleted";
      if (receipts !== undefined && !dryRun) await receipts.record(o);
    }
    out.push(o);
    await onOutcome?.(o);
  }
  return out;
}

// --- serving ------------------------------------------------------------

export interface RewriteHandlerOptions {
  /** The plan to serve (parse it with `verifyPlan`). */
  plan: RewritePlan | (() => Promise<RewritePlan>);
  /** The Slack client the apply writes with (a bot token, for sender overrides); built only on a `check` / `apply`. */
  client: SlackClient | (() => SlackClient | Promise<SlackClient>);
  /** A label `GET plan` returns as `path` (the page's title). */
  name?: string;
  receipts?: RewriteReceipts;
  /** The most ids one request takes (default `DEFAULT_BATCH`). */
  maxBatch?: number;
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/**
 * `PlanView`'s backend, for a Worker / Pages Function behind the app's own auth: by the request path's last segment,
 * `GET …/plan` → `{path, plan}` (with `counts`), `POST …/check` / `…/apply` `{ids}` → `{outcomes}` (a dry run for
 * `check`). A POST must be `application/json` and, when the browser sends an `Origin`, same-origin; ids must be the
 * plan's edits / reposts, at most `maxBatch`.
 */
export async function rewriteHandler(request: Request, options: RewriteHandlerOptions): Promise<Response> {
  const url = new URL(request.url);
  const op = url.pathname.replace(/\/+$/, "").split("/").at(-1);
  const p = typeof options.plan === "function" ? await options.plan() : options.plan;
  if (request.method === "GET" && op === "plan") {
    return jsonResponse(200, { path: options.name ?? "plan", plan: { ...p, counts: planCounts(p) } });
  }
  if (request.method !== "POST" || (op !== "check" && op !== "apply")) return jsonResponse(404, { error: `not found: ${request.method} ${url.pathname}` });
  if ((request.headers.get("Content-Type") ?? "").split(";")[0]!.trim() !== "application/json") {
    return jsonResponse(415, { error: "expected Content-Type: application/json" });
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return jsonResponse(403, { error: `cross-origin request from ${origin}` });
  let ids: unknown;
  try {
    ids = ((await request.json()) as { ids?: unknown }).ids;
  } catch (e) {
    return jsonResponse(400, { error: `bad request: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!Array.isArray(ids) || !ids.every((i): i is string => typeof i === "string")) {
    return jsonResponse(400, { error: "bad request: ids must be a list of ts strings" });
  }
  const maxBatch = options.maxBatch ?? DEFAULT_BATCH;
  if (ids.length > maxBatch) return jsonResponse(413, { error: `${ids.length} ids; at most ${maxBatch} per request` });
  const known = new Set(p.actions.filter(writes).map((a) => a.ts));
  const unknown = ids.filter((i) => !known.has(i));
  if (unknown.length > 0) return jsonResponse(400, { error: `not edits or reposts in this plan: ${unknown.join(", ")}` });
  try {
    const client = typeof options.client === "function" ? await options.client() : options.client;
    const applyOptions: ApplyOptions = { dryRun: op === "check", only: ids };
    if (options.receipts !== undefined) applyOptions.receipts = options.receipts;
    if (options.paceMs !== undefined) applyOptions.paceMs = options.paceMs;
    if (options.sleep !== undefined) applyOptions.sleep = options.sleep;
    return jsonResponse(200, { outcomes: await apply(p, client, applyOptions) });
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
}
