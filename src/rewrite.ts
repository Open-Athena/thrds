/**
 * Bulk-rewrite plans: the JSON a `thrds slack rewrite plan` (Python `thrds.rewrite`) writes, typed for review UIs.
 *
 * One action per message: `edit`, `repost` (the sender changes, which `chat.update` can't do), `noop`, `skip` (the
 * app's reason) or `blocked` (what Slack can't do). `review_json()` / `slck rewrite show -j` add each action's text
 * `diff` and the `counts`. See `specs/bulk-rewrite.md` on the `py` branch.
 */
import type { Block } from "./mrkdwn.js";

export const PLAN_VERSION = 1;

export const REWRITE_KINDS = ["edit", "repost", "noop", "skip", "blocked"] as const;
export type RewriteKind = (typeof REWRITE_KINDS)[number];

export interface RewriteSender {
  username: string | null;
  icon_url: string | null;
  icon_emoji: string | null;
}

/** What a message shows: wire `text` (Slack mrkdwn), `blocks` (`null`: none), sender override, attached file ids. */
export interface RewriteContent {
  text: string;
  blocks: Block[] | null;
  sender: RewriteSender;
  files: string[];
}

export interface PlannedAction {
  kind: RewriteKind;
  channel: string;
  ts: string;
  /** The parent's ts for a reply; `null` for a top-level message. */
  thread_ts: string | null;
  /** The message's content hash when planned; apply refuses the action once it moves. */
  hash: string;
  old: RewriteContent;
  new: RewriteContent | null;
  reason: string | null;
  broadcast?: boolean;
  metadata?: unknown;
  /** Unified diff of the text (review form only). */
  diff?: string;
}

export interface RewritePlan {
  thrds_rewrite_plan: typeof PLAN_VERSION;
  actions: PlannedAction[];
  /** Per-kind counts (review form only). */
  counts?: Record<RewriteKind, number>;
}

export const REWRITE_STATUSES = ["done", "already", "receipt", "pending", "stale", "gone", "failed", "undeleted"] as const;
export type RewriteStatus = (typeof REWRITE_STATUSES)[number];

/** One applied (or dry-run) action's result. */
export interface RewriteOutcome {
  ts: string;
  kind: RewriteKind;
  status: RewriteStatus;
  new_ts?: string;
  error?: string;
}

/** Validates a parsed plan's version and shape; throws on anything else. */
export function parsePlan(json: unknown): RewritePlan {
  if (typeof json !== "object" || json === null) throw new Error("not a thrds rewrite plan (not an object)");
  const plan = json as Partial<RewritePlan>;
  if (plan.thrds_rewrite_plan !== PLAN_VERSION) {
    throw new Error(`not a thrds rewrite plan (version ${JSON.stringify(plan.thrds_rewrite_plan)}, expected ${PLAN_VERSION})`);
  }
  if (!Array.isArray(plan.actions)) throw new Error("not a thrds rewrite plan (no actions)");
  for (const a of plan.actions) {
    if (!(REWRITE_KINDS as readonly string[]).includes(a.kind)) throw new Error(`plan action ${a.ts}: unknown kind ${JSON.stringify(a.kind)}`);
    if (writes(a) && a.new === null) throw new Error(`plan action ${a.ts}: ${a.kind} without new content`);
  }
  return plan as RewritePlan;
}

/** `edit` and `repost` write; the other kinds don't. */
export const writes = (a: Pick<PlannedAction, "kind">): boolean => a.kind === "edit" || a.kind === "repost";

export function planCounts(plan: RewritePlan): Record<RewriteKind, number> {
  const out = Object.fromEntries(REWRITE_KINDS.map((k) => [k, 0])) as Record<RewriteKind, number>;
  for (const a of plan.actions) out[a.kind] += 1;
  return out;
}

export const senderChanged = (a: PlannedAction): boolean =>
  a.new !== null &&
  (a.new.sender.username !== a.old.sender.username ||
    a.new.sender.icon_url !== a.old.sender.icon_url ||
    a.new.sender.icon_emoji !== a.old.sender.icon_emoji);

export function describeSender(s: RewriteSender): string {
  const parts = [s.username === null ? null : `"${s.username}"`, s.icon_emoji, s.icon_url].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" ") : "the app";
}

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

/** Line diff of `a` → `b` (longest common subsequence): unchanged, removed and added lines in order. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // lcs[i][j]: LCS length of x[i:] and y[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: x[i++]! });
    } else {
      out.push({ op: "+", text: y[j++]! });
    }
  }
  while (i < n) out.push({ op: "-", text: x[i++]! });
  while (j < m) out.push({ op: "+", text: y[j++]! });
  return out;
}
