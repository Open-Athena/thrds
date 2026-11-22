// src/rewrite.ts
var PLAN_VERSION = 1;
var REWRITE_KINDS = ["edit", "repost", "noop", "skip", "blocked"];
var REWRITE_STATUSES = ["done", "already", "receipt", "pending", "stale", "gone", "failed", "undeleted"];
function parsePlan(json) {
  if (typeof json !== "object" || json === null) throw new Error("not a thrds rewrite plan (not an object)");
  const plan = json;
  if (plan.thrds_rewrite_plan !== PLAN_VERSION) {
    throw new Error(`not a thrds rewrite plan (version ${JSON.stringify(plan.thrds_rewrite_plan)}, expected ${PLAN_VERSION})`);
  }
  if (!Array.isArray(plan.actions)) throw new Error("not a thrds rewrite plan (no actions)");
  for (const a of plan.actions) {
    if (!REWRITE_KINDS.includes(a.kind)) throw new Error(`plan action ${a.ts}: unknown kind ${JSON.stringify(a.kind)}`);
    if (writes(a) && a.new === null) throw new Error(`plan action ${a.ts}: ${a.kind} without new content`);
  }
  return plan;
}
var writes = (a) => a.kind === "edit" || a.kind === "repost";
function planCounts(plan) {
  const out = Object.fromEntries(REWRITE_KINDS.map((k) => [k, 0]));
  for (const a of plan.actions) out[a.kind] += 1;
  return out;
}
var senderChanged = (a) => a.new !== null && (a.new.sender.username !== a.old.sender.username || a.new.sender.icon_url !== a.old.sender.icon_url || a.new.sender.icon_emoji !== a.old.sender.icon_emoji);
function describeSender(s) {
  const parts = [s.username === null ? null : `"${s.username}"`, s.icon_emoji, s.icon_url].filter((p) => p !== null);
  return parts.length ? parts.join(" ") : "the app";
}
function lineDiff(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      lcs[i2][j2] = x[i2] === y[j2] ? lcs[i2 + 1][j2 + 1] + 1 : Math.max(lcs[i2 + 1][j2], lcs[i2][j2 + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "-", text: x[i++] });
    } else {
      out.push({ op: "+", text: y[j++] });
    }
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}
var NO_SENDER = { username: null, icon_url: null, icon_emoji: null };
function pyJsonDumps(value) {
  if (value === null || value === void 0) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}
async function contentHash(c) {
  const body = pyJsonDumps({ text: c.text, blocks: c.blocks, sender: c.sender, files: c.files });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
function senderOf(m) {
  if (m["subtype"] !== "bot_message") return { ...NO_SENDER };
  const icons = m["icons"] ?? {};
  const emoji = typeof icons["emoji"] === "string" ? icons["emoji"] : null;
  let url = null;
  if (emoji === null) {
    const original = icons["image_original"];
    if (typeof original === "string" && original) url = original;
    else {
      const k = Object.keys(icons).sort().find((k2) => k2.startsWith("image_") && typeof icons[k2] === "string");
      url = k === void 0 ? null : icons[k];
    }
  }
  return { username: typeof m["username"] === "string" ? m["username"] : null, icon_url: url, icon_emoji: emoji };
}
function contentOf(m) {
  const files = m["files"] ?? [];
  return {
    text: typeof m["text"] === "string" ? m["text"] : "",
    blocks: m["blocks"] ?? null,
    sender: senderOf(m),
    files: files.filter((f) => typeof f["id"] === "string").map((f) => f["id"])
  };
}
var sameSender = (a, b) => a.username === b.username && a.icon_url === b.icon_url && a.icon_emoji === b.icon_emoji;
var stripBlockIds = (blocks) => blocks === null ? null : blocks.map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "block_id")));
var onlyRichText = (blocks) => !blocks || blocks.every((b) => b.type === "rich_text");
function sameContent(live, want) {
  if (live.text !== want.text || !sameSender(live.sender, want.sender)) return false;
  if (live.files.length !== want.files.length || live.files.some((f, i) => f !== want.files[i])) return false;
  if (want.blocks === null) return onlyRichText(live.blocks);
  return pyJsonDumps(stripBlockIds(live.blocks)) === pyJsonDumps(stripBlockIds(want.blocks));
}
function foundOf(m, channel, ids, last) {
  const parent = m["thread_ts"];
  return {
    channel,
    ts: m.ts,
    threadTs: typeof parent === "string" && parent !== m.ts ? parent : null,
    content: contentOf(m),
    ours: m["user"] === ids.userId || ids.botId !== void 0 && m["bot_id"] === ids.botId,
    last,
    replyCount: typeof m["reply_count"] === "number" ? m["reply_count"] : 0,
    subtype: typeof m["subtype"] === "string" ? m["subtype"] : null,
    metadata: m["metadata"] ?? null,
    raw: m
  };
}
var POST_SUBTYPES = [null, "bot_message", "thread_broadcast"];
var isOverride = (s) => s.username !== null || s.icon_url !== null || s.icon_emoji !== null;
async function verifyPlan(json) {
  const p = parsePlan(json);
  for (const a of p.actions) {
    const h = await contentHash(a.old);
    if (a.hash !== h) throw new Error(`plan action ${a.ts}: recorded hash ${a.hash} doesn't match its old content (${h})`);
  }
  return p;
}
function memoryReceipts(initial = []) {
  const outcomes = [...initial];
  return {
    outcomes,
    async done() {
      return new Set(outcomes.filter((o) => o.status === "done" || o.status === "already").map((o) => o.ts));
    },
    async record(o) {
      outcomes.push(o);
    }
  };
}
var DEFAULT_PACE_MS = 1200;
function substitute(mapping) {
  const emoji = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(mapping)) {
    if (k.length > 2 && v.length > 2 && k.startsWith(":") && k.endsWith(":") && v.startsWith(":") && v.endsWith(":")) {
      emoji.set(k.slice(1, -1), v.slice(1, -1));
    }
  }
  const subText = (s) => Object.entries(mapping).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  const sub = (x) => {
    if (typeof x === "string") return subText(x);
    if (Array.isArray(x)) return x.map(sub);
    if (typeof x === "object" && x !== null) {
      const o = x;
      if (o["type"] === "emoji" && typeof o["name"] === "string" && emoji.has(o["name"])) return { ...o, name: emoji.get(o["name"]) };
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "block_id" ? v : sub(v)]));
    }
    return x;
  };
  return (f) => ({
    text: subText(f.content.text),
    blocks: onlyRichText(f.content.blocks) ? null : sub(f.content.blocks)
  });
}
var DEFAULT_BATCH = 10;
async function postRewrite(endpoint, ids, options = {}) {
  const batch = options.batch ?? DEFAULT_BATCH;
  const f = options.fetch ?? fetch;
  const all = [];
  for (let i = 0; i < ids.length; i += batch) {
    const res = await f(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + batch) })
    });
    const body = await res.json();
    if (!res.ok || body.outcomes === void 0) throw new Error(body.error ?? `${endpoint}: HTTP ${res.status}`);
    all.push(...body.outcomes);
    options.onOutcomes?.(body.outcomes);
  }
  return all;
}

export {
  PLAN_VERSION,
  REWRITE_KINDS,
  REWRITE_STATUSES,
  parsePlan,
  writes,
  planCounts,
  senderChanged,
  describeSender,
  lineDiff,
  pyJsonDumps,
  contentHash,
  senderOf,
  contentOf,
  sameSender,
  sameContent,
  foundOf,
  POST_SUBTYPES,
  isOverride,
  verifyPlan,
  memoryReceipts,
  DEFAULT_PACE_MS,
  substitute,
  DEFAULT_BATCH,
  postRewrite
};
//# sourceMappingURL=chunk-L4VEQWK7.js.map