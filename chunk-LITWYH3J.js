import {
  OrphanedRepliesError,
  THRDS_HASH,
  contentKey,
  isRich,
  msgHash,
  sync,
  toMsg
} from "./chunk-ZJWW4GA7.js";

// src/api.ts
var SLACK_API = "https://slack.com/api";
var SAFE_CODE = /^[a-z0-9_.]{1,64}$/;
var SlackApiError = class extends Error {
  constructor(method, code, status, response, retryAfterS2, kind, options) {
    super(`${method}: ${SAFE_CODE.test(code) ? code : "unknown_error"}`, options);
    this.method = method;
    this.code = code;
    this.status = status;
    this.response = response;
    this.retryAfterS = retryAfterS2;
    this.name = "SlackApiError";
    this.kind = kind ?? (code === "timeout" ? "timeout" : code.startsWith("http_") || code === "invalid_json" ? "http" : "slack");
    const sent = response?.["error"];
    if (typeof sent === "string" && SAFE_CODE.test(sent)) this.slackCode = sent;
  }
  method;
  code;
  status;
  response;
  retryAfterS;
  kind;
  /** The code Slack itself sent (absent for synthesized ones like `http_502`), only if it looks like a Slack code. */
  slackCode;
  /**
   * Whether the failure means the request certainly did nothing: Slack refused it (`ok:false`, a 429) or rejected it
   * with a 4xx. False for timeouts, 5xx, transport errors and unparseable replies, after which a write may have landed.
   */
  get definite() {
    return this.kind === "slack" || this.kind === "http" && this.status >= 400 && this.status < 500;
  }
};
var NON_IDEMPOTENT = /* @__PURE__ */ new Set([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.scheduleMessage",
  "chat.meMessage",
  "files.completeUploadExternal",
  "files.upload",
  "conversations.create",
  "usergroups.create"
]);
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryAfterS(headers) {
  const raw = headers.get("Retry-After");
  const s = raw === null ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s : void 0;
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
    maxRetryWaitMs,
    deadlineMs,
    beforeCall,
    baseUrl = SLACK_API,
    headers: extraHeaders,
    sleep: sleep2 = defaultSleep,
    now = Date.now,
    onRetry,
    get = false,
    form = false
  } = options;
  if (options.token !== void 0) token = options.token;
  const repeatable = !NON_IDEMPOTENT.has(method);
  const start = now();
  await beforeCall?.(method, body);
  for (let attempt = 0; ; attempt++) {
    const retry = async (reason, waitMs) => {
      if (attempt >= retries) return false;
      if (maxRetryWaitMs !== void 0 && waitMs > maxRetryWaitMs) return false;
      if (deadlineMs !== void 0 && now() - start + waitMs > deadlineMs) return false;
      onRetry?.({ method, attempt: attempt + 1, waitMs, reason });
      await sleep2(waitMs);
      return true;
    };
    let url = `${baseUrl}/${method}`;
    const headers = { Authorization: `Bearer ${token}`, ...extraHeaders };
    let payload;
    if (get) {
      const q = encodeQuery(body);
      if (q) url = `${url}?${q}`;
    } else if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = encodeQuery(body);
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
      if (timedOut && retryServerErrors && repeatable && await retry("timeout", 1e3 * 2 ** attempt)) continue;
      if (timedOut) throw new SlackApiError(method, "timeout", 0);
      throw new SlackApiError(method, "transport_error", 0, void 0, void 0, "transport", { cause: e });
    }
    if (response.status === 429) {
      const after = retryAfterS(response.headers);
      if (await retry("http_429", (after ?? 1) * 1e3)) continue;
      throw new SlackApiError(method, "ratelimited", 429, void 0, after);
    }
    if (response.status >= 500 && retryServerErrors && repeatable && await retry("server_error", 1e3 * 2 ** attempt)) continue;
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
      if (code === "ratelimited") {
        const after = retryAfterS(response.headers);
        if (await retry("ratelimited", after !== void 0 ? after * 1e3 : 3e4 * (attempt + 1))) continue;
        throw new SlackApiError(method, code, response.status, json, after);
      }
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
var defaultBullet = (section, url) => `- [**${section.title}**](${url}) \u2014 ${section.summary}`;
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
var USERNAME_MAX = 80;
var slackBullet = (section, url) => `- <${url}|*${section.title}*> \u2014 ${section.summary}`;
var DETAIL_URL_PLACEHOLDER = "x".repeat(130);
var USER_TTL_MS = 60 * 60 * 1e3;
var NOT_FOUND_TTL_MS = 60 * 1e3;
var MAX_CACHED_USERS = 1e4;
var CHANNEL_TTL_MS = 60 * 60 * 1e3;
function webClientTransport(client) {
  return async (_token, method, body) => {
    let json;
    try {
      json = await client.apiCall(method, body);
    } catch (e) {
      const data = e.data;
      const code = typeof data?.["error"] === "string" ? data["error"] : "unknown_error";
      throw new SlackApiError(method, code, 200, data, void 0, data ? "slack" : "transport", { cause: e });
    }
    if (json["ok"] !== true) {
      throw new SlackApiError(method, typeof json["error"] === "string" ? json["error"] : "unknown_error", 200, json);
    }
    const scopes = json["response_metadata"]?.scopes ?? [];
    return { json, headers: new Headers({ "x-oauth-scopes": scopes.join(",") }) };
  };
}
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
function unfurlFields(u) {
  if (u === "omit") return {};
  if (typeof u === "boolean") return { unfurl_links: u, unfurl_media: u };
  const out = {};
  if (u.links !== void 0) out["unfurl_links"] = u.links;
  if (u.media !== void 0) out["unfurl_media"] = u.media;
  return out;
}
var SlackClient = class _SlackClient {
  token;
  username;
  iconUrl;
  iconEmoji;
  options;
  _channel;
  shared;
  unfurl;
  skipOp = false;
  constructor(options, shared) {
    this.options = options;
    this.token = options.token;
    this._channel = options.channel;
    this.username = options.username;
    this.iconUrl = options.iconUrl;
    this.iconEmoji = options.iconEmoji;
    this.unfurl = options.unfurl ?? !(options.suppressUnfurls ?? true);
    this.shared = shared ?? { users: /* @__PURE__ */ new Map(), loading: /* @__PURE__ */ new Map() };
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
  /** The same client and caches with some options changed (e.g. `{ unfurl: true }`, or a different `channel`). */
  with(options) {
    return new _SlackClient({ ...this.options, ...options }, this.shared);
  }
  now() {
    return (this.options.now ?? Date.now)();
  }
  /** Call any Web API method with this client's token and transport options; `options` override them per call. */
  async api(method, body = {}, options = {}) {
    return (await this.call(method, body, options)).json;
  }
  async call(method, body, options) {
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
  paginate(method, params, key, options = {}) {
    return paginate(
      (cursor) => this.api(method, { ...params, ...cursor ? { cursor } : {} }, options),
      key
    );
  }
  /** The token's identity and scopes, from one cached `auth.test`. */
  async auth() {
    this.shared.auth ??= this.call("auth.test", {}, {}).then(({ json, headers }) => {
      const auth = {
        userId: json["user_id"],
        scopes: new Set(
          (headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
        )
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
  async botIds() {
    const { userId, botId } = await this.auth();
    return botId === void 0 ? { userId } : { userId, botId };
  }
  /** The token's OAuth scopes. */
  async scopes() {
    return (await this.auth()).scopes;
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
    if (raw.latest_reply) msg.latestReply = raw.latest_reply;
    if (raw.blocks) msg.blocks = raw.blocks;
    if (raw.attachments) msg.attachments = raw.attachments;
    if (raw.files) msg.files = raw.files;
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
   * Every message in the channel back to `oldest`: each top-level message (newest first), followed by its thread's
   * replies when `includeReplies` (for auditing bots that post into threads).
   */
  async *messages(options = {}) {
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
  async findByMetadata(eventType, match = () => true, options = {}) {
    return this.find(
      (m) => m.metadata?.event_type === eventType && match(m.metadata.event_payload ?? {}),
      options
    );
  }
  /**
   * The first message satisfying `hit`: in a thread (`threadTs`), else the channel's history back to `oldest` (with
   * thread replies, when `includeReplies`).
   */
  async find(hit, options = {}) {
    if (options.threadTs !== void 0) {
      return (await this.list(options.threadTs)).find(hit) ?? null;
    }
    const range = {};
    if (options.oldest !== void 0) range.oldest = options.oldest;
    if (options.includeReplies !== void 0) range.includeReplies = options.includeReplies;
    for await (const m of this.messages(range)) {
      if (hit(m)) return m;
    }
    return null;
  }
  /** The request body a message sends: text, blocks, attachments, metadata (hash-stamped when rich), flags. */
  body(m) {
    const msg = toMsg(m);
    const data = {
      channel: this.channel,
      text: msg.text,
      ...unfurlFields(msg.unfurl ?? this.unfurl)
    };
    if (this.options.parse !== void 0) data["parse"] = this.options.parse;
    if (this.options.linkNames !== void 0) data["link_names"] = this.options.linkNames;
    if (msg.blocks !== void 0) data["blocks"] = msg.blocks;
    if (msg.attachments !== void 0) data["attachments"] = msg.attachments;
    if (isRich(msg) && (msg.stamp ?? this.options.stamp ?? true)) {
      data["metadata"] = {
        event_type: msg.metadata?.event_type ?? "thrds",
        event_payload: { ...msg.metadata?.event_payload, [THRDS_HASH]: msgHash(msg) }
      };
    } else if (msg.metadata !== void 0) {
      data["metadata"] = msg.metadata;
    }
    return data;
  }
  sent(id, m) {
    const msg = toMsg(m);
    const key = msg.stamp ?? this.options.stamp ?? true ? contentKey(msg) : msg.text;
    return key === msg.text ? { id, content: msg.text } : { id, content: msg.text, key };
  }
  /** Post a message (a thread reply with `threadId`). Its sender overrides the client's default sender. */
  async post(m, threadId) {
    const msg = toMsg(m);
    const data = this.body(msg);
    const username = msg.username ?? this.username;
    const iconUrl = msg.iconUrl ?? this.iconUrl;
    const iconEmoji = msg.iconEmoji ?? this.iconEmoji;
    if (username !== void 0) data["username"] = [...username].slice(0, USERNAME_MAX).join("");
    if (iconUrl !== void 0) data["icon_url"] = iconUrl;
    else if (iconEmoji !== void 0) data["icon_emoji"] = iconEmoji;
    if (threadId !== void 0) {
      data["thread_ts"] = threadId;
      if (msg.replyBroadcast) data["reply_broadcast"] = true;
    }
    const result = await this.api("chat.postMessage", data);
    const ts = result["ts"];
    if (typeof ts !== "string" || !ts) throw new SlackApiError("chat.postMessage", "invalid_response", 200, result, void 0, "http");
    return this.sent(ts, msg);
  }
  /**
   * Edit a message's text, blocks, attachments and metadata. Slack ignores sender fields on an edit. To clear blocks
   * or attachments, pass `[]`; omitting them leaves them as they were. For Slack's raw reply (`message`), call
   * `api("chat.update", …)` directly.
   */
  async edit(messageId, m) {
    await this.api("chat.update", { ...this.body(m), ts: messageId });
    return this.sent(messageId, m);
  }
  /**
   * One message by ts, read cheaply (`conversations.replies`, `limit: 1`): a thread parent or top-level message, with
   * its reactions and reply count. Null if it's gone.
   */
  async message(ts) {
    let result;
    try {
      result = await this.api("conversations.replies", { channel: this.channel, ts, limit: 1, include_all_metadata: true }, { get: true });
    } catch (e) {
      if (e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found")) return null;
      throw e;
    }
    const raw = (result["messages"] ?? [])[0];
    if (!raw || raw.ts !== ts) return null;
    return this.toMessage(raw, await this.botIds());
  }
  /** How many replies a thread has (0 for a message without one). Needs a history scope on this token. */
  async replyCount(ts) {
    const result = await this.api("conversations.replies", { channel: this.channel, ts }, { get: true });
    const messages = result["messages"] ?? [];
    return messages[0]?.reply_count ?? Math.max(0, messages.length - 1);
  }
  /**
   * Delete a message. Unless `orphansOk`, first refuses (`OrphanedRepliesError`) if it has thread replies, which
   * needs a history scope on this token: with a token that only has `chat:write`, check `replyCount` with another
   * client first and pass `orphansOk`.
   */
  async delete(messageId, options = {}) {
    if (!options.orphansOk) {
      let replies;
      try {
        replies = await this.replyCount(messageId);
      } catch (e) {
        if (e instanceof SlackApiError && e.code === "missing_scope") {
          throw new Error(
            "delete: the orphaned-replies check (conversations.replies) needs a history scope on this token; check replyCount() with a client that has one, then pass { orphansOk: true }",
            { cause: e }
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
      ts: messageId
    });
  }
  /** A message only `user` sees; returns its `message_ts`. Ephemerals can't be read back, so nothing is stamped. */
  async postEphemeral(user, m, options = {}) {
    const { metadata: _metadata, ...msg } = toMsg(m);
    const data = { ...this.body({ ...msg, stamp: false }), user };
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
  async cachedUser(key, load, fresh = false) {
    const { users, loading } = this.shared;
    const hit = users.get(key);
    if (!fresh && hit && hit.expires > this.now()) return hit.value;
    const inflight = loading.get(key);
    if (inflight) return inflight;
    const remember = (value, ttl) => {
      users.delete(key);
      users.set(key, { value, expires: this.now() + ttl });
      const cap = this.options.userCacheSize ?? MAX_CACHED_USERS;
      while (users.size > cap) users.delete(users.keys().next().value);
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
  async userInfo(id, options = {}) {
    return this.cachedUser(
      `id:${id}`,
      async () => toUser((await this.api("users.info", { user: id }, { get: true }))["user"]),
      options.fresh
    );
  }
  /** A user by email (`users.lookupByEmail`, needs `users:read.email`), cached; null if none. */
  async userByEmail(email, options = {}) {
    const normalized = email.trim().toLowerCase();
    return this.cachedUser(
      `email:${normalized}`,
      async () => toUser((await this.api("users.lookupByEmail", { email: normalized }, { get: true }))["user"]),
      options.fresh
    );
  }
  /** A user group's member ids, by id (`S…`) or handle (`@eng-leads` / `eng-leads`). */
  async usergroupMembers(idOrHandle) {
    let id = idOrHandle.replace(/^@/, "");
    if (!/^S[A-Z0-9]+$/.test(id)) {
      const groups = (await this.api("usergroups.list", {}, { get: true }))["usergroups"] ?? [];
      const group = groups.find((g) => g.handle === id);
      if (!group) throw new SlackApiError("usergroups.list", "no_such_subteam", 200);
      id = group.id;
    }
    return (await this.api("usergroups.users.list", { usergroup: id }, { get: true }))["users"] ?? [];
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
   * A sender that looks like a user (by id or email): their display/real name and Slack photo. Pair with `/avatar`'s `badgedSvg` to
   * mark the post as automated. Null for an unknown user (or a deactivated one, unless `includeDeleted`).
   */
  async senderFor(userIdOrEmail, options = {}) {
    const user = userIdOrEmail.includes("@") ? await this.userByEmail(userIdOrEmail) : await this.userInfo(userIdOrEmail);
    if (!user || user.deleted && !options.includeDeleted) return null;
    const name = user.displayName ?? user.realName ?? user.name;
    const sender = { username: [...`${name}${options.suffix ?? ""}`].slice(0, USERNAME_MAX).join("") };
    const icon = options.iconUrl ?? (options.imageSize ? user.images[options.imageSize] : void 0) ?? user.image;
    if (icon) sender.iconUrl = icon;
    return sender;
  }
  /**
   * A channel's id from `#name`, `name` or an id (returned as-is), via `conversations.list`, cached for
   * `CHANNEL_TTL_MS`. `refresh` re-lists now; `includeArchived` also matches archived channels.
   */
  async channelId(nameOrId, options = {}) {
    const name = nameOrId.replace(/^#/, "");
    if (CHANNEL_ID.test(name)) return name;
    const archived = options.includeArchived ?? false;
    const cached = this.shared.channels;
    if (options.refresh || !cached || cached.expires <= this.now() || cached.archived !== archived) {
      const value = (async () => {
        const map = /* @__PURE__ */ new Map();
        for await (const c of this.paginate(
          "conversations.list",
          { types: "public_channel,private_channel", exclude_archived: !archived, limit: 1e3 },
          "channels",
          { get: true }
        )) {
          map.set(c.name, c.id);
        }
        return map;
      })();
      this.shared.channels = { value, expires: this.now() + CHANNEL_TTL_MS, archived };
    }
    let channels;
    try {
      channels = await this.shared.channels.value;
    } catch (e) {
      delete this.shared.channels;
      throw e;
    }
    const id = channels.get(name);
    if (id === void 0) throw new SlackApiError("conversations.list", "channel_not_found", 200);
    return id;
  }
  /** Forget cached channel names (after archiving / re-creating one). */
  invalidateChannels() {
    delete this.shared.channels;
  }
  /** The DM (one user) or group DM (several) channel id, opening it if needed. */
  async openDm(users) {
    const result = await this.api("conversations.open", { users: [].concat(users).join(",") });
    return result["channel"].id;
  }
  /** Open a modal (`views.open`); returns the view, whose `id`/`hash` `updateView` takes. */
  async openView(triggerId, view, options = {}) {
    return (await this.api("views.open", { trigger_id: triggerId, view }, options))["view"];
  }
  async pushView(triggerId, view, options = {}) {
    return (await this.api("views.push", { trigger_id: triggerId, view }, options))["view"];
  }
  /** Update a modal by `viewId` or `externalId`; pass the last-seen `hash` to refuse a stale overwrite. */
  async updateView(view, target, options = {}) {
    const data = { view };
    if (target.viewId !== void 0) data["view_id"] = target.viewId;
    if (target.externalId !== void 0) data["external_id"] = target.externalId;
    if (target.hash !== void 0) data["hash"] = target.hash;
    return (await this.api("views.update", data, options))["view"];
  }
  /** Publish a user's App Home tab. */
  async publishHome(userId, view) {
    await this.api("views.publish", { user_id: userId, view });
  }
  async sync(thread, options = {}) {
    const { threadTs, suppressUnfurls, ...rest } = options;
    const prior = this.unfurl;
    if (suppressUnfurls !== void 0) this.unfurl = !suppressUnfurls;
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

export {
  SLACK_API,
  SlackApiError,
  NON_IDEMPOTENT,
  slackCall,
  slackApi,
  paginate,
  collect,
  defaultBullet,
  splitBody,
  buildDetailMessages,
  buildSummaryMessages,
  SLACK_MESSAGE_LIMIT,
  USERNAME_MAX,
  USER_TTL_MS,
  NOT_FOUND_TTL_MS,
  MAX_CACHED_USERS,
  CHANNEL_TTL_MS,
  webClientTransport,
  SlackClient
};
//# sourceMappingURL=chunk-LITWYH3J.js.map