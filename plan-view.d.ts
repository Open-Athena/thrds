import { ReactNode } from 'react';
import { B as Block, e as RewriteContent, h as RewritePlan, g as RewriteOutcome, c as PlannedAction, f as RewriteKind } from './rewrite-D8KfbPDU.js';

/**
 * A Slack message rendered as React elements for review: wire mrkdwn (bold, italic, strike, code, links, mentions,
 * quotes, emoji) and Block Kit (header, section, context, divider, image, rich_text, actions). Close to what Slack
 * shows, not pixel-exact; no raw HTML is injected.
 */

/** Emoji name → a unicode character or an image URL (a workspace's custom emoji). */
type EmojiMap = Record<string, string>;
/** A few common Slack shortcodes; anything else shows as its `:code:` unless the app's `emoji` map has it. */
declare const COMMON_EMOJI: EmojiMap;
interface RenderOptions {
    emoji?: EmojiMap;
}
declare function Emoji({ name, emoji }: {
    name: string;
    emoji?: EmojiMap;
}): ReactNode;
/** One line of mrkdwn (no newlines) as inline nodes. */
declare function inline(text: string, opts?: RenderOptions): ReactNode[];
/** Wire mrkdwn as block-level nodes: ``` fences, `>` quotes, lines. */
declare function Mrkdwn({ text, emoji }: {
    text: string;
    emoji?: EmojiMap;
}): ReactNode;
declare function BlockView({ block, emoji }: {
    block: Block;
    emoji?: EmojiMap;
}): ReactNode;
/** The message as Slack would show it: its blocks when it has any, else its text; then its attached files. */
declare function SlackMessage({ content, emoji }: {
    content: RewriteContent;
    emoji?: EmojiMap;
}): ReactNode;

/** `PlanView`'s stylesheet: `tpv-` classes, colors as custom properties on `.tpv` (light, and dark via the OS or `data-theme`). */
declare const PLAN_VIEW_CSS = "\n.tpv {\n  --tpv-bg: #ffffff;\n  --tpv-fg: #1d1c1d;\n  --tpv-muted: #616061;\n  --tpv-border: #dddddd;\n  --tpv-panel: #f8f8f8;\n  --tpv-accent: #1264a3;\n  --tpv-add-bg: #e6f4ea;\n  --tpv-add-fg: #116329;\n  --tpv-del-bg: #fdecea;\n  --tpv-del-fg: #a40e26;\n  --tpv-edit: #1264a3;\n  --tpv-repost: #8a4baf;\n  --tpv-noop: #8d8d8d;\n  --tpv-skip: #b07d00;\n  --tpv-blocked: #c22a3a;\n  --tpv-code-bg: #f2f2f2;\n  background: var(--tpv-bg);\n  color: var(--tpv-fg);\n  font: 15px/1.46 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n}\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) .tpv {\n    --tpv-bg: #1a1d21;\n    --tpv-fg: #d1d2d3;\n    --tpv-muted: #9a9b9d;\n    --tpv-border: #3b3e43;\n    --tpv-panel: #222529;\n    --tpv-accent: #4fa3e3;\n    --tpv-add-bg: #12301d;\n    --tpv-add-fg: #7ad497;\n    --tpv-del-bg: #3a1519;\n    --tpv-del-fg: #f08b97;\n    --tpv-edit: #4fa3e3;\n    --tpv-repost: #c08ae0;\n    --tpv-noop: #8d8d8d;\n    --tpv-skip: #e0b23c;\n    --tpv-blocked: #f0707d;\n    --tpv-code-bg: #2c2f33;\n  }\n}\n:root[data-theme=\"dark\"] .tpv {\n  --tpv-bg: #1a1d21;\n  --tpv-fg: #d1d2d3;\n  --tpv-muted: #9a9b9d;\n  --tpv-border: #3b3e43;\n  --tpv-panel: #222529;\n  --tpv-accent: #4fa3e3;\n  --tpv-add-bg: #12301d;\n  --tpv-add-fg: #7ad497;\n  --tpv-del-bg: #3a1519;\n  --tpv-del-fg: #f08b97;\n  --tpv-edit: #4fa3e3;\n  --tpv-repost: #c08ae0;\n  --tpv-noop: #8d8d8d;\n  --tpv-skip: #e0b23c;\n  --tpv-blocked: #f0707d;\n  --tpv-code-bg: #2c2f33;\n}\n.tpv * { box-sizing: border-box; }\n.tpv button { font: inherit; color: inherit; }\n.tpv-toolbar, .tpv-applybar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }\n.tpv-kinds { display: flex; flex-wrap: wrap; gap: 6px; }\n.tpv-chip { border: 1px solid var(--tpv-border); background: var(--tpv-panel); border-radius: 999px; padding: 2px 10px; cursor: pointer; opacity: 0.55; }\n.tpv-chip[aria-pressed=\"true\"] { opacity: 1; border-color: currentColor; }\n.tpv-count { color: var(--tpv-muted); font-variant-numeric: tabular-nums; }\n.tpv-search { flex: 1 1 200px; min-width: 0; padding: 5px 10px; border: 1px solid var(--tpv-border); border-radius: 6px; background: var(--tpv-bg); color: var(--tpv-fg); font: inherit; }\n.tpv-applybar { padding: 8px 10px; border: 1px solid var(--tpv-border); border-radius: 8px; background: var(--tpv-panel); position: sticky; top: 0; z-index: 1; }\n.tpv-spacer { flex: 1; }\n.tpv-btn { border: 1px solid var(--tpv-border); background: var(--tpv-bg); border-radius: 6px; padding: 4px 12px; cursor: pointer; }\n.tpv-btn:disabled { opacity: 0.5; cursor: default; }\n.tpv-primary { background: var(--tpv-accent); border-color: var(--tpv-accent); color: #ffffff !important; }\n.tpv-link { border: none; background: none; padding: 0 2px; color: var(--tpv-accent) !important; cursor: pointer; }\n.tpv-link[aria-pressed=\"true\"] { font-weight: 600; text-decoration: underline; }\n.tpv-link:disabled { opacity: 0.5; cursor: default; }\n.tpv-confirm { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }\n.tpv-error { color: var(--tpv-del-fg); background: var(--tpv-del-bg); border-radius: 6px; padding: 6px 10px; margin-bottom: 12px; }\n.tpv-empty { color: var(--tpv-muted); padding: 24px 0; text-align: center; }\n.tpv-actions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }\n.tpv-action { border: 1px solid var(--tpv-border); border-radius: 8px; padding: 10px 12px; min-width: 0; }\n.tpv-action-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }\n.tpv-badge { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 8px; border-radius: 4px; border: 1px solid currentColor; }\n.tpv-kind-edit { color: var(--tpv-edit); }\n.tpv-kind-repost { color: var(--tpv-repost); }\n.tpv-kind-noop { color: var(--tpv-noop); }\n.tpv-kind-skip { color: var(--tpv-skip); }\n.tpv-kind-blocked { color: var(--tpv-blocked); }\n.tpv-muted, .tpv-side-label { color: var(--tpv-muted); font-size: 13px; }\n.tpv-reason { color: var(--tpv-muted); font-style: italic; }\n.tpv-status { font-size: 13px; padding: 1px 8px; border-radius: 4px; background: var(--tpv-panel); border: 1px solid var(--tpv-border); }\n.tpv-status-done, .tpv-status-already, .tpv-status-receipt { color: var(--tpv-add-fg); background: var(--tpv-add-bg); }\n.tpv-status-stale, .tpv-status-gone, .tpv-status-failed, .tpv-status-undeleted { color: var(--tpv-del-fg); background: var(--tpv-del-bg); }\n.tpv-modes { margin-left: auto; display: inline-flex; gap: 6px; }\n.tpv-sender-change { font-size: 13px; margin-bottom: 8px; color: var(--tpv-repost); }\n.tpv-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }\n.tpv-side, .tpv-single { min-width: 0; background: var(--tpv-panel); border-radius: 6px; padding: 8px 10px; }\n.tpv-diff { margin: 0; padding: 8px 10px; background: var(--tpv-panel); border-radius: 6px; overflow-x: auto; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }\n.tpv-add { display: block; background: var(--tpv-add-bg); color: var(--tpv-add-fg); }\n.tpv-del { display: block; background: var(--tpv-del-bg); color: var(--tpv-del-fg); }\n.tpv-message { overflow-wrap: anywhere; }\n.tpv-sender { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; }\n.tpv-avatar { width: 20px; height: 20px; border-radius: 4px; }\n.tpv-mrkdwn pre, .tpv-message pre { white-space: pre-wrap; background: var(--tpv-code-bg); border: 1px solid var(--tpv-border); border-radius: 4px; padding: 6px 8px; margin: 4px 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }\n.tpv-message code { background: var(--tpv-code-bg); border: 1px solid var(--tpv-border); border-radius: 3px; padding: 0 3px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--tpv-del-fg); }\n.tpv-message pre code { border: none; padding: 0; color: inherit; }\n.tpv-message a { color: var(--tpv-accent); }\n.tpv-message blockquote { margin: 2px 0; padding-left: 10px; border-left: 4px solid var(--tpv-border); }\n.tpv-message ul, .tpv-message ol { margin: 2px 0; padding-left: 22px; }\n.tpv-line { display: block; min-height: 1.46em; }\n.tpv-pre-wrap { display: block; white-space: pre-wrap; }\n.tpv-mention { color: var(--tpv-accent); background: color-mix(in srgb, var(--tpv-accent) 12%, transparent); border-radius: 3px; padding: 0 2px; }\n.tpv-emoji { font-size: 1.15em; }\nimg.tpv-emoji { width: 1.3em; height: 1.3em; vertical-align: -0.3em; }\n.tpv-emoji-code { font-size: 12px; color: var(--tpv-muted); background: var(--tpv-code-bg); border-radius: 3px; padding: 0 3px; }\n.tpv-header { font-weight: 700; font-size: 18px; margin: 2px 0; }\n.tpv-section { display: flex; gap: 10px; align-items: flex-start; margin: 2px 0; }\n.tpv-section-body { flex: 1; min-width: 0; }\n.tpv-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; margin-top: 4px; }\n.tpv-context { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--tpv-muted); margin: 2px 0; }\n.tpv-context .tpv-image { width: 16px; height: 16px; }\n.tpv-divider { border: none; border-top: 1px solid var(--tpv-border); margin: 6px 0; }\n.tpv-image { max-width: 100%; max-height: 240px; border-radius: 4px; }\n.tpv-section .tpv-image { width: 72px; height: 72px; object-fit: cover; }\n.tpv-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }\n.tpv-button { border: 1px solid var(--tpv-border); border-radius: 4px; padding: 1px 10px; font-size: 13px; font-weight: 600; }\n.tpv-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }\n.tpv-file { font-size: 13px; color: var(--tpv-muted); border: 1px solid var(--tpv-border); border-radius: 4px; padding: 0 6px; }\n.tpv-unknown { color: var(--tpv-muted); font-size: 13px; }\n";

/**
 * `PlanView`: review a bulk-rewrite plan (`@open-athena/thrds/plan-view`).
 *
 * Lists the plan's actions with kind filters and a text filter. Each action shows the message before and after,
 * rendered as Slack would (or by the app's `renderContent`), or as a text diff. The edits and reposts you select go to
 * `onApply` (and `onCheck`, a dry run). The app's backend runs the apply (Python `thrds.rewrite.apply`), so the view
 * works behind the app's own auth. Outcomes passed back show on each row.
 */

interface PlanViewProps {
    plan: RewritePlan;
    /** Outcomes by message ts, from the last check or apply. */
    outcomes?: Record<string, RewriteOutcome>;
    /** Apply the selected edits and reposts. Without it, the view is read-only. */
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
declare function PlanView({ plan, outcomes, onApply, onCheck, renderContent, messageHref, emoji, initialKinds, unstyled, }: PlanViewProps): ReactNode;
/** The text change as a line diff. */
declare function Diff({ from, to }: {
    from: string;
    to: string;
}): ReactNode;

export { BlockView, COMMON_EMOJI, Diff, Emoji, type EmojiMap, Mrkdwn, PLAN_VIEW_CSS, PlanView, type PlanViewProps, type RenderOptions, SlackMessage, inline };
