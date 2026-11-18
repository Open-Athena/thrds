import { h as ThreadClient, S as Sender, M as Message, b as MessageMetadata, d as MsgLike, g as Thread, e as SyncOptions, f as SyncResult, c as Msg } from './core-C7X-hhBF.js';

/**
 * Slack Web API transport: one place for the `Bearer` + JSON/query request, the `ok` check, retries and timeouts that
 * every bot otherwise re-writes. Web APIs only (`fetch`, `AbortSignal`), so it runs on Workers and Node alike.
 */
declare const SLACK_API = "https://slack.com/api";
/** A Slack response that came back `ok`. Method-specific fields are untyped; read them where they're used. */
interface SlackResponse {
    ok: true;
    [key: string]: unknown;
}
/** A failed call: Slack's own error code (`channel_not_found`, `ratelimited`, …) or `http_<status>` / `timeout`. */
declare class SlackApiError extends Error {
    readonly method: string;
    readonly code: string;
    readonly status: number;
    readonly response?: Record<string, unknown> | undefined;
    constructor(method: string, code: string, status: number, response?: Record<string, unknown> | undefined);
}
interface RetryInfo {
    method: string;
    /** 1-based: the retry about to happen. */
    attempt: number;
    waitMs: number;
    reason: "http_429" | "ratelimited" | "server_error" | "timeout";
}
interface TransportOptions {
    fetch?: typeof fetch;
    /** Retries after the first attempt. Default 3. */
    retries?: number;
    /**
     * Also retry HTTP 5xx and timeouts (exponential, 1s base). Off by default: a write that timed out may have landed,
     * and a blind retry of `chat.postMessage` posts twice. `syncSlots`' write-ahead `pending` record makes that safe.
     */
    retryServerErrors?: boolean;
    /** Per-request timeout. Default 30 000; 0 disables. */
    timeoutMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: RetryInfo) => void;
}
interface CallOptions extends TransportOptions {
    /** Send `body` as query parameters on a GET (read methods that don't accept JSON, e.g. `users.lookupByEmail`). */
    get?: boolean;
}
/** A successful call's JSON and headers (`auth.test`'s `x-oauth-scopes` lives in a header). */
declare function slackCall(token: string, method: string, body?: Record<string, unknown>, options?: CallOptions): Promise<{
    json: SlackResponse;
    headers: Headers;
}>;
/** Call a Slack Web API method; throws `SlackApiError` unless Slack says `ok`. */
declare function slackApi(token: string, method: string, body?: Record<string, unknown>, options?: CallOptions): Promise<SlackResponse>;
/**
 * Every item of a cursor-paginated method (`conversations.history` / `.replies` / `.list`, `users.list`, …), lazily.
 * `key` is the response field holding the page's items (`messages`, `channels`, `members`).
 */
declare function paginate<T = Record<string, unknown>>(call: (cursor: string | undefined) => Promise<SlackResponse>, key: string): AsyncGenerator<T>;
declare function collect<T>(items: AsyncIterable<T>): Promise<T[]>;

interface Section {
    title: string;
    summary: string;
    body: string;
}
interface LinkedThread {
    summaryPrefix: string;
    sections: Section[];
    summarySuffix?: string;
}
interface LinkedSyncResult {
    threadId: string;
    summaryIds: string[];
    detailIds: string[];
    /** section title → first detail message ID */
    sectionDetailIds: Record<string, string>;
}
type BulletFn = (section: Section, url: string) => string;
/** Default bullet format: bold linked title (Markdown). */
declare const defaultBullet: BulletFn;
/** Split a body into messages on paragraph (then line) boundaries. */
declare function splitBody(body: string, limit: number): string[];
/**
 * Build detail messages for each section.
 *
 * Returns `[messages, sectionStarts]` where `sectionStarts[i]` is the
 * index (0-based within details) where section `i` begins.
 */
declare function buildDetailMessages(sections: Section[], limit: number): [string[], Record<number, number>];
/**
 * Build summary messages with section bullets and links.
 *
 * Greedy-packs bullets into messages respecting the char limit.
 * `sectionUrls[i]` is the link URL for section `i` (placeholder or real).
 */
declare function buildSummaryMessages(linked: LinkedThread, sectionUrls: string[], limit: number, bulletFn?: BulletFn): string[];

declare const SLACK_MESSAGE_LIMIT = 4000;
/** Found users are cached this long; `users_not_found` for `NOT_FOUND_TTL_MS`; failures not at all. */
declare const USER_TTL_MS: number;
declare const NOT_FOUND_TTL_MS: number;
interface SlackClientOptions extends TransportOptions, Sender {
    token: string;
    /** The channel thread operations (`list`/`post`/`edit`/`delete`/`sync`) act in. `in(channel)` re-targets. */
    channel?: string;
    /** Default true: posts and edits set `unfurl_links`/`unfurl_media` false (Slack re-unfurls on edit, too). */
    suppressUnfurls?: boolean;
    /** Sent as `parse` on posts and edits (`"none"`: don't auto-link names/channels). */
    parse?: "none" | "full";
    /** Sent as `link_names` on posts and edits. */
    linkNames?: boolean;
    /** Clock (ms), for cache expiry. */
    now?: () => number;
}
interface SlackPostOptions {
    threadId?: string;
}
interface SlackDeleteOptions {
    orphansOk?: boolean;
}
interface SlackSyncOptions extends SyncOptions {
    threadTs?: string;
    suppressUnfurls?: boolean;
}
interface Reaction {
    name: string;
    count: number;
    users: string[];
}
/** A message as read back: `Message` plus what Slack says about it. Absent fields are omitted, not `undefined`. */
interface SlackMessage extends Message {
    user?: string;
    botId?: string;
    /** The display name it was posted under (`username` override, or a bot's name). */
    username?: string;
    subtype?: string;
    threadTs?: string;
    replyCount?: number;
    blocks?: unknown[];
    metadata?: MessageMetadata;
    reactions?: Reaction[];
}
interface SlackUser {
    id: string;
    name: string;
    realName?: string;
    displayName?: string;
    email?: string;
    /** `profile.image_192`. */
    image?: string;
    /** Every `profile.image_*` size, keyed by size (`"24"`, …, `"512"`, `"original"`). */
    images: Record<string, string>;
    tz?: string;
    isBot: boolean;
    deleted: boolean;
}
interface BotIds {
    userId: string;
    botId?: string;
}
interface Cached<T> {
    value: T;
    expires: number;
}
/** State shared by a client and its `in(channel)` siblings. */
interface Shared {
    botIds?: Promise<BotIds>;
    scopes?: Promise<Set<string>>;
    channels?: Promise<Map<string, string>>;
    users: Map<string, Cached<SlackUser | null>>;
}
declare class SlackClient implements ThreadClient {
    readonly token: string;
    readonly username?: string;
    readonly iconUrl?: string;
    readonly iconEmoji?: string;
    private readonly options;
    private readonly _channel?;
    private readonly shared;
    private suppressUnfurls;
    private skipOp;
    constructor(options: SlackClientOptions, shared?: Shared);
    /** The channel thread operations act in; throws if the client wasn't given one. */
    get channel(): string;
    /** The same client (token, options, caches) acting in another channel. */
    in(channel: string): SlackClient;
    private now;
    /** Call any Web API method with this client's token, retries and timeout. */
    api(method: string, body?: Record<string, unknown>, options?: {
        get?: boolean;
    }): Promise<SlackResponse>;
    /** Every item of a cursor-paginated method; `key` is the response field holding the items. */
    paginate<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, key: string, options?: {
        get?: boolean;
    }): AsyncGenerator<T>;
    /**
     * Lazily resolve the authenticated bot's `user_id` and `bot_id`.
     *
     * Slack returns `user: null` on `bot_message` events — the bot's identity
     * lives in `bot_id`. Matching only `user_id` mis-labels our own posts as
     * non-editable, which makes `sync()` re-post the whole thread every run.
     */
    botIds(): Promise<BotIds>;
    /** The token's OAuth scopes (`auth.test`'s `x-oauth-scopes` header), cached. */
    scopes(): Promise<Set<string>>;
    /** Whether per-message `username` / `icon_url` will be honored (`chat:write.customize`). */
    canCustomizeSender(): Promise<boolean>;
    private toMessage;
    /** A thread's messages (parent first), every page, with metadata. */
    list(threadId: string): Promise<SlackMessage[]>;
    /** The channel's top-level messages, newest first, lazily across pages. */
    history(options?: {
        oldest?: string;
        latest?: string;
        inclusive?: boolean;
        limit?: number;
    }): AsyncGenerator<SlackMessage>;
    /**
     * The first message tagged with `metadata.event_type === eventType` whose payload satisfies `match`: in a thread
     * (`threadTs`), else the channel's history back to `oldest`. How a bot finds "its" message without a database.
     */
    findByMetadata(eventType: string, match?: (payload: Record<string, unknown>) => boolean, options?: {
        threadTs?: string;
        oldest?: string;
    }): Promise<SlackMessage | null>;
    /** The first message satisfying `hit`: in a thread (`threadTs`), else the channel's history back to `oldest`. */
    find(hit: (m: SlackMessage) => boolean, options?: {
        threadTs?: string;
        oldest?: string;
    }): Promise<SlackMessage | null>;
    /** The request body a message sends: text, blocks, metadata (hash-stamped when rich), formatting flags. */
    private body;
    private sent;
    /** Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. */
    post(m: MsgLike, threadId?: string): Promise<Message>;
    /**
     * Edit a message's text, blocks and metadata. Slack ignores sender fields on an edit. To clear a message's blocks,
     * pass `blocks: []`; omitting `blocks` leaves them as they were.
     */
    edit(messageId: string, m: MsgLike): Promise<Message>;
    delete(messageId: string, options?: SlackDeleteOptions): Promise<void>;
    /** A message only `user` sees; returns its `message_ts`. */
    postEphemeral(user: string, m: MsgLike, options?: {
        threadTs?: string;
    }): Promise<string>;
    permalink(messageTs: string): Promise<string>;
    /** Add a reaction (no-op if we already reacted). */
    react(ts: string, name: string): Promise<void>;
    /** Remove our reaction (no-op if it isn't there). */
    unreact(ts: string, name: string): Promise<void>;
    reactions(ts: string): Promise<Reaction[]>;
    private cachedUser;
    /** A user by id (`users.info`), cached; null if there's no such user. */
    userInfo(id: string): Promise<SlackUser | null>;
    /** A user by email (`users.lookupByEmail`, needs `users:read.email`), cached; null if none. */
    userByEmail(email: string): Promise<SlackUser | null>;
    /** Every workspace member (`users.list`), lazily. */
    users(): AsyncGenerator<SlackUser>;
    /**
     * A sender that looks like `user`: their display/real name and Slack photo. Pair with `/avatar`'s `badgedSvg` to
     * mark the post as automated.
     */
    senderFor(userId: string, options?: {
        suffix?: string;
        iconUrl?: string;
    }): Promise<Sender | null>;
    /** A channel's id from `#name`, `name` or an id (returned as-is), via a cached `conversations.list`. */
    channelId(nameOrId: string): Promise<string>;
    /** The DM (one user) or group DM (several) channel id, opening it if needed. */
    openDm(users: string | string[]): Promise<string>;
    /** Open a modal (`views.open`); returns the view, whose `id`/`hash` `updateView` takes. */
    openView(triggerId: string, view: Record<string, unknown>): Promise<Record<string, unknown>>;
    pushView(triggerId: string, view: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Update a modal by `viewId` or `externalId`; pass the last-seen `hash` to refuse a stale overwrite. */
    updateView(view: Record<string, unknown>, target: {
        viewId?: string;
        externalId?: string;
        hash?: string;
    }): Promise<Record<string, unknown>>;
    /** Publish a user's App Home tab. */
    publishHome(userId: string, view: Record<string, unknown>): Promise<void>;
    sync(thread: Thread, options?: SlackSyncOptions): Promise<SyncResult>;
    /**
     * Sync a linked summary thread.
     *
     * In Slack the thread parent (OP) is the first message in
     * `conversations.replies`. This method manages the OP separately
     * (setting it to `summaryPrefix`) and syncs bullets + details as thread
     * replies. Two phases: post all messages with placeholder URLs first
     * (to obtain real message ids), then edit summaries with real
     * permalinks.
     */
    syncLinked(linked: LinkedThread, options?: {
        threadTs?: string;
        dryRun?: boolean;
        pace?: number;
        jitter?: number;
        suppressUnfurls?: boolean;
    }): Promise<LinkedSyncResult>;
}

/** Where a slot's message lives, and a hash of what was last sent there. */
interface SlotRecord {
    ts: string;
    hash: string;
}
interface SlotState {
    parent?: SlotRecord;
    slots: Record<string, SlotRecord>;
    /** A post that started but wasn't recorded. `slot` null is the parent; `at` is epoch seconds. */
    pending?: {
        slot: string | null;
        hash: string;
        at: number;
    };
}
/**
 * Persistence for slot state, by thread key. `put` with a `lease` must fail (return false) once the lease is no longer
 * held. `claim` / `release` are optional: a store without them can't fence concurrent runs (fine for a cron job).
 */
interface SlotStore {
    get(key: string): Promise<SlotState | undefined>;
    put(key: string, state: SlotState, lease?: string): Promise<boolean>;
    claim?(key: string, leaseS: number, nowS: number): Promise<string | null>;
    release?(key: string, lease: string): Promise<void>;
}
declare class LeaseLostError extends Error {
    readonly key: string;
    constructor(key: string);
}
interface SlotSpec {
    slot: string;
    msg: MsgLike;
}
interface SlotThread {
    /** The thread's identity in the store (`burst:123`, `week:2026-11-13`). */
    key: string;
    /** Our parent message, or an existing message (someone else's prompt) to reply under without managing it. */
    parent: MsgLike | {
        ts: string;
    };
    /** Named replies, in post order. */
    slots?: SlotSpec[];
    /** Delete stored slots no longer desired. Default false: a slot dropped from `slots` is left alone. */
    prune?: boolean;
}
interface SlotSyncOptions {
    /** Claim the key for this long first (needs a store with `claim`). A busy key returns `status: "busy"`. */
    leaseS?: number;
    /** Seconds between Slack writes. */
    pace?: number;
    dryRun?: boolean;
    /** How far back (s) before a `pending` post's start to look for it in channel history. Default 120. */
    recoverWindowS?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
type SlotActionType = "POST" | "EDIT" | "SKIP" | "DELETE" | "ADOPT" | "REPOST";
interface SlotAction {
    type: SlotActionType;
    /** null for the parent. */
    slot: string | null;
    ts?: string;
}
interface SlotSyncResult {
    status: "synced" | "busy";
    /** The parent's ts (empty when busy, or `<new>` in a dry run). */
    ts: string;
    slots: Record<string, string>;
    actions: SlotAction[];
}
/** Metadata payload fields that tag a message with its slot. */
declare const SLOT_KEY = "thrds_key";
declare const SLOT_NAME = "thrds_slot";
/** `msg` with its key and slot in its metadata (keeping a caller's own `event_type` and payload). */
declare function tagSlot(m: MsgLike, key: string, slot: string | null): Msg;
declare function syncSlots(client: SlackClient, store: SlotStore, thread: SlotThread, options?: SlotSyncOptions): Promise<SlotSyncResult>;
/** One message kept in place under `key`: posted the first time, edited when it changes, skipped otherwise. */
declare function upsert(client: SlackClient, store: SlotStore, key: string, msg: MsgLike, options?: SlotSyncOptions): Promise<{
    status: "synced" | "busy";
    ts: string;
    action: SlotActionType | null;
}>;
/** An in-process store (tests, single-isolate bots, or a cache in front of something slower). */
declare function memoryStore(initial?: Record<string, SlotState>): SlotStore & {
    dump(): Record<string, SlotState>;
};

export { buildSummaryMessages as A, type BulletFn as B, type CallOptions as C, collect as D, defaultBullet as E, memoryStore as F, paginate as G, slackApi as H, slackCall as I, splitBody as J, syncSlots as K, LeaseLostError as L, tagSlot as M, NOT_FOUND_TTL_MS as N, upsert as O, type Reaction as R, SLACK_API as S, type TransportOptions as T, USER_TTL_MS as U, type LinkedSyncResult as a, type LinkedThread as b, type RetryInfo as c, SLACK_MESSAGE_LIMIT as d, SLOT_KEY as e, SLOT_NAME as f, type Section as g, SlackApiError as h, SlackClient as i, type SlackClientOptions as j, type SlackDeleteOptions as k, type SlackMessage as l, type SlackPostOptions as m, type SlackResponse as n, type SlackSyncOptions as o, type SlackUser as p, type SlotAction as q, type SlotActionType as r, type SlotRecord as s, type SlotSpec as t, type SlotState as u, type SlotStore as v, type SlotSyncOptions as w, type SlotSyncResult as x, type SlotThread as y, buildDetailMessages as z };
