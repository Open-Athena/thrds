/** `PlanView`'s stylesheet: `tpv-` classes, colors as custom properties on `.tpv` (light, and dark via the OS or `data-theme`). */
export const PLAN_VIEW_CSS = `
.tpv {
  --tpv-bg: #ffffff;
  --tpv-fg: #1d1c1d;
  --tpv-muted: #616061;
  --tpv-border: #dddddd;
  --tpv-panel: #f8f8f8;
  --tpv-accent: #1264a3;
  --tpv-add-bg: #e6f4ea;
  --tpv-add-fg: #116329;
  --tpv-del-bg: #fdecea;
  --tpv-del-fg: #a40e26;
  --tpv-edit: #1264a3;
  --tpv-repost: #8a4baf;
  --tpv-post: #2b7a3d;
  --tpv-delete: #a33b12;
  --tpv-noop: #8d8d8d;
  --tpv-skip: #b07d00;
  --tpv-blocked: #c22a3a;
  --tpv-code-bg: #f2f2f2;
  background: var(--tpv-bg);
  color: var(--tpv-fg);
  font: 15px/1.46 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tpv {
    --tpv-bg: #1a1d21;
    --tpv-fg: #d1d2d3;
    --tpv-muted: #9a9b9d;
    --tpv-border: #3b3e43;
    --tpv-panel: #222529;
    --tpv-accent: #4fa3e3;
    --tpv-add-bg: #12301d;
    --tpv-add-fg: #7ad497;
    --tpv-del-bg: #3a1519;
    --tpv-del-fg: #f08b97;
    --tpv-edit: #4fa3e3;
    --tpv-repost: #c08ae0;
    --tpv-post: #6cc985;
    --tpv-delete: #ee8a5c;
    --tpv-noop: #8d8d8d;
    --tpv-skip: #e0b23c;
    --tpv-blocked: #f0707d;
    --tpv-code-bg: #2c2f33;
  }
}
:root[data-theme="dark"] .tpv {
  --tpv-bg: #1a1d21;
  --tpv-fg: #d1d2d3;
  --tpv-muted: #9a9b9d;
  --tpv-border: #3b3e43;
  --tpv-panel: #222529;
  --tpv-accent: #4fa3e3;
  --tpv-add-bg: #12301d;
  --tpv-add-fg: #7ad497;
  --tpv-del-bg: #3a1519;
  --tpv-del-fg: #f08b97;
  --tpv-edit: #4fa3e3;
  --tpv-repost: #c08ae0;
  --tpv-post: #6cc985;
  --tpv-delete: #ee8a5c;
  --tpv-noop: #8d8d8d;
  --tpv-skip: #e0b23c;
  --tpv-blocked: #f0707d;
  --tpv-code-bg: #2c2f33;
}
.tpv * { box-sizing: border-box; }
.tpv button { font: inherit; color: inherit; }
.tpv-toolbar, .tpv-applybar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.tpv-kinds { display: flex; flex-wrap: wrap; gap: 6px; }
.tpv-chip { border: 1px solid var(--tpv-border); background: var(--tpv-panel); border-radius: 999px; padding: 2px 10px; cursor: pointer; opacity: 0.55; }
.tpv-chip[aria-pressed="true"] { opacity: 1; border-color: currentColor; }
.tpv-count { color: var(--tpv-muted); font-variant-numeric: tabular-nums; }
.tpv-search { flex: 1 1 200px; min-width: 0; padding: 5px 10px; border: 1px solid var(--tpv-border); border-radius: 6px; background: var(--tpv-bg); color: var(--tpv-fg); font: inherit; }
.tpv-applybar { padding: 8px 10px; border: 1px solid var(--tpv-border); border-radius: 8px; background: var(--tpv-panel); position: sticky; top: 0; z-index: 1; }
.tpv-spacer { flex: 1; }
.tpv-btn { border: 1px solid var(--tpv-border); background: var(--tpv-bg); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
.tpv-btn:disabled { opacity: 0.5; cursor: default; }
.tpv-primary { background: var(--tpv-accent); border-color: var(--tpv-accent); color: #ffffff !important; }
.tpv-link { border: none; background: none; padding: 0 2px; color: var(--tpv-accent) !important; cursor: pointer; }
.tpv-link[aria-pressed="true"] { font-weight: 600; text-decoration: underline; }
.tpv-link:disabled { opacity: 0.5; cursor: default; }
.tpv-confirm { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tpv-error { color: var(--tpv-del-fg); background: var(--tpv-del-bg); border-radius: 6px; padding: 6px 10px; margin-bottom: 12px; }
.tpv-empty { color: var(--tpv-muted); padding: 24px 0; text-align: center; }
.tpv-actions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.tpv-action { border: 1px solid var(--tpv-border); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.tpv-action-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.tpv-badge { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 8px; border-radius: 4px; border: 1px solid currentColor; }
.tpv-kind-edit { color: var(--tpv-edit); }
.tpv-kind-repost { color: var(--tpv-repost); }
.tpv-kind-post { color: var(--tpv-post); }
.tpv-kind-delete { color: var(--tpv-delete); }
.tpv-kind-noop { color: var(--tpv-noop); }
.tpv-kind-skip { color: var(--tpv-skip); }
.tpv-kind-blocked { color: var(--tpv-blocked); }
.tpv-muted, .tpv-side-label { color: var(--tpv-muted); font-size: 13px; }
.tpv-reason { color: var(--tpv-muted); font-style: italic; }
.tpv-status { font-size: 13px; padding: 1px 8px; border-radius: 4px; background: var(--tpv-panel); border: 1px solid var(--tpv-border); }
.tpv-status-done, .tpv-status-already, .tpv-status-receipt { color: var(--tpv-add-fg); background: var(--tpv-add-bg); }
.tpv-status-stale, .tpv-status-gone, .tpv-status-failed, .tpv-status-undeleted { color: var(--tpv-del-fg); background: var(--tpv-del-bg); }
.tpv-modes { margin-left: auto; display: inline-flex; gap: 6px; }
.tpv-sender-change { font-size: 13px; margin-bottom: 8px; color: var(--tpv-repost); }
.tpv-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.tpv-struck { opacity: 0.6; text-decoration: line-through; }
.tpv-summary { font-weight: 600; }
.tpv-side, .tpv-single { min-width: 0; background: var(--tpv-panel); border-radius: 6px; padding: 8px 10px; }
.tpv-diff { margin: 0; padding: 8px 10px; background: var(--tpv-panel); border-radius: 6px; overflow-x: auto; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.tpv-add { display: block; background: var(--tpv-add-bg); color: var(--tpv-add-fg); }
.tpv-del { display: block; background: var(--tpv-del-bg); color: var(--tpv-del-fg); }
.tpv-message { overflow-wrap: anywhere; }
.tpv-sender { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; }
.tpv-avatar { width: 20px; height: 20px; border-radius: 4px; }
.tpv-mrkdwn pre, .tpv-message pre { white-space: pre-wrap; background: var(--tpv-code-bg); border: 1px solid var(--tpv-border); border-radius: 4px; padding: 6px 8px; margin: 4px 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.tpv-message code { background: var(--tpv-code-bg); border: 1px solid var(--tpv-border); border-radius: 3px; padding: 0 3px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--tpv-del-fg); }
.tpv-message pre code { border: none; padding: 0; color: inherit; }
.tpv-message a { color: var(--tpv-accent); }
.tpv-message blockquote { margin: 2px 0; padding-left: 10px; border-left: 4px solid var(--tpv-border); }
.tpv-message ul, .tpv-message ol { margin: 2px 0; padding-left: 22px; }
.tpv-line { display: block; min-height: 1.46em; }
.tpv-pre-wrap { display: block; white-space: pre-wrap; }
.tpv-mention { color: var(--tpv-accent); background: color-mix(in srgb, var(--tpv-accent) 12%, transparent); border-radius: 3px; padding: 0 2px; }
.tpv-emoji { font-size: 1.15em; }
img.tpv-emoji { width: 1.3em; height: 1.3em; vertical-align: -0.3em; }
.tpv-emoji-code { font-size: 12px; color: var(--tpv-muted); background: var(--tpv-code-bg); border-radius: 3px; padding: 0 3px; }
.tpv-header { font-weight: 700; font-size: 18px; margin: 2px 0; }
.tpv-section { display: flex; gap: 10px; align-items: flex-start; margin: 2px 0; }
.tpv-section-body { flex: 1; min-width: 0; }
.tpv-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; margin-top: 4px; }
.tpv-context { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--tpv-muted); margin: 2px 0; }
.tpv-context .tpv-image { width: 16px; height: 16px; }
.tpv-divider { border: none; border-top: 1px solid var(--tpv-border); margin: 6px 0; }
.tpv-image { max-width: 100%; max-height: 240px; border-radius: 4px; }
.tpv-section .tpv-image { width: 72px; height: 72px; object-fit: cover; }
.tpv-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.tpv-button { border: 1px solid var(--tpv-border); border-radius: 4px; padding: 1px 10px; font-size: 13px; font-weight: 600; }
.tpv-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.tpv-file { font-size: 13px; color: var(--tpv-muted); border: 1px solid var(--tpv-border); border-radius: 4px; padding: 0 6px; }
.tpv-unknown { color: var(--tpv-muted); font-size: 13px; }
`;
