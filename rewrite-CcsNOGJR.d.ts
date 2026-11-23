/**
 * Slack mrkdwn and Block Kit helpers: the escaping, links, mentions and block shapes every bot re-writes.
 * Blocks are plain objects (Slack's JSON), loosely typed, so callers can pass anything Block Kit accepts.
 */
/** Escape text for mrkdwn: Slack treats only `&`, `<` and `>` as control characters. */
declare const escape: (text: string) => string;
/** `<url|label>`; the label is escaped, and `|` / `<` / `>` can't appear unescaped in either part. */
declare function link(url: string, label?: string): string;
declare const mention: {
    user: (id: string) => string;
    channel: (id: string) => string;
    /** A user group (`S…`). */
    group: (id: string) => string;
    here: string;
    channelAll: string;
};
/**
 * `<!date^…>`: a timestamp each reader sees in their own time zone. `format` uses Slack's tokens
 * (`{date_short_pretty} at {time}`); `fallback` shows where it can't render (notifications, old clients).
 */
declare function date(tsS: number, format: string, fallback: string, href?: string): string;
/**
 * Cut `text` to at most `max` characters (by code point, so no split emoji), ending in `ellipsis` when cut. With
 * `atLine`, cut at the last line break past half the budget when there is one, ending in `\n…`.
 */
declare function bound(text: string, max: number, options?: string | {
    ellipsis?: string;
    atLine?: boolean;
}): string;
type Block = Record<string, unknown>;
declare const mrkdwnText: (text: string) => Block;
declare const plainText: (text: string, emoji?: boolean) => Block;
declare const header: (text: string) => Block;
declare const divider: () => Block;
/** A mrkdwn section (Slack caps its text at 3000), with optional side `fields` and `accessory`. */
declare function section(text: string, options?: {
    fields?: string[];
    accessory?: Block;
    blockId?: string;
}): Block;
/** Small grey lines: strings become mrkdwn elements; pass `image(...)`-style objects as is. */
declare function context(...elements: Array<string | Block>): Block;
/**
 * An image block: from a public URL (`image_url`), or a file uploaded to Slack, by id (`{ slackFile }`) or by its
 * `url_private` / permalink (`{ slackFileUrl }`). Edited in place, a URL image only refreshes under a new URL
 * (`versionedUrl`), and a Slack file must be processed first (`upload` waits by default). Phone apps offer no Download
 * on image blocks; attach the file (`Msg.files`) for that.
 */
declare function image(src: string | {
    slackFile: string;
} | {
    slackFileUrl: string;
}, alt: string, title?: string): Block;
/**
 * `url` with `v=<version>` set in its query: Slack caches an image block's picture by URL, so an edit that keeps the
 * URL keeps showing the old image. Use a content hash or timestamp as the version (or sign the URL per version).
 */
declare function versionedUrl(url: string, version: string | number, param?: string): string;
/** A `context` / `section`-accessory image element. */
declare const imageElement: (url: string, alt: string) => Block;
interface ButtonOptions {
    text: string;
    actionId: string;
    value?: string;
    url?: string;
    style?: "primary" | "danger";
    confirm?: {
        title: string;
        text: string;
        confirm: string;
        deny: string;
    };
}
declare function button(options: ButtonOptions): Block;
declare function actions(elements: Block[], blockId?: string): Block;
/** Slack's cap on a view's `private_metadata`. */
declare const PRIVATE_METADATA_MAX = 3000;
/** Whether `value` fits in `private_metadata` as JSON (to degrade gracefully instead of throwing). */
declare const fitsPrivateMetadata: (value: unknown) => boolean;
/**
 * Encode JSON state for a view's `private_metadata`, throwing (rather than letting `views.open` fail opaquely) when it
 * doesn't fit.
 */
declare function encodePrivateMetadata(value: unknown): string;
declare function decodePrivateMetadata<T = unknown>(s: string | undefined): T | null;
/**
 * `msg` without image blocks or image accessories: the `fallback` to post when Slack rejects a message whose image it
 * can't fetch yet (`invalid_blocks`), to be edited back in once it can.
 */
declare function withoutImages<M extends {
    blocks?: unknown[];
}>(msg: M): M;
declare const option: (text: string, value: string) => Block;
/** An `input` block: a labeled form field around `element`. */
declare function input(options: {
    label: string;
    element: Block;
    blockId?: string;
    optional?: boolean;
    hint?: string;
    dispatchAction?: boolean;
}): Block;
declare function plainTextInput(options: {
    actionId: string;
    multiline?: boolean;
    initial?: string;
    placeholder?: string;
    maxLength?: number;
}): Block;
/** A single (`static_select`) or multi (`multi`: `multi_static_select`) select over `[text, value]` options. */
declare function staticSelect(options: {
    actionId: string;
    options: Array<[string, string]>;
    initial?: string | string[];
    placeholder?: string;
    multi?: boolean;
}): Block;
declare function usersSelect(options: {
    actionId: string;
    initial?: string;
    placeholder?: string;
}): Block;
declare function datePicker(options: {
    actionId: string;
    initial?: string;
    placeholder?: string;
}): Block;
/** A modal view. */
declare function modal(options: {
    title: string;
    blocks: Block[];
    submit?: string;
    close?: string;
    callbackId?: string;
    privateMetadata?: string;
    externalId?: string;
}): Block;
interface RichStyle {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    code?: boolean;
}
/**
 * `rich_text` builders: literal text that mrkdwn would mangle (emoji inside link anchors, `*` and `_` as themselves),
 * real bullet lists, and per-run styles.
 */
declare const rich: {
    /** The `rich_text` block. */
    block: (...elements: Block[]) => Block;
    /** A paragraph of inline elements (strings become plain text). */
    section: (...elements: Array<string | Block>) => Block;
    /** A bullet (or numbered) list of sections. */
    list: (items: Block[], options?: {
        style?: "bullet" | "ordered";
        indent?: number;
    }) => Block;
    quote: (...elements: Array<string | Block>) => Block;
    preformatted: (text: string) => Block;
    text: (text: string, style?: RichStyle) => Block;
    link: (url: string, text?: string, style?: RichStyle) => Block;
    /** An emoji by name (`"star"`, not `":star:"`). */
    emoji: (name: string) => Block;
    user: (id: string) => Block;
    channel: (id: string) => Block;
    date: (tsS: number, format: string, fallback?: string) => Block;
};

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

declare const PLAN_VERSION = 1;
declare const REWRITE_KINDS: readonly ["edit", "repost", "noop", "skip", "blocked"];
type RewriteKind = (typeof REWRITE_KINDS)[number];
interface RewriteSender {
    username: string | null;
    icon_url: string | null;
    icon_emoji: string | null;
}
/** What a message shows: wire `text` (Slack mrkdwn), `blocks` (`null`: none), sender override, attached file ids. */
interface RewriteContent {
    text: string;
    blocks: Block[] | null;
    sender: RewriteSender;
    files: string[];
}
interface PlannedAction {
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
interface RewritePlan {
    thrds_rewrite_plan: typeof PLAN_VERSION;
    actions: PlannedAction[];
    /** Per-kind counts (review form only). */
    counts?: Record<RewriteKind, number>;
}
declare const REWRITE_STATUSES: readonly ["done", "already", "receipt", "pending", "stale", "gone", "failed", "undeleted"];
type RewriteStatus = (typeof REWRITE_STATUSES)[number];
/** One applied (or dry-run) action's result. */
interface RewriteOutcome {
    ts: string;
    kind: RewriteKind;
    status: RewriteStatus;
    new_ts?: string;
    error?: string;
}
/** Validates a parsed plan's version and shape; throws on anything else. */
declare function parsePlan(json: unknown): RewritePlan;
/** `edit` and `repost` write; the other kinds don't. */
declare const writes: (a: Pick<PlannedAction, "kind">) => boolean;
declare function planCounts(plan: RewritePlan): Record<RewriteKind, number>;
declare const senderChanged: (a: PlannedAction) => boolean;
declare function describeSender(s: RewriteSender): string;
interface DiffLine {
    op: " " | "-" | "+";
    text: string;
}
/** Line diff of `a` → `b` (longest common subsequence): unchanged, removed and added lines in order. */
declare function lineDiff(a: string, b: string): DiffLine[];
/** `json.dumps(value, sort_keys=True, ensure_ascii=False)`: Python's separators, keys sorted at every level. Numbers
 *  print as JS does, which matches Python for ints (Slack's blocks carry no floats). */
declare function pyJsonDumps(value: unknown): string;
/** A message's content hash: the first 16 hex digits of the SHA-256 of its `pyJsonDumps`, as Python's `Content.hash`. */
declare function contentHash(c: RewriteContent): Promise<string>;
/** A raw Slack message, as `conversations.history` / `replies` return it. */
type RawSlackMessage = Record<string, unknown> & {
    ts: string;
};
/** The override a read message shows: `username`, and `icons.emoji` or an `icons.image_*` URL. Only a `bot_message`
 *  carries one; an app's plain post has `icons` for its own avatar, which isn't one. */
declare function senderOf(m: Record<string, unknown>): RewriteSender;
declare function contentOf(m: Record<string, unknown>): RewriteContent;
/** `live` (as read) already shows `want`, compared as Slack stores a message (as Python's `same_content`):
 *  - `&amp;` `&lt;` `&gt;` (how Slack stores `&` `<` `>`) equal the characters, in the text and every block string.
 *  - A text-only `want` (no blocks) matches live blocks that are only `rich_text`, which Slack derives from the text;
 *    the text must match.
 *  - With blocks, the blocks are what renders and the text is only the notification fallback, so the text is
 *    compared with whitespace runs collapsed. Block ids, the fields Slack adds to an image block, and the default
 *    `verbatim: false` / `emoji: true` are ignored. */
declare function sameContent(live: RewriteContent, want: RewriteContent): boolean;
/** A message in scope, as read from Slack. `threadTs`: the parent's ts for a reply, null for a top-level message.
 *  `last`: the newest in its container (the channel's top level, or its thread); only then can a repost keep its
 *  place. `ours`: posted by this token's bot / user. */
interface RewriteFound {
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
/** What a message should show. `blocks` absent / null: text only. `sender` absent / null: keep its sender. */
interface Desired {
    text: string;
    blocks?: Block[] | null;
    sender?: RewriteSender | null;
}
/** The app leaves this message alone, for `skip` (the reason). */
interface Skip {
    skip: string;
}
type Render = (found: RewriteFound) => Desired | Skip | Promise<Desired | Skip>;
/** `parsePlan`, then each action's recorded hash checked against its old content (as Python's `Plan.from_json`). */
declare function verifyPlan(json: unknown): Promise<RewritePlan>;
/** Where outcomes of real runs go, so a re-run skips what's `done` / `already`. */
interface RewriteReceipts {
    /** The ts already `done` or `already`. */
    done(): Promise<Set<string>>;
    record(o: RewriteOutcome): Promise<void>;
}
/** Receipts in memory (tests, one-request runs). */
declare function memoryReceipts(initial?: RewriteOutcome[]): RewriteReceipts & {
    outcomes: RewriteOutcome[];
};
/** `chat.update` / `chat.delete` are Slack tier 3 (~50/min), `chat.postMessage` ~1/s per channel: 1.2 s between
 *  writes stays under both. */
declare const DEFAULT_PACE_MS = 1200;
/**
 * A render replacing each `mapping` key with its value, in the text and the blocks. Blocks that are only `rich_text`
 * are dropped (Slack re-derives them from the new text); other blocks have their strings substituted, and an `emoji`
 * element named `x` becomes `y` when `:x:` maps to `:y:`.
 */
declare function substitute(mapping: Record<string, string>): Render;
/** How many actions one `check` / `apply` request takes: each is 2–5 Slack calls, and a Worker request has a
 *  subrequest cap (50 free, 1000 paid). `postRewrite` batches to it. */
declare const DEFAULT_BATCH = 10;
/**
 * The page's side of `rewriteHandler` (or `slck rewrite review`): POST `ids` to `endpoint` (`…/check` or `…/apply`)
 * `batch` at a time, in order, calling `onOutcomes` after each batch; resolves to every outcome. Throws on the first
 * refused batch (what was applied before it stays applied, and its receipts say so).
 */
declare function postRewrite(endpoint: string, ids: readonly string[], options?: {
    batch?: number;
    fetch?: typeof fetch;
    onOutcomes?: (os: RewriteOutcome[]) => void;
}): Promise<RewriteOutcome[]>;

export { pyJsonDumps as $, decodePrivateMetadata as A, type Block as B, describeSender as C, DEFAULT_BATCH as D, divider as E, encodePrivateMetadata as F, escape as G, fitsPrivateMetadata as H, header as I, image as J, imageElement as K, input as L, lineDiff as M, link as N, memoryReceipts as O, PLAN_VERSION as P, mention as Q, REWRITE_KINDS as R, type Skip as S, modal as T, mrkdwnText as U, option as V, parsePlan as W, plainText as X, plainTextInput as Y, planCounts as Z, postRewrite as _, type ButtonOptions as a, rich as a0, sameContent as a1, section as a2, senderChanged as a3, senderOf as a4, staticSelect as a5, substitute as a6, usersSelect as a7, verifyPlan as a8, versionedUrl as a9, withoutImages as aa, writes as ab, DEFAULT_PACE_MS as b, type Desired as c, type DiffLine as d, PRIVATE_METADATA_MAX as e, type PlannedAction as f, REWRITE_STATUSES as g, type RawSlackMessage as h, type Render as i, type RewriteContent as j, type RewriteFound as k, type RewriteKind as l, type RewriteOutcome as m, type RewritePlan as n, type RewriteReceipts as o, type RewriteSender as p, type RewriteStatus as q, type RichStyle as r, actions as s, bound as t, button as u, contentHash as v, contentOf as w, context as x, date as y, datePicker as z };
