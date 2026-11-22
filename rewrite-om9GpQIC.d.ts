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
 * Bulk-rewrite plans: the JSON a `thrds slack rewrite plan` (Python `thrds.rewrite`) writes, typed for review UIs.
 *
 * One action per message: `edit`, `repost` (the sender changes, which `chat.update` can't do), `noop`, `skip` (the
 * app's reason) or `blocked` (what Slack can't do). `review_json()` / `slck rewrite show -j` add each action's text
 * `diff` and the `counts`. See `specs/done/bulk-rewrite.md` on the `py` branch.
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

export { input as A, type Block as B, lineDiff as C, type DiffLine as D, link as E, mention as F, modal as G, mrkdwnText as H, option as I, parsePlan as J, plainText as K, plainTextInput as L, planCounts as M, rich as N, section as O, PLAN_VERSION as P, senderChanged as Q, REWRITE_KINDS as R, staticSelect as S, usersSelect as T, versionedUrl as U, withoutImages as V, writes as W, type ButtonOptions as a, PRIVATE_METADATA_MAX as b, type PlannedAction as c, REWRITE_STATUSES as d, type RewriteContent as e, type RewriteKind as f, type RewriteOutcome as g, type RewritePlan as h, type RewriteSender as i, type RewriteStatus as j, type RichStyle as k, actions as l, bound as m, button as n, context as o, date as p, datePicker as q, decodePrivateMetadata as r, describeSender as s, divider as t, encodePrivateMetadata as u, escape as v, fitsPrivateMetadata as w, header as x, image as y, imageElement as z };
