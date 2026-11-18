/** A message's location, parsed from a permalink. `threadTs` is set for a reply link (`?thread_ts=`). */
export interface MessageRef {
  channel: string;
  ts: string;
  threadTs?: string;
}

/** `p1794940661977049` → `1794940661.977049`. */
const tsOf = (p: string): string => `${p.slice(0, -6)}.${p.slice(-6)}`;

/**
 * Parse a Slack message permalink (`https://<ws>.slack.com/archives/<channel>/p<ts digits>[?thread_ts=…]`), or
 * return null for anything else.
 */
export function parsePermalink(url: string): MessageRef | null {
  let u: URL;
  // Lenient about how links arrive: mrkdwn-escaped (`&amp;`), or followed by punctuation in prose.
  const cleaned = url.trim().replace(/&amp;/g, "&").replace(/[.,;:!?)\]}>'"]+$/, "");
  try {
    u = new URL(cleaned);
  } catch {
    return null;
  }
  if (!/(^|\.)slack(-gov)?\.com$/.test(u.hostname)) return null;
  const m = /^\/archives\/([A-Z0-9]+)\/p(\d{7,})\/?$/.exec(u.pathname);
  if (!m) return null;
  const ref: MessageRef = { channel: m[1]!, ts: tsOf(m[2]!) };
  const threadTs = u.searchParams.get("thread_ts");
  if (threadTs && threadTs !== ref.ts) ref.threadTs = threadTs;
  return ref;
}

/**
 * Build a permalink without an API call (applitrack's `permalinkFromTs`). `workspace` is the subdomain
 * (`openathena`) or a full origin. `chat.getPermalink` is authoritative; this is for when a call isn't worth it.
 */
export function buildPermalink(workspace: string, ref: MessageRef): string {
  const origin = workspace.includes("://") ? workspace.replace(/\/+$/, "") : `https://${workspace}.slack.com`;
  const base = `${origin}/archives/${ref.channel}/p${ref.ts.replace(".", "")}`;
  return ref.threadTs ? `${base}?thread_ts=${ref.threadTs}&cid=${ref.channel}` : base;
}

/** A permalink found in text: its ref, plus the URL as written. */
export interface FoundPermalink extends MessageRef {
  url: string;
}

const PERMALINK_IN_TEXT = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|https?:\/\/[^\s<>|]+/g;
/** Prose punctuation a bare URL picks up (`see …/p123.`), which belongs to the sentence. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Every distinct Slack message permalink in `text` (bare, or mrkdwn `<url>` / `<url|label>`), in order of appearance. */
export function permalinksIn(text: string): FoundPermalink[] {
  const out: FoundPermalink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PERMALINK_IN_TEXT)) {
    const url = m[1] ?? m[0].replace(TRAILING, "");
    const ref = parsePermalink(url);
    if (!ref) continue;
    const id = `${ref.channel}/${ref.ts}/${ref.threadTs ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...ref, url });
  }
  return out;
}

/** `text` with its Slack permalinks (bare or `<…>`) removed, and the whitespace they leave collapsed. */
export function withoutPermalinks(text: string): string {
  return text
    .replace(PERMALINK_IN_TEXT, (m: string, inner: string | undefined) => {
      if (!parsePermalink(inner ?? m)) return m;
      return inner !== undefined ? "" : (TRAILING.exec(m)?.[0] ?? "");
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
