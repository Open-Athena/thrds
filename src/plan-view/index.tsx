/**
 * `PlanView`: review a bulk-rewrite plan (`@open-athena/thrds/plan-view`).
 *
 * Lists the plan's actions with kind filters and a text filter. Each action shows the message before and after,
 * rendered as Slack would (or by the app's `renderContent`), or as a text diff; a `post` shows only the new message, a
 * `delete` only the old one, struck. The writes you select go to `onApply` (and `onCheck`, a dry run), in `applyOrder`
 * (deletes last). An `atomic` plan is applied whole: no per-row selection. The app's backend runs the apply (`rewriteHandler` in a Worker, or Python
 * `thrds.rewrite.apply`), so the view works behind the app's own auth; `postRewrite` posts a selection to it in
 * batches. Outcomes passed back show on each row.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  applyOrder,
  describeSender,
  lineDiff,
  planCounts,
  REWRITE_KINDS,
  senderChanged,
  writes,
  writesSummary,
  type PlannedAction,
  type RewriteContent,
  type RewriteKind,
  type RewriteOutcome,
  type RewritePlan,
} from "../rewrite.js";
import { SlackMessage, type EmojiMap } from "./slack.js";
import { PLAN_VIEW_CSS } from "./style.js";

export { BlockView, COMMON_EMOJI, Emoji, inline, Mrkdwn, SlackMessage, type EmojiMap, type RenderOptions } from "./slack.js";
export { PLAN_VIEW_CSS } from "./style.js";

export interface PlanViewProps {
  plan: RewritePlan;
  /** Outcomes by message ts, from the last check or apply. */
  outcomes?: Record<string, RewriteOutcome>;
  /** Apply the selected writes (in `applyOrder`). Without it, the view is read-only. */
  onApply?: (selected: PlannedAction[]) => void | Promise<void>;
  /** Dry-run the selected actions: each is checked against its message, nothing is written. */
  onCheck?: (selected: PlannedAction[]) => void | Promise<void>;
  /** The app's own rendering of a message (e.g. a card for one message kind); `undefined` falls back to Slack's. */
  renderContent?: (content: RewriteContent, side: "old" | "new", action: PlannedAction) => ReactNode | undefined;
  /** A link to each message (e.g. its permalink). */
  messageHref?: (action: PlannedAction) => string | undefined;
  /** Emoji names → unicode or image URLs (the workspace's custom emoji). */
  emoji?: EmojiMap;
  /** Kinds shown at first (default: all but `noop`). */
  initialKinds?: RewriteKind[];
  /** Leave out the bundled stylesheet (the app styles the `tpv-` classes itself). */
  unstyled?: boolean;
}

const DEFAULT_KINDS: RewriteKind[] = ["edit", "repost", "post", "delete", "skip", "blocked"];

/** Kinds a plan only sometimes has; their filter chips show only when it does. */
const OPTIONAL_KINDS: ReadonlySet<RewriteKind> = new Set(["post", "delete"]);

function matches(a: PlannedAction, query: string): boolean {
  if (query === "") return true;
  const q = query.toLowerCase();
  return [a.ts, a.thread_ts ?? "", a.reason ?? "", a.old?.text ?? "", a.new?.text ?? ""].some((s) => s.toLowerCase().includes(q));
}

export function PlanView({
  plan,
  outcomes = {},
  onApply,
  onCheck,
  renderContent,
  messageHref,
  emoji,
  initialKinds = DEFAULT_KINDS,
  unstyled = false,
}: PlanViewProps): ReactNode {
  const counts = useMemo(() => plan.counts ?? planCounts(plan), [plan]);
  const [kinds, setKinds] = useState<Set<RewriteKind>>(() => new Set(initialKinds));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(plan.actions.filter(writes).map((a) => a.ts)));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const atomic = plan.atomic === true;
  const shown = plan.actions.filter((a) => kinds.has(a.kind) && matches(a, query));
  const shownWrites = shown.filter(writes);
  const allWrites = plan.actions.filter(writes);
  const chosen = applyOrder(atomic ? allWrites : allWrites.filter((a) => selected.has(a.ts)));
  const chosenDeletes = chosen.filter((a) => a.kind === "delete").length;
  const interactive = onApply !== undefined || onCheck !== undefined;
  const summary = writesSummary(counts);

  const toggleKind = (k: RewriteKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const toggle = (ts: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ts)) next.delete(ts);
      else next.add(ts);
      return next;
    });
  const setAllShown = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of shownWrites) {
        if (on) next.add(a.ts);
        else next.delete(a.ts);
      }
      return next;
    });

  const run = async (which: "check" | "apply", fn: (s: PlannedAction[]) => void | Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await fn(chosen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <div className="tpv">
      {!unstyled && <style>{PLAN_VIEW_CSS}</style>}
      <div className="tpv-toolbar">
        {summary !== "" && <span className="tpv-summary">{summary}</span>}
        <div className="tpv-kinds" role="group" aria-label="Filter by kind">
          {REWRITE_KINDS.filter((k) => !OPTIONAL_KINDS.has(k) || counts[k] > 0).map((k) => (
            <button
              key={k}
              type="button"
              className={`tpv-chip tpv-kind-${k}`}
              aria-pressed={kinds.has(k)}
              onClick={() => toggleKind(k)}
            >
              {k} <span className="tpv-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <input
          className="tpv-search"
          type="search"
          placeholder="Filter by text or ts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {interactive && (
        <div className="tpv-applybar">
          {atomic ? (
            <span>All {allWrites.length}: this plan applies as a whole</span>
          ) : (
            <>
              <span>
                {chosen.length} of {allWrites.length} selected
              </span>
              <button type="button" className="tpv-link" onClick={() => setAllShown(true)} disabled={shownWrites.length === 0}>
                Select shown
              </button>
              <button type="button" className="tpv-link" onClick={() => setAllShown(false)} disabled={shownWrites.length === 0}>
                Clear shown
              </button>
            </>
          )}
          <span className="tpv-spacer" />
          {onCheck !== undefined && (
            <button type="button" className="tpv-btn" disabled={chosen.length === 0 || busy !== null} onClick={() => run("check", onCheck)}>
              {busy === "check" ? "Checking…" : "Check"}
            </button>
          )}
          {onApply !== undefined &&
            (confirming ? (
              <span className="tpv-confirm">
                Write {chosen.length} message{chosen.length === 1 ? "" : "s"} to Slack?
                {chosenDeletes > 0 && ` ${chosenDeletes} delete${chosenDeletes === 1 ? "" : "s"} can't be undone.`}
                <button type="button" className="tpv-btn tpv-primary" disabled={busy !== null} onClick={() => run("apply", onApply)}>
                  {busy === "apply" ? "Applying…" : "Apply"}
                </button>
                <button type="button" className="tpv-btn" disabled={busy !== null} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="tpv-btn tpv-primary" disabled={chosen.length === 0 || busy !== null} onClick={() => setConfirming(true)}>
                Apply {chosen.length}…
              </button>
            ))}
        </div>
      )}
      {error !== null && <div className="tpv-error">{error}</div>}
      {shown.length === 0 ? (
        <div className="tpv-empty">No actions match.</div>
      ) : (
        <ol className="tpv-actions-list">
          {shown.map((a) => (
            <ActionRow
              key={a.ts}
              action={a}
              outcome={outcomes[a.ts]}
              selectable={interactive && !atomic && writes(a)}
              selected={selected.has(a.ts)}
              onToggle={() => toggle(a.ts)}
              renderContent={renderContent}
              href={messageHref?.(a)}
              emoji={emoji}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

interface ActionRowProps {
  action: PlannedAction;
  outcome: RewriteOutcome | undefined;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  renderContent: PlanViewProps["renderContent"];
  href: string | undefined;
  emoji: EmojiMap | undefined;
}

function ActionRow({ action: a, outcome, selectable, selected, onToggle, renderContent, href, emoji }: ActionRowProps): ReactNode {
  const [mode, setMode] = useState<"rendered" | "diff">("rendered");
  const render = (c: RewriteContent, side: "old" | "new") => renderContent?.(c, side, a) ?? <SlackMessage content={c} emoji={emoji} />;
  const ts = href === undefined ? <code>{a.ts}</code> : <a href={href} target="_blank" rel="noreferrer"><code>{a.ts}</code></a>;
  return (
    <li className={`tpv-action tpv-action-${a.kind}`}>
      <div className="tpv-action-head">
        {selectable && <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${a.ts}`} />}
        <span className={`tpv-badge tpv-kind-${a.kind}`}>{a.kind}</span>
        {ts}
        {a.thread_ts !== null && <span className="tpv-muted">in thread {a.thread_ts}</span>}
        {a.reason !== null && <span className="tpv-reason">{a.reason}</span>}
        {outcome !== undefined && (
          <span className={`tpv-status tpv-status-${outcome.status}`} title={outcome.error}>
            {outcome.status}
            {outcome.new_ts !== undefined ? ` → ${outcome.new_ts}` : ""}
            {outcome.error !== undefined ? `: ${outcome.error}` : ""}
          </span>
        )}
        {a.old !== null && a.new !== null && writes(a) && (
          <span className="tpv-modes">
            <button type="button" className="tpv-link" aria-pressed={mode === "rendered"} onClick={() => setMode("rendered")}>
              Rendered
            </button>
            <button type="button" className="tpv-link" aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>
              Diff
            </button>
          </span>
        )}
      </div>
      {senderChanged(a) && a.new !== null && a.old !== null && (
        <div className="tpv-sender-change">
          Sender: {describeSender(a.old.sender)} → {describeSender(a.new.sender)}
        </div>
      )}
      {a.old === null ? (
        <div className="tpv-single">
          <div className="tpv-side-label">New</div>
          {render(a.new!, "new")}
        </div>
      ) : a.kind === "delete" ? (
        <div className="tpv-single tpv-struck">{render(a.old, "old")}</div>
      ) : a.new === null || !writes(a) ? (
        <div className="tpv-single">{render(a.old, "old")}</div>
      ) : mode === "diff" ? (
        <Diff from={a.old.text} to={a.new.text} />
      ) : (
        <div className="tpv-sides">
          <div className="tpv-side">
            <div className="tpv-side-label">Now</div>
            {render(a.old, "old")}
          </div>
          <div className="tpv-side">
            <div className="tpv-side-label">Planned</div>
            {render(a.new, "new")}
          </div>
        </div>
      )}
    </li>
  );
}

/** The text change as a line diff. */
export function Diff({ from, to }: { from: string; to: string }): ReactNode {
  const lines = lineDiff(from, to);
  if (lines.every((l) => l.op === " ")) return <div className="tpv-muted tpv-diff-none">Text unchanged (blocks or sender change).</div>;
  return (
    <pre className="tpv-diff">
      {lines.map((l, i) => (
        <span key={i} className={l.op === "-" ? "tpv-del" : l.op === "+" ? "tpv-add" : undefined}>
          {l.op}
          {l.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
