import { h as ThreadClient, S as Sender, U as Unfurl, M as Message, b as MessageMetadata, d as MsgLike, g as Thread, e as SyncOptions, f as SyncResult } from './core-mTIXjUC4.js';

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
/**
 * How a call failed: `slack` (Slack answered, refusing: `ok:false` or a 429), `http` (a non-2xx status or an
 * unparseable body), `timeout`, or `transport` (the request never got an answer: DNS, connection reset, …).
 */
type SlackErrorKind = "slack" | "http" | "timeout" | "transport";
/** A failed call: Slack's own error code (`channel_not_found`, `ratelimited`, …) or `http_<status>` / `timeout`. */
declare class SlackApiError extends Error {
    readonly method: string;
    readonly code: string;
    readonly status: number;
    readonly response?: Record<string, unknown> | undefined;
    /** For `ratelimited`: how long Slack asked us to wait, when it said. */
    readonly retryAfterS?: number | undefined;
    readonly kind: SlackErrorKind;
    /** The code Slack itself sent (absent for synthesized ones like `http_502`), only if it looks like a Slack code. */
    readonly slackCode?: string;
    constructor(method: string, code: string, status: number, response?: Record<string, unknown> | undefined, 
    /** For `ratelimited`: how long Slack asked us to wait, when it said. */
    retryAfterS?: number | undefined, kind?: SlackErrorKind, options?: {
        cause?: unknown;
    });
    /**
     * Whether the failure means the request certainly did nothing: Slack refused it (`ok:false`, a 429) or rejected it
     * with a 4xx. False for timeouts, 5xx, transport errors and unparseable replies, after which a write may have landed.
     */
    get definite(): boolean;
}
interface RetryInfo {
    method: string;
    /** 1-based: the retry about to happen. */
    attempt: number;
    waitMs: number;
    reason: "http_429" | "ratelimited" | "server_error" | "timeout";
}
/**
 * Writes that create something: a 5xx or timeout leaves it unknown whether the write landed, so they are never
 * retried on those (a retry could post twice). A 429 or `ratelimited` reply means Slack refused the request, so
 * those are always safe to retry.
 */
declare const NON_IDEMPOTENT: Set<string>;
interface TransportOptions {
    fetch?: typeof fetch;
    /** Retries after the first attempt. Default 3. */
    retries?: number;
    /**
     * Also retry HTTP 5xx and timeouts (exponential, 1 s base) for methods that are safe to repeat: never for
     * `NON_IDEMPOTENT` ones, whose first attempt may have landed.
     */
    retryServerErrors?: boolean;
    /** Per-request timeout. Default 30 000; 0 disables. */
    timeoutMs?: number;
    /** Longest single wait before a retry; a longer `Retry-After` throws `ratelimited` (with `retryAfterS`) instead. */
    maxRetryWaitMs?: number;
    /** Total budget for a call, retries and waits included: a retry that wouldn't fit throws instead. */
    deadlineMs?: number;
    /**
     * Runs before every request with the method and its (unserialized) body: a place for policy, e.g. refusing posts
     * to a channel. Throw to block the call.
     */
    beforeCall?: (method: string, body: Record<string, unknown>) => void | Promise<void>;
    /** Default `https://slack.com/api`. */
    baseUrl?: string;
    /** Extra request headers (e.g. a session cookie for an undocumented endpoint). */
    headers?: Record<string, string>;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Clock for `deadlineMs`. */
    now?: () => number;
    onRetry?: (info: RetryInfo) => void;
}
interface CallOptions extends TransportOptions {
    /** Use this token for this call instead of the client's (e.g. a user token for deleting a user's message). */
    token?: string;
    /** Send `body` as query parameters on a GET (read methods that don't accept JSON, e.g. `users.lookupByEmail`). */
    get?: boolean;
    /** POST `body` form-encoded instead of as JSON (methods that don't accept JSON bodies). */
    form?: boolean;
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
/** Slack shows at most 80 characters of a `username` override. */
declare const USERNAME_MAX = 80;
/** Found users are cached this long; `users_not_found` for `NOT_FOUND_TTL_MS`; failures not at all. */
declare const USER_TTL_MS: number;
declare const NOT_FOUND_TTL_MS: number;
/** The user cache's size cap (oldest entries go first): plenty for a workspace, bounded for a long-lived process. */
declare const MAX_CACHED_USERS = 10000;
/** How long a `channelId` name lookup is trusted (channels get archived and re-created). */
declare const CHANNEL_TTL_MS: number;
interface SlackClientOptions extends TransportOptions, Sender {
    token: string;
    /** The channel thread operations (`list`/`post`/`edit`/`delete`/`sync`) act in. `in(channel)` re-targets. */
    channel?: string;
    /**
     * Unfurling on posts and edits (Slack re-unfurls on edit, too): `false` (the default) sends
     * `unfurl_links`/`unfurl_media` false, `true` sends them true, `{links, media}` sends only what's given, and
     * `"omit"` sends neither (Slack's defaults). A message's own `unfurl` wins.
     */
    unfurl?: Unfurl | "omit";
    /** Shorthand for `unfurl: !suppressUnfurls`; `unfurl` wins when both are given. */
    suppressUnfurls?: boolean;
    /** Sent as `parse` on posts and edits (`"none"`: don't auto-link names/channels). */
    parse?: "none" | "full";
    /** Sent as `link_names` on posts and edits. */
    linkNames?: boolean;
    /** Minimum gap between this client family's write calls (shared with `in(channel)` siblings). */
    minIntervalMs?: number;
    /**
     * Default for `Msg.stamp`: whether rich messages carry a content hash in their metadata. Leave it on for clients used
     * with `sync` or `threadStore`, which compare by that hash (`syncSlots` with a real store doesn't need it).
     */
    stamp?: boolean;
    /** Cap on cached users (oldest go first). Default `MAX_CACHED_USERS`. */
    userCacheSize?: number;
    /** Replace the HTTP transport, e.g. `webClientTransport(app.client)` to run over Bolt's `WebClient`. */
    transport?: Transport;
}
/** What `SlackClient` sends its calls through (default: `slackCall`). */
type Transport = (token: string, method: string, body: Record<string, unknown>, options: CallOptions) => Promise<{
    json: SlackResponse;
    headers: Headers;
}>;
/**
 * A transport over a Bolt / `@slack/web-api` `WebClient` (its token, retries and rate limiting), so a Bolt app can use
 * `SlackClient`, `syncSlots` and friends without a second HTTP stack. Scopes come from the result's
 * `response_metadata.scopes`; errors become `SlackApiError`s.
 */
declare function webClientTransport(client: {
    apiCall(method: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}): Transport;
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
    /** ts of the thread's latest reply (on a parent). */
    latestReply?: string;
    blocks?: unknown[];
    attachments?: unknown[];
    files?: Array<Record<string, unknown>>;
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
/** Who the token is (`auth.test`, cached): its user, bot, team, and OAuth scopes. */
interface Auth {
    userId: string;
    botId?: string;
    teamId?: string;
    scopes: Set<string>;
}
interface Cached<T> {
    value: T;
    expires: number;
}
/** State shared by a client and its `in(channel)` siblings. */
interface Shared {
    auth?: Promise<Auth>;
    channels?: Cached<Promise<Map<string, string>>> & {
        archived: boolean;
    };
    users: Map<string, Cached<SlackUser | null>>;
    /** Lookups in flight, so concurrent callers share one request. */
    loading: Map<string, Promise<SlackUser | null>>;
    lastWrite?: number;
}
declare class SlackClient implements ThreadClient {
    readonly token: string;
    readonly username?: string;
    readonly iconUrl?: string;
    readonly iconEmoji?: string;
    private readonly options;
    private readonly _channel?;
    private readonly shared;
    private unfurl;
    private skipOp;
    constructor(options: SlackClientOptions, shared?: Shared);
    /** The channel thread operations act in; throws if the client wasn't given one. */
    get channel(): string;
    /** The same client (token, options, caches) acting in another channel. */
    in(channel: string): SlackClient;
    /** The same client and caches with some options changed (e.g. `{ unfurl: true }`, or a different `channel`). */
    with(options: Partial<Omit<SlackClientOptions, "token">>): SlackClient;
    private now;
    /** Call any Web API method with this client's token and transport options; `options` override them per call. */
    api(method: string, body?: Record<string, unknown>, options?: CallOptions): Promise<SlackResponse>;
    private call;
    /** Every item of a cursor-paginated method; `key` is the response field holding the items. */
    paginate<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, key: string, options?: CallOptions): AsyncGenerator<T>;
    /** The token's identity and scopes, from one cached `auth.test`. */
    auth(): Promise<Auth>;
    /**
     * The authenticated bot's `user_id` and `bot_id`.
     *
     * Slack returns `user: null` on `bot_message` events — the bot's identity
     * lives in `bot_id`. Matching only `user_id` mis-labels our own posts as
     * non-editable, which makes `sync()` re-post the whole thread every run.
     */
    botIds(): Promise<{
        userId: string;
        botId?: string;
    }>;
    /** The token's OAuth scopes. */
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
     * Every message in the channel back to `oldest`: each top-level message (newest first), followed by its thread's
     * replies when `includeReplies` (for auditing bots that post into threads).
     */
    messages(options?: {
        oldest?: string;
        latest?: string;
        includeReplies?: boolean;
    }): AsyncGenerator<SlackMessage>;
    /**
     * The first message tagged with `metadata.event_type === eventType` whose payload satisfies `match`: in a thread
     * (`threadTs`), else the channel's history back to `oldest`. How a bot finds "its" message without a database.
     */
    findByMetadata(eventType: string, match?: (payload: Record<string, unknown>) => boolean, options?: {
        threadTs?: string;
        oldest?: string;
        includeReplies?: boolean;
    }): Promise<SlackMessage | null>;
    /**
     * The first message satisfying `hit`: in a thread (`threadTs`), else the channel's history back to `oldest` (with
     * thread replies, when `includeReplies`).
     */
    find(hit: (m: SlackMessage) => boolean, options?: {
        threadTs?: string;
        oldest?: string;
        includeReplies?: boolean;
    }): Promise<SlackMessage | null>;
    /** The request body a message sends: text, blocks, attachments, metadata (hash-stamped when rich), flags. */
    private body;
    private sent;
    /** Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. */
    post(m: MsgLike, threadId?: string): Promise<Message>;
    /**
     * Edit a message's text, blocks, attachments and metadata. Slack ignores sender fields on an edit. To clear blocks
     * or attachments, pass `[]`; omitting them leaves them as they were. For Slack's raw reply (`message`), call
     * `api("chat.update", …)` directly.
     */
    edit(messageId: string, m: MsgLike): Promise<Message>;
    /**
     * One message by ts, read cheaply (`conversations.replies`, `limit: 1`): a thread parent or top-level message, with
     * its reactions and reply count. Null if it's gone.
     */
    message(ts: string): Promise<SlackMessage | null>;
    /** How many replies a thread has (0 for a message without one). Needs a history scope on this token. */
    replyCount(ts: string): Promise<number>;
    /**
     * Delete a message. Unless `orphansOk`, first refuses (`OrphanedRepliesError`) if it has thread replies, which
     * needs a history scope on this token: with a token that only has `chat:write`, check `replyCount` with another
     * client first and pass `orphansOk`.
     */
    delete(messageId: string, options?: SlackDeleteOptions): Promise<void>;
    /** A message only `user` sees; returns its `message_ts`. Ephemerals can't be read back, so nothing is stamped. */
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
    /** A user by id (`users.info`), cached; null if there's no such user. `fresh` skips the cache (authz checks). */
    userInfo(id: string, options?: {
        fresh?: boolean;
    }): Promise<SlackUser | null>;
    /** A user by email (`users.lookupByEmail`, needs `users:read.email`), cached; null if none. */
    userByEmail(email: string, options?: {
        fresh?: boolean;
    }): Promise<SlackUser | null>;
    /** A user group's member ids, by id (`S…`) or handle (`@eng-leads` / `eng-leads`). */
    usergroupMembers(idOrHandle: string): Promise<string[]>;
    /** Every workspace member (`users.list`), lazily. */
    users(): AsyncGenerator<SlackUser>;
    /**
     * A sender that looks like a user (by id or email): their display/real name and Slack photo. Pair with `/avatar`'s `badgedSvg` to
     * mark the post as automated. Null for an unknown user (or a deactivated one, unless `includeDeleted`).
     */
    senderFor(userIdOrEmail: string, options?: {
        suffix?: string;
        iconUrl?: string;
        imageSize?: string;
        includeDeleted?: boolean;
    }): Promise<Sender | null>;
    /**
     * A channel's id from `#name`, `name` or an id (returned as-is), via `conversations.list`, cached for
     * `CHANNEL_TTL_MS`. `refresh` re-lists now; `includeArchived` also matches archived channels.
     */
    channelId(nameOrId: string, options?: {
        refresh?: boolean;
        includeArchived?: boolean;
    }): Promise<string>;
    /** Forget cached channel names (after archiving / re-creating one). */
    invalidateChannels(): void;
    /** The DM (one user) or group DM (several) channel id, opening it if needed. */
    openDm(users: string | string[]): Promise<string>;
    /** Open a modal (`views.open`); returns the view, whose `id`/`hash` `updateView` takes. */
    openView(triggerId: string, view: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
    pushView(triggerId: string, view: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
    /** Update a modal by `viewId` or `externalId`; pass the last-seen `hash` to refuse a stale overwrite. */
    updateView(view: Record<string, unknown>, target: {
        viewId?: string;
        externalId?: string;
        hash?: string;
    }, options?: CallOptions): Promise<Record<string, unknown>>;
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

export { type Auth as A, type BulletFn as B, CHANNEL_TTL_MS as C, webClientTransport as D, type LinkedSyncResult as L, MAX_CACHED_USERS as M, NON_IDEMPOTENT as N, type Reaction as R, SLACK_API as S, type Transport as T, USERNAME_MAX as U, type CallOptions as a, type LinkedThread as b, NOT_FOUND_TTL_MS as c, type RetryInfo as d, SLACK_MESSAGE_LIMIT as e, type Section as f, SlackApiError as g, SlackClient as h, type SlackClientOptions as i, type SlackDeleteOptions as j, type SlackErrorKind as k, type SlackMessage as l, type SlackPostOptions as m, type SlackResponse as n, type SlackSyncOptions as o, type SlackUser as p, type TransportOptions as q, USER_TTL_MS as r, buildDetailMessages as s, buildSummaryMessages as t, collect as u, defaultBullet as v, paginate as w, slackApi as x, slackCall as y, splitBody as z };
