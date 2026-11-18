export { A as Action, a as ActionType, E as EditRateLimited, M as Message, b as MessageMetadata, c as Msg, d as MsgLike, O as OrphanedRepliesError, S as Sender, e as SyncOptions, f as SyncResult, T as THRDS_HASH, g as Thread, h as ThreadClient, i as contentKey, j as isRich, m as msgHash, s as sync, t as toMsg } from './core-C7X-hhBF.js';
export { B as BulletFn, C as CallOptions, L as LeaseLostError, a as LinkedSyncResult, b as LinkedThread, N as NOT_FOUND_TTL_MS, R as Reaction, c as RetryInfo, S as SLACK_API, d as SLACK_MESSAGE_LIMIT, e as SLOT_KEY, f as SLOT_NAME, g as Section, h as SlackApiError, i as SlackClient, j as SlackClientOptions, k as SlackDeleteOptions, l as SlackMessage, m as SlackPostOptions, n as SlackResponse, o as SlackSyncOptions, p as SlackUser, q as SlotAction, r as SlotActionType, s as SlotRecord, t as SlotSpec, u as SlotState, v as SlotStore, w as SlotSyncOptions, x as SlotSyncResult, y as SlotThread, T as TransportOptions, U as USER_TTL_MS, z as buildDetailMessages, A as buildSummaryMessages, D as collect, E as defaultBullet, F as memoryStore, G as paginate, H as slackApi, I as slackCall, J as splitBody, K as syncSlots, M as tagSlot, O as upsert } from './slots-BtvdSGce.js';

/**
 * Slack mrkdwn and Block Kit helpers: the escaping, links, mentions and block shapes every bot re-writes.
 * Blocks are plain objects (Slack's JSON), loosely typed, so callers can pass anything Block Kit accepts.
 */
/** Escape text for mrkdwn: Slack treats only `&`, `<` and `>` as control characters. */
declare const escape: (text: string) => string;
/** `<url|label>`; the label is escaped, and `|` / `>` can't appear unescaped in either part. */
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
/** Cut `text` to at most `max` characters (by code point, so no split emoji), ending in `ellipsis` when cut. */
declare function bound(text: string, max: number, ellipsis?: string): string;
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
/**
 * Slack caps a view's `private_metadata` at 3000 characters. Encode JSON state for it, throwing (rather than letting
 * `views.open` fail opaquely) when it doesn't fit.
 */
declare function encodePrivateMetadata(value: unknown): string;
declare function decodePrivateMetadata<T = unknown>(s: string | undefined): T | null;

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

/** JSON with object keys sorted at every level, so equal values always serialize equally. */
declare function stableStringify(value: unknown): string;
/**
 * A 53-bit non-cryptographic hash (cyrb53) as 14 hex digits. Change detection only: synchronous, and identical on
 * Workers and Node, unlike `crypto.subtle.digest`.
 */
declare function hash53(s: string, seed?: number): string;

export { type Block, type ButtonOptions, type MessageRef, actions, bound, buildPermalink, button, context, date, decodePrivateMetadata, divider, encodePrivateMetadata, escape, hash53, header, image, imageElement, link, mention, mrkdwnText, parsePermalink, plainText, section, stableStringify };
