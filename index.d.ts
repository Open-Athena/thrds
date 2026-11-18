export { A as Action, a as ActionType, E as EditRateLimited, M as Message, b as MessageMetadata, c as Msg, d as MsgLike, O as OrphanedRepliesError, S as Sender, e as SyncOptions, f as SyncResult, T as THRDS_HASH, g as Thread, h as ThreadClient, U as Unfurl, i as contentKey, j as isRich, m as msgHash, s as sync, t as toMsg } from './core-mTIXjUC4.js';
export { A as Auth, B as BulletFn, C as CHANNEL_TTL_MS, a as CallOptions, L as LinkedSyncResult, b as LinkedThread, M as MAX_CACHED_USERS, N as NON_IDEMPOTENT, c as NOT_FOUND_TTL_MS, R as Reaction, d as RetryInfo, S as SLACK_API, e as SLACK_MESSAGE_LIMIT, f as Section, g as SlackApiError, h as SlackClient, i as SlackClientOptions, j as SlackDeleteOptions, k as SlackErrorKind, l as SlackMessage, m as SlackPostOptions, n as SlackResponse, o as SlackSyncOptions, p as SlackUser, T as Transport, q as TransportOptions, U as USERNAME_MAX, r as USER_TTL_MS, s as buildDetailMessages, t as buildSummaryMessages, u as collect, v as defaultBullet, w as paginate, x as slackApi, y as slackCall, z as splitBody, D as webClientTransport } from './slack-_HD6P5rZ.js';
export { L as LeaseLostError, R as REJECTED, a as RenderedSlotThread, S as SLOT_KEY, b as SLOT_NAME, c as SlotAction, d as SlotActionType, e as SlotClient, f as SlotParent, g as SlotRecord, h as SlotSpec, i as SlotState, j as SlotStore, k as SlotSyncOptions, l as SlotSyncResult, m as SlotThread, n as SlotThreadSpec, U as UpsertOptions, o as importAnchor, p as memoryStore, q as oneKeyStore, r as partialOf, s as syncSlots, t as tagSlot, u as threadStore, v as upsert } from './slots-Dg6mOzxN.js';

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
/** An image block from a public URL, or (`{ slackFile }`) a file uploaded to Slack, by id. */
declare function image(src: string | {
    slackFile: string;
}, alt: string, title?: string): Block;
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

/** A message's location, parsed from a permalink. `threadTs` is set for a reply link (`?thread_ts=`). */
interface MessageRef {
    channel: string;
    ts: string;
    threadTs?: string;
}
/**
 * Parse a Slack message permalink (`https://<ws>.slack.com/archives/<channel>/p<ts digits>[?thread_ts=…]`), or
 * return null for anything else.
 */
declare function parsePermalink(url: string): MessageRef | null;
/**
 * Build a permalink without an API call (applitrack's `permalinkFromTs`). `workspace` is the subdomain
 * (`openathena`) or a full origin. `chat.getPermalink` is authoritative; this is for when a call isn't worth it.
 */
declare function buildPermalink(workspace: string, ref: MessageRef): string;
/** A permalink found in text: its ref, plus the URL as written. */
interface FoundPermalink extends MessageRef {
    url: string;
}
/** Every distinct Slack message permalink in `text` (bare, or mrkdwn `<url>` / `<url|label>`), in order of appearance. */
declare function permalinksIn(text: string): FoundPermalink[];
/** `text` with its Slack permalinks (bare or `<…>`) removed, and the whitespace they leave collapsed. */
declare function withoutPermalinks(text: string): string;

/** JSON with object keys sorted at every level, so equal values always serialize equally. */
declare function stableStringify(value: unknown): string;
/**
 * A 53-bit non-cryptographic hash (cyrb53) as 14 hex digits. Change detection only: synchronous, and identical on
 * Workers and Node, unlike `crypto.subtle.digest`.
 */
declare function hash53(s: string, seed?: number): string;

export { type Block, type ButtonOptions, type FoundPermalink, type MessageRef, PRIVATE_METADATA_MAX, type RichStyle, actions, bound, buildPermalink, button, context, date, datePicker, decodePrivateMetadata, divider, encodePrivateMetadata, escape, fitsPrivateMetadata, hash53, header, image, imageElement, input, link, mention, modal, mrkdwnText, option, parsePermalink, permalinksIn, plainText, plainTextInput, rich, section, stableStringify, staticSelect, usersSelect, withoutImages, withoutPermalinks };
