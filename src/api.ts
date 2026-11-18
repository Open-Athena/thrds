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

/**
 * How a call failed: `slack` (Slack answered, refusing: `ok:false` or a 429), `http` (a non-2xx status or an
 * unparseable body), `timeout`, or `transport` (the request never got an answer: DNS, connection reset, …).
 */
export type SlackErrorKind = "slack" | "http" | "timeout" | "transport";

/** Slack's error codes are short fixed strings (`not_in_channel`); anything else is kept out of messages. */
const SAFE_CODE = /^[a-z0-9_.]{1,64}$/;

/** A failed call: Slack's own error code (`channel_not_found`, `ratelimited`, …) or `http_<status>` / `timeout`. */
export class SlackApiError extends Error {
  readonly kind: SlackErrorKind;
  /** The code Slack itself sent (absent for synthesized ones like `http_502`), only if it looks like a Slack code. */
  readonly slackCode?: string;

  constructor(
    public readonly method: string,
    public readonly code: string,
    public readonly status: number,
    public readonly response?: Record<string, unknown>,
    /** For `ratelimited`: how long Slack asked us to wait, when it said. */
    public readonly retryAfterS?: number,
    kind?: SlackErrorKind,
    options?: { cause?: unknown },
  ) {
    super(`${method}: ${SAFE_CODE.test(code) ? code : "unknown_error"}`, options);
    this.name = "SlackApiError";
    this.kind = kind ?? (code === "timeout" ? "timeout" : code.startsWith("http_") || code === "invalid_json" ? "http" : "slack");
    const sent = response?.["error"];
    if (typeof sent === "string" && SAFE_CODE.test(sent)) this.slackCode = sent;
  }

  /**
   * Whether the failure means the request certainly did nothing: Slack refused it (`ok:false`, a 429) or rejected it
   * with a 4xx. False for timeouts, 5xx, transport errors and unparseable replies, after which a write may have landed.
   */
  get definite(): boolean {
    return this.kind === "slack" || (this.kind === "http" && this.status >= 400 && this.status < 500);
  }
}

export interface RetryInfo {
  method: string;
  /** 1-based: the retry about to happen. */
  attempt: number;
  waitMs: number;
  reason: "http_429" | "ratelimited" | "server_error" | "timeout";
}

/**
 * Writes that create something: a 5xx or timeout leaves it unknown whether the write landed, so they are never
 * retried on those (a retry could post twice). A 429 or `ratelimited` reply means Slack refused the request, so
 * those are always safe to retry.
 */
export const NON_IDEMPOTENT = new Set([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.scheduleMessage",
  "chat.meMessage",
  "files.completeUploadExternal",
  "files.upload",
  "conversations.create",
  "usergroups.create",
]);

export interface TransportOptions {
  fetch?: typeof fetch;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /**
   * Also retry HTTP 5xx and timeouts (exponential, 1 s base) for methods that are safe to repeat: never for
   * `NON_IDEMPOTENT` ones, whose first attempt may have landed.
   */
  retryServerErrors?: boolean;
  /** Per-request timeout. Default 30 000; 0 disables. */
  timeoutMs?: number;
  /** Longest single wait before a retry; a longer `Retry-After` throws `ratelimited` (with `retryAfterS`) instead. */
  maxRetryWaitMs?: number;
  /** Total budget for a call, retries and waits included: a retry that wouldn't fit throws instead. */
  deadlineMs?: number;
  /**
   * Runs before every request with the method and its (unserialized) body: a place for policy, e.g. refusing posts
   * to a channel. Throw to block the call.
   */
  beforeCall?: (method: string, body: Record<string, unknown>) => void | Promise<void>;
  /** Default `https://slack.com/api`. */
  baseUrl?: string;
  /** Extra request headers (e.g. a session cookie for an undocumented endpoint). */
  headers?: Record<string, string>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for `deadlineMs`. */
  now?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

export interface CallOptions extends TransportOptions {
  /** Use this token for this call instead of the client's (e.g. a user token for deleting a user's message). */
  token?: string;
  /** Send `body` as query parameters on a GET (read methods that don't accept JSON, e.g. `users.lookupByEmail`). */
  get?: boolean;
  /** POST `body` form-encoded instead of as JSON (methods that don't accept JSON bodies). */
  form?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` in seconds, or undefined. */
function retryAfterS(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After");
  const s = raw === null ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? s : undefined;
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
    maxRetryWaitMs,
    deadlineMs,
    beforeCall,
    baseUrl = SLACK_API,
    headers: extraHeaders,
    sleep = defaultSleep,
    now = Date.now,
    onRetry,
    get = false,
    form = false,
  } = options;
  if (options.token !== undefined) token = options.token;
  const repeatable = !NON_IDEMPOTENT.has(method);
  const start = now();
  await beforeCall?.(method, body);
  for (let attempt = 0; ; attempt++) {
    /** Wait and go again, if retries, the wait cap and the deadline allow it. */
    const retry = async (reason: RetryInfo["reason"], waitMs: number): Promise<boolean> => {
      if (attempt >= retries) return false;
      if (maxRetryWaitMs !== undefined && waitMs > maxRetryWaitMs) return false;
      if (deadlineMs !== undefined && now() - start + waitMs > deadlineMs) return false;
      onRetry?.({ method, attempt: attempt + 1, waitMs, reason });
      await sleep(waitMs);
      return true;
    };
    let url = `${baseUrl}/${method}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...extraHeaders };
    let payload: string | undefined;
    if (get) {
      const q = encodeQuery(body);
      if (q) url = `${url}?${q}`;
    } else if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = encodeQuery(body);
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
      if (timedOut && retryServerErrors && repeatable && (await retry("timeout", 1000 * 2 ** attempt))) continue;
      if (timedOut) throw new SlackApiError(method, "timeout", 0);
      throw new SlackApiError(method, "transport_error", 0, undefined, undefined, "transport", { cause: e });
    }
    if (response.status === 429) {
      const after = retryAfterS(response.headers);
      if (await retry("http_429", (after ?? 1) * 1000)) continue;
      throw new SlackApiError(method, "ratelimited", 429, undefined, after);
    }
    if (response.status >= 500 && retryServerErrors && repeatable && (await retry("server_error", 1000 * 2 ** attempt))) continue;
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
      if (code === "ratelimited") {
        const after = retryAfterS(response.headers);
        if (await retry("ratelimited", after !== undefined ? after * 1000 : 30_000 * (attempt + 1))) continue;
        throw new SlackApiError(method, code, response.status, json, after);
      }
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
