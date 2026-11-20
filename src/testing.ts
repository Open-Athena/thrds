/**
 * `@open-athena/thrds/testing`: fakes for testing Slack code without a network: a recording `fetch` for
 * slack.com/api (`fakeSlack`), a stateful fake channel that behaves like Slack (`fakeChannel`: ts assignment,
 * threads, metadata, `message_not_found`, with an `intercept` hook to inject failures), and a no-op `sleep`.
 * Pair with `sqliteD1` (`/d1`) over `node:sqlite` to run `d1Store` against real SQL.
 */
import { SlackClient, type SlackClientOptions } from "./slack";

export interface Call {
  method: string;
  http: string;
  /** Parsed JSON or form body (POST), or query parameters (GET and upload POSTs). */
  body: Record<string, unknown>;
  /** The bytes of a file upload (a POST to an upload URL, whose method is `upload_url`). */
  bytes?: Uint8Array;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A route: one reply for every call, a queue (one per call, in order), or a function of the call. */
export type Route = Reply | Reply[] | ((call: Call) => Reply);

/**
 * A fake `fetch` for slack.com/api: replies per method, every call recorded (method, HTTP verb, body). A request to
 * any other path (a file's upload URL) is method `upload_url`.
 */
export function fakeSlack(routes: Record<string, Route>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.startsWith("/api/") ? url.pathname.slice("/api/".length) : "upload_url";
    const http = init.method ?? "GET";
    const form = new Headers(init.headers).get("Content-Type")?.startsWith("application/x-www-form-urlencoded");
    const body: Record<string, unknown> =
      typeof init.body === "string"
        ? form
          ? Object.fromEntries(new URLSearchParams(init.body))
          : JSON.parse(init.body)
        : Object.fromEntries(url.searchParams);
    const call: Call = { method, http, body };
    if (init.body instanceof Uint8Array) call.bytes = init.body;
    calls.push(call);
    const route = routes[method];
    if (route === undefined) throw new Error(`unexpected Slack method: ${method}`);
    let reply: Reply;
    if (typeof route === "function") reply = route(call);
    else if (Array.isArray(route)) {
      const i = queues.get(method) ?? 0;
      queues.set(method, i + 1);
      reply = route[Math.min(i, route.length - 1)]!;
    } else reply = route;
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Records waits instead of sleeping. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleep: async (ms) => void waits.push(ms), waits };
}

/** An `auth.test` reply: the bot is `U_BOT` / `B_BOT` (the fake channel's own posts carry `bot_id: "B_BOT"`). */
export const AUTH = { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } };

/** A `SlackClient` (token `xoxb-t`, channel `C1`) over `fakeSlack(routes)`, with waits recorded instead of slept. */
export function fakeClient(
  routes: Record<string, Route>,
  options: Partial<SlackClientOptions> = {},
): { client: SlackClient; calls: Call[]; waits: number[] } {
  const { fetch, calls } = fakeSlack(routes);
  const { sleep, waits } = fakeSleep();
  return { client: new SlackClient({ token: "xoxb-t", channel: "C1", fetch, sleep, ...options }), calls, waits };
}

export interface FakeMessage {
  ts: string;
  text: string;
  thread_ts?: string;
  bot_id?: string;
  user?: string;
  username?: string;
  blocks?: unknown[];
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
  /** Attached files, as Slack lists them on a message (here just `id` and `name`). */
  files?: Array<{ id: string; name: string }>;
}

/** An uploaded file in a `fakeChannel`. */
export interface FakeFile {
  id: string;
  name: string;
  title: string;
  /** Empty until the file is "processed": `processedAfter` `files.info` reads (default 0). */
  mimetype: string;
  bytes?: Uint8Array;
  /** The channel it was shared into, if any. */
  channel?: string;
}

/**
 * A stateful fake channel: `chat.postMessage` / `update` / `delete`, `conversations.replies` / `history`, file
 * uploads (`files.getUploadURLExternal`, the upload, `files.completeUploadExternal`, `files.info`, `files.delete`,
 * `chat.update` `file_ids`) and `auth.test`, behaving like Slack (ts assignment, threads, metadata, `message_not_found`,
 * a sharing upload posting a file message). `writes` lists every write; `files` holds the uploads.
 */
export function fakeChannel(
  options: {
    messages?: FakeMessage[];
    /** Runs first for every call: return a reply to answer it, throw to fail it, or undefined for normal handling. */
    intercept?: (call: Call, messages: FakeMessage[]) => Reply | undefined;
    clientOptions?: Partial<SlackClientOptions>;
    /** How many `files.info` reads report an upload unprocessed (`mimetype: ""`) before it's ready. Default 0. */
    processedAfter?: number;
  } = {},
) {
  const messages: FakeMessage[] = [...(options.messages ?? [])];
  const files = new Map<string, FakeFile>();
  const infoReads = new Map<string, number>();
  let n = 100;
  let f = 100;
  const writes: Array<[string, string]> = [];
  const err = (error: string): Reply => ({ body: { ok: false, error } });
  const routes: Record<string, Route> = {
    "auth.test": AUTH,
    "chat.postMessage": ({ body }) => {
      if (body["thread_ts"] && !messages.some((x) => x.ts === body["thread_ts"])) return err("thread_not_found");
      const ts = `${++n}.000000`;
      const m: FakeMessage = { ts, text: body["text"] as string, bot_id: "B_BOT" };
      if (body["thread_ts"]) m.thread_ts = body["thread_ts"] as string;
      if (body["username"]) m.username = body["username"] as string;
      if (body["blocks"]) m.blocks = body["blocks"] as unknown[];
      if (body["metadata"]) m.metadata = body["metadata"] as FakeMessage["metadata"];
      messages.push(m);
      writes.push(["post", m.text]);
      return { body: { ok: true, ts } };
    },
    "chat.update": ({ body }) => {
      const m = messages.find((x) => x.ts === body["ts"]);
      if (!m) return err("message_not_found");
      m.text = body["text"] as string;
      if (body["blocks"]) m.blocks = body["blocks"] as unknown[];
      if (body["metadata"]) m.metadata = body["metadata"] as FakeMessage["metadata"];
      if (body["file_ids"] !== undefined) {
        const ids = body["file_ids"] as string[];
        const missing = ids.find((id) => !files.has(id));
        if (missing !== undefined) return err("file_not_found");
        if (ids.length > 0) m.files = ids.map((id) => ({ id, name: files.get(id)!.name }));
        else delete m.files;
      }
      writes.push(["edit", m.text]);
      return { body: { ok: true, ts: m.ts } };
    },
    "chat.delete": ({ body }) => {
      const i = messages.findIndex((x) => x.ts === body["ts"]);
      if (i < 0) return err("message_not_found");
      writes.push(["delete", messages[i]!.text]);
      messages.splice(i, 1);
      return { body: { ok: true } };
    },
    "conversations.replies": ({ body }) => {
      const ts = body["ts"] as string;
      const parent = messages.find((x) => x.ts === ts);
      if (!parent) return err("thread_not_found");
      return { body: { ok: true, messages: [parent, ...messages.filter((x) => x.thread_ts === ts && x.ts !== ts)] } };
    },
    "files.getUploadURLExternal": ({ body }) => {
      const id = `F${++f}`;
      const name = body["filename"] as string;
      files.set(id, { id, name, title: name, mimetype: "" });
      return { body: { ok: true, file_id: id, upload_url: `https://files.slack.com/upload/v1/fake?file=${id}` } };
    },
    upload_url: ({ body, bytes }) => {
      const file = files.get(body["file"] as string);
      if (!file) return { status: 404, body: "" };
      if (bytes !== undefined) file.bytes = bytes;
      return { body: "OK - " + String(bytes?.byteLength ?? 0) };
    },
    "files.completeUploadExternal": ({ body }) => {
      const done = body["files"] as Array<{ id: string; title?: string }>;
      for (const { id, title } of done) {
        const file = files.get(id);
        if (!file || file.bytes === undefined) return err("file_not_found");
        if (title !== undefined) file.title = title;
      }
      const channel = body["channel_id"] as string | undefined;
      if (channel !== undefined) {
        const ts = `${++n}.000000`;
        const m: FakeMessage = {
          ts,
          text: (body["initial_comment"] as string | undefined) ?? "",
          bot_id: "B_BOT",
          files: done.map(({ id }) => ({ id, name: files.get(id)!.name })),
        };
        if (body["thread_ts"]) m.thread_ts = body["thread_ts"] as string;
        for (const { id } of done) files.get(id)!.channel = channel;
        messages.push(m);
        writes.push(["share", m.text]);
      }
      return { body: { ok: true, files: done.map(({ id }) => ({ id })) } };
    },
    "files.info": ({ body }) => {
      const file = files.get(body["file"] as string);
      if (!file) return err("file_not_found");
      const reads = (infoReads.get(file.id) ?? 0) + 1;
      infoReads.set(file.id, reads);
      if (reads > (options.processedAfter ?? 0)) file.mimetype = file.name.endsWith(".png") ? "image/png" : "application/octet-stream";
      const info: Record<string, unknown> = { id: file.id, name: file.name, title: file.title, mimetype: file.mimetype };
      if (file.mimetype.startsWith("image/")) info["thumb_64"] = `https://files.slack.com/thumb/${file.id}_64.png`;
      return { body: { ok: true, file: info } };
    },
    "files.delete": ({ body }) => {
      const id = body["file"] as string;
      if (!files.delete(id)) return err("file_not_found");
      writes.push(["delete_file", id]);
      return { body: { ok: true } };
    },
    "conversations.history": ({ body }) => {
      const oldest = Number(body["oldest"] ?? 0);
      const top = messages.filter((x) => !x.thread_ts && Number(x.ts) >= oldest).reverse();
      return { body: { ok: true, messages: top } };
    },
  };
  const intercepted: Record<string, Route> = {};
  for (const [method, route] of Object.entries(routes)) {
    intercepted[method] = (call) => {
      const hit = options.intercept?.(call, messages);
      if (hit !== undefined) return hit;
      return typeof route === "function" ? route(call) : (route as Reply);
    };
  }
  const { client: c, calls } = fakeClient(intercepted, options.clientOptions);
  return { client: c, calls, messages, files, writes, routes };
}

/** An error a fake `fetch` can throw to look like a request that timed out. */
export const timeoutError = (): Error => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
