import {
  EditRateLimited,
  OrphanedRepliesError,
  THRDS_HASH,
  contentKey,
  isRich,
  msgHash,
  sync,
  toMsg
} from "./chunk-LIS4UL2J.js";
import {
  hash53,
  stableStringify
} from "./chunk-YSTFV535.js";

// src/api.ts
var SLACK_API = "https://slack.com/api";
var SlackApiError = class extends Error {
  constructor(method, code, status, response) {
    super(`${method}: ${code}`);
    this.method = method;
    this.code = code;
    this.status = status;
    this.response = response;
    this.name = "SlackApiError";
  }
  method;
  code;
  status;
  response;
};
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryAfterMs(headers, fallbackMs) {
  const raw = headers.get("Retry-After");
  const s = raw === null ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s * 1e3 : fallbackMs;
}
function encodeQuery(body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === void 0 || v === null) continue;
    params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return params.toString();
}
async function slackCall(token, method, body = {}, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    retries = 3,
    retryServerErrors = false,
    timeoutMs = 3e4,
    sleep: sleep2 = defaultSleep,
    onRetry,
    get = false
  } = options;
  for (let attempt = 0; ; attempt++) {
    const retry = async (reason, waitMs) => {
      if (attempt >= retries) return false;
      onRetry?.({ method, attempt: attempt + 1, waitMs, reason });
      await sleep2(waitMs);
      return true;
    };
    let url = `${SLACK_API}/${method}`;
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (get) {
      const q = encodeQuery(body);
      if (q) url = `${url}?${q}`;
    } else {
      headers["Content-Type"] = "application/json; charset=utf-8";
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: get ? "GET" : "POST",
        headers,
        body: payload,
        ...timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (timedOut && retryServerErrors && await retry("timeout", 1e3 * 2 ** attempt)) continue;
      if (timedOut) throw new SlackApiError(method, "timeout", 0);
      throw e;
    }
    if (response.status === 429) {
      if (await retry("http_429", retryAfterMs(response.headers, 1e3))) continue;
      throw new SlackApiError(method, "ratelimited", 429);
    }
    if (response.status >= 500 && retryServerErrors && await retry("server_error", 1e3 * 2 ** attempt)) continue;
    const text = await response.text();
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`, response.status);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SlackApiError(method, "invalid_json", response.status);
    }
    if (json["ok"] !== true) {
      const code = typeof json["error"] === "string" ? json["error"] : "unknown_error";
      if (code === "ratelimited" && await retry("ratelimited", retryAfterMs(response.headers, 3e4 * (attempt + 1)))) continue;
      throw new SlackApiError(method, code, response.status, json);
    }
    return { json, headers: response.headers };
  }
}
async function slackApi(token, method, body = {}, options = {}) {
  return (await slackCall(token, method, body, options)).json;
}
async function* paginate(call, key) {
  let cursor;
  do {
    const page = await call(cursor);
    for (const item of page[key] ?? []) yield item;
    const next = page["response_metadata"]?.next_cursor;
    cursor = next ? next : void 0;
  } while (cursor !== void 0);
}
async function collect(items) {
  const out = [];
  for await (const item of items) out.push(item);
  return out;
}

// src/linked.ts
var defaultBullet = (section2, url) => `- [**${section2.title}**](${url}) \u2014 ${section2.summary}`;
function splitBody(body, limit) {
  if (body.length <= limit) return [body];
  const paragraphs = body.split("\n\n");
  const messages = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? `${current}

${para}` : para;
    if (candidate.length > limit) {
      if (current) messages.push(current);
      if (para.length > limit) {
        const lines = para.split("\n");
        current = "";
        for (const line of lines) {
          const c = current ? `${current}
${line}` : line;
          if (c.length > limit) {
            if (current) messages.push(current);
            current = line;
          } else {
            current = c;
          }
        }
      } else {
        current = para;
      }
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}
function buildDetailMessages(sections, limit) {
  const messages = [];
  const sectionStarts = {};
  for (let i = 0; i < sections.length; i++) {
    sectionStarts[i] = messages.length;
    const parts = splitBody(sections[i].body, limit);
    messages.push(...parts);
  }
  return [messages, sectionStarts];
}
function buildSummaryMessages(linked, sectionUrls, limit, bulletFn = defaultBullet) {
  const bullets = linked.sections.map((s, i) => bulletFn(s, sectionUrls[i]));
  const messages = [];
  let current = linked.summaryPrefix;
  for (const bullet of bullets) {
    const candidate = current ? `${current}
${bullet}` : bullet;
    if (candidate.length > limit) {
      if (current) messages.push(current);
      current = bullet;
    } else {
      current = candidate;
    }
  }
  if (linked.summarySuffix) {
    const candidate = current ? `${current}
${linked.summarySuffix}` : linked.summarySuffix;
    if (candidate.length > limit) {
      if (current) messages.push(current);
      current = linked.summarySuffix;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}

// src/slack.ts
var SLACK_MESSAGE_LIMIT = 4e3;
var slackBullet = (section2, url) => `- <${url}|*${section2.title}*> \u2014 ${section2.summary}`;
var DETAIL_URL_PLACEHOLDER = "x".repeat(130);
var USER_TTL_MS = 60 * 60 * 1e3;
var NOT_FOUND_TTL_MS = 60 * 1e3;
var CHANNEL_ID = /^[CDG][A-Z0-9]{6,}$/;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function toUser(raw) {
  const profile = raw["profile"] ?? {};
  const images = {};
  for (const [k, v] of Object.entries(profile)) {
    const m = /^image_(\w+)$/.exec(k);
    if (m && typeof v === "string") images[m[1]] = v;
  }
  const str = (v) => typeof v === "string" && v ? v : void 0;
  const user = {
    id: raw["id"],
    name: raw["name"] ?? "",
    images,
    isBot: raw["is_bot"] === true,
    deleted: raw["deleted"] === true
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
var SlackClient = class _SlackClient {
  token;
  username;
  iconUrl;
  iconEmoji;
  options;
  _channel;
  shared;
  suppressUnfurls;
  skipOp = false;
  constructor(options, shared) {
    this.options = options;
    this.token = options.token;
    this._channel = options.channel;
    this.username = options.username;
    this.iconUrl = options.iconUrl;
    this.iconEmoji = options.iconEmoji;
    this.suppressUnfurls = options.suppressUnfurls ?? true;
    this.shared = shared ?? { users: /* @__PURE__ */ new Map() };
  }
  /** The channel thread operations act in; throws if the client wasn't given one. */
  get channel() {
    if (this._channel === void 0) throw new Error("SlackClient: no channel (pass `channel`, or use `in(channel)`)");
    return this._channel;
  }
  /** The same client (token, options, caches) acting in another channel. */
  in(channel) {
    return new _SlackClient({ ...this.options, channel }, this.shared);
  }
  now() {
    return (this.options.now ?? Date.now)();
  }
  /** Call any Web API method with this client's token, retries and timeout. */
  async api(method, body = {}, options = {}) {
    return (await slackCall(this.token, method, body, { ...this.options, ...options })).json;
  }
  /** Every item of a cursor-paginated method; `key` is the response field holding the items. */
  paginate(method, params, key, options = {}) {
    return paginate(
      (cursor) => this.api(method, { ...params, ...cursor ? { cursor } : {} }, options),
      key
    );
  }
  /**
   * Lazily resolve the authenticated bot's `user_id` and `bot_id`.
   *
   * Slack returns `user: null` on `bot_message` events — the bot's identity
   * lives in `bot_id`. Matching only `user_id` mis-labels our own posts as
   * non-editable, which makes `sync()` re-post the whole thread every run.
   */
  async botIds() {
    this.shared.botIds ??= this.api("auth.test").then((r) => ({
      userId: r["user_id"],
      botId: r["bot_id"] ?? void 0
    }));
    try {
      return await this.shared.botIds;
    } catch (e) {
      delete this.shared.botIds;
      throw e;
    }
  }
  /** The token's OAuth scopes (`auth.test`'s `x-oauth-scopes` header), cached. */
  async scopes() {
    this.shared.scopes ??= slackCall(this.token, "auth.test", {}, this.options).then(
      ({ headers }) => new Set(
        (headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      )
    );
    try {
      return await this.shared.scopes;
    } catch (e) {
      delete this.shared.scopes;
      throw e;
    }
  }
  /** Whether per-message `username` / `icon_url` will be honored (`chat:write.customize`). */
  async canCustomizeSender() {
    return (await this.scopes()).has("chat:write.customize");
  }
  toMessage(raw, ids) {
    const msg = {
      id: raw.ts,
      content: raw.text ?? "",
      editable: raw.user === ids.userId || ids.botId !== void 0 && raw.bot_id === ids.botId
    };
    const stamped = raw.metadata?.event_payload?.[THRDS_HASH];
    if (typeof stamped === "string") msg.key = `thrds:${stamped}`;
    if (raw.user) msg.user = raw.user;
    if (raw.bot_id) msg.botId = raw.bot_id;
    const username = raw.username ?? raw.bot_profile?.name;
    if (username) msg.username = username;
    if (raw.subtype) msg.subtype = raw.subtype;
    if (raw.thread_ts) msg.threadTs = raw.thread_ts;
    if (raw.reply_count !== void 0) msg.replyCount = raw.reply_count;
    if (raw.blocks) msg.blocks = raw.blocks;
    if (raw.metadata) msg.metadata = raw.metadata;
    if (raw.reactions) msg.reactions = raw.reactions;
    return msg;
  }
  /** A thread's messages (parent first), every page, with metadata. */
  async list(threadId) {
    const ids = await this.botIds();
    const raw = await collect(
      this.paginate(
        "conversations.replies",
        { channel: this.channel, ts: threadId, include_all_metadata: true, limit: 200 },
        "messages",
        { get: true }
      )
    );
    let messages = raw.map((m) => this.toMessage(m, ids));
    if (this.skipOp && messages.length > 0) {
      messages = messages.slice(1);
    }
    return messages;
  }
  /** The channel's top-level messages, newest first, lazily across pages. */
  async *history(options = {}) {
    const ids = await this.botIds();
    const { limit = 200, ...range } = options;
    for await (const raw of this.paginate(
      "conversations.history",
      { channel: this.channel, include_all_metadata: true, limit, ...range },
      "messages",
      { get: true }
    )) {
      yield this.toMessage(raw, ids);
    }
  }
  /**
   * The first message tagged with `metadata.event_type === eventType` whose payload satisfies `match`: in a thread
   * (`threadTs`), else the channel's history back to `oldest`. How a bot finds "its" message without a database.
   */
  async findByMetadata(eventType, match = () => true, options = {}) {
    return this.find(
      (m) => m.metadata?.event_type === eventType && match(m.metadata.event_payload ?? {}),
      options
    );
  }
  /** The first message satisfying `hit`: in a thread (`threadTs`), else the channel's history back to `oldest`. */
  async find(hit, options = {}) {
    if (options.threadTs !== void 0) {
      return (await this.list(options.threadTs)).find(hit) ?? null;
    }
    for await (const m of this.history(options.oldest !== void 0 ? { oldest: options.oldest } : {})) {
      if (hit(m)) return m;
    }
    return null;
  }
  /** The request body a message sends: text, blocks, metadata (hash-stamped when rich), formatting flags. */
  body(m) {
    const msg = toMsg(m);
    const data = {
      channel: this.channel,
      text: msg.text,
      unfurl_links: !this.suppressUnfurls,
      unfurl_media: !this.suppressUnfurls
    };
    if (this.options.parse !== void 0) data["parse"] = this.options.parse;
    if (this.options.linkNames !== void 0) data["link_names"] = this.options.linkNames;
    if (msg.blocks !== void 0) data["blocks"] = msg.blocks;
    if (isRich(msg)) {
      data["metadata"] = {
        event_type: msg.metadata?.event_type ?? "thrds",
        event_payload: { ...msg.metadata?.event_payload, [THRDS_HASH]: msgHash(msg) }
      };
    }
    return data;
  }
  sent(id, m) {
    const key = contentKey(m);
    const content = toMsg(m).text;
    return key === content ? { id, content } : { id, content, key };
  }
  /** Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. */
  async post(m, threadId) {
    const msg = toMsg(m);
    const data = this.body(msg);
    const username = msg.username ?? this.username;
    const iconUrl = msg.iconUrl ?? this.iconUrl;
    const iconEmoji = msg.iconEmoji ?? this.iconEmoji;
    if (username !== void 0) data["username"] = username;
    if (iconUrl !== void 0) data["icon_url"] = iconUrl;
    else if (iconEmoji !== void 0) data["icon_emoji"] = iconEmoji;
    if (threadId !== void 0) {
      data["thread_ts"] = threadId;
      if (msg.replyBroadcast) data["reply_broadcast"] = true;
    }
    const result = await this.api("chat.postMessage", data);
    return this.sent(result["ts"], msg);
  }
  /**
   * Edit a message's text, blocks and metadata. Slack ignores sender fields on an edit. To clear a message's blocks,
   * pass `blocks: []`; omitting `blocks` leaves them as they were.
   */
  async edit(messageId, m) {
    await this.api("chat.update", { ...this.body(m), ts: messageId });
    return this.sent(messageId, m);
  }
  async delete(messageId, options = {}) {
    if (!options.orphansOk) {
      const result = await this.api(
        "conversations.replies",
        { channel: this.channel, ts: messageId },
        { get: true }
      );
      const replies = result["messages"] ?? [];
      if (replies.length > 1) {
        throw new OrphanedRepliesError(messageId, replies.length - 1);
      }
    }
    await this.api("chat.delete", {
      channel: this.channel,
      ts: messageId
    });
  }
  /** A message only `user` sees; returns its `message_ts`. */
  async postEphemeral(user, m, options = {}) {
    const data = { ...this.body(m), user };
    if (options.threadTs !== void 0) data["thread_ts"] = options.threadTs;
    const result = await this.api("chat.postEphemeral", data);
    return result["message_ts"];
  }
  async permalink(messageTs) {
    const result = await this.api(
      "chat.getPermalink",
      { channel: this.channel, message_ts: messageTs },
      { get: true }
    );
    return result["permalink"];
  }
  /** Add a reaction (no-op if we already reacted). */
  async react(ts, name) {
    try {
      await this.api("reactions.add", { channel: this.channel, timestamp: ts, name: name.replace(/^:|:$/g, "") });
    } catch (e) {
      if (!(e instanceof SlackApiError && e.code === "already_reacted")) throw e;
    }
  }
  /** Remove our reaction (no-op if it isn't there). */
  async unreact(ts, name) {
    try {
      await this.api("reactions.remove", { channel: this.channel, timestamp: ts, name: name.replace(/^:|:$/g, "") });
    } catch (e) {
      if (!(e instanceof SlackApiError && e.code === "no_reaction")) throw e;
    }
  }
  async reactions(ts) {
    const result = await this.api("reactions.get", { channel: this.channel, timestamp: ts, full: true }, { get: true });
    return result["message"]?.reactions ?? [];
  }
  async cachedUser(key, load) {
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
  async userInfo(id) {
    return this.cachedUser(
      `id:${id}`,
      async () => toUser((await this.api("users.info", { user: id }, { get: true }))["user"])
    );
  }
  /** A user by email (`users.lookupByEmail`, needs `users:read.email`), cached; null if none. */
  async userByEmail(email) {
    const normalized = email.trim().toLowerCase();
    return this.cachedUser(
      `email:${normalized}`,
      async () => toUser((await this.api("users.lookupByEmail", { email: normalized }, { get: true }))["user"])
    );
  }
  /** Every workspace member (`users.list`), lazily. */
  users() {
    const client = this;
    return (async function* () {
      for await (const raw of client.paginate("users.list", { limit: 200 }, "members", { get: true })) {
        yield toUser(raw);
      }
    })();
  }
  /**
   * A sender that looks like `user`: their display/real name and Slack photo. Pair with `/avatar`'s `badgedSvg` to
   * mark the post as automated.
   */
  async senderFor(userId, options = {}) {
    const user = await this.userInfo(userId);
    if (!user || user.deleted) return null;
    const name = user.displayName ?? user.realName ?? user.name;
    const sender = { username: `${name}${options.suffix ?? ""}`.slice(0, 80) };
    const icon = options.iconUrl ?? user.image;
    if (icon) sender.iconUrl = icon;
    return sender;
  }
  /** A channel's id from `#name`, `name` or an id (returned as-is), via a cached `conversations.list`. */
  async channelId(nameOrId) {
    const name = nameOrId.replace(/^#/, "");
    if (CHANNEL_ID.test(name)) return name;
    this.shared.channels ??= (async () => {
      const map = /* @__PURE__ */ new Map();
      for await (const c of this.paginate(
        "conversations.list",
        { types: "public_channel,private_channel", exclude_archived: true, limit: 1e3 },
        "channels",
        { get: true }
      )) {
        map.set(c.name, c.id);
      }
      return map;
    })();
    let channels;
    try {
      channels = await this.shared.channels;
    } catch (e) {
      delete this.shared.channels;
      throw e;
    }
    const id = channels.get(name);
    if (id === void 0) throw new SlackApiError("conversations.list", "channel_not_found", 200);
    return id;
  }
  /** The DM (one user) or group DM (several) channel id, opening it if needed. */
  async openDm(users) {
    const result = await this.api("conversations.open", { users: [].concat(users).join(",") });
    return result["channel"].id;
  }
  /** Open a modal (`views.open`); returns the view, whose `id`/`hash` `updateView` takes. */
  async openView(triggerId, view) {
    return (await this.api("views.open", { trigger_id: triggerId, view }))["view"];
  }
  async pushView(triggerId, view) {
    return (await this.api("views.push", { trigger_id: triggerId, view }))["view"];
  }
  /** Update a modal by `viewId` or `externalId`; pass the last-seen `hash` to refuse a stale overwrite. */
  async updateView(view, target) {
    const data = { view };
    if (target.viewId !== void 0) data["view_id"] = target.viewId;
    if (target.externalId !== void 0) data["external_id"] = target.externalId;
    if (target.hash !== void 0) data["hash"] = target.hash;
    return (await this.api("views.update", data))["view"];
  }
  /** Publish a user's App Home tab. */
  async publishHome(userId, view) {
    await this.api("views.publish", { user_id: userId, view });
  }
  async sync(thread, options = {}) {
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
  async syncLinked(linked, options = {}) {
    const {
      threadTs: providedThreadTs,
      dryRun = false,
      pace = 0.4,
      jitter = 0,
      suppressUnfurls = true
    } = options;
    const linkedReplies = {
      summaryPrefix: "",
      sections: linked.sections,
      summarySuffix: linked.summarySuffix
    };
    const [detailMsgs, sectionStarts] = buildDetailMessages(
      linked.sections,
      SLACK_MESSAGE_LIMIT
    );
    const placeholderUrls = linked.sections.map(() => DETAIL_URL_PLACEHOLDER);
    const summaryMsgs = buildSummaryMessages(
      linkedReplies,
      placeholderUrls,
      SLACK_MESSAGE_LIMIT,
      slackBullet
    );
    const nSummary = summaryMsgs.length;
    const allReplyMsgs = [...summaryMsgs, ...detailMsgs];
    let threadTs = providedThreadTs;
    if (threadTs === void 0) {
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
    let result;
    try {
      result = await this.sync(
        { messages: allReplyMsgs },
        { threadTs, dryRun, pace, jitter, suppressUnfurls }
      );
    } finally {
      this.skipOp = false;
    }
    if (dryRun) {
      return {
        threadId: threadTs,
        summaryIds: result.messageIds.slice(0, nSummary),
        detailIds: result.messageIds.slice(nSummary),
        sectionDetailIds: {}
      };
    }
    const detailIds = result.messageIds.slice(nSummary);
    const summaryIds = result.messageIds.slice(0, nSummary);
    const sectionDetailIds = {};
    const realLinks = [];
    for (let i = 0; i < linked.sections.length; i++) {
      if (i > 0 && pace > 0) {
        await sleep((pace + Math.random() * jitter) * 1e3);
      }
      const detailIdx = sectionStarts[i];
      const detailMsgId = detailIds[detailIdx];
      sectionDetailIds[linked.sections[i].title] = detailMsgId;
      realLinks.push(await this.permalink(detailMsgId));
    }
    const finalSummaries = buildSummaryMessages(
      linkedReplies,
      realLinks,
      SLACK_MESSAGE_LIMIT,
      slackBullet
    );
    for (let i = 0; i < summaryIds.length; i++) {
      if (i > 0 && pace > 0) {
        await sleep((pace + Math.random() * jitter) * 1e3);
      }
      await this.edit(summaryIds[i], finalSummaries[i]);
    }
    return {
      threadId: result.threadId,
      summaryIds,
      detailIds,
      sectionDetailIds
    };
  }
};

// src/mrkdwn.ts
var escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function link(url, label) {
  const href = url.replace(/\|/g, "%7C").replace(/>/g, "%3E");
  return label === void 0 ? `<${href}>` : `<${href}|${escape(label).replace(/\|/g, "\xA6")}>`;
}
var mention = {
  user: (id) => `<@${id}>`,
  channel: (id) => `<#${id}>`,
  /** A user group (`S…`). */
  group: (id) => `<!subteam^${id}>`,
  here: "<!here>",
  channelAll: "<!channel>"
};
function date(tsS, format, fallback, href) {
  return `<!date^${Math.floor(tsS)}^${format}${href ? `^${href}` : ""}|${escape(fallback)}>`;
}
function bound(text, max, ellipsis = "\u2026") {
  const chars = [...text];
  if (chars.length <= max) return text;
  const keep = Math.max(0, max - [...ellipsis].length);
  return chars.slice(0, keep).join("") + ellipsis;
}
var mrkdwnText = (text) => ({ type: "mrkdwn", text });
var plainText = (text, emoji = true) => ({ type: "plain_text", text, emoji });
var header = (text) => ({ type: "header", text: plainText(bound(text, 150)) });
var divider = () => ({ type: "divider" });
function section(text, options = {}) {
  const block = { type: "section", text: mrkdwnText(bound(text, 3e3)) };
  if (options.fields) block["fields"] = options.fields.map((f) => mrkdwnText(bound(f, 2e3)));
  if (options.accessory) block["accessory"] = options.accessory;
  if (options.blockId) block["block_id"] = options.blockId;
  return block;
}
function context(...elements) {
  return { type: "context", elements: elements.map((e) => typeof e === "string" ? mrkdwnText(e) : e) };
}
function image(src, alt, title) {
  const block = { type: "image", alt_text: alt };
  if (typeof src === "string") block["image_url"] = src;
  else block["slack_file"] = { id: src.slackFile };
  if (title) block["title"] = plainText(title);
  return block;
}
var imageElement = (url, alt) => ({ type: "image", image_url: url, alt_text: alt });
function button(options) {
  const block = { type: "button", text: plainText(options.text), action_id: options.actionId };
  if (options.value !== void 0) block["value"] = options.value;
  if (options.url !== void 0) block["url"] = options.url;
  if (options.style !== void 0) block["style"] = options.style;
  if (options.confirm) {
    block["confirm"] = {
      title: plainText(options.confirm.title),
      text: mrkdwnText(options.confirm.text),
      confirm: plainText(options.confirm.confirm),
      deny: plainText(options.confirm.deny)
    };
  }
  return block;
}
function actions(elements, blockId) {
  const block = { type: "actions", elements };
  if (blockId) block["block_id"] = blockId;
  return block;
}
function encodePrivateMetadata(value) {
  const s = JSON.stringify(value);
  if (s.length > 3e3) throw new RangeError(`private_metadata is ${s.length} chars; Slack's limit is 3000`);
  return s;
}
function decodePrivateMetadata(s) {
  if (!s) return null;
  return JSON.parse(s);
}

// src/permalink.ts
var tsOf = (p) => `${p.slice(0, -6)}.${p.slice(-6)}`;
function parsePermalink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/.test(u.hostname)) return null;
  const m = /^\/archives\/([A-Z0-9]+)\/p(\d{7,})\/?$/.exec(u.pathname);
  if (!m) return null;
  const ref = { channel: m[1], ts: tsOf(m[2]) };
  const threadTs = u.searchParams.get("thread_ts");
  if (threadTs && threadTs !== ref.ts) ref.threadTs = threadTs;
  return ref;
}
function buildPermalink(workspace, ref) {
  const origin = workspace.includes("://") ? workspace.replace(/\/+$/, "") : `https://${workspace}.slack.com`;
  const base = `${origin}/archives/${ref.channel}/p${ref.ts.replace(".", "")}`;
  return ref.threadTs ? `${base}?thread_ts=${ref.threadTs}&cid=${ref.channel}` : base;
}

// src/slots.ts
var LeaseLostError = class extends Error {
  constructor(key) {
    super(`slot lease lost for ${key}: another run took over`);
    this.key = key;
    this.name = "LeaseLostError";
  }
  key;
};
var SLOT_KEY = "thrds_key";
var SLOT_NAME = "thrds_slot";
function tagSlot(m, key, slot) {
  const msg = toMsg(m);
  return {
    ...msg,
    metadata: {
      event_type: msg.metadata?.event_type ?? "thrds_slot",
      event_payload: { ...msg.metadata?.event_payload, [SLOT_KEY]: key, [SLOT_NAME]: slot ?? "" }
    }
  };
}
var isRef = (p) => typeof p !== "string" && !("text" in p) && "ts" in p;
var isGone = (e) => e instanceof SlackApiError && e.code === "message_not_found";
var isThreadGone = (e) => e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found");
var ParentGone = class extends Error {
};
var defaultSleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
async function syncSlots(client, store, thread, options = {}) {
  const { leaseS, pace = 0, dryRun = false, recoverWindowS = 120, now = Date.now, sleep: sleep2 = defaultSleep2 } = options;
  const { key } = thread;
  const nowS = () => Math.floor(now() / 1e3);
  let lease;
  if (leaseS !== void 0 && !dryRun) {
    if (!store.claim) throw new TypeError("syncSlots: `leaseS` needs a store with `claim` (memoryStore, d1Store)");
    const got = await store.claim(key, leaseS, nowS());
    if (got === null) return { status: "busy", ts: "", slots: {}, actions: [] };
    lease = got;
  }
  try {
    const state = await store.get(key) ?? { slots: {} };
    const actions2 = [];
    let wrote = false;
    const save = async () => {
      if (dryRun) return;
      if (!await store.put(key, state, lease)) throw new LeaseLostError(key);
    };
    const paced = async () => {
      if (wrote && pace > 0) await sleep2(pace * 1e3);
      wrote = true;
    };
    const tagged = (m, slot) => m.metadata?.event_payload?.[SLOT_KEY] === key && m.metadata.event_payload[SLOT_NAME] === (slot ?? "");
    if (state.pending && !dryRun) {
      const { slot, hash, at } = state.pending;
      const parentTs2 = slot === null ? void 0 : isRef(thread.parent) ? thread.parent.ts : state.parent?.ts;
      const found = slot === null ? await client.find((m) => tagged(m, null), { oldest: String(at - recoverWindowS) }) : parentTs2 !== void 0 ? await client.find((m) => tagged(m, slot), { threadTs: parentTs2 }) : null;
      if (found) {
        if (slot === null) state.parent = { ts: found.id, hash };
        else state.slots[slot] = { ts: found.id, hash };
        actions2.push({ type: "ADOPT", slot, ts: found.id });
      }
      delete state.pending;
      await save();
    }
    const post = async (msg, slot, threadTs) => {
      const hash = msgHash(msg);
      if (dryRun) return "<new>";
      state.pending = { slot, hash, at: nowS() };
      await save();
      await paced();
      let ts;
      try {
        ts = (await client.post(msg, threadTs)).id;
      } catch (e) {
        if (slot !== null && isThreadGone(e)) {
          delete state.pending;
          await save();
          throw new ParentGone();
        }
        throw e;
      }
      if (slot === null) state.parent = { ts, hash };
      else state.slots[slot] = { ts, hash };
      delete state.pending;
      await save();
      return ts;
    };
    const reconcile = async (msg, slot, record, threadTs) => {
      const hash = msgHash(msg);
      if (record === void 0) {
        const ts = await post(msg, slot, threadTs);
        actions2.push({ type: "POST", slot, ts });
        return { ts, reposted: false };
      }
      if (record.hash === hash) {
        actions2.push({ type: "SKIP", slot, ts: record.ts });
        return { ts: record.ts, reposted: false };
      }
      if (dryRun) {
        actions2.push({ type: "EDIT", slot, ts: record.ts });
        return { ts: record.ts, reposted: false };
      }
      try {
        await paced();
        await client.edit(record.ts, msg);
      } catch (e) {
        if (!isGone(e)) throw e;
        if (slot !== null && threadTs !== void 0 && await threadGone(threadTs)) throw new ParentGone();
        const ts = await post(msg, slot, threadTs);
        actions2.push({ type: "REPOST", slot, ts });
        return { ts, reposted: true };
      }
      record.hash = hash;
      await save();
      actions2.push({ type: "EDIT", slot, ts: record.ts });
      return { ts: record.ts, reposted: false };
    };
    const threadGone = async (ts) => {
      try {
        await client.list(ts);
        return false;
      } catch (e) {
        if (isThreadGone(e)) return true;
        throw e;
      }
    };
    const desired = thread.slots ?? [];
    const names = /* @__PURE__ */ new Set();
    for (const { slot } of desired) {
      if (names.has(slot)) throw new TypeError(`syncSlots: duplicate slot ${JSON.stringify(slot)}`);
      names.add(slot);
    }
    let parentTs = "";
    const start = actions2.length;
    for (let attempt = 0; ; attempt++) {
      try {
        if (isRef(thread.parent)) {
          parentTs = thread.parent.ts;
        } else {
          const parent = await reconcile(tagSlot(thread.parent, key, null), null, state.parent);
          parentTs = parent.ts;
          if (attempt > 0) actions2[start].type = "REPOST";
          if (parent.reposted) {
            state.slots = {};
            await save();
          }
        }
        for (const { slot, msg } of desired) {
          await reconcile(tagSlot(msg, key, slot), slot, state.slots[slot], parentTs);
        }
        break;
      } catch (e) {
        if (!(e instanceof ParentGone)) throw e;
        if (isRef(thread.parent) || attempt > 0) throw new SlackApiError("conversations.replies", "thread_not_found", 200);
        actions2.length = start;
        delete state.parent;
        state.slots = {};
        await save();
      }
    }
    if (thread.prune) {
      for (const [slot, record] of Object.entries(state.slots)) {
        if (names.has(slot)) continue;
        actions2.push({ type: "DELETE", slot, ts: record.ts });
        if (dryRun) continue;
        await paced();
        try {
          await client.delete(record.ts, { orphansOk: true });
        } catch (e) {
          if (!isGone(e)) throw e;
        }
        delete state.slots[slot];
        await save();
      }
    }
    const slots = {};
    for (const { slot } of desired) {
      const record = state.slots[slot];
      slots[slot] = record ? record.ts : "<new>";
    }
    return { status: "synced", ts: parentTs, slots, actions: actions2 };
  } finally {
    if (lease !== void 0) await store.release?.(key, lease);
  }
}
async function upsert(client, store, key, msg, options = {}) {
  const result = await syncSlots(client, store, { key, parent: msg }, options);
  return { status: result.status, ts: result.ts, action: result.actions.at(-1)?.type ?? null };
}
var newLease = () => globalThis.crypto.randomUUID();
function memoryStore(initial = {}) {
  const states = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const leases = /* @__PURE__ */ new Map();
  return {
    async get(key) {
      const s = states.get(key);
      return s === void 0 ? void 0 : JSON.parse(s);
    },
    async put(key, state, lease) {
      if (lease !== void 0 && leases.get(key)?.token !== lease) return false;
      states.set(key, JSON.stringify(state));
      return true;
    },
    async claim(key, leaseS, nowS) {
      const held = leases.get(key);
      if (held && held.until > nowS) return null;
      const token = newLease();
      leases.set(key, { token, until: nowS + leaseS });
      return token;
    },
    async release(key, lease) {
      if (leases.get(key)?.token === lease) leases.delete(key);
    },
    dump() {
      return Object.fromEntries([...states].map(([k, v]) => [k, JSON.parse(v)]));
    }
  };
}
export {
  EditRateLimited,
  LeaseLostError,
  NOT_FOUND_TTL_MS,
  OrphanedRepliesError,
  SLACK_API,
  SLACK_MESSAGE_LIMIT,
  SLOT_KEY,
  SLOT_NAME,
  SlackApiError,
  SlackClient,
  THRDS_HASH,
  USER_TTL_MS,
  actions,
  bound,
  buildDetailMessages,
  buildPermalink,
  buildSummaryMessages,
  button,
  collect,
  contentKey,
  context,
  date,
  decodePrivateMetadata,
  defaultBullet,
  divider,
  encodePrivateMetadata,
  escape,
  hash53,
  header,
  image,
  imageElement,
  isRich,
  link,
  memoryStore,
  mention,
  mrkdwnText,
  msgHash,
  paginate,
  parsePermalink,
  plainText,
  section,
  slackApi,
  slackCall,
  splitBody,
  stableStringify,
  sync,
  syncSlots,
  tagSlot,
  toMsg,
  upsert
};
//# sourceMappingURL=index.js.map