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
  type MsgLike,
  type Sender,
  type SyncOptions,
  type SyncResult,
  type Thread,
  type ThreadClient,
} from "./core";
import {
  SlackApiError,
  collect,
  paginate,
  slackCall,
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

/** Slack mrkdwn bullet: linked bold title via `<url|*title*>`. */
const slackBullet: BulletFn = (section, url) =>
  `- <${url}|*${section.title}*> — ${section.summary}`;

/** Placeholder URL with safe upper bound on Slack permalink length (~120). */
const DETAIL_URL_PLACEHOLDER = "x".repeat(130);

/** Found users are cached this long; `users_not_found` for `NOT_FOUND_TTL_MS`; failures not at all. */
export const USER_TTL_MS = 60 * 60 * 1000;
export const NOT_FOUND_TTL_MS = 60 * 1000;

export interface SlackClientOptions extends TransportOptions, Sender {
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
  blocks?: unknown[];
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

interface RawMessage {
  ts: string;
  text?: string;
  user?: string | null;
  bot_id?: string;
  username?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  blocks?: unknown[];
  metadata?: MessageMetadata;
  reactions?: Reaction[];
  bot_profile?: { name?: string };
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

export class SlackClient implements ThreadClient {
  readonly token: string;
  readonly username?: string;
  readonly iconUrl?: string;
  readonly iconEmoji?: string;

  private readonly options: SlackClientOptions;
  private readonly _channel?: string;
  private readonly shared: Shared;
  private suppressUnfurls: boolean;
  private skipOp = false;

  constructor(options: SlackClientOptions, shared?: Shared) {
    this.options = options;
    this.token = options.token;
    this._channel = options.channel;
    this.username = options.username;
    this.iconUrl = options.iconUrl;
    this.iconEmoji = options.iconEmoji;
    this.suppressUnfurls = options.suppressUnfurls ?? true;
    this.shared = shared ?? { users: new Map() };
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

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Call any Web API method with this client's token, retries and timeout. */
  async api(
    method: string,
    body: Record<string, unknown> = {},
    options: { get?: boolean } = {},
  ): Promise<SlackResponse> {
    return (await slackCall(this.token, method, body, { ...this.options, ...options })).json;
  }

  /** Every item of a cursor-paginated method; `key` is the response field holding the items. */
  paginate<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    key: string,
    options: { get?: boolean } = {},
  ): AsyncGenerator<T> {
    return paginate<T>(
      (cursor) => this.api(method, { ...params, ...(cursor ? { cursor } : {}) }, options),
      key,
    );
  }

  /**
   * Lazily resolve the authenticated bot's `user_id` and `bot_id`.
   *
   * Slack returns `user: null` on `bot_message` events — the bot's identity
   * lives in `bot_id`. Matching only `user_id` mis-labels our own posts as
   * non-editable, which makes `sync()` re-post the whole thread every run.
   */
  async botIds(): Promise<BotIds> {
    this.shared.botIds ??= this.api("auth.test").then((r) => ({
      userId: r["user_id"] as string,
      botId: (r["bot_id"] as string | undefined) ?? undefined,
    }));
    try {
      return await this.shared.botIds;
    } catch (e) {
      delete this.shared.botIds;
      throw e;
    }
  }

  /** The token's OAuth scopes (`auth.test`'s `x-oauth-scopes` header), cached. */
  async scopes(): Promise<Set<string>> {
    this.shared.scopes ??= slackCall(this.token, "auth.test", {}, this.options).then(
      ({ headers }) =>
        new Set(
          (headers.get("x-oauth-scopes") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
    );
    try {
      return await this.shared.scopes;
    } catch (e) {
      delete this.shared.scopes;
      throw e;
    }
  }

  /** Whether per-message `username` / `icon_url` will be honored (`chat:write.customize`). */
  async canCustomizeSender(): Promise<boolean> {
    return (await this.scopes()).has("chat:write.customize");
  }

  private toMessage(raw: RawMessage, ids: BotIds): SlackMessage {
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
    if (raw.blocks) msg.blocks = raw.blocks;
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
   * The first message tagged with `metadata.event_type === eventType` whose payload satisfies `match`: in a thread
   * (`threadTs`), else the channel's history back to `oldest`. How a bot finds "its" message without a database.
   */
  async findByMetadata(
    eventType: string,
    match: (payload: Record<string, unknown>) => boolean = () => true,
    options: { threadTs?: string; oldest?: string } = {},
  ): Promise<SlackMessage | null> {
    const hit = (m: SlackMessage): boolean =>
      m.metadata?.event_type === eventType && match(m.metadata.event_payload ?? {});
    if (options.threadTs !== undefined) {
      return (await this.list(options.threadTs)).find(hit) ?? null;
    }
    for await (const m of this.history(options.oldest !== undefined ? { oldest: options.oldest } : {})) {
      if (hit(m)) return m;
    }
    return null;
  }

  /** The request body a message sends: text, blocks, metadata (hash-stamped when rich), formatting flags. */
  private body(m: MsgLike): Record<string, unknown> {
    const msg = toMsg(m);
    const data: Record<string, unknown> = {
      channel: this.channel,
      text: msg.text,
      unfurl_links: !this.suppressUnfurls,
      unfurl_media: !this.suppressUnfurls,
    };
    if (this.options.parse !== undefined) data["parse"] = this.options.parse;
    if (this.options.linkNames !== undefined) data["link_names"] = this.options.linkNames;
    if (msg.blocks !== undefined) data["blocks"] = msg.blocks;
    if (isRich(msg)) {
      data["metadata"] = {
        event_type: msg.metadata?.event_type ?? "thrds",
        event_payload: { ...msg.metadata?.event_payload, [THRDS_HASH]: msgHash(msg) },
      };
    }
    return data;
  }

  private sent(id: string, m: MsgLike): Message {
    const key = contentKey(m);
    const content = toMsg(m).text;
    return key === content ? { id, content } : { id, content, key };
  }

  /** Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. */
  async post(m: MsgLike, threadId?: string): Promise<Message> {
    const msg = toMsg(m);
    const data = this.body(msg);
    const username = msg.username ?? this.username;
    const iconUrl = msg.iconUrl ?? this.iconUrl;
    const iconEmoji = msg.iconEmoji ?? this.iconEmoji;
    if (username !== undefined) data["username"] = username;
    if (iconUrl !== undefined) data["icon_url"] = iconUrl;
    else if (iconEmoji !== undefined) data["icon_emoji"] = iconEmoji;
    if (threadId !== undefined) {
      data["thread_ts"] = threadId;
      if (msg.replyBroadcast) data["reply_broadcast"] = true;
    }
    const result = await this.api("chat.postMessage", data);
    return this.sent(result["ts"] as string, msg);
  }

  /**
   * Edit a message's text, blocks and metadata. Slack ignores sender fields on an edit. To clear a message's blocks,
   * pass `blocks: []`; omitting `blocks` leaves them as they were.
   */
  async edit(messageId: string, m: MsgLike): Promise<Message> {
    await this.api("chat.update", { ...this.body(m), ts: messageId });
    return this.sent(messageId, m);
  }

  async delete(
    messageId: string,
    options: SlackDeleteOptions = {},
  ): Promise<void> {
    if (!options.orphansOk) {
      const result = await this.api(
        "conversations.replies",
        { channel: this.channel, ts: messageId },
        { get: true },
      );
      const replies = (result["messages"] ?? []) as unknown[];
      if (replies.length > 1) {
        throw new OrphanedRepliesError(messageId, replies.length - 1);
      }
    }
    await this.api("chat.delete", {
      channel: this.channel,
      ts: messageId,
    });
  }

  /** A message only `user` sees; returns its `message_ts`. */
  async postEphemeral(user: string, m: MsgLike, options: { threadTs?: string } = {}): Promise<string> {
    const data: Record<string, unknown> = { ...this.body(m), user };
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

  private async cachedUser(key: string, load: () => Promise<SlackUser>): Promise<SlackUser | null> {
    const now = this.now();
    const hit = this.shared.users.get(key);
    if (hit && hit.expires > now) return hit.value;
    try {
      const user = await load();
      this.shared.users.set(key, { value: user, expires: now + USER_TTL_MS });
      return user;
    } catch (e) {
      if (e instanceof SlackApiError && (e.code === "users_not_found" || e.code === "user_not_found")) {
        this.shared.users.set(key, { value: null, expires: now + NOT_FOUND_TTL_MS });
        return null;
      }
      throw e;
    }
  }

  /** A user by id (`users.info`), cached; null if there's no such user. */
  async userInfo(id: string): Promise<SlackUser | null> {
    return this.cachedUser(`id:${id}`, async () =>
      toUser((await this.api("users.info", { user: id }, { get: true }))["user"] as Record<string, unknown>),
    );
  }

  /** A user by email (`users.lookupByEmail`, needs `users:read.email`), cached; null if none. */
  async userByEmail(email: string): Promise<SlackUser | null> {
    const normalized = email.trim().toLowerCase();
    return this.cachedUser(`email:${normalized}`, async () =>
      toUser((await this.api("users.lookupByEmail", { email: normalized }, { get: true }))["user"] as Record<string, unknown>),
    );
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
   * A sender that looks like `user`: their display/real name and Slack photo. Pair with `/avatar`'s `badgedSvg` to
   * mark the post as automated.
   */
  async senderFor(userId: string, options: { suffix?: string; iconUrl?: string } = {}): Promise<Sender | null> {
    const user = await this.userInfo(userId);
    if (!user || user.deleted) return null;
    const name = user.displayName ?? user.realName ?? user.name;
    const sender: Sender = { username: `${name}${options.suffix ?? ""}`.slice(0, 80) };
    const icon = options.iconUrl ?? user.image;
    if (icon) sender.iconUrl = icon;
    return sender;
  }

  /** A channel's id from `#name`, `name` or an id (returned as-is), via a cached `conversations.list`. */
  async channelId(nameOrId: string): Promise<string> {
    const name = nameOrId.replace(/^#/, "");
    if (CHANNEL_ID.test(name)) return name;
    this.shared.channels ??= (async () => {
      const map = new Map<string, string>();
      for await (const c of this.paginate<{ id: string; name: string }>(
        "conversations.list",
        { types: "public_channel,private_channel", exclude_archived: true, limit: 1000 },
        "channels",
        { get: true },
      )) {
        map.set(c.name, c.id);
      }
      return map;
    })();
    let channels: Map<string, string>;
    try {
      channels = await this.shared.channels;
    } catch (e) {
      delete this.shared.channels;
      throw e;
    }
    const id = channels.get(name);
    if (id === undefined) throw new SlackApiError("conversations.list", "channel_not_found", 200);
    return id;
  }

  /** The DM (one user) or group DM (several) channel id, opening it if needed. */
  async openDm(users: string | string[]): Promise<string> {
    const result = await this.api("conversations.open", { users: ([] as string[]).concat(users).join(",") });
    return (result["channel"] as { id: string }).id;
  }

  /** Open a modal (`views.open`); returns the view, whose `id`/`hash` `updateView` takes. */
  async openView(triggerId: string, view: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.api("views.open", { trigger_id: triggerId, view }))["view"] as Record<string, unknown>;
  }

  async pushView(triggerId: string, view: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.api("views.push", { trigger_id: triggerId, view }))["view"] as Record<string, unknown>;
  }

  /** Update a modal by `viewId` or `externalId`; pass the last-seen `hash` to refuse a stale overwrite. */
  async updateView(
    view: Record<string, unknown>,
    target: { viewId?: string; externalId?: string; hash?: string },
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = { view };
    if (target.viewId !== undefined) data["view_id"] = target.viewId;
    if (target.externalId !== undefined) data["external_id"] = target.externalId;
    if (target.hash !== undefined) data["hash"] = target.hash;
    return (await this.api("views.update", data))["view"] as Record<string, unknown>;
  }

  /** Publish a user's App Home tab. */
  async publishHome(userId: string, view: Record<string, unknown>): Promise<void> {
    await this.api("views.publish", { user_id: userId, view });
  }

  async sync(
    thread: Thread,
    options: SlackSyncOptions = {},
  ): Promise<SyncResult> {
    const { threadTs, suppressUnfurls = this.options.suppressUnfurls ?? true, ...rest } = options;
    const prior = this.suppressUnfurls;
    this.suppressUnfurls = suppressUnfurls;
    try {
      return await sync(this, thread, threadTs, rest);
    } finally {
      this.suppressUnfurls = prior;
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

