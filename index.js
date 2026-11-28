import {
  CHANNEL_TTL_MS,
  CustomSenderFilesError,
  FILE_HASHES,
  FileNotProcessedError,
  FileSwapError,
  FilesNotAttachedError,
  MAX_CACHED_USERS,
  NON_IDEMPOTENT,
  NOT_FOUND_TTL_MS,
  SLACK_API,
  SLACK_BLOCKS_LIMIT,
  SLACK_MESSAGE_LIMIT,
  SLACK_SECTION_LIMIT,
  SlackApiError,
  SlackClient,
  USERNAME_MAX,
  USER_TTL_MS,
  assertFilesAttachable,
  attachedFiles,
  buildDetailMessages,
  buildSummaryMessages,
  codePoints,
  collect,
  defaultBullet,
  definitelyNotAttached,
  fallbackText,
  isProcessed,
  paginate,
  sectionBlocks,
  senderOverrides,
  slackApi,
  slackCall,
  splitBody,
  swapFiles,
  toBytes,
  webClientTransport,
  withFiles
} from "./chunk-OVMSNX65.js";
import {
  EditRateLimited,
  OrphanedRepliesError,
  THRDS_HASH,
  contentKey,
  isRich,
  msgHash,
  sync,
  toMsg
} from "./chunk-OY4HFIJO.js";
import {
  hash53,
  hash53Bytes,
  stableStringify
} from "./chunk-3ZH5IQC7.js";
import {
  DEFAULT_BATCH,
  DEFAULT_PACE_MS,
  PLAN_VERSION,
  POST_SUBTYPES,
  REWRITE_KINDS,
  REWRITE_STATUSES,
  applyOrder,
  contentHash,
  contentOf,
  describeSender,
  foundOf,
  isOverride,
  lineDiff,
  memoryReceipts,
  parsePlan,
  planCounts,
  postRewrite,
  postedOf,
  pyJsonDumps,
  sameContent,
  sameSender,
  senderChanged,
  senderOf,
  substitute,
  verifyPlan,
  writes,
  writesSummary
} from "./chunk-STZYHR2L.js";

// src/mrkdwn.ts
var escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function link(url, label) {
  const href = url.replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E");
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
function bound(text, max, options = {}) {
  const { ellipsis = "\u2026", atLine = false } = typeof options === "string" ? { ellipsis: options } : options;
  const chars = [...text];
  if (chars.length <= max) return text;
  if (atLine) {
    const tail = `
${ellipsis}`;
    const room = Math.max(0, max - [...tail].length);
    const cut = chars.slice(0, room).join("").lastIndexOf("\n");
    if (cut >= 0 && [...text.slice(0, cut)].length >= room / 2) return text.slice(0, cut) + tail;
  }
  const keep2 = Math.max(0, max - [...ellipsis].length);
  return chars.slice(0, keep2).join("") + ellipsis;
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
  else if ("slackFile" in src) block["slack_file"] = { id: src.slackFile };
  else block["slack_file"] = { url: src.slackFileUrl };
  if (title) block["title"] = plainText(title);
  return block;
}
function versionedUrl(url, version, param = "v") {
  const u = new URL(url);
  u.searchParams.set(param, String(version));
  return u.toString();
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
var PRIVATE_METADATA_MAX = 3e3;
var fitsPrivateMetadata = (value) => JSON.stringify(value).length <= PRIVATE_METADATA_MAX;
function encodePrivateMetadata(value) {
  const s = JSON.stringify(value);
  if (s.length > PRIVATE_METADATA_MAX) throw new RangeError(`private_metadata is ${s.length} chars; Slack's limit is ${PRIVATE_METADATA_MAX}`);
  return s;
}
function decodePrivateMetadata(s) {
  if (!s) return null;
  return JSON.parse(s);
}
function withoutImages(msg) {
  if (!msg.blocks) return msg;
  const blocks = msg.blocks.filter((b) => b["type"] !== "image").map((b) => {
    const block = b;
    const accessory = block["accessory"];
    if (accessory?.["type"] !== "image") return block;
    const { accessory: _accessory, ...rest } = block;
    return rest;
  });
  return { ...msg, blocks };
}
var option = (text, value) => ({ text: plainText(text), value });
function input(options) {
  const block = { type: "input", label: plainText(options.label), element: options.element };
  if (options.blockId !== void 0) block["block_id"] = options.blockId;
  if (options.optional) block["optional"] = true;
  if (options.hint !== void 0) block["hint"] = plainText(options.hint);
  if (options.dispatchAction) block["dispatch_action"] = true;
  return block;
}
function plainTextInput(options) {
  const el = { type: "plain_text_input", action_id: options.actionId };
  if (options.multiline) el["multiline"] = true;
  if (options.initial !== void 0) el["initial_value"] = options.initial;
  if (options.placeholder !== void 0) el["placeholder"] = plainText(options.placeholder);
  if (options.maxLength !== void 0) el["max_length"] = options.maxLength;
  return el;
}
function staticSelect(options) {
  const opts = options.options.map(([t, v]) => option(t, v));
  const el = { type: options.multi ? "multi_static_select" : "static_select", action_id: options.actionId, options: opts };
  if (options.placeholder !== void 0) el["placeholder"] = plainText(options.placeholder);
  if (options.initial !== void 0) {
    const chosen = [].concat(options.initial);
    const picked = opts.filter((o) => chosen.includes(o["value"]));
    if (options.multi) el["initial_options"] = picked;
    else if (picked[0]) el["initial_option"] = picked[0];
  }
  return el;
}
function usersSelect(options) {
  const el = { type: "users_select", action_id: options.actionId };
  if (options.initial !== void 0) el["initial_user"] = options.initial;
  if (options.placeholder !== void 0) el["placeholder"] = plainText(options.placeholder);
  return el;
}
function datePicker(options) {
  const el = { type: "datepicker", action_id: options.actionId };
  if (options.initial !== void 0) el["initial_date"] = options.initial;
  if (options.placeholder !== void 0) el["placeholder"] = plainText(options.placeholder);
  return el;
}
function modal(options) {
  const view = { type: "modal", title: plainText(bound(options.title, 24)), blocks: options.blocks };
  if (options.submit !== void 0) view["submit"] = plainText(options.submit);
  if (options.close !== void 0) view["close"] = plainText(options.close);
  if (options.callbackId !== void 0) view["callback_id"] = options.callbackId;
  if (options.privateMetadata !== void 0) view["private_metadata"] = options.privateMetadata;
  if (options.externalId !== void 0) view["external_id"] = options.externalId;
  return view;
}
var rich = {
  /** The `rich_text` block. */
  block: (...elements) => ({ type: "rich_text", elements }),
  /** A paragraph of inline elements (strings become plain text). */
  section: (...elements) => ({
    type: "rich_text_section",
    elements: elements.map((e) => typeof e === "string" ? rich.text(e) : e)
  }),
  /** A bullet (or numbered) list of sections. */
  list: (items, options = {}) => {
    const block = { type: "rich_text_list", style: options.style ?? "bullet", elements: items };
    if (options.indent) block["indent"] = options.indent;
    return block;
  },
  quote: (...elements) => ({
    type: "rich_text_quote",
    elements: elements.map((e) => typeof e === "string" ? rich.text(e) : e)
  }),
  preformatted: (text) => ({ type: "rich_text_preformatted", elements: [rich.text(text)] }),
  text: (text, style) => style ? { type: "text", text, style } : { type: "text", text },
  link: (url, text, style) => {
    const el = { type: "link", url };
    if (text !== void 0) el["text"] = text;
    if (style) el["style"] = style;
    return el;
  },
  /** An emoji by name (`"star"`, not `":star:"`). */
  emoji: (name) => ({ type: "emoji", name: name.replace(/^:|:$/g, "") }),
  user: (id) => ({ type: "user", user_id: id }),
  channel: (id) => ({ type: "channel", channel_id: id }),
  date: (tsS, format, fallback) => {
    const el = { type: "date", timestamp: Math.floor(tsS), format };
    if (fallback !== void 0) el["fallback"] = fallback;
    return el;
  }
};

// src/permalink.ts
var tsOf = (p) => `${p.slice(0, -6)}.${p.slice(-6)}`;
function parsePermalink(url) {
  let u;
  const cleaned = url.trim().replace(/&amp;/g, "&").replace(/[.,;:!?)\]}>'"]+$/, "");
  try {
    u = new URL(cleaned);
  } catch {
    return null;
  }
  if (!/(^|\.)slack(-gov)?\.com$/.test(u.hostname)) return null;
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
var PERMALINK_IN_TEXT = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|https?:\/\/[^\s<>|]+/g;
var TRAILING = /[.,;:!?)\]}'"]+$/;
function permalinksIn(text) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(PERMALINK_IN_TEXT)) {
    const url = m[1] ?? m[0].replace(TRAILING, "");
    const ref = parsePermalink(url);
    if (!ref) continue;
    const id = `${ref.channel}/${ref.ts}/${ref.threadTs ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...ref, url });
  }
  return out;
}
function withoutPermalinks(text) {
  return text.replace(PERMALINK_IN_TEXT, (m, inner) => {
    if (!parsePermalink(inner ?? m)) return m;
    return inner !== void 0 ? "" : TRAILING.exec(m)?.[0] ?? "";
  }).replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").trim();
}

// src/slots.ts
function slotRecord(ts, hash, files, fileHashes) {
  if (files === void 0 || files.length === 0) return { ts, hash };
  const aligned = Array.isArray(fileHashes) && fileHashes.length === files.length && fileHashes.every((h) => typeof h === "string");
  return aligned ? { ts, hash, files, fileHashes } : { ts, hash, files };
}
var fileHashesOf = (m) => m.metadata?.event_payload?.[FILE_HASHES];
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
var REJECTED = /* @__PURE__ */ new Set(["invalid_blocks", "invalid_blocks_format", "invalid_attachments", "msg_too_long", "invalid_metadata_format"]);
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
var partialOf = (e) => e?.partial;
var isRef = (p) => typeof p !== "string" && !("text" in p) && "ts" in p;
var isKeep = (p) => typeof p !== "string" && "keep" in p;
var isGone = (e) => e instanceof SlackApiError && e.code === "message_not_found";
var isThreadGone = (e) => e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found");
var isRejected = (e) => e instanceof SlackApiError && REJECTED.has(e.code);
var ParentGone = class extends Error {
};
var Forgotten = class extends Error {
  constructor(slot) {
    super("forgotten");
    this.slot = slot;
  }
  slot;
};
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function syncSlots(client, store, thread, options = {}) {
  const {
    leaseS,
    pace = 0,
    dryRun = false,
    force = false,
    onGone = "repost",
    recover = "scan",
    recoverWindowS = 120,
    create = true,
    maxReruns = 3,
    now = Date.now,
    sleep = defaultSleep
  } = options;
  const { key } = thread;
  const nowS = () => Math.floor(now() / 1e3);
  const render = async (state2) => "render" in thread ? thread.render(state2) : thread;
  let lease;
  if (leaseS !== void 0 && !dryRun) {
    if (!store.claim) throw new TypeError("syncSlots: `leaseS` needs a store with `claim` (memoryStore, d1Store)");
    const got = await store.claim(key, leaseS, nowS());
    if (got === null) {
      await store.markDirty?.(key);
      return { status: "busy", ts: "", slots: {}, actions: [] };
    }
    lease = got;
  }
  const actions2 = [];
  let state = { slots: {} };
  let parentTs = "";
  let status = "synced";
  let desired = [];
  const result = () => {
    const slots = {};
    if (status === "synced") {
      for (const { slot } of desired) {
        const record = state.slots[slot];
        if (record) slots[slot] = record.ts;
        else if (dryRun) slots[slot] = "<new>";
      }
    }
    return { status, ts: parentTs, slots, actions: actions2 };
  };
  try {
    state = await store.get(key) ?? { slots: {} };
    let unsaved = false;
    const save = async () => {
      if (dryRun) return;
      if (!await store.put(key, state, lease)) throw new LeaseLostError(key);
      unsaved = false;
    };
    let wrote = false;
    const beforeWrite = async () => {
      if (wrote && pace > 0) await sleep(pace * 1e3);
      wrote = true;
      if (lease !== void 0 && store.renew && !await store.renew(key, lease, leaseS, nowS())) throw new LeaseLostError(key);
    };
    const tagged = (m, slot) => m.editable !== false && m.metadata?.event_payload?.[SLOT_KEY] === key && m.metadata.event_payload[SLOT_NAME] === (slot ?? "");
    if (state.channel !== void 0 && state.channel !== client.channel) {
      state = { slots: {} };
      unsaved = true;
    }
    if (state.pending && !dryRun) {
      const { slot, hash, at } = state.pending;
      let found = null;
      if (recover !== "post") {
        const first = await render(state);
        const threadTs = slot === null ? void 0 : isRef(first.parent) ? first.parent.ts : state.parent?.ts;
        try {
          found = slot === null ? await client.find((m) => tagged(m, null), { oldest: String(at - recoverWindowS) }) : threadTs !== void 0 ? await client.find((m) => tagged(m, slot), { threadTs }) : null;
        } catch (e) {
          if (!(e instanceof SlackApiError && e.definite)) throw e;
          if (recover !== "scan-or-post") {
            throw new Error(
              `syncSlots: can't check whether ${key}'s interrupted post landed (${e.code}); grant a history scope (channels:history / groups:history), or pass recover: "scan-or-post"`,
              { cause: e }
            );
          }
          actions2.push({ type: "UNRESOLVED", slot });
        }
      }
      if (found) {
        const stamped = found.metadata?.event_payload?.[THRDS_HASH];
        const live = typeof stamped === "string" ? stamped : hash;
        if (slot === null) state.parent = { ts: found.id, hash: live };
        else state.slots[slot] = { ts: found.id, hash: live };
        actions2.push({ type: "ADOPT", slot, ts: found.id });
      }
      delete state.pending;
      await save();
    }
    const record = (slot, r) => {
      if (slot === null) state.parent = r;
      else state.slots[slot] = r;
    };
    const post = async (msg, slot, threadTs, fallback) => {
      if (dryRun) return { ts: "<new>", fell: false };
      state.channel = client.channel;
      state.pending = { slot, hash: msgHash(msg), at: nowS() };
      await save();
      await beforeWrite();
      let sent = msg;
      let ts;
      try {
        ts = (await client.post(msg, threadTs)).id;
      } catch (e) {
        if (slot !== null && isThreadGone(e)) {
          delete state.pending;
          await save();
          throw new ParentGone();
        }
        if (!(e instanceof SlackApiError && e.definite)) throw e;
        delete state.pending;
        await save();
        if (fallback === void 0 || !isRejected(e)) throw e;
        sent = tagSlot(fallback, key, slot);
        state.pending = { slot, hash: msgHash(sent), at: nowS() };
        await save();
        ts = (await client.post(sent, threadTs)).id;
      }
      record(slot, slotRecord(ts, msgHash(sent), sent.files, fileHashesOf(sent)));
      delete state.pending;
      await save();
      return { ts, fell: sent !== msg };
    };
    const threadGone = async (ts) => {
      try {
        if (client.message) return await client.message(ts) === null;
        await client.list(ts);
        return false;
      } catch (e) {
        if (isThreadGone(e)) return true;
        throw e;
      }
    };
    const reconcile = async (msg, slot, current, mode) => {
      const hash = msgHash(msg);
      if (current === void 0 && mode.editOnly === void 0) {
        const { ts, fell: fell2 } = await post(msg, slot, mode.threadTs, mode.fallback);
        actions2.push({ type: fell2 ? "FALLBACK" : "POST", slot, ts });
        return { ts, reposted: false };
      }
      const target = current ?? { ts: mode.editOnly, hash: "" };
      if (mode.keep || !force && target.hash === hash) {
        actions2.push({ type: "SKIP", slot, ts: target.ts });
        return { ts: target.ts, reposted: false };
      }
      if (dryRun) {
        actions2.push({ type: "EDIT", slot, ts: target.ts });
        return { ts: target.ts, reposted: false };
      }
      let sentHash = hash;
      let sentFiles = msg.files;
      let sentFileHashes = fileHashesOf(msg);
      let fell = false;
      try {
        await beforeWrite();
        try {
          await client.edit(target.ts, msg);
        } catch (e) {
          if (mode.fallback === void 0 || !isRejected(e)) throw e;
          const fb = tagSlot(mode.fallback, key, slot);
          await client.edit(target.ts, fb);
          sentHash = msgHash(fb);
          sentFiles = fb.files;
          sentFileHashes = fileHashesOf(fb);
          fell = true;
        }
      } catch (e) {
        if (!isGone(e)) throw e;
        if (slot !== null && mode.threadTs !== void 0 && await threadGone(mode.threadTs)) throw new ParentGone();
        if (onGone === "forget") {
          if (slot === null) state = { slots: {} };
          else delete state.slots[slot];
          unsaved = true;
          actions2.push({ type: "GONE", slot });
          throw new Forgotten(slot);
        }
        if (onGone === "throw" || mode.editOnly !== void 0) throw e;
        const { ts, fell: refell } = await post(msg, slot, mode.threadTs, mode.fallback);
        actions2.push({ type: refell ? "FALLBACK" : "REPOST", slot, ts });
        return { ts, reposted: true };
      }
      record(
        slot,
        sentFiles !== void 0 ? slotRecord(target.ts, sentHash, sentFiles, sentFileHashes) : slotRecord(target.ts, sentHash, current?.files, current?.fileHashes)
      );
      state.channel = client.channel;
      unsaved = true;
      actions2.push({ type: fell ? "FALLBACK" : "EDIT", slot, ts: target.ts });
      return { ts: target.ts, reposted: false };
    };
    const pass = async (spec) => {
      desired = spec.slots ?? [];
      const names = /* @__PURE__ */ new Set();
      for (const { slot } of desired) {
        if (names.has(slot)) throw new TypeError(`syncSlots: duplicate slot ${JSON.stringify(slot)}`);
        names.add(slot);
      }
      const parentFallback = spec.parentFallback !== void 0 ? { fallback: spec.parentFallback } : {};
      const start = actions2.length;
      for (let attempt = 0; ; attempt++) {
        try {
          const parent = spec.parent;
          if (isRef(parent)) {
            parentTs = parent.ts;
            if ("msg" in parent) {
              await reconcile(tagSlot(parent.msg, key, null), null, state.parent, { editOnly: parent.ts, ...parentFallback });
            } else if (state.channel === void 0 && !dryRun) {
              state.channel = client.channel;
              unsaved = true;
            }
          } else {
            if (state.parent === void 0 && !create) {
              status = "missing";
              parentTs = "";
              return;
            }
            const keep2 = isKeep(parent);
            const r = await reconcile(tagSlot(keep2 ? parent.keep : parent, key, null), null, state.parent, { keep: keep2, ...parentFallback });
            parentTs = r.ts;
            if (attempt > 0) actions2[start].type = "REPOST";
            if (r.reposted) {
              state.slots = {};
              unsaved = true;
            }
          }
          for (const { slot, msg, fallback } of desired) {
            try {
              await reconcile(tagSlot(msg, key, slot), slot, state.slots[slot], {
                threadTs: parentTs,
                ...fallback !== void 0 ? { fallback } : {}
              });
            } catch (e) {
              if (!(e instanceof Forgotten)) throw e;
            }
          }
          break;
        } catch (e) {
          if (e instanceof Forgotten) {
            status = "gone";
            parentTs = "";
            return;
          }
          if (!(e instanceof ParentGone)) throw e;
          if (onGone === "forget") {
            state = { slots: {} };
            unsaved = true;
            actions2.push({ type: "GONE", slot: null });
            status = "gone";
            parentTs = "";
            return;
          }
          if (isRef(spec.parent) || onGone === "throw" || attempt > 0) {
            throw new SlackApiError("conversations.replies", "thread_not_found", 200);
          }
          actions2.length = start;
          delete state.parent;
          state.slots = {};
          await save();
        }
      }
      if (spec.prune) {
        for (const [slot, r] of Object.entries(state.slots)) {
          if (names.has(slot)) continue;
          actions2.push({ type: "DELETE", slot, ts: r.ts });
          if (dryRun) continue;
          await beforeWrite();
          try {
            await client.delete(r.ts, { orphansOk: true });
          } catch (e) {
            if (!isGone(e)) throw e;
          }
          delete state.slots[slot];
          unsaved = true;
        }
      }
    };
    try {
      await pass(await render(state));
      for (let rerun = 0; lease !== void 0 && rerun < maxReruns && await store.takeDirty?.(key, lease); rerun++) {
        if (unsaved) await save();
        await pass(await render(state));
      }
      if (unsaved) await save();
    } catch (e) {
      if (unsaved && !(e instanceof LeaseLostError)) await save().catch(() => void 0);
      throw e;
    }
    return result();
  } catch (e) {
    if (e !== null && typeof e === "object") Object.assign(e, { partial: result() });
    throw e;
  } finally {
    if (lease !== void 0) await store.release?.(key, lease);
  }
}
async function upsert(client, store, key, msg, options = {}) {
  const { ts, ...rest } = options;
  const parent = ts !== void 0 ? { ts, msg } : msg;
  const result = await syncSlots(client, store, { key, parent }, rest);
  return { status: result.status, ts: result.ts, action: result.actions.at(-1)?.type ?? null };
}
async function upsertFiles(client, store, key, msg, files, options = {}) {
  if (files.length > 0) assertFilesAttachable(senderOverrides(toMsg(msg), client));
  const { concurrency, ...upsertOptions } = options;
  const record = (await store.get(key))?.parent;
  if (record === void 0 && options.create === false && options.ts === void 0) {
    return { ...await upsert(client, store, key, msg, upsertOptions), fileIds: [], uploaded: [], deleted: [], undeleted: [] };
  }
  const previous = (record?.files ?? []).map((id, i) => {
    const hash = record?.fileHashes?.[i];
    return hash === void 0 ? { id } : { id, hash };
  });
  const desired = await Promise.all(
    files.map(async ({ name, data, ...uploadOptions }) => {
      const bytes = await toBytes(data);
      return { hash: hash53Bytes(bytes), upload: () => client.upload(name, bytes, uploadOptions) };
    })
  );
  const hashes = desired.map((d) => d.hash);
  const { result, ...swap } = await swapFiles(
    client,
    previous,
    desired,
    (ids) => upsert(client, store, key, withFiles(msg, ids, hashes), upsertOptions),
    concurrency !== void 0 ? { concurrency } : {}
  );
  return { ...result, ...swap };
}
async function upsertFile(client, store, key, msg, file, options = {}) {
  const r = await upsertFiles(client, store, key, msg, [file], options);
  return { ...r, fileId: r.fileIds[0] ?? null };
}
async function importAnchor(store, key, anchor) {
  const state = { slots: {} };
  if (anchor.channel !== void 0) state.channel = anchor.channel;
  if (anchor.parent !== void 0) state.parent = { ts: anchor.parent, hash: "" };
  for (const [slot, ts] of Object.entries(anchor.slots ?? {})) state.slots[slot] = { ts, hash: "" };
  await store.put(key, state);
}
var newLease = () => globalThis.crypto.randomUUID();
function memoryStore(initial = {}) {
  const states = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const leases = /* @__PURE__ */ new Map();
  const dirty = /* @__PURE__ */ new Set();
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
    async renew(key, lease, leaseS, nowS) {
      const held = leases.get(key);
      if (held?.token !== lease) return false;
      held.until = nowS + leaseS;
      return true;
    },
    async release(key, lease) {
      if (leases.get(key)?.token === lease) leases.delete(key);
    },
    async markDirty(key) {
      dirty.add(key);
    },
    async takeDirty(key, lease) {
      if (leases.get(key)?.token !== lease) return false;
      return dirty.delete(key);
    },
    dump() {
      return Object.fromEntries([...states].map(([k, v]) => [k, JSON.parse(v)]));
    }
  };
}
function oneKeyStore(io) {
  return {
    async get() {
      return io.get();
    },
    async put(_key, state) {
      return await io.put(state) !== false;
    }
  };
}
function threadStore(client, threadTs) {
  return {
    async get(key) {
      let messages;
      try {
        messages = await client.list(threadTs);
      } catch (e) {
        if (isThreadGone(e)) return void 0;
        throw e;
      }
      const state = { slots: {} };
      for (const m of messages) {
        const payload = m.metadata?.event_payload;
        if (!payload || payload[SLOT_KEY] !== key || !m.editable) continue;
        const stamped = payload[THRDS_HASH];
        const r = { ts: m.id, hash: typeof stamped === "string" ? stamped : "" };
        const slot = payload[SLOT_NAME];
        if (slot === "") state.parent = r;
        else if (typeof slot === "string" && !(slot in state.slots)) state.slots[slot] = r;
      }
      return state;
    },
    async put() {
      return true;
    }
  };
}

// src/rewrite-slack.ts
function sendable(text, blocks) {
  const n = codePoints(text);
  if (n <= SLACK_MESSAGE_LIMIT) return { text, blocks };
  if (blocks !== null && blocks.length > 0) return { text: fallbackText(text), blocks };
  const sections = sectionBlocks(text, { lines: true });
  if (sections.length > SLACK_BLOCKS_LIMIT) {
    throw new Error(`new text is ${n} chars, ${sections.length} sections over Slack's ${SLACK_BLOCKS_LIMIT} blocks`);
  }
  return { text: fallbackText(text), blocks: sections };
}
var keep = (f, includeForeign) => includeForeign || f.ours && POST_SUBTYPES.includes(f.subtype);
async function newestTopLevel(client, channel) {
  const r = await client.api("conversations.history", { channel, limit: 1 }, { get: true });
  const messages = r["messages"] ?? [];
  return messages[0]?.ts ?? null;
}
async function threadRaw(client, channel, threadTs) {
  const out = [];
  for await (const m of client.paginate(
    "conversations.replies",
    { channel, ts: threadTs, include_all_metadata: true, limit: 200 },
    "messages",
    { get: true }
  )) out.push(m);
  return out;
}
async function threadReplies(client, channel, threadTs, ids) {
  const replies = (await threadRaw(client, channel, threadTs)).filter((r) => r.ts !== threadTs);
  const last = replies.at(-1)?.ts;
  return replies.map((r) => foundOf(r, channel, ids, r.ts === last));
}
async function findHistory(client, options = {}) {
  const channel = options.channel ?? client.channel;
  const includeForeign = options.includeForeign ?? false;
  const ids = await client.botIds();
  const params = { channel, include_all_metadata: true, limit: 200 };
  if (options.oldest !== void 0) params["oldest"] = options.oldest;
  if (options.latest !== void 0) params["latest"] = options.latest;
  let newest;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for await (const m of client.paginate("conversations.history", params, "messages", { get: true })) {
    if (newest === void 0) newest = options.latest === void 0 ? m.ts : await newestTopLevel(client, channel);
    if (!seen.has(m.ts)) {
      seen.add(m.ts);
      const f = foundOf(m, channel, ids, m.ts === newest);
      if (keep(f, includeForeign)) out.push(f);
    }
    if (options.includeReplies && typeof m["reply_count"] === "number" && m["reply_count"] > 0) {
      for (const f of await threadReplies(client, channel, m.ts, ids)) {
        if (!seen.has(f.ts) && keep(f, includeForeign)) out.push(f);
        seen.add(f.ts);
      }
    }
  }
  return out;
}
async function findThread(client, threadTs, options = {}) {
  const channel = options.channel ?? client.channel;
  const includeForeign = options.includeForeign ?? false;
  const ids = await client.botIds();
  const raw = await threadRaw(client, channel, threadTs);
  const out = [];
  if (raw[0]?.ts === threadTs) {
    const parent = foundOf(raw[0], channel, ids, await newestTopLevel(client, channel) === threadTs);
    if (keep(parent, includeForeign)) out.push(parent);
  }
  const last = raw.filter((r) => r.ts !== threadTs).at(-1)?.ts;
  for (const r of raw) {
    if (r.ts === threadTs) continue;
    const f = foundOf(r, channel, ids, r.ts === last);
    if (keep(f, includeForeign)) out.push(f);
  }
  return out;
}
async function readMessage(client, channel, ts) {
  let r;
  try {
    r = await client.api("conversations.replies", { channel, ts, limit: 1, include_all_metadata: true }, { get: true });
  } catch (e) {
    if (e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found")) return null;
    throw e;
  }
  const m = (r["messages"] ?? [])[0];
  return m !== void 0 && m.ts === ts ? m : null;
}
async function isLast(client, channel, ts, threadTs) {
  if (threadTs === null) return await newestTopLevel(client, channel) === ts;
  const replies = (await threadRaw(client, channel, threadTs)).filter((r) => r.ts !== threadTs);
  return replies.at(-1)?.ts === ts;
}
async function findIds(client, tss, options = {}) {
  const channel = options.channel ?? client.channel;
  const ids = await client.botIds();
  const out = [];
  for (const ts of tss) {
    const m = await readMessage(client, channel, ts);
    if (m === null) throw new Error(`no message ${ts} in ${channel}`);
    const parent = m["thread_ts"];
    const threadTs = typeof parent === "string" && parent !== ts ? parent : null;
    out.push(foundOf(m, channel, ids, await isLast(client, channel, ts, threadTs)));
  }
  return out;
}
var NO_SENDER = { username: null, icon_url: null, icon_emoji: null };
var TS_SHAPED = /^\d+\.\d+$/;
async function postActions(posts, taken) {
  const out = [];
  const counts = /* @__PURE__ */ new Map();
  for (const p of posts) {
    const sender = p.desired.sender ?? { ...NO_SENDER };
    let kind = "post";
    let reason = null;
    let next;
    try {
      next = { ...sendable(p.desired.text, p.desired.blocks ?? null), sender, files: [] };
    } catch (e) {
      next = { text: p.desired.text, blocks: p.desired.blocks ?? null, sender, files: [] };
      kind = "blocked";
      reason = e.message;
    }
    const hash = await contentHash(next);
    let key = p.key;
    if (key === void 0) {
      const stem = `post-${hash}`;
      const n = (counts.get(stem) ?? 0) + 1;
      counts.set(stem, n);
      key = n === 1 ? stem : `${stem}-${n}`;
    }
    if (TS_SHAPED.test(key)) throw new Error(`post key '${key}' looks like a message ts`);
    if (taken.has(key)) throw new Error(`post key '${key}' is already an id in the plan`);
    taken.add(key);
    const a = { kind, channel: p.channel, ts: key, thread_ts: p.threadTs, hash, old: null, new: next, reason };
    if (p.broadcast && p.threadTs !== null) a.broadcast = true;
    if (p.metadata !== void 0 && p.metadata !== null) a.metadata = p.metadata;
    out.push(a);
  }
  return out;
}
async function plan(found, render, options = {}) {
  const actions2 = [];
  for (const f of found) {
    const hash = await contentHash(f.content);
    const action = (kind, extra = {}) => {
      const a = {
        kind,
        channel: f.channel,
        ts: f.ts,
        thread_ts: f.threadTs,
        hash,
        old: f.content,
        new: extra.new ?? null,
        reason: extra.reason ?? null
      };
      if (f.subtype === "thread_broadcast") a.broadcast = true;
      if (extra.metadata !== void 0 && extra.metadata !== null) a.metadata = extra.metadata;
      return a;
    };
    if (!f.ours) {
      actions2.push(action("blocked", { reason: "another app's or a person's message" }));
      continue;
    }
    if (!POST_SUBTYPES.includes(f.subtype)) {
      actions2.push(action("blocked", { reason: `a ${f.subtype} message` }));
      continue;
    }
    const r = await render(f);
    if ("skip" in r) {
      actions2.push(action("skip", { reason: r.skip }));
      continue;
    }
    if ("delete" in r) {
      if (f.replyCount > 0) actions2.push(action("blocked", { reason: `a delete would orphan its ${f.replyCount} replies` }));
      else actions2.push(action("delete", r.reason === void 0 || r.reason === null ? {} : { reason: r.reason }));
      continue;
    }
    const sender = r.sender ?? f.content.sender;
    let sent;
    try {
      sent = sendable(r.text, r.blocks ?? null);
    } catch (e) {
      const asRendered = { text: r.text, blocks: r.blocks ?? null, sender, files: f.content.files };
      actions2.push(action("blocked", { new: asRendered, reason: e.message }));
      continue;
    }
    const next = { ...sent, sender, files: f.content.files };
    if (sameContent(f.content, next)) {
      actions2.push(action("noop", { new: next }));
      continue;
    }
    if (sameSender(next.sender, f.content.sender)) {
      actions2.push(action("edit", { new: next }));
      continue;
    }
    const where = f.threadTs === null ? "channel" : "thread";
    let reason = null;
    if (f.replyCount > 0) reason = `the sender changes, and a repost would orphan its ${f.replyCount} replies`;
    else if (!f.last && !options.reorderOk) reason = `the sender changes, and a repost would move it to the end of its ${where}`;
    else if (next.files.length > 0 && isOverride(next.sender)) reason = "the sender changes to an override, and Slack shows no files on those";
    actions2.push(reason === null ? action("repost", { new: next, metadata: f.metadata }) : action("blocked", { new: next, reason }));
  }
  actions2.push(...await postActions(options.posts ?? [], new Set(actions2.map((a) => a.ts))));
  return {
    thrds_rewrite_plan: PLAN_VERSION,
    ...options.deleteAfterPosts ? { delete_after_posts: true } : {},
    ...options.atomic ? { atomic: true } : {},
    actions: actions2
  };
}
var defaultSleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
function updatePayload(a, next) {
  return { channel: a.channel, ts: a.ts, text: next.text, blocks: next.blocks ?? [] };
}
function postPayload(a, next) {
  const data = { channel: a.channel, text: next.text, unfurl_links: false, unfurl_media: false };
  if (next.blocks && next.blocks.length > 0) data["blocks"] = next.blocks;
  if (a.thread_ts !== null) {
    data["thread_ts"] = a.thread_ts;
    if (a.broadcast) data["reply_broadcast"] = true;
  }
  const s = next.sender;
  if (s.username !== null) data["username"] = s.username;
  if (s.icon_url !== null) data["icon_url"] = s.icon_url;
  else if (s.icon_emoji !== null) data["icon_emoji"] = s.icon_emoji;
  if (a.metadata !== void 0 && a.metadata !== null) data["metadata"] = a.metadata;
  return data;
}
var outcome = (a, status, extra = {}) => ({
  ts: a.ts,
  kind: a.kind,
  status,
  ...extra
});
var errorCode = (e) => e instanceof SlackApiError ? e.code : e instanceof Error ? e.message : String(e);
var overrideOnUserToken = (client, a) => a.new !== null && isOverride(a.new.sender) && client.token.startsWith("xoxp-");
async function applyPost(client, a, dryRun) {
  const next = a.new;
  if (await contentHash(next) !== a.hash) return outcome(a, "failed", { error: "the plan's hash doesn't match its new content" });
  if (a.thread_ts !== null && await readMessage(client, a.channel, a.thread_ts) === null) {
    return outcome(a, "gone", { error: `its thread ${a.thread_ts} is gone` });
  }
  if (overrideOnUserToken(client, a)) return outcome(a, "failed", { error: "a sender override needs a bot token (xoxb-\u2026)" });
  if (dryRun) return outcome(a, "pending");
  try {
    const posted = await client.api("chat.postMessage", postPayload(a, next));
    return outcome(a, "done", { new_ts: posted["ts"] });
  } catch (e) {
    return outcome(a, "failed", { error: errorCode(e) });
  }
}
async function applyDelete(client, a, dryRun) {
  const old = a.old;
  if (await contentHash(old) !== a.hash) return outcome(a, "failed", { error: "the plan's hash doesn't match its old content" });
  const m = await readMessage(client, a.channel, a.ts);
  if (m === null) return outcome(a, "gone");
  if (await contentHash(contentOf(m)) !== a.hash) return outcome(a, "stale", { error: "changed since planning" });
  const replies = typeof m["reply_count"] === "number" ? m["reply_count"] : 0;
  if (replies > 0) return outcome(a, "stale", { error: `now has ${replies} replies` });
  if (dryRun) return outcome(a, "pending");
  try {
    await client.api("chat.delete", { channel: a.channel, ts: a.ts });
  } catch (e) {
    if (e instanceof SlackApiError && e.code === "message_not_found") return outcome(a, "gone");
    return outcome(a, "failed", { error: errorCode(e) });
  }
  return outcome(a, "done");
}
async function applyOne(client, a, dryRun) {
  if (a.kind === "post") return applyPost(client, a, dryRun);
  if (a.kind === "delete") return applyDelete(client, a, dryRun);
  const next = a.new;
  if (await contentHash(a.old) !== a.hash) return outcome(a, "failed", { error: "the plan's hash doesn't match its old content" });
  const m = await readMessage(client, a.channel, a.ts);
  if (m === null) return outcome(a, "gone");
  const live = contentOf(m);
  if (sameContent(live, next)) return outcome(a, "already");
  if (await contentHash(live) !== a.hash) return outcome(a, "stale", { error: "changed since planning" });
  if (a.kind === "repost") {
    const replies = typeof m["reply_count"] === "number" ? m["reply_count"] : 0;
    if (replies > 0) return outcome(a, "stale", { error: `now has ${replies} replies` });
    if (!await isLast(client, a.channel, a.ts, a.thread_ts)) return outcome(a, "stale", { error: "no longer the newest; a repost would move it" });
    if (overrideOnUserToken(client, a)) return outcome(a, "failed", { error: "a sender override needs a bot token (xoxb-\u2026)" });
  }
  if (dryRun) return outcome(a, "pending");
  let newTs;
  try {
    if (a.kind === "edit") {
      await client.api("chat.update", updatePayload(a, next));
      return outcome(a, "done");
    }
    newTs = (await client.api("chat.postMessage", postPayload(a, next)))["ts"];
    if (next.files.length > 0) {
      await client.api("chat.update", { channel: a.channel, ts: newTs, text: next.text, file_ids: next.files });
    }
  } catch (e) {
    return outcome(a, "failed", { error: errorCode(e) });
  }
  try {
    await client.api("chat.delete", { channel: a.channel, ts: a.ts });
  } catch (e) {
    return outcome(a, "undeleted", { new_ts: newTs, error: errorCode(e) });
  }
  return outcome(a, "done", { new_ts: newTs });
}
async function apply(p, client, options = {}) {
  const { dryRun = true, receipts, paceMs = DEFAULT_PACE_MS, jitterMs = 0, sleep = defaultSleep2, onOutcome } = options;
  const selected = options.only === void 0 ? null : new Set(options.only);
  const todo = applyOrder(p.actions).filter((a) => writes(a) && (selected === null || selected.has(a.ts)));
  if (!dryRun && receipts === void 0 && todo.some((a) => a.kind === "post")) {
    throw new Error("a real run with posts needs receipts (a re-run would post again)");
  }
  const done = receipts === void 0 ? /* @__PURE__ */ new Map() : await receipts.done();
  const unposted = new Set(p.delete_after_posts ? p.actions.filter((a) => a.kind === "post" && !done.has(a.ts)).map((a) => a.ts) : []);
  const failedPosts = [];
  const out = [];
  let wrote = false;
  for (const a of todo) {
    let o;
    if (done.has(a.ts)) {
      const newTs = done.get(a.ts);
      o = outcome(a, "receipt", newTs === null || newTs === void 0 ? {} : { new_ts: newTs });
    } else if (a.kind === "delete" && !dryRun && (failedPosts.length > 0 || unposted.size > 0)) {
      const waiting = failedPosts.length > 0 ? failedPosts : [...unposted].sort();
      o = outcome(a, "pending", { error: `held: post ${waiting.join(", ")} not done` });
    } else {
      if (wrote && paceMs > 0) await sleep(paceMs + Math.random() * jitterMs);
      o = await applyOne(client, a, dryRun);
      wrote = o.status === "done" || o.status === "undeleted";
      if (receipts !== void 0 && !dryRun) await receipts.record(o);
    }
    if (a.kind === "post") {
      if (o.status === "done" || o.status === "receipt") unposted.delete(a.ts);
      else if (!dryRun) failedPosts.push(a.ts);
    }
    out.push(o);
    await onOutcome?.(o);
  }
  return out;
}
var jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
async function rewriteHandler(request, options) {
  const url = new URL(request.url);
  const op = url.pathname.replace(/\/+$/, "").split("/").at(-1);
  const p = typeof options.plan === "function" ? await options.plan() : options.plan;
  if (request.method === "GET" && op === "plan") {
    return jsonResponse(200, { path: options.name ?? "plan", plan: { ...p, counts: planCounts(p) } });
  }
  if (request.method !== "POST" || op !== "check" && op !== "apply") return jsonResponse(404, { error: `not found: ${request.method} ${url.pathname}` });
  if ((request.headers.get("Content-Type") ?? "").split(";")[0].trim() !== "application/json") {
    return jsonResponse(415, { error: "expected Content-Type: application/json" });
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return jsonResponse(403, { error: `cross-origin request from ${origin}` });
  let ids;
  try {
    ids = (await request.json()).ids;
  } catch (e) {
    return jsonResponse(400, { error: `bad request: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) {
    return jsonResponse(400, { error: "bad request: ids must be a list of strings" });
  }
  const maxBatch = options.maxBatch ?? DEFAULT_BATCH;
  if (ids.length > maxBatch) return jsonResponse(413, { error: `${ids.length} ids; at most ${maxBatch} per request` });
  const known = new Set(p.actions.filter(writes).map((a) => a.ts));
  const unknown = ids.filter((i) => !known.has(i));
  if (unknown.length > 0) return jsonResponse(400, { error: `not writes in this plan: ${unknown.join(", ")}` });
  try {
    const client = typeof options.client === "function" ? await options.client() : options.client;
    const applyOptions = { dryRun: op === "check", only: ids };
    if (options.receipts !== void 0) applyOptions.receipts = options.receipts;
    if (options.paceMs !== void 0) applyOptions.paceMs = options.paceMs;
    if (options.sleep !== void 0) applyOptions.sleep = options.sleep;
    const outcomes = await apply(p, client, applyOptions);
    return jsonResponse(200, { outcomes, posted: postedOf(outcomes) });
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
}
export {
  CHANNEL_TTL_MS,
  CustomSenderFilesError,
  DEFAULT_BATCH,
  DEFAULT_PACE_MS,
  EditRateLimited,
  FILE_HASHES,
  FileNotProcessedError,
  FileSwapError,
  FilesNotAttachedError,
  LeaseLostError,
  MAX_CACHED_USERS,
  NON_IDEMPOTENT,
  NOT_FOUND_TTL_MS,
  OrphanedRepliesError,
  PLAN_VERSION,
  PRIVATE_METADATA_MAX,
  REJECTED,
  REWRITE_KINDS,
  REWRITE_STATUSES,
  SLACK_API,
  SLACK_BLOCKS_LIMIT,
  SLACK_MESSAGE_LIMIT,
  SLACK_SECTION_LIMIT,
  SLOT_KEY,
  SLOT_NAME,
  SlackApiError,
  SlackClient,
  THRDS_HASH,
  USERNAME_MAX,
  USER_TTL_MS,
  actions,
  apply,
  applyOrder,
  assertFilesAttachable,
  attachedFiles,
  bound,
  buildDetailMessages,
  buildPermalink,
  buildSummaryMessages,
  button,
  codePoints,
  collect,
  contentHash,
  contentKey,
  contentOf,
  context,
  date,
  datePicker,
  decodePrivateMetadata,
  defaultBullet,
  definitelyNotAttached,
  describeSender,
  divider,
  encodePrivateMetadata,
  escape,
  fallbackText,
  findHistory,
  findIds,
  findThread,
  fitsPrivateMetadata,
  hash53,
  header,
  image,
  imageElement,
  importAnchor,
  input,
  isProcessed,
  isRich,
  lineDiff,
  link,
  memoryReceipts,
  memoryStore,
  mention,
  modal,
  mrkdwnText,
  msgHash,
  oneKeyStore,
  option,
  paginate,
  parsePermalink,
  parsePlan,
  partialOf,
  permalinksIn,
  plainText,
  plainTextInput,
  plan,
  planCounts,
  postRewrite,
  postedOf,
  pyJsonDumps,
  readMessage,
  rewriteHandler,
  rich,
  sameContent,
  section,
  sectionBlocks,
  sendable,
  senderChanged,
  senderOf,
  senderOverrides,
  slackApi,
  slackCall,
  splitBody,
  stableStringify,
  staticSelect,
  substitute,
  swapFiles,
  sync,
  syncSlots,
  tagSlot,
  threadStore,
  toBytes,
  toMsg,
  upsert,
  upsertFile,
  upsertFiles,
  usersSelect,
  verifyPlan,
  versionedUrl,
  webClientTransport,
  withFiles,
  withoutImages,
  withoutPermalinks,
  writes,
  writesSummary
};
//# sourceMappingURL=index.js.map