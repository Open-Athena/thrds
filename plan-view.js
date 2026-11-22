import {
  REWRITE_KINDS,
  describeSender,
  lineDiff,
  planCounts,
  senderChanged,
  writes
} from "./chunk-L4VEQWK7.js";

// src/plan-view/index.tsx
import { useMemo, useState } from "react";

// src/plan-view/slack.tsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var COMMON_EMOJI = {
  "+1": "\u{1F44D}",
  thumbsup: "\u{1F44D}",
  "-1": "\u{1F44E}",
  white_check_mark: "\u2705",
  heavy_check_mark: "\u2714\uFE0F",
  x: "\u274C",
  warning: "\u26A0\uFE0F",
  rotating_light: "\u{1F6A8}",
  large_green_circle: "\u{1F7E2}",
  large_yellow_circle: "\u{1F7E1}",
  large_orange_circle: "\u{1F7E0}",
  red_circle: "\u{1F534}",
  large_blue_circle: "\u{1F535}",
  white_circle: "\u26AA",
  black_circle: "\u26AB",
  green_heart: "\u{1F49A}",
  fire: "\u{1F525}",
  tada: "\u{1F389}",
  rocket: "\u{1F680}",
  eyes: "\u{1F440}",
  hourglass: "\u231B",
  hourglass_flowing_sand: "\u23F3",
  bar_chart: "\u{1F4CA}",
  chart_with_upwards_trend: "\u{1F4C8}",
  chart_with_downwards_trend: "\u{1F4C9}",
  floppy_disk: "\u{1F4BE}",
  cd: "\u{1F4BF}",
  dvd: "\u{1F4C0}",
  file_folder: "\u{1F4C1}",
  open_file_folder: "\u{1F4C2}",
  wastebasket: "\u{1F5D1}\uFE0F",
  broom: "\u{1F9F9}",
  gear: "\u2699\uFE0F",
  wrench: "\u{1F527}",
  hammer_and_wrench: "\u{1F6E0}\uFE0F",
  robot_face: "\u{1F916}",
  memo: "\u{1F4DD}",
  pushpin: "\u{1F4CC}",
  link: "\u{1F517}",
  lock: "\u{1F512}",
  bulb: "\u{1F4A1}",
  question: "\u2753",
  exclamation: "\u2757",
  information_source: "\u2139\uFE0F",
  arrow_right: "\u27A1\uFE0F",
  arrow_up: "\u2B06\uFE0F",
  arrow_down: "\u2B07\uFE0F",
  zap: "\u26A1",
  cloud: "\u2601\uFE0F",
  calendar: "\u{1F4C6}",
  clock3: "\u{1F552}",
  stopwatch: "\u23F1\uFE0F",
  moneybag: "\u{1F4B0}",
  dollar: "\u{1F4B5}",
  package: "\u{1F4E6}",
  sparkles: "\u2728",
  star: "\u2B50"
};
var decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function Emoji({ name, emoji }) {
  const v = emoji?.[name] ?? COMMON_EMOJI[name];
  if (v === void 0) return /* @__PURE__ */ jsxs("span", { className: "tpv-emoji-code", children: [
    ":",
    name,
    ":"
  ] });
  if (/^https?:\/\//.test(v)) return /* @__PURE__ */ jsx("img", { className: "tpv-emoji", src: v, alt: `:${name}:`, title: `:${name}:` });
  return /* @__PURE__ */ jsx("span", { className: "tpv-emoji", title: `:${name}:`, children: v });
}
var INLINE = /(`[^`\n]+`)|<([^>|\n]+)(?:\|([^>\n]+))?>|:([a-z0-9_+'-]+):|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w~])~([^~\n]+)~(?![\w~])/g;
function linkTarget(target, label, key) {
  if (target.startsWith("@")) return /* @__PURE__ */ jsxs("span", { className: "tpv-mention", children: [
    "@",
    label ?? target.slice(1)
  ] }, key);
  if (target.startsWith("#")) return /* @__PURE__ */ jsxs("span", { className: "tpv-mention", children: [
    "#",
    label ?? target.slice(1)
  ] }, key);
  if (target.startsWith("!")) {
    const name = target.slice(1).split("^")[0];
    return /* @__PURE__ */ jsx("span", { className: "tpv-mention", children: label ?? `@${name}` }, key);
  }
  return /* @__PURE__ */ jsx("a", { href: decode(target), target: "_blank", rel: "noreferrer", children: decode(label ?? target) }, key);
}
function inline(text, opts = {}) {
  const out = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(decode(text.slice(last, at)));
    const [, code, target, label, emoji, bold, italic, strike] = m;
    if (code !== void 0) out.push(/* @__PURE__ */ jsx("code", { children: decode(code.slice(1, -1)) }, key));
    else if (target !== void 0) out.push(linkTarget(target, label, key));
    else if (emoji !== void 0) out.push(/* @__PURE__ */ jsx(Emoji, { name: emoji, emoji: opts.emoji }, key));
    else if (bold !== void 0) out.push(/* @__PURE__ */ jsx("b", { children: inline(bold, opts) }, key));
    else if (italic !== void 0) out.push(/* @__PURE__ */ jsx("i", { children: inline(italic, opts) }, key));
    else if (strike !== void 0) out.push(/* @__PURE__ */ jsx("s", { children: inline(strike, opts) }, key));
    key++;
    last = at + m[0].length;
  }
  if (last < text.length) out.push(decode(text.slice(last)));
  return out;
}
var QUOTE = /^(?:>|&gt;) ?/;
function Mrkdwn({ text, emoji }) {
  const parts = text.split("```");
  return /* @__PURE__ */ jsx("div", { className: "tpv-mrkdwn", children: parts.map(
    (part, i) => i % 2 === 1 ? /* @__PURE__ */ jsx("pre", { children: decode(part.replace(/^\n/, "")) }, i) : /* @__PURE__ */ jsx(Lines, { text: part, emoji }, i)
  ) });
}
function Lines({ text, emoji }) {
  if (text === "") return null;
  const lines = text.split("\n");
  const groups = [];
  for (const line of lines) {
    const quote = QUOTE.test(line);
    const body = quote ? line.replace(QUOTE, "") : line;
    const g = groups[groups.length - 1];
    if (g !== void 0 && g.quote === quote) g.lines.push(body);
    else groups.push({ quote, lines: [body] });
  }
  const opts = { emoji };
  return /* @__PURE__ */ jsx(Fragment, { children: groups.map((g, i) => {
    const body = g.lines.map((l, j) => /* @__PURE__ */ jsx("span", { className: "tpv-line", children: inline(l, opts) }, j));
    return g.quote ? /* @__PURE__ */ jsx("blockquote", { children: body }, i) : /* @__PURE__ */ jsx("span", { children: body }, i);
  }) });
}
var str = (v) => typeof v === "string" ? v : "";
var arr = (v) => Array.isArray(v) ? v : [];
var obj = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : void 0;
function TextObject({ t, emoji }) {
  if (t === void 0) return null;
  if (t["type"] === "mrkdwn") return /* @__PURE__ */ jsx(Mrkdwn, { text: str(t["text"]), emoji });
  return /* @__PURE__ */ jsx("span", { children: str(t["text"]) });
}
function imageSrc(b) {
  const url = str(b["image_url"]);
  if (url) return url;
  const file = obj(b["slack_file"]);
  return file === void 0 ? void 0 : str(file["url"]) || void 0;
}
function Image({ b }) {
  const src = imageSrc(b);
  const alt = str(b["alt_text"]);
  if (src === void 0) {
    const id = str(obj(b["slack_file"])?.["id"]);
    return /* @__PURE__ */ jsxs("span", { className: "tpv-file", children: [
      "\u{1F5BC} ",
      id || "image"
    ] });
  }
  return /* @__PURE__ */ jsx("img", { className: "tpv-image", src, alt, title: alt });
}
function RichInline({ e, emoji }) {
  switch (e["type"]) {
    case "text": {
      const style = obj(e["style"]) ?? {};
      let node = str(e["text"]);
      if (style["code"]) node = /* @__PURE__ */ jsx("code", { children: node });
      if (style["bold"]) node = /* @__PURE__ */ jsx("b", { children: node });
      if (style["italic"]) node = /* @__PURE__ */ jsx("i", { children: node });
      if (style["strike"]) node = /* @__PURE__ */ jsx("s", { children: node });
      return node;
    }
    case "link":
      return /* @__PURE__ */ jsx("a", { href: str(e["url"]), target: "_blank", rel: "noreferrer", children: str(e["text"]) || str(e["url"]) });
    case "emoji":
      return /* @__PURE__ */ jsx(Emoji, { name: str(e["name"]), emoji });
    case "user":
      return /* @__PURE__ */ jsxs("span", { className: "tpv-mention", children: [
        "@",
        str(e["user_id"])
      ] });
    case "channel":
      return /* @__PURE__ */ jsxs("span", { className: "tpv-mention", children: [
        "#",
        str(e["channel_id"])
      ] });
    case "usergroup":
      return /* @__PURE__ */ jsxs("span", { className: "tpv-mention", children: [
        "@",
        str(e["usergroup_id"])
      ] });
    case "broadcast":
      return /* @__PURE__ */ jsxs("span", { className: "tpv-mention", children: [
        "@",
        str(e["range"])
      ] });
    case "date":
      return /* @__PURE__ */ jsx("span", { children: str(e["fallback"]) || str(e["timestamp"]) });
    default:
      return /* @__PURE__ */ jsxs("span", { className: "tpv-unknown", children: [
        "[",
        str(e["type"]),
        "]"
      ] });
  }
}
function RichSection({ s, emoji }) {
  return /* @__PURE__ */ jsx(Fragment, { children: arr(s["elements"]).map((e, i) => /* @__PURE__ */ jsx(RichInline, { e, emoji }, i)) });
}
function RichText({ b, emoji }) {
  return /* @__PURE__ */ jsx("div", { className: "tpv-mrkdwn", children: arr(b["elements"]).map((el, i) => {
    switch (el["type"]) {
      case "rich_text_section":
        return /* @__PURE__ */ jsx("span", { className: "tpv-pre-wrap", children: /* @__PURE__ */ jsx(RichSection, { s: el, emoji }) }, i);
      case "rich_text_list": {
        const items = arr(el["elements"]).map((s, j) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(RichSection, { s, emoji }) }, j));
        return el["style"] === "ordered" ? /* @__PURE__ */ jsx("ol", { children: items }, i) : /* @__PURE__ */ jsx("ul", { children: items }, i);
      }
      case "rich_text_preformatted":
        return /* @__PURE__ */ jsx("pre", { children: /* @__PURE__ */ jsx(RichSection, { s: el, emoji }) }, i);
      case "rich_text_quote":
        return /* @__PURE__ */ jsx("blockquote", { className: "tpv-pre-wrap", children: /* @__PURE__ */ jsx(RichSection, { s: el, emoji }) }, i);
      default:
        return /* @__PURE__ */ jsxs("span", { className: "tpv-unknown", children: [
          "[",
          str(el["type"]),
          "]"
        ] }, i);
    }
  }) });
}
function BlockView({ block, emoji }) {
  const b = block;
  switch (b["type"]) {
    case "header":
      return /* @__PURE__ */ jsx("div", { className: "tpv-header", children: str(obj(b["text"])?.["text"]) });
    case "section": {
      const fields = arr(b["fields"]);
      const accessory = obj(b["accessory"]);
      return /* @__PURE__ */ jsxs("div", { className: "tpv-section", children: [
        /* @__PURE__ */ jsxs("div", { className: "tpv-section-body", children: [
          /* @__PURE__ */ jsx(TextObject, { t: obj(b["text"]), emoji }),
          fields.length > 0 && /* @__PURE__ */ jsx("div", { className: "tpv-fields", children: fields.map((f, i) => /* @__PURE__ */ jsx(TextObject, { t: f, emoji }, i)) })
        ] }),
        accessory?.["type"] === "image" && /* @__PURE__ */ jsx(Image, { b: accessory })
      ] });
    }
    case "context":
      return /* @__PURE__ */ jsx("div", { className: "tpv-context", children: arr(b["elements"]).map(
        (e, i) => e["type"] === "image" ? /* @__PURE__ */ jsx(Image, { b: e }, i) : /* @__PURE__ */ jsx(TextObject, { t: e, emoji }, i)
      ) });
    case "divider":
      return /* @__PURE__ */ jsx("hr", { className: "tpv-divider" });
    case "image":
      return /* @__PURE__ */ jsx(Image, { b });
    case "rich_text":
      return /* @__PURE__ */ jsx(RichText, { b, emoji });
    case "actions":
      return /* @__PURE__ */ jsx("div", { className: "tpv-actions", children: arr(b["elements"]).map((e, i) => /* @__PURE__ */ jsx("span", { className: "tpv-button", children: str(obj(e["text"])?.["text"]) || str(e["type"]) }, i)) });
    default:
      return /* @__PURE__ */ jsxs("div", { className: "tpv-unknown", children: [
        "[",
        str(b["type"]),
        " block]"
      ] });
  }
}
function SlackMessage({ content, emoji }) {
  const { blocks, text, sender, files } = content;
  return /* @__PURE__ */ jsxs("div", { className: "tpv-message", children: [
    (sender.username !== null || sender.icon_emoji !== null || sender.icon_url !== null) && /* @__PURE__ */ jsxs("div", { className: "tpv-sender", children: [
      sender.icon_url !== null ? /* @__PURE__ */ jsx("img", { className: "tpv-avatar", src: sender.icon_url, alt: "" }) : sender.icon_emoji !== null ? /* @__PURE__ */ jsx(Emoji, { name: sender.icon_emoji.replace(/^:|:$/g, ""), emoji }) : null,
      /* @__PURE__ */ jsx("b", { children: sender.username ?? "the app" })
    ] }),
    blocks !== null && blocks.length > 0 ? blocks.map((b, i) => /* @__PURE__ */ jsx(BlockView, { block: b, emoji }, i)) : /* @__PURE__ */ jsx(Mrkdwn, { text, emoji }),
    files.length > 0 && /* @__PURE__ */ jsx("div", { className: "tpv-files", children: files.map((f) => /* @__PURE__ */ jsxs("span", { className: "tpv-file", children: [
      "\u{1F4CE} ",
      f
    ] }, f)) })
  ] });
}

// src/plan-view/style.ts
var PLAN_VIEW_CSS = `
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

// src/plan-view/index.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var DEFAULT_KINDS = ["edit", "repost", "skip", "blocked"];
function matches(a, query) {
  if (query === "") return true;
  const q = query.toLowerCase();
  return [a.ts, a.thread_ts ?? "", a.reason ?? "", a.old.text, a.new?.text ?? ""].some((s) => s.toLowerCase().includes(q));
}
function PlanView({
  plan,
  outcomes = {},
  onApply,
  onCheck,
  renderContent,
  messageHref,
  emoji,
  initialKinds = DEFAULT_KINDS,
  unstyled = false
}) {
  const counts = useMemo(() => plan.counts ?? planCounts(plan), [plan]);
  const [kinds, setKinds] = useState(() => new Set(initialKinds));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set(plan.actions.filter(writes).map((a) => a.ts)));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const shown = plan.actions.filter((a) => kinds.has(a.kind) && matches(a, query));
  const shownWrites = shown.filter(writes);
  const chosen = plan.actions.filter((a) => writes(a) && selected.has(a.ts));
  const interactive = onApply !== void 0 || onCheck !== void 0;
  const toggleKind = (k) => setKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });
  const toggle = (ts) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(ts)) next.delete(ts);
    else next.add(ts);
    return next;
  });
  const setAllShown = (on) => setSelected((prev) => {
    const next = new Set(prev);
    for (const a of shownWrites) {
      if (on) next.add(a.ts);
      else next.delete(a.ts);
    }
    return next;
  });
  const run = async (which, fn) => {
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
  return /* @__PURE__ */ jsxs2("div", { className: "tpv", children: [
    !unstyled && /* @__PURE__ */ jsx2("style", { children: PLAN_VIEW_CSS }),
    /* @__PURE__ */ jsxs2("div", { className: "tpv-toolbar", children: [
      /* @__PURE__ */ jsx2("div", { className: "tpv-kinds", role: "group", "aria-label": "Filter by kind", children: REWRITE_KINDS.map((k) => /* @__PURE__ */ jsxs2(
        "button",
        {
          type: "button",
          className: `tpv-chip tpv-kind-${k}`,
          "aria-pressed": kinds.has(k),
          onClick: () => toggleKind(k),
          children: [
            k,
            " ",
            /* @__PURE__ */ jsx2("span", { className: "tpv-count", children: counts[k] })
          ]
        },
        k
      )) }),
      /* @__PURE__ */ jsx2(
        "input",
        {
          className: "tpv-search",
          type: "search",
          placeholder: "Filter by text or ts",
          value: query,
          onChange: (e) => setQuery(e.target.value)
        }
      )
    ] }),
    interactive && /* @__PURE__ */ jsxs2("div", { className: "tpv-applybar", children: [
      /* @__PURE__ */ jsxs2("span", { children: [
        chosen.length,
        " of ",
        counts.edit + counts.repost,
        " selected"
      ] }),
      /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-link", onClick: () => setAllShown(true), disabled: shownWrites.length === 0, children: "Select shown" }),
      /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-link", onClick: () => setAllShown(false), disabled: shownWrites.length === 0, children: "Clear shown" }),
      /* @__PURE__ */ jsx2("span", { className: "tpv-spacer" }),
      onCheck !== void 0 && /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-btn", disabled: chosen.length === 0 || busy !== null, onClick: () => run("check", onCheck), children: busy === "check" ? "Checking\u2026" : "Check" }),
      onApply !== void 0 && (confirming ? /* @__PURE__ */ jsxs2("span", { className: "tpv-confirm", children: [
        "Write ",
        chosen.length,
        " message",
        chosen.length === 1 ? "" : "s",
        " to Slack?",
        /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-btn tpv-primary", disabled: busy !== null, onClick: () => run("apply", onApply), children: busy === "apply" ? "Applying\u2026" : "Apply" }),
        /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-btn", disabled: busy !== null, onClick: () => setConfirming(false), children: "Cancel" })
      ] }) : /* @__PURE__ */ jsxs2("button", { type: "button", className: "tpv-btn tpv-primary", disabled: chosen.length === 0 || busy !== null, onClick: () => setConfirming(true), children: [
        "Apply ",
        chosen.length,
        "\u2026"
      ] }))
    ] }),
    error !== null && /* @__PURE__ */ jsx2("div", { className: "tpv-error", children: error }),
    shown.length === 0 ? /* @__PURE__ */ jsx2("div", { className: "tpv-empty", children: "No actions match." }) : /* @__PURE__ */ jsx2("ol", { className: "tpv-actions-list", children: shown.map((a) => /* @__PURE__ */ jsx2(
      ActionRow,
      {
        action: a,
        outcome: outcomes[a.ts],
        selectable: interactive && writes(a),
        selected: selected.has(a.ts),
        onToggle: () => toggle(a.ts),
        renderContent,
        href: messageHref?.(a),
        emoji
      },
      a.ts
    )) })
  ] });
}
function ActionRow({ action: a, outcome, selectable, selected, onToggle, renderContent, href, emoji }) {
  const [mode, setMode] = useState("rendered");
  const render = (c, side) => renderContent?.(c, side, a) ?? /* @__PURE__ */ jsx2(SlackMessage, { content: c, emoji });
  const ts = href === void 0 ? /* @__PURE__ */ jsx2("code", { children: a.ts }) : /* @__PURE__ */ jsx2("a", { href, target: "_blank", rel: "noreferrer", children: /* @__PURE__ */ jsx2("code", { children: a.ts }) });
  return /* @__PURE__ */ jsxs2("li", { className: `tpv-action tpv-action-${a.kind}`, children: [
    /* @__PURE__ */ jsxs2("div", { className: "tpv-action-head", children: [
      selectable && /* @__PURE__ */ jsx2("input", { type: "checkbox", checked: selected, onChange: onToggle, "aria-label": `Select ${a.ts}` }),
      /* @__PURE__ */ jsx2("span", { className: `tpv-badge tpv-kind-${a.kind}`, children: a.kind }),
      ts,
      a.thread_ts !== null && /* @__PURE__ */ jsxs2("span", { className: "tpv-muted", children: [
        "in thread ",
        a.thread_ts
      ] }),
      a.reason !== null && /* @__PURE__ */ jsx2("span", { className: "tpv-reason", children: a.reason }),
      outcome !== void 0 && /* @__PURE__ */ jsxs2("span", { className: `tpv-status tpv-status-${outcome.status}`, title: outcome.error, children: [
        outcome.status,
        outcome.new_ts !== void 0 ? ` \u2192 ${outcome.new_ts}` : "",
        outcome.error !== void 0 ? `: ${outcome.error}` : ""
      ] }),
      a.new !== null && writes(a) && /* @__PURE__ */ jsxs2("span", { className: "tpv-modes", children: [
        /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-link", "aria-pressed": mode === "rendered", onClick: () => setMode("rendered"), children: "Rendered" }),
        /* @__PURE__ */ jsx2("button", { type: "button", className: "tpv-link", "aria-pressed": mode === "diff", onClick: () => setMode("diff"), children: "Diff" })
      ] })
    ] }),
    senderChanged(a) && a.new !== null && /* @__PURE__ */ jsxs2("div", { className: "tpv-sender-change", children: [
      "Sender: ",
      describeSender(a.old.sender),
      " \u2192 ",
      describeSender(a.new.sender)
    ] }),
    a.new === null || !writes(a) ? /* @__PURE__ */ jsx2("div", { className: "tpv-single", children: render(a.old, "old") }) : mode === "diff" ? /* @__PURE__ */ jsx2(Diff, { from: a.old.text, to: a.new.text }) : /* @__PURE__ */ jsxs2("div", { className: "tpv-sides", children: [
      /* @__PURE__ */ jsxs2("div", { className: "tpv-side", children: [
        /* @__PURE__ */ jsx2("div", { className: "tpv-side-label", children: "Now" }),
        render(a.old, "old")
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "tpv-side", children: [
        /* @__PURE__ */ jsx2("div", { className: "tpv-side-label", children: "Planned" }),
        render(a.new, "new")
      ] })
    ] })
  ] });
}
function Diff({ from, to }) {
  const lines = lineDiff(from, to);
  if (lines.every((l) => l.op === " ")) return /* @__PURE__ */ jsx2("div", { className: "tpv-muted tpv-diff-none", children: "Text unchanged (blocks or sender change)." });
  return /* @__PURE__ */ jsx2("pre", { className: "tpv-diff", children: lines.map((l, i) => /* @__PURE__ */ jsxs2("span", { className: l.op === "-" ? "tpv-del" : l.op === "+" ? "tpv-add" : void 0, children: [
    l.op,
    l.text,
    "\n"
  ] }, i)) });
}
export {
  BlockView,
  COMMON_EMOJI,
  Diff,
  Emoji,
  Mrkdwn,
  PLAN_VIEW_CSS,
  PlanView,
  SlackMessage,
  inline
};
//# sourceMappingURL=plan-view.js.map