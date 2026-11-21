import { hash53Bytes } from "./hash";
import {
  OrphanedRepliesError,
  THRDS_HASH,
  contentKey,
  isRich,
  msgHash,
  sync,
  toMsg,
  type Message,
  type MessageMetadata,
  type Msg,
  type MsgLike,
  type Sender,
  type SyncOptions,
  type SyncResult,
  type Thread,
  type ThreadClient,
  type Unfurl,
} from "./core";
import {
  SlackApiError,
  collect,
  paginate,
  slackCall,
  type CallOptions,
  type RetryInfo,
  type SlackResponse,
  type TransportOptions,
} from "./api";
import {
  buildDetailMessages,
  buildSummaryMessages,
  type BulletFn,
  type LinkedSyncResult,
  type LinkedThread,
} from "./linked";

export const SLACK_MESSAGE_LIMIT = 4000;

/** Slack shows at most 80 characters of a `username` override. */
export const USERNAME_MAX = 80;

/** Slack mrkdwn bullet: linked bold title via `<url|*title*>`. */
const slackBullet: BulletFn = (section, url) =>
  `- <${url}|*${section.title}*> — ${section.summary}`;

/** Placeholder URL with safe upper bound on Slack permalink length (~120). */
const DETAIL_URL_PLACEHOLDER = "x".repeat(130);

/** Found users are cached this long; `users_not_found` for `NOT_FOUND_TTL_MS`; failures not at all. */
export const USER_TTL_MS = 60 * 60 * 1000;
export const NOT_FOUND_TTL_MS = 60 * 1000;
/** The user cache's size cap (oldest entries go first): plenty for a workspace, bounded for a long-lived process. */
export const MAX_CACHED_USERS = 10_000;
/** How long a `channelId` name lookup is trusted (channels get archived and re-created). */
export const CHANNEL_TTL_MS = 60 * 60 * 1000;

export interface SlackClientOptions extends TransportOptions, Sender {
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
export type Transport = (
  token: string,
  method: string,
  body: Record<string, unknown>,
  options: CallOptions,
) => Promise<{ json: SlackResponse; headers: Headers }>;

/**
 * A transport over a Bolt / `@slack/web-api` `WebClient` (its token, retries and rate limiting), so a Bolt app can use
 * `SlackClient`, `syncSlots` and friends without a second HTTP stack. Scopes come from the result's
 * `response_metadata.scopes`; errors become `SlackApiError`s.
 */
export function webClientTransport(client: {
  apiCall(method: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}): Transport {
  return async (_token, method, body) => {
    let json: Record<string, unknown>;
    try {
      json = await client.apiCall(method, body);
    } catch (e) {
      const data = (e as { data?: Record<string, unknown> }).data;
      const code = typeof data?.["error"] === "string" ? (data["error"] as string) : "unknown_error";
      throw new SlackApiError(method, code, 200, data, undefined, data ? "slack" : "transport", { cause: e });
    }
    if (json["ok"] !== true) {
      throw new SlackApiError(method, typeof json["error"] === "string" ? json["error"] : "unknown_error", 200, json);
    }
    const scopes = (json["response_metadata"] as { scopes?: string[] } | undefined)?.scopes ?? [];
    return { json: json as SlackResponse, headers: new Headers({ "x-oauth-scopes": scopes.join(",") }) };
  };
}

/**
 * A post with `files` landed (`ts`), but the edit attaching them failed. The message is stamped without the files, so
 * `sync` / `syncSlots` see it as out of date and attach them on their next run.
 */
export class FilesNotAttachedError extends Error {
  constructor(
    public readonly ts: string,
    options?: { cause?: unknown },
  ) {
    super(`posted ${ts}, but attaching its files failed`, options);
    this.name = "FilesNotAttachedError";
  }
}

/**
 * Slack doesn't attach files to a message with a sender override (`username`, `icon_emoji` or `icon_url`, which make
 * its subtype `bot_message`). `chat.update` with `file_ids` returns ok, and `files.info` records a share at the
 * message's ts, but the update's own `message.files` is `[]`, and history and clients show no files.
 * `chat.postMessage` with `file_ids` is just as silent, and thread replies make no difference (disky and gcs,
 * 2026-11-20). So thrds refuses before writing (or uploading) when it knows of an override, and checks the update's
 * response otherwise: post and edit the message from a client without sender overrides.
 */
export class CustomSenderFilesError extends Error {
  constructor(
    /** The override, e.g. `username "cw"` (when known). */
    public readonly override: string | undefined,
    /** The message, when it already exists. */
    public readonly ts?: string,
  ) {
    super(
      `Slack won't attach files to ${ts === undefined ? "a message" : `message ${ts}`} with a sender override` +
        `${override === undefined ? "" : ` (${override})`}: chat.update returns ok, but the message shows no files. ` +
        "Post it without `username` / `iconEmoji` / `iconUrl`",
    );
    this.name = "CustomSenderFilesError";
  }
}

/** A message's sender overrides, as `chat.postMessage` would send them. */
export interface SenderOverrides {
  username?: string | undefined;
  iconUrl?: string | undefined;
  iconEmoji?: string | undefined;
}

/**
 * Throws `CustomSenderFilesError` when files can't be attached: the message would be sent with a sender override, or
 * (`target`, as read back) is a `bot_message`.
 */
export function assertFilesAttachable(
  sender: SenderOverrides,
  target?: Pick<SlackMessage, "id" | "subtype" | "username"> | null,
): void {
  const override =
    sender.username !== undefined
      ? `username "${sender.username}"`
      : sender.iconEmoji !== undefined
        ? `icon_emoji "${sender.iconEmoji}"`
        : sender.iconUrl !== undefined
          ? "icon_url"
          : undefined;
  if (override !== undefined) throw new CustomSenderFilesError(override);
  if (target?.subtype === "bot_message") {
    throw new CustomSenderFilesError(target.username === undefined ? undefined : `username "${target.username}"`, target.id);
  }
}

/** `msg`'s sender overrides, falling back to `client`'s. */
export function senderOverrides(msg: Msg, client: SenderOverrides): SenderOverrides {
  return {
    username: msg.username ?? client.username,
    iconUrl: msg.iconUrl ?? client.iconUrl,
    iconEmoji: msg.iconEmoji ?? client.iconEmoji,
  };
}

/** Slack hadn't processed an upload in time. An unshared one is deleted (`deleted`), since nothing can use it. */
export class FileNotProcessedError extends Error {
  constructor(
    public readonly fileId: string,
    public readonly waitedMs: number,
    public readonly deleted: boolean,
  ) {
    super(`Slack hadn't processed file ${fileId} after ${waitedMs / 1000} s${deleted ? " (deleted it)" : ""}`);
    this.name = "FileNotProcessedError";
  }
}

/**
 * Attaching newly uploaded files failed (`cause`). If Slack definitely refused the write, this run's uploads were
 * deleted (`deleted`); otherwise the write may have landed, so they're kept and `fileIds` says which they are. Files
 * reused from the message's previous attachments are never deleted.
 */
export class FileSwapError extends Error {
  constructor(
    public readonly fileIds: string[],
    public readonly deleted: boolean,
    options?: { cause?: unknown },
  ) {
    const what = fileIds.length === 1 ? `file ${fileIds[0]}` : `files ${fileIds.join(", ")}`;
    const fate = deleted ? `deleted the upload${fileIds.length === 1 ? "" : "s"}` : `kept the upload${fileIds.length === 1 ? "" : "s"}: the write may have landed`;
    super(`attaching ${what} failed (${fate})`, options);
    this.name = "FileSwapError";
  }

  /** The first (for a single-file swap, the only) upload. */
  get fileId(): string | undefined {
    return this.fileIds[0];
  }
}

/** The `metadata.event_payload` field the swap helpers stamp the attached files' content hashes into (in order). */
export const FILE_HASHES = "thrds_files";

/** A previously attached file: its id, and its content hash when known (from `FILE_HASHES`). */
export interface AttachedFile {
  id: string;
  hash?: string;
}

/** What a file swap did. */
export interface FilesSwap {
  /** The message's files now, in order. */
  fileIds: string[];
  /** Which of them this run uploaded (the rest were already attached, with the same bytes). */
  uploaded: string[];
  /** Replaced files that were deleted. */
  deleted: string[];
  /** Replaced files whose `files.delete` failed (other than already being gone): delete them later, or by hand. */
  undeleted: Array<{ id: string; error: unknown }>;
}

/** A single-file swap: `FilesSwap` plus that file's id. */
export interface FileSwap extends FilesSwap {
  fileId: string;
}

/** A file to attach: its bytes (with a name and upload options). */
export type FileSpec = { name: string; data: UploadData } & UploadOptions;

/**
 * Whether Slack has processed an upload (`files.info`'s `file`): it reports a `mimetype`, and an image has thumbnails
 * (`thumb_*`), which it can lack for a moment after the `mimetype` appears (disky waited for both, and saw images render
 * inline from the first view).
 */
export function isProcessed(file: Record<string, unknown>): boolean {
  const mimetype = file["mimetype"];
  if (typeof mimetype !== "string" || !mimetype) return false;
  return !mimetype.startsWith("image/") || Object.keys(file).some((k) => /^thumb_\d+$/.test(k));
}

/** What `upload` sends: bytes, or a string as UTF-8. */
export type UploadData = Uint8Array | ArrayBuffer | Blob | string;

export async function toBytes(data: UploadData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/**
 * Whether a failed write certainly didn't attach anything: Slack refused it (or refused the edit after a post), or it
 * landed on a message that shows no files (`CustomSenderFilesError`).
 */
export function definitelyNotAttached(e: unknown): boolean {
  if (e instanceof SlackApiError) return e.definite;
  if (e instanceof CustomSenderFilesError) return true;
  if (e instanceof FilesNotAttachedError) return definitelyNotAttached(e.cause);
  return false;
}

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
export async function swapFiles<T>(
  client: Pick<SlackClient, "deleteFile">,
  previous: readonly AttachedFile[],
  desired: ReadonlyArray<{ hash: string; upload: () => Promise<string> }>,
  write: (fileIds: string[]) => Promise<T>,
  options: { concurrency?: number } = {},
): Promise<FilesSwap & { result: T }> {
  const unused = [...previous];
  const fileIds: Array<string | undefined> = desired.map(({ hash }) => {
    const i = unused.findIndex((p) => p.hash !== undefined && p.hash === hash);
    return i < 0 ? undefined : unused.splice(i, 1)[0]!.id;
  });
  const todo = desired.flatMap((d, i) => (fileIds[i] === undefined ? [i] : []));
  const uploaded: string[] = [];
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && failures.length === 0) {
      const i = todo[next++]!;
      try {
        const id = await desired[i]!.upload();
        fileIds[i] = id;
        uploaded.push(id);
      } catch (e) {
        failures.push(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, todo.length)) }, worker));
  const cleanUp = async (): Promise<boolean> => {
    let all = true;
    for (const id of uploaded) {
      try {
        await client.deleteFile(id);
      } catch {
        all = false;
      }
    }
    return all;
  };
  if (failures.length > 0) {
    await cleanUp();
    throw failures[0];
  }
  const ids = fileIds as string[];
  let result: T;
  try {
    result = await write(ids);
  } catch (e) {
    if (uploaded.length === 0) throw e;
    const deleted = definitelyNotAttached(e) && (await cleanUp());
    throw new FileSwapError(uploaded, deleted, { cause: e });
  }
  const swap: FilesSwap & { result: T } = { fileIds: ids, uploaded, deleted: [], undeleted: [], result };
  const kept = new Set(ids);
  for (const { id } of unused) {
    if (kept.has(id)) continue;
    try {
      await client.deleteFile(id);
      swap.deleted.push(id);
    } catch (error) {
      swap.undeleted.push({ id, error });
    }
  }
  return swap;
}

/** The files attached to a message as read back, with content hashes from its `FILE_HASHES` metadata when it lines up. */
export function attachedFiles(m: Pick<SlackMessage, "files" | "metadata"> | null): AttachedFile[] {
  const ids = (m?.files ?? []).map((f) => f["id"]).filter((id): id is string => typeof id === "string");
  const hashes = m?.metadata?.event_payload?.[FILE_HASHES];
  const aligned = Array.isArray(hashes) && hashes.length === ids.length && hashes.every((h) => typeof h === "string");
  return ids.map((id, i) => (aligned ? { id, hash: hashes[i] as string } : { id }));
}

/** `m` with `files` attached and their content hashes stamped into its metadata (`FILE_HASHES`). */
export function withFiles(m: MsgLike, fileIds: string[], hashes: string[]): Msg {
  const msg = toMsg(m);
  return {
    ...msg,
    files: fileIds,
    metadata: {
      event_type: msg.metadata?.event_type ?? "thrds",
      event_payload: { ...msg.metadata?.event_payload, [FILE_HASHES]: hashes },
    },
  };
}

export interface UploadOptions {
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
  processed?: boolean | { timeoutMs?: number; intervalMs?: number };
}

export interface SlackPostOptions {
  threadId?: string;
}

export interface SlackDeleteOptions {
  orphansOk?: boolean;
}

export interface SlackSyncOptions extends SyncOptions {
  threadTs?: string;
  suppressUnfurls?: boolean;
}

export interface Reaction {
  name: string;
  count: number;
  users: string[];
}

/** A message as read back: `Message` plus what Slack says about it. Absent fields are omitted, not `undefined`. */
export interface SlackMessage extends Message {
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

export interface SlackUser {
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
export interface Auth {
  userId: string;
  botId?: string;
  teamId?: string;
  scopes: Set<string>;
}

interface RawMessage {
  ts: string;
  text?: string;
  user?: string | null;
  bot_id?: string;
  username?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: Array<Record<string, unknown>>;
  metadata?: MessageMetadata;
  reactions?: Reaction[];
  bot_profile?: { name?: string };
}

interface Cached<T> {
  value: T;
  expires: number;
}

/** State shared by a client and its `in(channel)` siblings. */
interface Shared {
  auth?: Promise<Auth>;
  channels?: Cached<Promise<Map<string, string>>> & { archived: boolean };
  users: Map<string, Cached<SlackUser | null>>;
  /** Lookups in flight, so concurrent callers share one request. */
  loading: Map<string, Promise<SlackUser | null>>;
  lastWrite?: number;
}

const CHANNEL_ID = /^[CDG][A-Z0-9]{6,}$/;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toUser(raw: Record<string, unknown>): SlackUser {
  const profile = (raw["profile"] ?? {}) as Record<string, unknown>;
  const images: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile)) {
    const m = /^image_(\w+)$/.exec(k);
    if (m && typeof v === "string") images[m[1]!] = v;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const user: SlackUser = {
    id: raw["id"] as string,
    name: (raw["name"] as string | undefined) ?? "",
    images,
    isBot: raw["is_bot"] === true,
    deleted: raw["deleted"] === true,
  };
  const realName = str(profile["real_name"]) ?? str(raw["real_name"]);
  if (realName) user.realName = realName;
  const displayName = str(profile["display_name"]);
  if (displayName) user.displayName = displayName;
  const email = str(profile["email"]);
  if (email) user.email = email;
  if (images["192"]) user.image = images["192"];
  const tz = str(raw["tz"]);
  if (tz) user.tz = tz;
  return user;
}

/** The request fields for an unfurl setting. */
function unfurlFields(u: Unfurl | "omit"): Record<string, boolean> {
  if (u === "omit") return {};
  if (typeof u === "boolean") return { unfurl_links: u, unfurl_media: u };
  const out: Record<string, boolean> = {};
  if (u.links !== undefined) out["unfurl_links"] = u.links;
  if (u.media !== undefined) out["unfurl_media"] = u.media;
  return out;
}

export class SlackClient implements ThreadClient {
  readonly token: string;
  readonly username?: string;
  readonly iconUrl?: string;
  readonly iconEmoji?: string;

  private readonly options: SlackClientOptions;
  private readonly _channel?: string;
  private readonly shared: Shared;
  private unfurl: Unfurl | "omit";
  private skipOp = false;

  constructor(options: SlackClientOptions, shared?: Shared) {
    this.options = options;
    this.token = options.token;
    this._channel = options.channel;
    this.username = options.username;
    this.iconUrl = options.iconUrl;
    this.iconEmoji = options.iconEmoji;
    this.unfurl = options.unfurl ?? !(options.suppressUnfurls ?? true);
    this.shared = shared ?? { users: new Map(), loading: new Map() };
  }

  /** The channel thread operations act in; throws if the client wasn't given one. */
  get channel(): string {
    if (this._channel === undefined) throw new Error("SlackClient: no channel (pass `channel`, or use `in(channel)`)");
    return this._channel;
  }

  /** The same client (token, options, caches) acting in another channel. */
  in(channel: string): SlackClient {
    return new SlackClient({ ...this.options, channel }, this.shared);
  }

  /** The same client and caches with some options changed (e.g. `{ unfurl: true }`, or a different `channel`). */
  with(options: Partial<Omit<SlackClientOptions, "token">>): SlackClient {
    return new SlackClient({ ...this.options, ...options }, this.shared);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Call any Web API method with this client's token and transport options; `options` override them per call. */
  async api(method: string, body: Record<string, unknown> = {}, options: CallOptions = {}): Promise<SlackResponse> {
    return (await this.call(method, body, options)).json;
  }

  private async call(method: string, body: Record<string, unknown>, options: CallOptions): Promise<{ json: SlackResponse; headers: Headers }> {
    const merged = { ...this.options, ...options };
    const gap = merged.minIntervalMs;
    if (gap && !merged.get) {
      const wait = (this.shared.lastWrite ?? -Infinity) + gap - this.now();
      if (wait > 0) await (merged.sleep ?? sleep)(wait);
      this.shared.lastWrite = this.now();
    }
    return (merged.transport ?? slackCall)(this.token, method, body, merged);
  }

  /** Every item of a cursor-paginated method; `key` is the response field holding the items. */
  paginate<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    key: string,
    options: CallOptions = {},
  ): AsyncGenerator<T> {
    return paginate<T>(
      (cursor) => this.api(method, { ...params, ...(cursor ? { cursor } : {}) }, options),
      key,
    );
  }

  /** The token's identity and scopes, from one cached `auth.test`. */
  async auth(): Promise<Auth> {
    this.shared.auth ??= this.call("auth.test", {}, {}).then(({ json, headers }) => {
      const auth: Auth = {
        userId: json["user_id"] as string,
        scopes: new Set(
          (headers.get("x-oauth-scopes") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      };
      if (typeof json["bot_id"] === "string") auth.botId = json["bot_id"];
      if (typeof json["team_id"] === "string") auth.teamId = json["team_id"];
      return auth;
    });
    try {
      return await this.shared.auth;
    } catch (e) {
      delete this.shared.auth;
      throw e;
    }
  }

  /**
   * The authenticated bot's `user_id` and `bot_id`.
   *
   * Slack returns `user: null` on `bot_message` events — the bot's identity
   * lives in `bot_id`. Matching only `user_id` mis-labels our own posts as
   * non-editable, which makes `sync()` re-post the whole thread every run.
   */
  async botIds(): Promise<{ userId: string; botId?: string }> {
    const { userId, botId } = await this.auth();
    return botId === undefined ? { userId } : { userId, botId };
  }

  /** The token's OAuth scopes. */
  async scopes(): Promise<Set<string>> {
    return (await this.auth()).scopes;
  }

  /** Whether per-message `username` / `icon_url` will be honored (`chat:write.customize`). */
  async canCustomizeSender(): Promise<boolean> {
    return (await this.scopes()).has("chat:write.customize");
  }

  private toMessage(raw: RawMessage, ids: { userId: string; botId?: string }): SlackMessage {
    const msg: SlackMessage = {
      id: raw.ts,
      content: raw.text ?? "",
      editable: raw.user === ids.userId || (ids.botId !== undefined && raw.bot_id === ids.botId),
    };
    const stamped = raw.metadata?.event_payload?.[THRDS_HASH];
    if (typeof stamped === "string") msg.key = `thrds:${stamped}`;
    if (raw.user) msg.user = raw.user;
    if (raw.bot_id) msg.botId = raw.bot_id;
    const username = raw.username ?? raw.bot_profile?.name;
    if (username) msg.username = username;
    if (raw.subtype) msg.subtype = raw.subtype;
    if (raw.thread_ts) msg.threadTs = raw.thread_ts;
    if (raw.reply_count !== undefined) msg.replyCount = raw.reply_count;
    if (raw.latest_reply) msg.latestReply = raw.latest_reply;
    if (raw.blocks) msg.blocks = raw.blocks;
    if (raw.attachments) msg.attachments = raw.attachments;
    if (raw.files) msg.files = raw.files;
    if (raw.metadata) msg.metadata = raw.metadata;
    if (raw.reactions) msg.reactions = raw.reactions;
    return msg;
  }

  /** A thread's messages (parent first), every page, with metadata. */
  async list(threadId: string): Promise<SlackMessage[]> {
    const ids = await this.botIds();
    const raw = await collect(
      this.paginate<RawMessage>(
        "conversations.replies",
        { channel: this.channel, ts: threadId, include_all_metadata: true, limit: 200 },
        "messages",
        { get: true },
      ),
    );
    let messages = raw.map((m) => this.toMessage(m, ids));
    if (this.skipOp && messages.length > 0) {
      messages = messages.slice(1);
    }
    return messages;
  }

  /** The channel's top-level messages, newest first, lazily across pages. */
  async *history(
    options: { oldest?: string; latest?: string; inclusive?: boolean; limit?: number } = {},
  ): AsyncGenerator<SlackMessage> {
    const ids = await this.botIds();
    const { limit = 200, ...range } = options;
    for await (const raw of this.paginate<RawMessage>(
      "conversations.history",
      { channel: this.channel, include_all_metadata: true, limit, ...range },
      "messages",
      { get: true },
    )) {
      yield this.toMessage(raw, ids);
    }
  }

  /**
   * Every message in the channel back to `oldest`: each top-level message (newest first), followed by its thread's
   * replies when `includeReplies` (for auditing bots that post into threads).
   */
  async *messages(options: { oldest?: string; latest?: string; includeReplies?: boolean } = {}): AsyncGenerator<SlackMessage> {
    const { includeReplies = false, ...range } = options;
    for await (const m of this.history(range)) {
      yield m;
      if (includeReplies && (m.replyCount ?? 0) > 0) {
        for (const reply of (await this.list(m.id)).slice(1)) yield reply;
      }
    }
  }

  /**
   * The first message tagged with `metadata.event_type === eventType` whose payload satisfies `match`: in a thread
   * (`threadTs`), else the channel's history back to `oldest`. How a bot finds "its" message without a database.
   */
  async findByMetadata(
    eventType: string,
    match: (payload: Record<string, unknown>) => boolean = () => true,
    options: { threadTs?: string; oldest?: string; includeReplies?: boolean } = {},
  ): Promise<SlackMessage | null> {
    return this.find(
      (m) => m.metadata?.event_type === eventType && match(m.metadata.event_payload ?? {}),
      options,
    );
  }

  /**
   * The first message satisfying `hit`: in a thread (`threadTs`), else the channel's history back to `oldest` (with
   * thread replies, when `includeReplies`).
   */
  async find(
    hit: (m: SlackMessage) => boolean,
    options: { threadTs?: string; oldest?: string; includeReplies?: boolean } = {},
  ): Promise<SlackMessage | null> {
    if (options.threadTs !== undefined) {
      return (await this.list(options.threadTs)).find(hit) ?? null;
    }
    const range: { oldest?: string; includeReplies?: boolean } = {};
    if (options.oldest !== undefined) range.oldest = options.oldest;
    if (options.includeReplies !== undefined) range.includeReplies = options.includeReplies;
    for await (const m of this.messages(range)) {
      if (hit(m)) return m;
    }
    return null;
  }

  /** The request body a message sends: text, blocks, attachments, metadata (hash-stamped when rich), flags. */
  private body(m: MsgLike): Record<string, unknown> {
    const msg = toMsg(m);
    const data: Record<string, unknown> = {
      channel: this.channel,
      text: msg.text,
      ...unfurlFields(msg.unfurl ?? this.unfurl),
    };
    if (this.options.parse !== undefined) data["parse"] = this.options.parse;
    if (this.options.linkNames !== undefined) data["link_names"] = this.options.linkNames;
    if (msg.blocks !== undefined) data["blocks"] = msg.blocks;
    if (msg.attachments !== undefined) data["attachments"] = msg.attachments;
    if (isRich(msg) && (msg.stamp ?? this.options.stamp ?? true)) {
      data["metadata"] = {
        event_type: msg.metadata?.event_type ?? "thrds",
        event_payload: { ...msg.metadata?.event_payload, [THRDS_HASH]: msgHash(msg) },
      };
    } else if (msg.metadata !== undefined) {
      data["metadata"] = msg.metadata;
    }
    return data;
  }

  private sent(id: string, m: MsgLike): Message {
    const msg = toMsg(m);
    const key = (msg.stamp ?? this.options.stamp ?? true) ? contentKey(msg) : msg.text;
    return key === msg.text ? { id, content: msg.text } : { id, content: msg.text, key };
  }

  /**
   * Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. `files` are
   * attached by an edit right after the post; if that edit fails, this throws `FilesNotAttachedError`. Files with a
   * sender override (`username`, `iconEmoji`, `iconUrl`) throw `CustomSenderFilesError` before posting (Slack
   * wouldn't show them).
   */
  async post(m: MsgLike, threadId?: string): Promise<Message> {
    const msg = toMsg(m);
    const { files, ...bare } = msg;
    const attach = files !== undefined && files.length > 0;
    if (attach) assertFilesAttachable(senderOverrides(msg, this));
    const data = this.body(attach ? bare : msg);
    const username = msg.username ?? this.username;
    const iconUrl = msg.iconUrl ?? this.iconUrl;
    const iconEmoji = msg.iconEmoji ?? this.iconEmoji;
    if (username !== undefined) data["username"] = [...username].slice(0, USERNAME_MAX).join("");
    if (iconUrl !== undefined) data["icon_url"] = iconUrl;
    else if (iconEmoji !== undefined) data["icon_emoji"] = iconEmoji;
    if (threadId !== undefined) {
      data["thread_ts"] = threadId;
      if (msg.replyBroadcast) data["reply_broadcast"] = true;
    }
    const result = await this.api("chat.postMessage", data);
    const ts = result["ts"];
    // Recording a missing ts would make the next run post again.
    if (typeof ts !== "string" || !ts) throw new SlackApiError("chat.postMessage", "invalid_response", 200, result, undefined, "http");
    if (attach) {
      try {
        return await this.edit(ts, msg);
      } catch (e) {
        throw new FilesNotAttachedError(ts, { cause: e });
      }
    }
    return this.sent(ts, msg);
  }

  /**
   * Edit a message's text, blocks, attachments, attached files and metadata. Slack ignores sender fields on an edit.
   * To clear blocks, attachments or files, pass `[]`; omitting them leaves them as they were. Detaching a file doesn't
   * delete it (`deleteFile`). For Slack's raw reply (`message`), call `api("chat.update", …)` directly.
   *
   * Attaching files from a client (or `msg`) with a sender override throws `CustomSenderFilesError` before writing:
   * that client's posts carry the override, and Slack shows no files on those. Edit with a client without one
   * (`with`). Otherwise the update's response is checked: if its `message` is a `bot_message`, or lists files without
   * all of the new ones, the edit landed but the files didn't, and this throws `CustomSenderFilesError` (with `ts`).
   */
  async edit(messageId: string, m: MsgLike): Promise<Message> {
    const msg = toMsg(m);
    const attach = msg.files !== undefined && msg.files.length > 0;
    if (attach) assertFilesAttachable(senderOverrides(msg, this));
    const data: Record<string, unknown> = { ...this.body(msg), ts: messageId };
    if (msg.files !== undefined) data["file_ids"] = msg.files;
    const result = await this.api("chat.update", data);
    if (attach) {
      const echoed = result["message"] as { subtype?: string; username?: string; files?: Array<{ id?: unknown }> } | undefined;
      const shown = echoed?.files === undefined ? undefined : new Set(echoed.files.map((f) => f.id));
      if (echoed?.subtype === "bot_message" || (shown !== undefined && !msg.files!.every((id) => shown.has(id)))) {
        throw new CustomSenderFilesError(echoed?.username === undefined ? undefined : `username "${echoed.username}"`, messageId);
      }
    }
    return this.sent(messageId, msg);
  }

  /**
   * Upload a file (`files.getUploadURLExternal`, the bytes, `files.completeUploadExternal`); returns its id. Unshared
   * unless `channel` is given: attach it to a message with `Msg.files`, or reference it from an `image` block.
   */
  async upload(name: string, data: UploadData, options: UploadOptions = {}): Promise<string> {
    const bytes = await toBytes(data);
    const request: Record<string, unknown> = { filename: name, length: bytes.byteLength };
    if (options.altText !== undefined) request["alt_txt"] = options.altText;
    const target = await this.api("files.getUploadURLExternal", request, { form: true });
    const id = target["file_id"] as string;
    await this.sendUpload(target["upload_url"] as string, bytes);
    const done: Record<string, unknown> = { files: [{ id, title: options.title ?? name }] };
    if (options.channel !== undefined) {
      done["channel_id"] = options.channel;
      if (options.initialComment !== undefined) done["initial_comment"] = options.initialComment;
      if (options.threadTs !== undefined) done["thread_ts"] = options.threadTs;
    }
    await this.api("files.completeUploadExternal", done);
    const processed = options.processed ?? true;
    if (processed) {
      const { timeoutMs: limit = 30_000, intervalMs = 500 } = processed === true ? {} : processed;
      const start = this.now();
      // Bounded by polls as well as time, so a clock that doesn't advance (a test's no-op `sleep`) can't spin forever.
      const maxPolls = Math.floor(limit / intervalMs) + 1;
      for (let poll = 1; ; poll++) {
        if (isProcessed(await this.fileInfo(id))) break;
        if (poll >= maxPolls || this.now() - start + intervalMs > limit) {
          let deleted = false;
          if (options.channel === undefined) {
            try {
              await this.deleteFile(id);
              deleted = true;
            } catch {
              // Reported via `deleted: false`.
            }
          }
          throw new FileNotProcessedError(id, this.now() - start, deleted);
        }
        await (this.options.sleep ?? sleep)(intervalMs);
      }
    }
    return id;
  }

  /**
   * POST an upload's bytes to its `upload_url`, retrying (like `slackCall`, up to `retries`, exponential from 1 s, or
   * `Retry-After`) on a 429, a 5xx, a timeout or a dropped connection. That's safe: until `completeUploadExternal`,
   * a re-sent body just replaces the last one.
   */
  private async sendUpload(url: string, bytes: Uint8Array): Promise<void> {
    const { fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000, retries = 3, maxRetryWaitMs, onRetry } = this.options;
    const wait = this.options.sleep ?? sleep;
    for (let attempt = 0; ; attempt++) {
      let failure: SlackApiError;
      let waitMs = 1000 * 2 ** attempt;
      let reason: RetryInfo["reason"];
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          body: bytes as Uint8Array<ArrayBuffer>,
          ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
        await response.text();
        if (response.ok) return;
        failure = new SlackApiError("upload_url", `http_${response.status}`, response.status);
        if (response.status === 429) {
          const after = Number(response.headers.get("Retry-After"));
          if (Number.isFinite(after) && after >= 0) waitMs = after * 1000;
          reason = "http_429";
        } else if (response.status >= 500) reason = "server_error";
        else throw failure;
      } catch (e) {
        if (e instanceof SlackApiError) throw e;
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        failure = timedOut
          ? new SlackApiError("upload_url", "timeout", 0)
          : new SlackApiError("upload_url", "transport_error", 0, undefined, undefined, "transport", { cause: e });
        reason = timedOut ? "timeout" : "transport";
      }
      if (attempt >= retries || (maxRetryWaitMs !== undefined && waitMs > maxRetryWaitMs)) throw failure;
      onRetry?.({ method: "upload_url", attempt: attempt + 1, waitMs, reason });
      await wait(waitMs);
    }
  }

  /**
   * Keep the files attached to message `ts` current: each of `files` is uploaded unless the message already has a file
   * with the same bytes, then the message is edited to `m` with exactly those files, in order, and the files it no
   * longer has are deleted. The previous files (and their content hashes, from the message's metadata) are read from
   * the message (a history scope), unless `previous` is given. See `swapFiles` for failures; `upsertFiles` is the
   * stored-state version.
   *
   * A message with a sender override (`bot_message`, when it was read) or a client with one throws
   * `CustomSenderFilesError` before uploading anything. One only the update's response reveals throws it after,
   * having deleted this run's uploads.
   */
  async replaceFiles(
    ts: string,
    files: readonly FileSpec[],
    m: MsgLike,
    options: { previous?: AttachedFile[]; concurrency?: number } = {},
  ): Promise<FilesSwap> {
    const target = options.previous === undefined ? await this.message(ts) : undefined;
    if (files.length > 0) assertFilesAttachable(senderOverrides(toMsg(m), this), target);
    const previous = options.previous ?? attachedFiles(target ?? null);
    const desired = await Promise.all(
      files.map(async ({ name, data, ...uploadOptions }) => {
        const bytes = await toBytes(data);
        return { hash: hash53Bytes(bytes), upload: () => this.upload(name, bytes, uploadOptions) };
      }),
    );
    const hashes = desired.map((d) => d.hash);
    const { result: _result, ...swap } = await swapFiles(
      this,
      previous,
      desired,
      (ids) => this.edit(ts, withFiles(m, ids, hashes)),
      options.concurrency !== undefined ? { concurrency: options.concurrency } : {},
    );
    return swap;
  }

  /** `replaceFiles` with one file. */
  async replaceFile(ts: string, file: FileSpec, m: MsgLike, options: { previous?: AttachedFile[] } = {}): Promise<FileSwap> {
    const swap = await this.replaceFiles(ts, [file], m, options);
    return { ...swap, fileId: swap.fileIds[0]! };
  }

  /** A file's `files.info` record (`mimetype`, `name`, `shares`, `url_private`, …). */
  async fileInfo(id: string): Promise<Record<string, unknown>> {
    return (await this.api("files.info", { file: id }, { get: true }))["file"] as Record<string, unknown>;
  }

  /** Delete a file (`files.delete`), e.g. the one an edit just replaced. A file that's already gone is fine. */
  async deleteFile(id: string): Promise<void> {
    try {
      await this.api("files.delete", { file: id }, { form: true });
    } catch (e) {
      if (!(e instanceof SlackApiError && (e.code === "file_not_found" || e.code === "file_deleted"))) throw e;
    }
  }

  /**
   * One message by ts, read cheaply (`conversations.replies`, `limit: 1`): a thread parent or top-level message, with
   * its reactions and reply count. Null if it's gone.
   */
  async message(ts: string): Promise<SlackMessage | null> {
    let result: SlackResponse;
    try {
      result = await this.api("conversations.replies", { channel: this.channel, ts, limit: 1, include_all_metadata: true }, { get: true });
    } catch (e) {
      if (e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found")) return null;
      throw e;
    }
    const raw = ((result["messages"] ?? []) as RawMessage[])[0];
    if (!raw || raw.ts !== ts) return null;
    return this.toMessage(raw, await this.botIds());
  }

  /** How many replies a thread has (0 for a message without one). Needs a history scope on this token. */
  async replyCount(ts: string): Promise<number> {
    const result = await this.api("conversations.replies", { channel: this.channel, ts }, { get: true });
    const messages = (result["messages"] ?? []) as RawMessage[];
    return messages[0]?.reply_count ?? Math.max(0, messages.length - 1);
  }

  /**
   * Delete a message. Unless `orphansOk`, first refuses (`OrphanedRepliesError`) if it has thread replies, which
   * needs a history scope on this token: with a token that only has `chat:write`, check `replyCount` with another
   * client first and pass `orphansOk`.
   */
  async delete(
    messageId: string,
    options: SlackDeleteOptions = {},
  ): Promise<void> {
    if (!options.orphansOk) {
      let replies: number;
      try {
        replies = await this.replyCount(messageId);
      } catch (e) {
        if (e instanceof SlackApiError && e.code === "missing_scope") {
          throw new Error(
            "delete: the orphaned-replies check (conversations.replies) needs a history scope on this token; " +
              "check replyCount() with a client that has one, then pass { orphansOk: true }",
            { cause: e },
          );
        }
        throw e;
      }
      if (replies > 0) {
        throw new OrphanedRepliesError(messageId, replies);
      }
    }
    await this.api("chat.delete", {
      channel: this.channel,
      ts: messageId,
    });
  }

  /** A message only `user` sees; returns its `message_ts`. Ephemerals can't be read back, so nothing is stamped. */
  async postEphemeral(user: string, m: MsgLike, options: { threadTs?: string } = {}): Promise<string> {
    const { metadata: _metadata, ...msg } = toMsg(m);
    const data: Record<string, unknown> = { ...this.body({ ...msg, stamp: false }), user };
    if (options.threadTs !== undefined) data["thread_ts"] = options.threadTs;
    const result = await this.api("chat.postEphemeral", data);
    return result["message_ts"] as string;
  }

  async permalink(messageTs: string): Promise<string> {
    const result = await this.api(
      "chat.getPermalink",
      { channel: this.channel, message_ts: messageTs },
      { get: true },
    );
    return result["permalink"] as string;
  }

  /** Add a reaction (no-op if we already reacted). */
  async react(ts: string, name: string): Promise<void> {
    try {
      await this.api("reactions.add", { channel: this.channel, timestamp: ts, name: name.replace(/^:|:$/g, "") });
    } catch (e) {
      if (!(e instanceof SlackApiError && e.code === "already_reacted")) throw e;
    }
  }

  /** Remove our reaction (no-op if it isn't there). */
  async unreact(ts: string, name: string): Promise<void> {
    try {
      await this.api("reactions.remove", { channel: this.channel, timestamp: ts, name: name.replace(/^:|:$/g, "") });
    } catch (e) {
      if (!(e instanceof SlackApiError && e.code === "no_reaction")) throw e;
    }
  }

  async reactions(ts: string): Promise<Reaction[]> {
    const result = await this.api("reactions.get", { channel: this.channel, timestamp: ts, full: true }, { get: true });
    return ((result["message"] as { reactions?: Reaction[] } | undefined)?.reactions) ?? [];
  }

  private async cachedUser(key: string, load: () => Promise<SlackUser>, fresh = false): Promise<SlackUser | null> {
    const { users, loading } = this.shared;
    const hit = users.get(key);
    if (!fresh && hit && hit.expires > this.now()) return hit.value;
    const inflight = loading.get(key);
    if (inflight) return inflight;
    const remember = (value: SlackUser | null, ttl: number): void => {
      users.delete(key);
      users.set(key, { value, expires: this.now() + ttl });
      const cap = this.options.userCacheSize ?? MAX_CACHED_USERS;
      while (users.size > cap) users.delete(users.keys().next().value!);
    };
    const p = (async () => {
      try {
        const user = await load();
        remember(user, USER_TTL_MS);
        return user;
      } catch (e) {
        if (e instanceof SlackApiError && (e.code === "users_not_found" || e.code === "user_not_found")) {
          remember(null, NOT_FOUND_TTL_MS);
          return null;
        }
        throw e;
      } finally {
        loading.delete(key);
      }
    })();
    loading.set(key, p);
    return p;
  }

  /** A user by id (`users.info`), cached; null if there's no such user. `fresh` skips the cache (authz checks). */
  async userInfo(id: string, options: { fresh?: boolean } = {}): Promise<SlackUser | null> {
    return this.cachedUser(
      `id:${id}`,
      async () => toUser((await this.api("users.info", { user: id }, { get: true }))["user"] as Record<string, unknown>),
      options.fresh,
    );
  }

  /** A user by email (`users.lookupByEmail`, needs `users:read.email`), cached; null if none. */
  async userByEmail(email: string, options: { fresh?: boolean } = {}): Promise<SlackUser | null> {
    const normalized = email.trim().toLowerCase();
    return this.cachedUser(
      `email:${normalized}`,
      async () => toUser((await this.api("users.lookupByEmail", { email: normalized }, { get: true }))["user"] as Record<string, unknown>),
      options.fresh,
    );
  }

  /** A user group's member ids, by id (`S…`) or handle (`@eng-leads` / `eng-leads`). */
  async usergroupMembers(idOrHandle: string): Promise<string[]> {
    let id = idOrHandle.replace(/^@/, "");
    if (!/^S[A-Z0-9]+$/.test(id)) {
      const groups = ((await this.api("usergroups.list", {}, { get: true }))["usergroups"] ?? []) as Array<{ id: string; handle: string }>;
      const group = groups.find((g) => g.handle === id);
      if (!group) throw new SlackApiError("usergroups.list", "no_such_subteam", 200);
      id = group.id;
    }
    return ((await this.api("usergroups.users.list", { usergroup: id }, { get: true }))["users"] ?? []) as string[];
  }

  /** Every workspace member (`users.list`), lazily. */
  users(): AsyncGenerator<SlackUser> {
    const client = this;
    return (async function* () {
      for await (const raw of client.paginate<Record<string, unknown>>("users.list", { limit: 200 }, "members", { get: true })) {
        yield toUser(raw);
      }
    })();
  }

  /**
   * A sender that looks like a user (by id or email): their display/real name and Slack photo. Pair with `/avatar`'s `badgedSvg` to
   * mark the post as automated. Null for an unknown user (or a deactivated one, unless `includeDeleted`).
   */
  async senderFor(
    userIdOrEmail: string,
    options: { suffix?: string; iconUrl?: string; imageSize?: string; includeDeleted?: boolean } = {},
  ): Promise<Sender | null> {
    const user = userIdOrEmail.includes("@") ? await this.userByEmail(userIdOrEmail) : await this.userInfo(userIdOrEmail);
    if (!user || (user.deleted && !options.includeDeleted)) return null;
    const name = user.displayName ?? user.realName ?? user.name;
    const sender: Sender = { username: [...`${name}${options.suffix ?? ""}`].slice(0, USERNAME_MAX).join("") };
    const icon = options.iconUrl ?? (options.imageSize ? user.images[options.imageSize] : undefined) ?? user.image;
    if (icon) sender.iconUrl = icon;
    return sender;
  }

  /**
   * A channel's id from `#name`, `name` or an id (returned as-is), via `conversations.list`, cached for
   * `CHANNEL_TTL_MS`. `refresh` re-lists now; `includeArchived` also matches archived channels.
   */
  async channelId(nameOrId: string, options: { refresh?: boolean; includeArchived?: boolean } = {}): Promise<string> {
    const name = nameOrId.replace(/^#/, "");
    if (CHANNEL_ID.test(name)) return name;
    const archived = options.includeArchived ?? false;
    const cached = this.shared.channels;
    if (options.refresh || !cached || cached.expires <= this.now() || cached.archived !== archived) {
      const value = (async () => {
        const map = new Map<string, string>();
        for await (const c of this.paginate<{ id: string; name: string }>(
          "conversations.list",
          { types: "public_channel,private_channel", exclude_archived: !archived, limit: 1000 },
          "channels",
          { get: true },
        )) {
          map.set(c.name, c.id);
        }
        return map;
      })();
      this.shared.channels = { value, expires: this.now() + CHANNEL_TTL_MS, archived };
    }
    let channels: Map<string, string>;
    try {
      channels = await this.shared.channels!.value;
    } catch (e) {
      delete this.shared.channels;
      throw e;
    }
    const id = channels.get(name);
    if (id === undefined) throw new SlackApiError("conversations.list", "channel_not_found", 200);
    return id;
  }

  /** Forget cached channel names (after archiving / re-creating one). */
  invalidateChannels(): void {
    delete this.shared.channels;
  }

  /** The DM (one user) or group DM (several) channel id, opening it if needed. */
  async openDm(users: string | string[]): Promise<string> {
    const result = await this.api("conversations.open", { users: ([] as string[]).concat(users).join(",") });
    return (result["channel"] as { id: string }).id;
  }

  /** Open a modal (`views.open`); returns the view, whose `id`/`hash` `updateView` takes. */
  async openView(triggerId: string, view: Record<string, unknown>, options: CallOptions = {}): Promise<Record<string, unknown>> {
    return (await this.api("views.open", { trigger_id: triggerId, view }, options))["view"] as Record<string, unknown>;
  }

  async pushView(triggerId: string, view: Record<string, unknown>, options: CallOptions = {}): Promise<Record<string, unknown>> {
    return (await this.api("views.push", { trigger_id: triggerId, view }, options))["view"] as Record<string, unknown>;
  }

  /** Update a modal by `viewId` or `externalId`; pass the last-seen `hash` to refuse a stale overwrite. */
  async updateView(
    view: Record<string, unknown>,
    target: { viewId?: string; externalId?: string; hash?: string },
    options: CallOptions = {},
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = { view };
    if (target.viewId !== undefined) data["view_id"] = target.viewId;
    if (target.externalId !== undefined) data["external_id"] = target.externalId;
    if (target.hash !== undefined) data["hash"] = target.hash;
    return (await this.api("views.update", data, options))["view"] as Record<string, unknown>;
  }

  /** Publish a user's App Home tab. */
  async publishHome(userId: string, view: Record<string, unknown>): Promise<void> {
    await this.api("views.publish", { user_id: userId, view });
  }

  async sync(
    thread: Thread,
    options: SlackSyncOptions = {},
  ): Promise<SyncResult> {
    const { threadTs, suppressUnfurls, ...rest } = options;
    const prior = this.unfurl;
    if (suppressUnfurls !== undefined) this.unfurl = !suppressUnfurls;
    try {
      return await sync(this, thread, threadTs, rest);
    } finally {
      this.unfurl = prior;
    }
  }

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
  async syncLinked(
    linked: LinkedThread,
    options: {
      threadTs?: string;
      dryRun?: boolean;
      pace?: number;
      jitter?: number;
      suppressUnfurls?: boolean;
    } = {},
  ): Promise<LinkedSyncResult> {
    const {
      threadTs: providedThreadTs,
      dryRun = false,
      pace = 0.4,
      jitter = 0,
      suppressUnfurls = true,
    } = options;

    // Summary bullets sit in the reply slots; the prefix goes to the OP.
    const linkedReplies: LinkedThread = {
      summaryPrefix: "",
      sections: linked.sections,
      summarySuffix: linked.summarySuffix,
    };

    const [detailMsgs, sectionStarts] = buildDetailMessages(
      linked.sections,
      SLACK_MESSAGE_LIMIT,
    );
    const placeholderUrls = linked.sections.map(() => DETAIL_URL_PLACEHOLDER);
    const summaryMsgs = buildSummaryMessages(
      linkedReplies,
      placeholderUrls,
      SLACK_MESSAGE_LIMIT,
      slackBullet,
    );
    const nSummary = summaryMsgs.length;
    const allReplyMsgs = [...summaryMsgs, ...detailMsgs];

    let threadTs = providedThreadTs;
    if (threadTs === undefined) {
      if (!dryRun) {
        const opContent = linked.summaryPrefix || " ";
        const op = await this.post(opContent);
        threadTs = op.id;
      } else {
        threadTs = "<new>";
      }
    } else if (linked.summaryPrefix && !dryRun) {
      await this.edit(threadTs, linked.summaryPrefix);
    }

    this.skipOp = true;
    let result: SyncResult;
    try {
      result = await this.sync(
        { messages: allReplyMsgs },
        { threadTs, dryRun, pace, jitter, suppressUnfurls },
      );
    } finally {
      this.skipOp = false;
    }

    if (dryRun) {
      return {
        threadId: threadTs,
        summaryIds: result.messageIds.slice(0, nSummary),
        detailIds: result.messageIds.slice(nSummary),
        sectionDetailIds: {},
      };
    }

    const detailIds = result.messageIds.slice(nSummary);
    const summaryIds = result.messageIds.slice(0, nSummary);

    // Phase 3: resolve real permalinks for the section-start details
    const sectionDetailIds: Record<string, string> = {};
    const realLinks: string[] = [];
    for (let i = 0; i < linked.sections.length; i++) {
      if (i > 0 && pace > 0) {
        await sleep((pace + Math.random() * jitter) * 1000);
      }
      const detailIdx = sectionStarts[i]!;
      const detailMsgId = detailIds[detailIdx]!;
      sectionDetailIds[linked.sections[i]!.title] = detailMsgId;
      realLinks.push(await this.permalink(detailMsgId));
    }

    // Phase 4: rebuild summaries with real URLs and edit
    const finalSummaries = buildSummaryMessages(
      linkedReplies,
      realLinks,
      SLACK_MESSAGE_LIMIT,
      slackBullet,
    );
    for (let i = 0; i < summaryIds.length; i++) {
      if (i > 0 && pace > 0) {
        await sleep((pace + Math.random() * jitter) * 1000);
      }
      await this.edit(summaryIds[i]!, finalSummaries[i]!);
    }

    return {
      threadId: result.threadId,
      summaryIds,
      detailIds,
      sectionDetailIds,
    };
  }
}
