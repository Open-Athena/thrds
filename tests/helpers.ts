import { SlackClient, type SlackClientOptions } from "../src/slack";

export interface Call {
  method: string;
  http: string;
  /** Parsed JSON body (POST) or query parameters (GET). */
  body: Record<string, unknown>;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A route: one reply for every call, a queue (one per call, in order), or a function of the call. */
export type Route = Reply | Reply[] | ((call: Call) => Reply);

/** A fake `fetch` for slack.com/api: replies per method, every call recorded (method, HTTP verb, body). */
export function fakeSlack(routes: Record<string, Route>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.replace(/^\/api\//, "");
    const http = init.method ?? "GET";
    const body: Record<string, unknown> =
      typeof init.body === "string" ? JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    const call = { method, http, body };
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

export const AUTH = { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } };

export function client(
  routes: Record<string, Route>,
  options: Partial<SlackClientOptions> = {},
): { client: SlackClient; calls: Call[]; waits: number[] } {
  const { fetch, calls } = fakeSlack(routes);
  const { sleep, waits } = fakeSleep();
  return { client: new SlackClient({ token: "xoxb-t", channel: "C1", fetch, sleep, ...options }), calls, waits };
}
