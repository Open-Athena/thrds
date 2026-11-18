/**
 * Slack Web API transport: one place for the `Bearer` + JSON/query request, the `ok` check, retries and timeouts that
 * every bot otherwise re-writes. Web APIs only (`fetch`, `AbortSignal`), so it runs on Workers and Node alike.
 */

export const SLACK_API = "https://slack.com/api";

/** A Slack response that came back `ok`. Method-specific fields are untyped; read them where they're used. */
export interface SlackResponse {
  ok: true;
  [key: string]: unknown;
}

/** A failed call: Slack's own error code (`channel_not_found`, `ratelimited`, …) or `http_<status>` / `timeout`. */
export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
    public readonly status: number,
    public readonly response?: Record<string, unknown>,
  ) {
    super(`${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

export interface RetryInfo {
  method: string;
  /** 1-based: the retry about to happen. */
  attempt: number;
  waitMs: number;
  reason: "http_429" | "ratelimited" | "server_error" | "timeout";
}

export interface TransportOptions {
  fetch?: typeof fetch;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /**
   * Also retry HTTP 5xx and timeouts (exponential, 1s base). Off by default: a write that timed out may have landed,
   * and a blind retry of `chat.postMessage` posts twice. `syncSlots`' write-ahead `pending` record makes that safe.
   */
  retryServerErrors?: boolean;
  /** Per-request timeout. Default 30 000; 0 disables. */
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

export interface CallOptions extends TransportOptions {
  /** Send `body` as query parameters on a GET (read methods that don't accept JSON, e.g. `users.lookupByEmail`). */
  get?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` (seconds) in ms, else `fallbackMs`. */
function retryAfterMs(headers: Headers, fallbackMs: number): number {
  const raw = headers.get("Retry-After");
  const s = raw === null ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : fallbackMs;
}

function encodeQuery(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return params.toString();
}

/** A successful call's JSON and headers (`auth.test`'s `x-oauth-scopes` lives in a header). */
export async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<{ json: SlackResponse; headers: Headers }> {
  const {
    fetch: fetchImpl = globalThis.fetch,
    retries = 3,
    retryServerErrors = false,
    timeoutMs = 30_000,
    sleep = defaultSleep,
    onRetry,
    get = false,
  } = options;
  for (let attempt = 0; ; attempt++) {
    const retry = async (reason: RetryInfo["reason"], waitMs: number): Promise<boolean> => {
      if (attempt >= retries) return false;
      onRetry?.({ method, attempt: attempt + 1, waitMs, reason });
      await sleep(waitMs);
      return true;
    };
    let url = `${SLACK_API}/${method}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let payload: string | undefined;
    if (get) {
      const q = encodeQuery(body);
      if (q) url = `${url}?${q}`;
    } else {
      headers["Content-Type"] = "application/json; charset=utf-8";
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: get ? "GET" : "POST",
        headers,
        body: payload,
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (timedOut && retryServerErrors && (await retry("timeout", 1000 * 2 ** attempt))) continue;
      if (timedOut) throw new SlackApiError(method, "timeout", 0);
      throw e;
    }
    if (response.status === 429) {
      if (await retry("http_429", retryAfterMs(response.headers, 1000))) continue;
      throw new SlackApiError(method, "ratelimited", 429);
    }
    if (response.status >= 500 && retryServerErrors && (await retry("server_error", 1000 * 2 ** attempt))) continue;
    const text = await response.text();
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`, response.status);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new SlackApiError(method, "invalid_json", response.status);
    }
    if (json["ok"] !== true) {
      const code = typeof json["error"] === "string" ? json["error"] : "unknown_error";
      // Some methods report throttling in the body with a 200 (emoji-bot hit this on `emoji.*`).
      if (code === "ratelimited" && (await retry("ratelimited", retryAfterMs(response.headers, 30_000 * (attempt + 1))))) continue;
      throw new SlackApiError(method, code, response.status, json);
    }
    return { json: json as SlackResponse, headers: response.headers };
  }
}

/** Call a Slack Web API method; throws `SlackApiError` unless Slack says `ok`. */
export async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<SlackResponse> {
  return (await slackCall(token, method, body, options)).json;
}

/**
 * Every item of a cursor-paginated method (`conversations.history` / `.replies` / `.list`, `users.list`, …), lazily.
 * `key` is the response field holding the page's items (`messages`, `channels`, `members`).
 */
export async function* paginate<T = Record<string, unknown>>(
  call: (cursor: string | undefined) => Promise<SlackResponse>,
  key: string,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await call(cursor);
    for (const item of (page[key] ?? []) as T[]) yield item;
    const next = (page["response_metadata"] as { next_cursor?: string } | undefined)?.next_cursor;
    cursor = next ? next : undefined;
  } while (cursor !== undefined);
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}
