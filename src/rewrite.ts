/**
 * Bulk rewrite: find an app's Slack messages, re-render them, review the plan, apply it. The TS twin of Python
 * `thrds.rewrite` (`specs/done/bulk-rewrite.md` on the `py` branch): the same plan JSON, the same content hash, so a
 * plan either side writes, the other applies.
 *
 * 1. **Find** (`findHistory` / `findThread` / `findIds`): the messages in scope, as `RewriteFound`.
 * 2. **Plan** (`plan(found, render)`): the app's `render(found) -> Desired | Skip` re-derives each message; one action
 *    per message: `edit`, `repost` (the sender changes, which `chat.update` can't do), `noop`, `skip` (the app's
 *    reason) or `blocked` (what Slack can't do), each recording the message's content hash.
 * 3. **Apply** (`apply(plan, client)`): a dry run unless `dryRun: false`; each action re-reads its message and refuses
 *    it once its hash moved (`stale`). Writes are paced; `receipts` (`memoryReceipts`, `/d1`'s `d1Receipts`) make a
 *    re-run skip what's done.
 *
 * This module is the browser-safe half (types, content hashing, `substitute`, `postRewrite`); the Slack half (find,
 * `plan`, `apply`, `rewriteHandler`) is `./rewrite-slack`, so a page bundling `PlanView` doesn't pull in the client.
 */
import type { Block } from "./mrkdwn.js";

export const PLAN_VERSION = 1;

export const REWRITE_KINDS = ["edit", "repost", "noop", "skip", "blocked"] as const;
export type RewriteKind = (typeof REWRITE_KINDS)[number];

export interface RewriteSender {
  username: string | null;
  icon_url: string | null;
  icon_emoji: string | null;
}

/** What a message shows: wire `text` (Slack mrkdwn), `blocks` (`null`: none), sender override, attached file ids. */
export interface RewriteContent {
  text: string;
  blocks: Block[] | null;
  sender: RewriteSender;
  files: string[];
}

export interface PlannedAction {
  kind: RewriteKind;
  channel: string;
  ts: string;
  /** The parent's ts for a reply; `null` for a top-level message. */
  thread_ts: string | null;
  /** The message's content hash when planned; apply refuses the action once it moves. */
  hash: string;
  old: RewriteContent;
  new: RewriteContent | null;
  reason: string | null;
  broadcast?: boolean;
  metadata?: unknown;
  /** Unified diff of the text (review form only). */
  diff?: string;
}

export interface RewritePlan {
  thrds_rewrite_plan: typeof PLAN_VERSION;
  actions: PlannedAction[];
  /** Per-kind counts (review form only). */
  counts?: Record<RewriteKind, number>;
}

export const REWRITE_STATUSES = ["done", "already", "receipt", "pending", "stale", "gone", "failed", "undeleted"] as const;
export type RewriteStatus = (typeof REWRITE_STATUSES)[number];

/** One applied (or dry-run) action's result. */
export interface RewriteOutcome {
  ts: string;
  kind: RewriteKind;
  status: RewriteStatus;
  new_ts?: string;
  error?: string;
}

/** Validates a parsed plan's version and shape; throws on anything else. */
export function parsePlan(json: unknown): RewritePlan {
  if (typeof json !== "object" || json === null) throw new Error("not a thrds rewrite plan (not an object)");
  const plan = json as Partial<RewritePlan>;
  if (plan.thrds_rewrite_plan !== PLAN_VERSION) {
    throw new Error(`not a thrds rewrite plan (version ${JSON.stringify(plan.thrds_rewrite_plan)}, expected ${PLAN_VERSION})`);
  }
  if (!Array.isArray(plan.actions)) throw new Error("not a thrds rewrite plan (no actions)");
  for (const a of plan.actions) {
    if (!(REWRITE_KINDS as readonly string[]).includes(a.kind)) throw new Error(`plan action ${a.ts}: unknown kind ${JSON.stringify(a.kind)}`);
    if (writes(a) && a.new === null) throw new Error(`plan action ${a.ts}: ${a.kind} without new content`);
  }
  return plan as RewritePlan;
}

/** `edit` and `repost` write; the other kinds don't. */
export const writes = (a: Pick<PlannedAction, "kind">): boolean => a.kind === "edit" || a.kind === "repost";

export function planCounts(plan: RewritePlan): Record<RewriteKind, number> {
  const out = Object.fromEntries(REWRITE_KINDS.map((k) => [k, 0])) as Record<RewriteKind, number>;
  for (const a of plan.actions) out[a.kind] += 1;
  return out;
}

export const senderChanged = (a: PlannedAction): boolean =>
  a.new !== null &&
  (a.new.sender.username !== a.old.sender.username ||
    a.new.sender.icon_url !== a.old.sender.icon_url ||
    a.new.sender.icon_emoji !== a.old.sender.icon_emoji);

export function describeSender(s: RewriteSender): string {
  const parts = [s.username === null ? null : `"${s.username}"`, s.icon_emoji, s.icon_url].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" ") : "the app";
}

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

/** Line diff of `a` → `b` (longest common subsequence): unchanged, removed and added lines in order. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // lcs[i][j]: LCS length of x[i:] and y[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: x[i++]! });
    } else {
      out.push({ op: "+", text: y[j++]! });
    }
  }
  while (i < n) out.push({ op: "-", text: x[i++]! });
  while (j < m) out.push({ op: "+", text: y[j++]! });
  return out;
}

// --- content ------------------------------------------------------------

const NO_SENDER: RewriteSender = { username: null, icon_url: null, icon_emoji: null };

/** `json.dumps(value, sort_keys=True, ensure_ascii=False)`: Python's separators, keys sorted at every level. Numbers
 *  print as JS does, which matches Python for ints (Slack's blocks carry no floats). */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** A message's content hash: the first 16 hex digits of the SHA-256 of its `pyJsonDumps`, as Python's `Content.hash`. */
export async function contentHash(c: RewriteContent): Promise<string> {
  const body = pyJsonDumps({ text: c.text, blocks: c.blocks, sender: c.sender, files: c.files });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** A raw Slack message, as `conversations.history` / `replies` return it. */
export type RawSlackMessage = Record<string, unknown> & { ts: string };

/** The override a read message shows: `username`, and `icons.emoji` or an `icons.image_*` URL. Only a `bot_message`
 *  carries one; an app's plain post has `icons` for its own avatar, which isn't one. */
export function senderOf(m: Record<string, unknown>): RewriteSender {
  if (m["subtype"] !== "bot_message") return { ...NO_SENDER };
  const icons = (m["icons"] ?? {}) as Record<string, unknown>;
  const emoji = typeof icons["emoji"] === "string" ? icons["emoji"] : null;
  let url: string | null = null;
  if (emoji === null) {
    const original = icons["image_original"];
    if (typeof original === "string" && original) url = original;
    else {
      const k = Object.keys(icons)
        .sort()
        .find((k) => k.startsWith("image_") && typeof icons[k] === "string");
      url = k === undefined ? null : (icons[k] as string);
    }
  }
  return { username: typeof m["username"] === "string" ? m["username"] : null, icon_url: url, icon_emoji: emoji };
}

export function contentOf(m: Record<string, unknown>): RewriteContent {
  const files = (m["files"] ?? []) as Array<Record<string, unknown>>;
  return {
    text: typeof m["text"] === "string" ? m["text"] : "",
    blocks: (m["blocks"] as Block[] | undefined) ?? null,
    sender: senderOf(m),
    files: files.filter((f) => typeof f["id"] === "string").map((f) => f["id"] as string),
  };
}

export const sameSender = (a: RewriteSender, b: RewriteSender): boolean =>
  a.username === b.username && a.icon_url === b.icon_url && a.icon_emoji === b.icon_emoji;

/** `s` with Slack's three stored entities (`&lt;` `&gt;` `&amp;`) turned back into characters. */
export const unescapeSlack = (s: string): string => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Fields Slack adds to an image block when it stores it. */
const IMAGE_ADDED = new Set(["image_width", "image_height", "image_bytes", "fallback", "is_animated"]);

/** A block value as Slack would show it, for comparison only: strings unescaped; dropped are a top-level block's
 *  `block_id`, the fields Slack adds to an image block, a mrkdwn text's default `verbatim: false` and a plain_text's
 *  default `emoji: true`. */
function canon(v: unknown, top = false): unknown {
  if (typeof v === "string") return unescapeSlack(v);
  if (Array.isArray(v)) return v.map((x) => canon(x));
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const t = o["type"];
  const drop = (k: string): boolean =>
    (top && (k === "block_id" || (t === "image" && IMAGE_ADDED.has(k)))) ||
    (t === "mrkdwn" && k === "verbatim" && o[k] === false) ||
    (t === "plain_text" && k === "emoji" && o[k] === true);
  return Object.fromEntries(Object.entries(o).filter(([k]) => !drop(k)).map(([k, x]) => [k, canon(x)]));
}

const canonBlocks = (blocks: Block[] | null): unknown[] | null => (blocks === null ? null : blocks.map((b) => canon(b, true)));

/** `blocks` differ as Slack would show them (see `sameContent`). */
const blocksDiffer = (a: Block[] | null, b: Block[] | null): boolean =>
  pyJsonDumps(canonBlocks(a)) !== pyJsonDumps(canonBlocks(b));

/** No blocks, or only `rich_text` (Slack's own rendering of the text). */
export const onlyRichText = (blocks: Block[] | null): boolean => !blocks || blocks.every((b) => b.type === "rich_text");

const words = (s: string): string => unescapeSlack(s).split(/[ \t\n\r\f\v]+/).filter(Boolean).join(" ");

/** `live` (as read) already shows `want`, compared as Slack stores a message (as Python's `same_content`):
 *  - `&amp;` `&lt;` `&gt;` (how Slack stores `&` `<` `>`) equal the characters, in the text and every block string.
 *  - A text-only `want` (no blocks) matches live blocks that are only `rich_text`, which Slack derives from the text;
 *    the text must match.
 *  - With blocks, the blocks are what renders and the text is only the notification fallback, so the text is
 *    compared with whitespace runs collapsed. Block ids, the fields Slack adds to an image block, and the default
 *    `verbatim: false` / `emoji: true` are ignored. */
export function sameContent(live: RewriteContent, want: RewriteContent): boolean {
  if (!sameSender(live.sender, want.sender)) return false;
  if (live.files.length !== want.files.length || live.files.some((f, i) => f !== want.files[i])) return false;
  if (!want.blocks || want.blocks.length === 0) {
    return unescapeSlack(live.text) === unescapeSlack(want.text) && onlyRichText(live.blocks);
  }
  return words(live.text) === words(want.text) && !blocksDiffer(live.blocks ?? [], want.blocks);
}

// --- find ---------------------------------------------------------------

/** A message in scope, as read from Slack. `threadTs`: the parent's ts for a reply, null for a top-level message.
 *  `last`: the newest in its container (the channel's top level, or its thread); only then can a repost keep its
 *  place. `ours`: posted by this token's bot / user. */
export interface RewriteFound {
  channel: string;
  ts: string;
  threadTs: string | null;
  content: RewriteContent;
  ours: boolean;
  last: boolean;
  replyCount: number;
  subtype: string | null;
  metadata: unknown;
  raw: RawSlackMessage;
}

export type BotIds = { userId: string; botId?: string };

export function foundOf(m: RawSlackMessage, channel: string, ids: BotIds, last: boolean): RewriteFound {
  const parent = m["thread_ts"];
  return {
    channel,
    ts: m.ts,
    threadTs: typeof parent === "string" && parent !== m.ts ? parent : null,
    content: contentOf(m),
    ours: m["user"] === ids.userId || (ids.botId !== undefined && m["bot_id"] === ids.botId),
    last,
    replyCount: typeof m["reply_count"] === "number" ? m["reply_count"] : 0,
    subtype: typeof m["subtype"] === "string" ? m["subtype"] : null,
    metadata: m["metadata"] ?? null,
    raw: m,
  };
}

/** Subtypes an app's own posts carry; anything else (joins, file comments, …) isn't a message the app wrote. */
export const POST_SUBTYPES: ReadonlyArray<string | null> = [null, "bot_message", "thread_broadcast"];

// --- plan ---------------------------------------------------------------

/** What a message should show. `blocks` absent / null: text only. `sender` absent / null: keep its sender. */
export interface Desired {
  text: string;
  blocks?: Block[] | null;
  sender?: RewriteSender | null;
}

/** The app leaves this message alone, for `skip` (the reason). */
export interface Skip {
  skip: string;
}

export type Render = (found: RewriteFound) => Desired | Skip | Promise<Desired | Skip>;

export const isOverride = (s: RewriteSender): boolean => s.username !== null || s.icon_url !== null || s.icon_emoji !== null;

/** `parsePlan`, then each action's recorded hash checked against its old content (as Python's `Plan.from_json`). */
export async function verifyPlan(json: unknown): Promise<RewritePlan> {
  const p = parsePlan(json);
  for (const a of p.actions) {
    const h = await contentHash(a.old);
    if (a.hash !== h) throw new Error(`plan action ${a.ts}: recorded hash ${a.hash} doesn't match its old content (${h})`);
  }
  return p;
}

// --- apply --------------------------------------------------------------

/** Where outcomes of real runs go, so a re-run skips what's `done` / `already`. */
export interface RewriteReceipts {
  /** The ts already `done` or `already`. */
  done(): Promise<Set<string>>;
  record(o: RewriteOutcome): Promise<void>;
}

/** Receipts in memory (tests, one-request runs). */
export function memoryReceipts(initial: RewriteOutcome[] = []): RewriteReceipts & { outcomes: RewriteOutcome[] } {
  const outcomes = [...initial];
  return {
    outcomes,
    async done() {
      return new Set(outcomes.filter((o) => o.status === "done" || o.status === "already").map((o) => o.ts));
    },
    async record(o) {
      outcomes.push(o);
    },
  };
}

/** `chat.update` / `chat.delete` are Slack tier 3 (~50/min), `chat.postMessage` ~1/s per channel: 1.2 s between
 *  writes stays under both. */
export const DEFAULT_PACE_MS = 1200;

// --- renders ------------------------------------------------------------

/**
 * A render replacing each `mapping` key with its value, in the text and the blocks. Blocks that are only `rich_text`
 * are dropped (Slack re-derives them from the new text); other blocks have their strings substituted, and an `emoji`
 * element named `x` becomes `y` when `:x:` maps to `:y:`.
 */
export function substitute(mapping: Record<string, string>): Render {
  const emoji = new Map<string, string>();
  for (const [k, v] of Object.entries(mapping)) {
    if (k.length > 2 && v.length > 2 && k.startsWith(":") && k.endsWith(":") && v.startsWith(":") && v.endsWith(":")) {
      emoji.set(k.slice(1, -1), v.slice(1, -1));
    }
  }
  const subText = (s: string): string => Object.entries(mapping).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  const sub = (x: unknown): unknown => {
    if (typeof x === "string") return subText(x);
    if (Array.isArray(x)) return x.map(sub);
    if (typeof x === "object" && x !== null) {
      const o = x as Record<string, unknown>;
      if (o["type"] === "emoji" && typeof o["name"] === "string" && emoji.has(o["name"])) return { ...o, name: emoji.get(o["name"]) };
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "block_id" ? v : sub(v)]));
    }
    return x;
  };
  return (f) => ({
    text: subText(f.content.text),
    blocks: onlyRichText(f.content.blocks) ? null : (sub(f.content.blocks) as Block[]),
  });
}

// --- serving ------------------------------------------------------------

/** How many actions one `check` / `apply` request takes: each is 2–5 Slack calls, and a Worker request has a
 *  subrequest cap (50 free, 1000 paid). `postRewrite` batches to it. */
export const DEFAULT_BATCH = 10;

/**
 * The page's side of `rewriteHandler` (or `slck rewrite review`): POST `ids` to `endpoint` (`…/check` or `…/apply`)
 * `batch` at a time, in order, calling `onOutcomes` after each batch; resolves to every outcome. Throws on the first
 * refused batch (what was applied before it stays applied, and its receipts say so).
 */
export async function postRewrite(
  endpoint: string,
  ids: readonly string[],
  options: { batch?: number; fetch?: typeof fetch; onOutcomes?: (os: RewriteOutcome[]) => void } = {},
): Promise<RewriteOutcome[]> {
  const batch = options.batch ?? DEFAULT_BATCH;
  const f = options.fetch ?? fetch;
  const all: RewriteOutcome[] = [];
  for (let i = 0; i < ids.length; i += batch) {
    const res = await f(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + batch) }),
    });
    const body = (await res.json()) as { outcomes?: RewriteOutcome[]; error?: string };
    if (!res.ok || body.outcomes === undefined) throw new Error(body.error ?? `${endpoint}: HTTP ${res.status}`);
    all.push(...body.outcomes);
    options.onOutcomes?.(body.outcomes);
  }
  return all;
}
