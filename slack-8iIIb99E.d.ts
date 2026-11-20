import { h as ThreadClient, S as Sender, U as Unfurl, M as Message, b as MessageMetadata, d as MsgLike, g as Thread, e as SyncOptions, f as SyncResult, c as Msg } from './core-BNb_OG-w.js';

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
    /** `transport`: a dropped connection (only retried for an upload's bytes, which are safe to re-send). */
    reason: "http_429" | "ratelimited" | "server_error" | "timeout" | "transport";
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
/**
 * A post with `files` landed (`ts`), but the edit attaching them failed. The message is stamped without the files, so
 * `sync` / `syncSlots` see it as out of date and attach them on their next run.
 */
declare class FilesNotAttachedError extends Error {
    readonly ts: string;
    constructor(ts: string, options?: {
        cause?: unknown;
    });
}
/** Slack hadn't processed an upload in time. An unshared one is deleted (`deleted`), since nothing can use it. */
declare class FileNotProcessedError extends Error {
    readonly fileId: string;
    readonly waitedMs: number;
    readonly deleted: boolean;
    constructor(fileId: string, waitedMs: number, deleted: boolean);
}
/**
 * Attaching newly uploaded files failed (`cause`). If Slack definitely refused the write, this run's uploads were
 * deleted (`deleted`); otherwise the write may have landed, so they're kept and `fileIds` says which they are. Files
 * reused from the message's previous attachments are never deleted.
 */
declare class FileSwapError extends Error {
    readonly fileIds: string[];
    readonly deleted: boolean;
    constructor(fileIds: string[], deleted: boolean, options?: {
        cause?: unknown;
    });
    /** The first (for a single-file swap, the only) upload. */
    get fileId(): string | undefined;
}
/** The `metadata.event_payload` field the swap helpers stamp the attached files' content hashes into (in order). */
declare const FILE_HASHES = "thrds_files";
/** A previously attached file: its id, and its content hash when known (from `FILE_HASHES`). */
interface AttachedFile {
    id: string;
    hash?: string;
}
/** What a file swap did. */
interface FilesSwap {
    /** The message's files now, in order. */
    fileIds: string[];
    /** Which of them this run uploaded (the rest were already attached, with the same bytes). */
    uploaded: string[];
    /** Replaced files that were deleted. */
    deleted: string[];
    /** Replaced files whose `files.delete` failed (other than already being gone): delete them later, or by hand. */
    undeleted: Array<{
        id: string;
        error: unknown;
    }>;
}
/** A single-file swap: `FilesSwap` plus that file's id. */
interface FileSwap extends FilesSwap {
    fileId: string;
}
/** A file to attach: its bytes (with a name and upload options). */
type FileSpec = {
    name: string;
    data: UploadData;
} & UploadOptions;
/**
 * Whether Slack has processed an upload (`files.info`'s `file`): it reports a `mimetype`, and an image has thumbnails
 * (`thumb_*`), which it can lack for a moment after the `mimetype` appears (disky waited for both, and saw images render
 * inline from the first view).
 */
declare function isProcessed(file: Record<string, unknown>): boolean;
/** What `upload` sends: bytes, or a string as UTF-8. */
type UploadData = Uint8Array | ArrayBuffer | Blob | string;
declare function toBytes(data: UploadData): Promise<Uint8Array>;
/** Whether a failed write certainly didn't attach anything: Slack refused it, or refused the edit after a post. */
declare function definitelyNotAttached(e: unknown): boolean;
/**
 * Attach `desired` files in place of `previous` ones:
 * 1. Each desired file reuses a previous file with the same content hash (each reused once), so unchanged or reordered
 *    files aren't re-uploaded. The rest are uploaded (`concurrency` at a time, default 1); if an upload fails, this run's
 *    uploads are deleted and the error is rethrown.
 * 2. `write` attaches the resulting ids, in `desired` order (an edit or upsert with `files`).
 * 3. Previous files that aren't attached any more are deleted, only after `write` succeeded.
 *
 * A `write` that fails deletes this run's uploads when Slack definitely refused it, and throws `FileSwapError`
 * (rethrowing the error as-is when nothing was uploaded).
 */
declare function swapFiles<T>(client: Pick<SlackClient, "deleteFile">, previous: readonly AttachedFile[], desired: ReadonlyArray<{
    hash: string;
    upload: () => Promise<string>;
}>, write: (fileIds: string[]) => Promise<T>, options?: {
    concurrency?: number;
}): Promise<FilesSwap & {
    result: T;
}>;
/** The files attached to a message as read back, with content hashes from its `FILE_HASHES` metadata when it lines up. */
declare function attachedFiles(m: Pick<SlackMessage, "files" | "metadata"> | null): AttachedFile[];
/** `m` with `files` attached and their content hashes stamped into its metadata (`FILE_HASHES`). */
declare function withFiles(m: MsgLike, fileIds: string[], hashes: string[]): Msg;
interface UploadOptions {
    /** Share the file into this channel, which posts a file message. Unshared by default. */
    channel?: string;
    /** With `channel`: the shared file message's text. */
    initialComment?: string;
    /** With `channel`: share it as a reply in this thread. */
    threadTs?: string;
    /** Default: the file name. */
    title?: string;
    altText?: string;
    /**
     * Return only once Slack has processed the file (`isProcessed`: a `mimetype`, and thumbnails for an image; needs
     * `files:read`). On by default: an `image` block on an unprocessed file (`slack_file: {id}`) fails with
     * `invalid_blocks`, and one attached with `files` first renders on phones as a generic file icon rather than inline.
     * Processing took ~0.5 s for a 12 KB PNG and ~4.6 s for 3 MB (disky, 2026-11). `true` polls every 0.5 s for up to
     * 30 s; `false` skips the wait. Past the limit it throws `FileNotProcessedError`, deleting the file if it's unshared.
     */
    processed?: boolean | {
        timeoutMs?: number;
        intervalMs?: number;
    };
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
    /**
     * Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. `files` are
     * attached by an edit right after the post; if that edit fails, this throws `FilesNotAttachedError`.
     */
    post(m: MsgLike, threadId?: string): Promise<Message>;
    /**
     * Edit a message's text, blocks, attachments, attached files and metadata. Slack ignores sender fields on an edit.
     * To clear blocks, attachments or files, pass `[]`; omitting them leaves them as they were. Detaching a file doesn't
     * delete it (`deleteFile`). For Slack's raw reply (`message`), call `api("chat.update", …)` directly.
     */
    edit(messageId: string, m: MsgLike): Promise<Message>;
    /**
     * Upload a file (`files.getUploadURLExternal`, the bytes, `files.completeUploadExternal`); returns its id. Unshared
     * unless `channel` is given: attach it to a message with `Msg.files`, or reference it from an `image` block.
     */
    upload(name: string, data: UploadData, options?: UploadOptions): Promise<string>;
    /**
     * POST an upload's bytes to its `upload_url`, retrying (like `slackCall`, up to `retries`, exponential from 1 s, or
     * `Retry-After`) on a 429, a 5xx, a timeout or a dropped connection. That's safe: until `completeUploadExternal`,
     * a re-sent body just replaces the last one.
     */
    private sendUpload;
    /**
     * Keep the files attached to message `ts` current: each of `files` is uploaded unless the message already has a file
     * with the same bytes, then the message is edited to `m` with exactly those files, in order, and the files it no
     * longer has are deleted. The previous files (and their content hashes, from the message's metadata) are read from
     * the message (a history scope), unless `previous` is given. See `swapFiles` for failures; `upsertFiles` is the
     * stored-state version.
     */
    replaceFiles(ts: string, files: readonly FileSpec[], m: MsgLike, options?: {
        previous?: AttachedFile[];
        concurrency?: number;
    }): Promise<FilesSwap>;
    /** `replaceFiles` with one file. */
    replaceFile(ts: string, file: FileSpec, m: MsgLike, options?: {
        previous?: AttachedFile[];
    }): Promise<FileSwap>;
    /** A file's `files.info` record (`mimetype`, `name`, `shares`, `url_private`, …). */
    fileInfo(id: string): Promise<Record<string, unknown>>;
    /** Delete a file (`files.delete`), e.g. the one an edit just replaced. A file that's already gone is fine. */
    deleteFile(id: string): Promise<void>;
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

export { type AttachedFile as A, type BulletFn as B, CHANNEL_TTL_MS as C, type UploadOptions as D, attachedFiles as E, FILE_HASHES as F, buildDetailMessages as G, buildSummaryMessages as H, collect as I, defaultBullet as J, definitelyNotAttached as K, type LinkedSyncResult as L, MAX_CACHED_USERS as M, NON_IDEMPOTENT as N, isProcessed as O, paginate as P, slackApi as Q, type Reaction as R, SLACK_API as S, type Transport as T, USERNAME_MAX as U, slackCall as V, splitBody as W, swapFiles as X, toBytes as Y, webClientTransport as Z, withFiles as _, type Auth as a, type CallOptions as b, FileNotProcessedError as c, type FileSpec as d, type FileSwap as e, FileSwapError as f, FilesNotAttachedError as g, type FilesSwap as h, type LinkedThread as i, NOT_FOUND_TTL_MS as j, type RetryInfo as k, SLACK_MESSAGE_LIMIT as l, type Section as m, SlackApiError as n, SlackClient as o, type SlackClientOptions as p, type SlackDeleteOptions as q, type SlackErrorKind as r, type SlackMessage as s, type SlackPostOptions as t, type SlackResponse as u, type SlackSyncOptions as v, type SlackUser as w, type TransportOptions as x, USER_TTL_MS as y, type UploadData as z };
