/**
 * A Slack message rendered as React elements for review: wire mrkdwn (bold, italic, strike, code, links, mentions,
 * quotes, emoji) and Block Kit (header, section, context, divider, image, rich_text, actions). Close to what Slack
 * shows, not pixel-exact; no raw HTML is injected.
 */
import type { ReactNode } from "react";
import type { Block } from "../mrkdwn.js";
import type { RewriteContent } from "../rewrite.js";

/** Emoji name → a unicode character or an image URL (a workspace's custom emoji). */
export type EmojiMap = Record<string, string>;

/** A few common Slack shortcodes; anything else shows as its `:code:` unless the app's `emoji` map has it. */
export const COMMON_EMOJI: EmojiMap = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  rotating_light: "🚨",
  large_green_circle: "🟢",
  large_yellow_circle: "🟡",
  large_orange_circle: "🟠",
  red_circle: "🔴",
  large_blue_circle: "🔵",
  white_circle: "⚪",
  black_circle: "⚫",
  green_heart: "💚",
  fire: "🔥",
  tada: "🎉",
  rocket: "🚀",
  eyes: "👀",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  bar_chart: "📊",
  chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉",
  floppy_disk: "💾",
  cd: "💿",
  dvd: "📀",
  file_folder: "📁",
  open_file_folder: "📂",
  wastebasket: "🗑️",
  broom: "🧹",
  gear: "⚙️",
  wrench: "🔧",
  hammer_and_wrench: "🛠️",
  robot_face: "🤖",
  memo: "📝",
  pushpin: "📌",
  link: "🔗",
  lock: "🔒",
  bulb: "💡",
  question: "❓",
  exclamation: "❗",
  information_source: "ℹ️",
  arrow_right: "➡️",
  arrow_up: "⬆️",
  arrow_down: "⬇️",
  zap: "⚡",
  cloud: "☁️",
  calendar: "📆",
  clock3: "🕒",
  stopwatch: "⏱️",
  moneybag: "💰",
  dollar: "💵",
  package: "📦",
  sparkles: "✨",
  star: "⭐",
};

export interface RenderOptions {
  emoji?: EmojiMap;
}

const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function Emoji({ name, emoji }: { name: string; emoji?: EmojiMap }): ReactNode {
  const v = emoji?.[name] ?? COMMON_EMOJI[name];
  if (v === undefined) return <span className="tpv-emoji-code">:{name}:</span>;
  if (/^https?:\/\//.test(v)) return <img className="tpv-emoji" src={v} alt={`:${name}:`} title={`:${name}:`} />;
  return (
    <span className="tpv-emoji" title={`:${name}:`}>
      {v}
    </span>
  );
}

// Order matters: code spans first (no formatting inside), then <…> links, emoji, and the three wrapping styles.
const INLINE =
  /(`[^`\n]+`)|<([^>|\n]+)(?:\|([^>\n]+))?>|:([a-z0-9_+'-]+):|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w~])~([^~\n]+)~(?![\w~])/g;

function linkTarget(target: string, label: string | undefined, key: number): ReactNode {
  if (target.startsWith("@")) return <span key={key} className="tpv-mention">@{label ?? target.slice(1)}</span>;
  if (target.startsWith("#")) return <span key={key} className="tpv-mention">#{label ?? target.slice(1)}</span>;
  if (target.startsWith("!")) {
    const name = target.slice(1).split("^")[0];
    return <span key={key} className="tpv-mention">{label ?? `@${name}`}</span>;
  }
  return (
    <a key={key} href={decode(target)} target="_blank" rel="noreferrer">
      {decode(label ?? target)}
    </a>
  );
}

/** One line of mrkdwn (no newlines) as inline nodes. */
export function inline(text: string, opts: RenderOptions = {}): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(decode(text.slice(last, at)));
    const [, code, target, label, emoji, bold, italic, strike] = m;
    if (code !== undefined) out.push(<code key={key}>{decode(code.slice(1, -1))}</code>);
    else if (target !== undefined) out.push(linkTarget(target, label, key));
    else if (emoji !== undefined) out.push(<Emoji key={key} name={emoji} emoji={opts.emoji} />);
    else if (bold !== undefined) out.push(<b key={key}>{inline(bold, opts)}</b>);
    else if (italic !== undefined) out.push(<i key={key}>{inline(italic, opts)}</i>);
    else if (strike !== undefined) out.push(<s key={key}>{inline(strike, opts)}</s>);
    key++;
    last = at + m[0].length;
  }
  if (last < text.length) out.push(decode(text.slice(last)));
  return out;
}

const QUOTE = /^(?:>|&gt;) ?/;

/** Wire mrkdwn as block-level nodes: ``` fences, `>` quotes, lines. */
export function Mrkdwn({ text, emoji }: { text: string; emoji?: EmojiMap }): ReactNode {
  const parts = text.split("```");
  return (
    <div className="tpv-mrkdwn">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i}>{decode(part.replace(/^\n/, ""))}</pre>
        ) : (
          <Lines key={i} text={part} emoji={emoji} />
        ),
      )}
    </div>
  );
}

function Lines({ text, emoji }: { text: string; emoji?: EmojiMap }): ReactNode {
  if (text === "") return null;
  const lines = text.split("\n");
  const groups: { quote: boolean; lines: string[] }[] = [];
  for (const line of lines) {
    const quote = QUOTE.test(line);
    const body = quote ? line.replace(QUOTE, "") : line;
    const g = groups[groups.length - 1];
    if (g !== undefined && g.quote === quote) g.lines.push(body);
    else groups.push({ quote, lines: [body] });
  }
  const opts = { emoji };
  return (
    <>
      {groups.map((g, i) => {
        const body = g.lines.map((l, j) => (
          <span key={j} className="tpv-line">
            {inline(l, opts)}
          </span>
        ));
        return g.quote ? <blockquote key={i}>{body}</blockquote> : <span key={i}>{body}</span>;
      })}
    </>
  );
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

function TextObject({ t, emoji }: { t: Json | undefined; emoji?: EmojiMap }): ReactNode {
  if (t === undefined) return null;
  if (t["type"] === "mrkdwn") return <Mrkdwn text={str(t["text"])} emoji={emoji} />;
  return <span>{str(t["text"])}</span>;
}

function imageSrc(b: Json): string | undefined {
  const url = str(b["image_url"]);
  if (url) return url;
  const file = obj(b["slack_file"]);
  return file === undefined ? undefined : str(file["url"]) || undefined;
}

function Image({ b }: { b: Json }): ReactNode {
  const src = imageSrc(b);
  const alt = str(b["alt_text"]);
  if (src === undefined) {
    const id = str(obj(b["slack_file"])?.["id"]);
    return <span className="tpv-file">🖼 {id || "image"}</span>;
  }
  return <img className="tpv-image" src={src} alt={alt} title={alt} />;
}

function RichInline({ e, emoji }: { e: Json; emoji?: EmojiMap }): ReactNode {
  switch (e["type"]) {
    case "text": {
      const style = obj(e["style"]) ?? {};
      let node: ReactNode = str(e["text"]);
      if (style["code"]) node = <code>{node}</code>;
      if (style["bold"]) node = <b>{node}</b>;
      if (style["italic"]) node = <i>{node}</i>;
      if (style["strike"]) node = <s>{node}</s>;
      return node;
    }
    case "link":
      return (
        <a href={str(e["url"])} target="_blank" rel="noreferrer">
          {str(e["text"]) || str(e["url"])}
        </a>
      );
    case "emoji":
      return <Emoji name={str(e["name"])} emoji={emoji} />;
    case "user":
      return <span className="tpv-mention">@{str(e["user_id"])}</span>;
    case "channel":
      return <span className="tpv-mention">#{str(e["channel_id"])}</span>;
    case "usergroup":
      return <span className="tpv-mention">@{str(e["usergroup_id"])}</span>;
    case "broadcast":
      return <span className="tpv-mention">@{str(e["range"])}</span>;
    case "date":
      return <span>{str(e["fallback"]) || str(e["timestamp"])}</span>;
    default:
      return <span className="tpv-unknown">[{str(e["type"])}]</span>;
  }
}

function RichSection({ s, emoji }: { s: Json; emoji?: EmojiMap }): ReactNode {
  return (
    <>
      {arr(s["elements"]).map((e, i) => (
        <RichInline key={i} e={e} emoji={emoji} />
      ))}
    </>
  );
}

function RichText({ b, emoji }: { b: Json; emoji?: EmojiMap }): ReactNode {
  return (
    <div className="tpv-mrkdwn">
      {arr(b["elements"]).map((el, i) => {
        switch (el["type"]) {
          case "rich_text_section":
            return (
              <span key={i} className="tpv-pre-wrap">
                <RichSection s={el} emoji={emoji} />
              </span>
            );
          case "rich_text_list": {
            const items = arr(el["elements"]).map((s, j) => (
              <li key={j}>
                <RichSection s={s} emoji={emoji} />
              </li>
            ));
            return el["style"] === "ordered" ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
          case "rich_text_preformatted":
            return (
              <pre key={i}>
                <RichSection s={el} emoji={emoji} />
              </pre>
            );
          case "rich_text_quote":
            return (
              <blockquote key={i} className="tpv-pre-wrap">
                <RichSection s={el} emoji={emoji} />
              </blockquote>
            );
          default:
            return (
              <span key={i} className="tpv-unknown">
                [{str(el["type"])}]
              </span>
            );
        }
      })}
    </div>
  );
}

export function BlockView({ block, emoji }: { block: Block; emoji?: EmojiMap }): ReactNode {
  const b = block as Json;
  switch (b["type"]) {
    case "header":
      return <div className="tpv-header">{str(obj(b["text"])?.["text"])}</div>;
    case "section": {
      const fields = arr(b["fields"]);
      const accessory = obj(b["accessory"]);
      return (
        <div className="tpv-section">
          <div className="tpv-section-body">
            <TextObject t={obj(b["text"])} emoji={emoji} />
            {fields.length > 0 && (
              <div className="tpv-fields">
                {fields.map((f, i) => (
                  <TextObject key={i} t={f} emoji={emoji} />
                ))}
              </div>
            )}
          </div>
          {accessory?.["type"] === "image" && <Image b={accessory} />}
        </div>
      );
    }
    case "context":
      return (
        <div className="tpv-context">
          {arr(b["elements"]).map((e, i) =>
            e["type"] === "image" ? <Image key={i} b={e} /> : <TextObject key={i} t={e} emoji={emoji} />,
          )}
        </div>
      );
    case "divider":
      return <hr className="tpv-divider" />;
    case "image":
      return <Image b={b} />;
    case "rich_text":
      return <RichText b={b} emoji={emoji} />;
    case "actions":
      return (
        <div className="tpv-actions">
          {arr(b["elements"]).map((e, i) => (
            <span key={i} className="tpv-button">
              {str(obj(e["text"])?.["text"]) || str(e["type"])}
            </span>
          ))}
        </div>
      );
    default:
      return <div className="tpv-unknown">[{str(b["type"])} block]</div>;
  }
}

/** The message as Slack would show it: its blocks when it has any, else its text; then its attached files. */
export function SlackMessage({ content, emoji }: { content: RewriteContent; emoji?: EmojiMap }): ReactNode {
  const { blocks, text, sender, files } = content;
  return (
    <div className="tpv-message">
      {(sender.username !== null || sender.icon_emoji !== null || sender.icon_url !== null) && (
        <div className="tpv-sender">
          {sender.icon_url !== null ? (
            <img className="tpv-avatar" src={sender.icon_url} alt="" />
          ) : sender.icon_emoji !== null ? (
            <Emoji name={sender.icon_emoji.replace(/^:|:$/g, "")} emoji={emoji} />
          ) : null}
          <b>{sender.username ?? "the app"}</b>
        </div>
      )}
      {blocks !== null && blocks.length > 0 ? (
        blocks.map((b, i) => <BlockView key={i} block={b} emoji={emoji} />)
      ) : (
        <Mrkdwn text={text} emoji={emoji} />
      )}
      {files.length > 0 && (
        <div className="tpv-files">
          {files.map((f) => (
            <span key={f} className="tpv-file">
              📎 {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
