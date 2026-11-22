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

export {
  PLAN_VERSION,
  REWRITE_KINDS,
  REWRITE_STATUSES,
  parsePlan,
  writes,
  planCounts,
  senderChanged,
  describeSender,
  lineDiff
};
//# sourceMappingURL=chunk-CEG2USOK.js.map