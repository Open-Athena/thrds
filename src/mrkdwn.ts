/**
 * Slack mrkdwn and Block Kit helpers: the escaping, links, mentions and block shapes every bot re-writes.
 * Blocks are plain objects (Slack's JSON), loosely typed, so callers can pass anything Block Kit accepts.
 */

/** Escape text for mrkdwn: Slack treats only `&`, `<` and `>` as control characters. */
export const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `<url|label>`; the label is escaped, and `|` / `>` can't appear unescaped in either part. */
export function link(url: string, label?: string): string {
  const href = url.replace(/\|/g, "%7C").replace(/>/g, "%3E");
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

/** Cut `text` to at most `max` characters (by code point, so no split emoji), ending in `ellipsis` when cut. */
export function bound(text: string, max: number, ellipsis = "…"): string {
  const chars = [...text];
  if (chars.length <= max) return text;
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

/** An image block from a public URL, or (`{ slackFile }`) a file uploaded to Slack, by id. */
export function image(src: string | { slackFile: string }, alt: string, title?: string): Block {
  const block: Block = { type: "image", alt_text: alt };
  if (typeof src === "string") block["image_url"] = src;
  else block["slack_file"] = { id: src.slackFile };
  if (title) block["title"] = plainText(title);
  return block;
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

/**
 * Slack caps a view's `private_metadata` at 3000 characters. Encode JSON state for it, throwing (rather than letting
 * `views.open` fail opaquely) when it doesn't fit.
 */
export function encodePrivateMetadata(value: unknown): string {
  const s = JSON.stringify(value);
  if (s.length > 3000) throw new RangeError(`private_metadata is ${s.length} chars; Slack's limit is 3000`);
  return s;
}

export function decodePrivateMetadata<T = unknown>(s: string | undefined): T | null {
  if (!s) return null;
  return JSON.parse(s) as T;
}
