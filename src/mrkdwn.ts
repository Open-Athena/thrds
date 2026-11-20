/**
 * Slack mrkdwn and Block Kit helpers: the escaping, links, mentions and block shapes every bot re-writes.
 * Blocks are plain objects (Slack's JSON), loosely typed, so callers can pass anything Block Kit accepts.
 */

/** Escape text for mrkdwn: Slack treats only `&`, `<` and `>` as control characters. */
export const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `<url|label>`; the label is escaped, and `|` / `<` / `>` can't appear unescaped in either part. */
export function link(url: string, label?: string): string {
  const href = url.replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E");
  return label === undefined ? `<${href}>` : `<${href}|${escape(label).replace(/\|/g, "¦")}>`;
}

export const mention = {
  user: (id: string): string => `<@${id}>`,
  channel: (id: string): string => `<#${id}>`,
  /** A user group (`S…`). */
  group: (id: string): string => `<!subteam^${id}>`,
  here: "<!here>",
  channelAll: "<!channel>",
};

/**
 * `<!date^…>`: a timestamp each reader sees in their own time zone. `format` uses Slack's tokens
 * (`{date_short_pretty} at {time}`); `fallback` shows where it can't render (notifications, old clients).
 */
export function date(tsS: number, format: string, fallback: string, href?: string): string {
  return `<!date^${Math.floor(tsS)}^${format}${href ? `^${href}` : ""}|${escape(fallback)}>`;
}

/**
 * Cut `text` to at most `max` characters (by code point, so no split emoji), ending in `ellipsis` when cut. With
 * `atLine`, cut at the last line break past half the budget when there is one, ending in `\n…`.
 */
export function bound(text: string, max: number, options: string | { ellipsis?: string; atLine?: boolean } = {}): string {
  const { ellipsis = "…", atLine = false } = typeof options === "string" ? { ellipsis: options } : options;
  const chars = [...text];
  if (chars.length <= max) return text;
  if (atLine) {
    const tail = `\n${ellipsis}`;
    const room = Math.max(0, max - [...tail].length);
    const cut = chars.slice(0, room).join("").lastIndexOf("\n");
    if (cut >= 0 && [...text.slice(0, cut)].length >= room / 2) return text.slice(0, cut) + tail;
  }
  const keep = Math.max(0, max - [...ellipsis].length);
  return chars.slice(0, keep).join("") + ellipsis;
}

export type Block = Record<string, unknown>;

export const mrkdwnText = (text: string): Block => ({ type: "mrkdwn", text });
export const plainText = (text: string, emoji = true): Block => ({ type: "plain_text", text, emoji });

export const header = (text: string): Block => ({ type: "header", text: plainText(bound(text, 150)) });

export const divider = (): Block => ({ type: "divider" });

/** A mrkdwn section (Slack caps its text at 3000), with optional side `fields` and `accessory`. */
export function section(text: string, options: { fields?: string[]; accessory?: Block; blockId?: string } = {}): Block {
  const block: Block = { type: "section", text: mrkdwnText(bound(text, 3000)) };
  if (options.fields) block["fields"] = options.fields.map((f) => mrkdwnText(bound(f, 2000)));
  if (options.accessory) block["accessory"] = options.accessory;
  if (options.blockId) block["block_id"] = options.blockId;
  return block;
}

/** Small grey lines: strings become mrkdwn elements; pass `image(...)`-style objects as is. */
export function context(...elements: Array<string | Block>): Block {
  return { type: "context", elements: elements.map((e) => (typeof e === "string" ? mrkdwnText(e) : e)) };
}

/**
 * An image block: from a public URL (`image_url`), or a file uploaded to Slack, by id (`{ slackFile }`) or by its
 * `url_private` / permalink (`{ slackFileUrl }`). Edited in place, a URL image only refreshes under a new URL
 * (`versionedUrl`), and a Slack file must be processed first (`upload` waits by default). Phone apps offer no Download
 * on image blocks; attach the file (`Msg.files`) for that.
 */
export function image(src: string | { slackFile: string } | { slackFileUrl: string }, alt: string, title?: string): Block {
  const block: Block = { type: "image", alt_text: alt };
  if (typeof src === "string") block["image_url"] = src;
  else if ("slackFile" in src) block["slack_file"] = { id: src.slackFile };
  else block["slack_file"] = { url: src.slackFileUrl };
  if (title) block["title"] = plainText(title);
  return block;
}

/**
 * `url` with `v=<version>` set in its query: Slack caches an image block's picture by URL, so an edit that keeps the
 * URL keeps showing the old image. Use a content hash or timestamp as the version (or sign the URL per version).
 */
export function versionedUrl(url: string, version: string | number, param = "v"): string {
  const u = new URL(url);
  u.searchParams.set(param, String(version));
  return u.toString();
}

/** A `context` / `section`-accessory image element. */
export const imageElement = (url: string, alt: string): Block => ({ type: "image", image_url: url, alt_text: alt });

export interface ButtonOptions {
  text: string;
  actionId: string;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
  confirm?: { title: string; text: string; confirm: string; deny: string };
}

export function button(options: ButtonOptions): Block {
  const block: Block = { type: "button", text: plainText(options.text), action_id: options.actionId };
  if (options.value !== undefined) block["value"] = options.value;
  if (options.url !== undefined) block["url"] = options.url;
  if (options.style !== undefined) block["style"] = options.style;
  if (options.confirm) {
    block["confirm"] = {
      title: plainText(options.confirm.title),
      text: mrkdwnText(options.confirm.text),
      confirm: plainText(options.confirm.confirm),
      deny: plainText(options.confirm.deny),
    };
  }
  return block;
}

export function actions(elements: Block[], blockId?: string): Block {
  const block: Block = { type: "actions", elements };
  if (blockId) block["block_id"] = blockId;
  return block;
}

/** Slack's cap on a view's `private_metadata`. */
export const PRIVATE_METADATA_MAX = 3000;

/** Whether `value` fits in `private_metadata` as JSON (to degrade gracefully instead of throwing). */
export const fitsPrivateMetadata = (value: unknown): boolean => JSON.stringify(value).length <= PRIVATE_METADATA_MAX;

/**
 * Encode JSON state for a view's `private_metadata`, throwing (rather than letting `views.open` fail opaquely) when it
 * doesn't fit.
 */
export function encodePrivateMetadata(value: unknown): string {
  const s = JSON.stringify(value);
  if (s.length > PRIVATE_METADATA_MAX) throw new RangeError(`private_metadata is ${s.length} chars; Slack's limit is ${PRIVATE_METADATA_MAX}`);
  return s;
}

export function decodePrivateMetadata<T = unknown>(s: string | undefined): T | null {
  if (!s) return null;
  return JSON.parse(s) as T;
}

/**
 * `msg` without image blocks or image accessories: the `fallback` to post when Slack rejects a message whose image it
 * can't fetch yet (`invalid_blocks`), to be edited back in once it can.
 */
export function withoutImages<M extends { blocks?: unknown[] }>(msg: M): M {
  if (!msg.blocks) return msg;
  const blocks = msg.blocks
    .filter((b) => (b as Block)["type"] !== "image")
    .map((b) => {
      const block = b as Block;
      const accessory = block["accessory"] as Block | undefined;
      if (accessory?.["type"] !== "image") return block;
      const { accessory: _accessory, ...rest } = block;
      return rest;
    });
  return { ...msg, blocks };
}

/* ---- modal inputs ---- */

export const option = (text: string, value: string): Block => ({ text: plainText(text), value });

/** An `input` block: a labeled form field around `element`. */
export function input(options: { label: string; element: Block; blockId?: string; optional?: boolean; hint?: string; dispatchAction?: boolean }): Block {
  const block: Block = { type: "input", label: plainText(options.label), element: options.element };
  if (options.blockId !== undefined) block["block_id"] = options.blockId;
  if (options.optional) block["optional"] = true;
  if (options.hint !== undefined) block["hint"] = plainText(options.hint);
  if (options.dispatchAction) block["dispatch_action"] = true;
  return block;
}

export function plainTextInput(options: { actionId: string; multiline?: boolean; initial?: string; placeholder?: string; maxLength?: number }): Block {
  const el: Block = { type: "plain_text_input", action_id: options.actionId };
  if (options.multiline) el["multiline"] = true;
  if (options.initial !== undefined) el["initial_value"] = options.initial;
  if (options.placeholder !== undefined) el["placeholder"] = plainText(options.placeholder);
  if (options.maxLength !== undefined) el["max_length"] = options.maxLength;
  return el;
}

/** A single (`static_select`) or multi (`multi`: `multi_static_select`) select over `[text, value]` options. */
export function staticSelect(options: {
  actionId: string;
  options: Array<[string, string]>;
  initial?: string | string[];
  placeholder?: string;
  multi?: boolean;
}): Block {
  const opts = options.options.map(([t, v]) => option(t, v));
  const el: Block = { type: options.multi ? "multi_static_select" : "static_select", action_id: options.actionId, options: opts };
  if (options.placeholder !== undefined) el["placeholder"] = plainText(options.placeholder);
  if (options.initial !== undefined) {
    const chosen = ([] as string[]).concat(options.initial);
    const picked = opts.filter((o) => chosen.includes(o["value"] as string));
    if (options.multi) el["initial_options"] = picked;
    else if (picked[0]) el["initial_option"] = picked[0];
  }
  return el;
}

export function usersSelect(options: { actionId: string; initial?: string; placeholder?: string }): Block {
  const el: Block = { type: "users_select", action_id: options.actionId };
  if (options.initial !== undefined) el["initial_user"] = options.initial;
  if (options.placeholder !== undefined) el["placeholder"] = plainText(options.placeholder);
  return el;
}

export function datePicker(options: { actionId: string; initial?: string; placeholder?: string }): Block {
  const el: Block = { type: "datepicker", action_id: options.actionId };
  if (options.initial !== undefined) el["initial_date"] = options.initial;
  if (options.placeholder !== undefined) el["placeholder"] = plainText(options.placeholder);
  return el;
}

/** A modal view. */
export function modal(options: {
  title: string;
  blocks: Block[];
  submit?: string;
  close?: string;
  callbackId?: string;
  privateMetadata?: string;
  externalId?: string;
}): Block {
  const view: Block = { type: "modal", title: plainText(bound(options.title, 24)), blocks: options.blocks };
  if (options.submit !== undefined) view["submit"] = plainText(options.submit);
  if (options.close !== undefined) view["close"] = plainText(options.close);
  if (options.callbackId !== undefined) view["callback_id"] = options.callbackId;
  if (options.privateMetadata !== undefined) view["private_metadata"] = options.privateMetadata;
  if (options.externalId !== undefined) view["external_id"] = options.externalId;
  return view;
}

/* ---- rich_text ---- */

export interface RichStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

/**
 * `rich_text` builders: literal text that mrkdwn would mangle (emoji inside link anchors, `*` and `_` as themselves),
 * real bullet lists, and per-run styles.
 */
export const rich = {
  /** The `rich_text` block. */
  block: (...elements: Block[]): Block => ({ type: "rich_text", elements }),
  /** A paragraph of inline elements (strings become plain text). */
  section: (...elements: Array<string | Block>): Block => ({
    type: "rich_text_section",
    elements: elements.map((e) => (typeof e === "string" ? rich.text(e) : e)),
  }),
  /** A bullet (or numbered) list of sections. */
  list: (items: Block[], options: { style?: "bullet" | "ordered"; indent?: number } = {}): Block => {
    const block: Block = { type: "rich_text_list", style: options.style ?? "bullet", elements: items };
    if (options.indent) block["indent"] = options.indent;
    return block;
  },
  quote: (...elements: Array<string | Block>): Block => ({
    type: "rich_text_quote",
    elements: elements.map((e) => (typeof e === "string" ? rich.text(e) : e)),
  }),
  preformatted: (text: string): Block => ({ type: "rich_text_preformatted", elements: [rich.text(text)] }),
  text: (text: string, style?: RichStyle): Block => (style ? { type: "text", text, style } : { type: "text", text }),
  link: (url: string, text?: string, style?: RichStyle): Block => {
    const el: Block = { type: "link", url };
    if (text !== undefined) el["text"] = text;
    if (style) el["style"] = style;
    return el;
  },
  /** An emoji by name (`"star"`, not `":star:"`). */
  emoji: (name: string): Block => ({ type: "emoji", name: name.replace(/^:|:$/g, "") }),
  user: (id: string): Block => ({ type: "user", user_id: id }),
  channel: (id: string): Block => ({ type: "channel", channel_id: id }),
  date: (tsS: number, format: string, fallback?: string): Block => {
    const el: Block = { type: "date", timestamp: Math.floor(tsS), format };
    if (fallback !== undefined) el["fallback"] = fallback;
    return el;
  },
};
