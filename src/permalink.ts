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
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/.test(u.hostname)) return null;
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
