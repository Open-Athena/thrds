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
 * 2. **Plan** (`plan(found, render, {posts})`): the app's `render(found) -> Desired | Skip | Delete` re-derives each
 *    message; one action per message: `edit`, `repost` (the sender changes, which `chat.update` can't do), `delete`,
 *    `noop`, `skip` (the app's reason) or `blocked` (what Slack can't do), each recording the message's content hash.
 *    New messages are `post` actions, keyed by a plan-assigned key (in `ts`) until they have a ts.
 * 3. **Apply** (`apply(plan, client)`): a dry run unless `dryRun: false`; each action re-reads its message and refuses
 *    it once its hash moved (`stale`). Every `post` runs before any `delete`, and a failed post holds the deletes.
 *    Writes are paced; `receipts` (`memoryReceipts`, `/d1`'s `d1Receipts`) make a re-run skip what's done, and a real
 *    run with posts needs them, so a re-run never posts twice.
 *
 * This module is the browser-safe half (types, content hashing, `substitute`, `postRewrite`); the Slack half (find,
 * `plan`, `apply`, `rewriteHandler`) is `./rewrite-slack`, so a page bundling `PlanView` doesn't pull in the client.
 */

declare const PLAN_VERSION = 1;
declare const REWRITE_KINDS: readonly ["edit", "repost", "post", "delete", "noop", "skip", "blocked"];
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
    /** The message's ts; a `post`'s key (it has no ts until posted). */
    ts: string;
    /** The parent's ts for a reply; `null` for a top-level message. */
    thread_ts: string | null;
    /** The message's content hash when planned (a post's: its new content's); apply refuses the action once it moves. */
    hash: string;
    /** `null` for a `post` (and a blocked one). */
    old: RewriteContent | null;
    /** `null` for a `delete`. */
    new: RewriteContent | null;
    reason: string | null;
    broadcast?: boolean;
    metadata?: unknown;
    /** Unified diff of the text (review form only). */
    diff?: string;
}
interface RewritePlan {
    thrds_rewrite_plan: typeof PLAN_VERSION;
    /** A `delete` runs only once every `post` in the plan is done (this run, or by receipt), across runs and batches.
     *  Without it, a post that fails in a run holds that run's deletes. */
    delete_after_posts?: boolean;
    /** Review applies the plan whole, never a selection of it. */
    atomic?: boolean;
    actions: PlannedAction[];
    /** Per-kind counts (review form only). */
    counts?: Record<RewriteKind, number>;
}
declare const REWRITE_STATUSES: readonly ["done", "already", "receipt", "pending", "stale", "gone", "failed", "undeleted"];
type RewriteStatus = (typeof REWRITE_STATUSES)[number];
/** One applied (or dry-run) action's result: `ts` is the action's (a post's key), `new_ts` what a post / repost
 *  posted. A real run's `pending` is a delete held by a post not done (see `error`). */
interface RewriteOutcome {
    ts: string;
    kind: RewriteKind;
    status: RewriteStatus;
    new_ts?: string;
    error?: string;
}
/** Validates a parsed plan's version and shape; throws on anything else. */
declare function parsePlan(json: unknown): RewritePlan;
/** `edit`, `repost`, `post` and `delete` write; the other kinds don't. */
declare const writes: (a: Pick<PlannedAction, "kind">) => boolean;
/** `actions` in the order `apply` runs them: the given order, with every `delete` moved after the rest. A review page
 *  sends its selection in this order (in batches, too), so no delete goes before a post. */
declare const applyOrder: <A extends Pick<PlannedAction, "kind">>(actions: Iterable<A>) => A[];
/** Each post's key → its ts, for posts done now or by an earlier run (so the app can record them). */
declare function postedOf(outcomes: Iterable<RewriteOutcome>): Record<string, string>;
/** The writes' counts, as a review header reads them: "3 to edit · 5 to post · 27 to delete" (`""` for none). */
declare function writesSummary(counts: Record<RewriteKind, number>): string;
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
/** The app wants this message gone (`reason`: why, for review). */
interface Delete {
    delete: true;
    reason?: string | null;
}
type Render = (found: RewriteFound) => Desired | Skip | Delete | Promise<Desired | Skip | Delete>;
/** A new message for the plan to post: `desired` into `channel` (a reply when `threadTs` is set). `key` names it until
 *  it has a ts (in `only`, receipts and `postedOf`); default `post-<hash of its content>` (`-2`, `-3`… for repeats), so
 *  a re-plan of the same content keeps it. Not ts-shaped, and unique within the plan. Python's `Post`. */
interface RewritePost {
    channel: string;
    threadTs: string | null;
    desired: Desired;
    key?: string;
    broadcast?: boolean;
    metadata?: unknown;
}
/** `parsePlan`, then each action's recorded hash checked against its old content (a post's: its new content), as
 *  Python's `Plan.from_json`. */
declare function verifyPlan(json: unknown): Promise<RewritePlan>;
/** Where outcomes of real runs go, so a re-run skips what's `done` / `already`. */
interface RewriteReceipts {
    /** The ids (a message's ts, a post's key) already `done` or `already` → the ts each posted (`null`: none). */
    done(): Promise<Map<string, string | null>>;
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
/** How many actions one `check` / `apply` request takes (posts and deletes count): each is 1–5 Slack calls, and a Worker request has a
 *  subrequest cap (50 free, 1000 paid). `postRewrite` batches to it. */
declare const DEFAULT_BATCH = 10;
/**
 * The page's side of `rewriteHandler` (or `slck rewrite review`): POST `ids` to `endpoint` (`…/check` or `…/apply`)
 * `batch` at a time, in order, calling `onOutcomes` after each batch; resolves to every outcome. Throws on the first
 * refused batch (what was applied before it stays applied, and its receipts say so). Pass the ids in `applyOrder`, so
 * no batch of deletes goes before a batch with posts.
 */
declare function postRewrite(endpoint: string, ids: readonly string[], options?: {
    batch?: number;
    fetch?: typeof fetch;
    onOutcomes?: (os: RewriteOutcome[]) => void;
}): Promise<RewriteOutcome[]>;

export { plainTextInput as $, context as A, type Block as B, date as C, DEFAULT_BATCH as D, datePicker as E, decodePrivateMetadata as F, describeSender as G, divider as H, encodePrivateMetadata as I, escape as J, fitsPrivateMetadata as K, header as L, image as M, imageElement as N, input as O, PLAN_VERSION as P, lineDiff as Q, REWRITE_KINDS as R, type Skip as S, link as T, memoryReceipts as U, mention as V, modal as W, mrkdwnText as X, option as Y, parsePlan as Z, plainText as _, type ButtonOptions as a, planCounts as a0, postRewrite as a1, postedOf as a2, pyJsonDumps as a3, rich as a4, sameContent as a5, section as a6, senderChanged as a7, senderOf as a8, staticSelect as a9, substitute as aa, usersSelect as ab, verifyPlan as ac, versionedUrl as ad, withoutImages as ae, writes as af, writesSummary as ag, DEFAULT_PACE_MS as b, type Delete as c, type Desired as d, type DiffLine as e, PRIVATE_METADATA_MAX as f, type PlannedAction as g, REWRITE_STATUSES as h, type RawSlackMessage as i, type Render as j, type RewriteContent as k, type RewriteFound as l, type RewriteKind as m, type RewriteOutcome as n, type RewritePlan as o, type RewritePost as p, type RewriteReceipts as q, type RewriteSender as r, type RewriteStatus as s, type RichStyle as t, actions as u, applyOrder as v, bound as w, button as x, contentHash as y, contentOf as z };
