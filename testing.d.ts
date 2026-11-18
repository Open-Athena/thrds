import { i as SlackClientOptions, h as SlackClient } from './slack-_HD6P5rZ.js';
import './core-mTIXjUC4.js';

/**
 * `@open-athena/thrds/testing`: fakes for testing Slack code without a network: a recording `fetch` for
 * slack.com/api (`fakeSlack`), a stateful fake channel that behaves like Slack (`fakeChannel`: ts assignment,
 * threads, metadata, `message_not_found`, with an `intercept` hook to inject failures), and a no-op `sleep`.
 * Pair with `sqliteD1` (`/d1`) over `node:sqlite` to run `d1Store` against real SQL.
 */

interface Call {
    method: string;
    http: string;
    /** Parsed JSON body (POST) or query parameters (GET). */
    body: Record<string, unknown>;
}
interface Reply {
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
}
/** A route: one reply for every call, a queue (one per call, in order), or a function of the call. */
type Route = Reply | Reply[] | ((call: Call) => Reply);
/** A fake `fetch` for slack.com/api: replies per method, every call recorded (method, HTTP verb, body). */
declare function fakeSlack(routes: Record<string, Route>): {
    fetch: typeof fetch;
    calls: Call[];
};
/** Records waits instead of sleeping. */
declare function fakeSleep(): {
    sleep: (ms: number) => Promise<void>;
    waits: number[];
};
/** An `auth.test` reply: the bot is `U_BOT` / `B_BOT` (the fake channel's own posts carry `bot_id: "B_BOT"`). */
declare const AUTH: {
    body: {
        ok: boolean;
        user_id: string;
        bot_id: string;
    };
};
/** A `SlackClient` (token `xoxb-t`, channel `C1`) over `fakeSlack(routes)`, with waits recorded instead of slept. */
declare function fakeClient(routes: Record<string, Route>, options?: Partial<SlackClientOptions>): {
    client: SlackClient;
    calls: Call[];
    waits: number[];
};
interface FakeMessage {
    ts: string;
    text: string;
    thread_ts?: string;
    bot_id?: string;
    user?: string;
    username?: string;
    blocks?: unknown[];
    metadata?: {
        event_type: string;
        event_payload: Record<string, unknown>;
    };
}
/**
 * A stateful fake channel: `chat.postMessage` / `update` / `delete`, `conversations.replies` / `history`, and
 * `auth.test`, behaving like Slack (ts assignment, threads, metadata, `message_not_found`). `writes` lists every write.
 */
declare function fakeChannel(options?: {
    messages?: FakeMessage[];
    /** Runs first for every call: return a reply to answer it, throw to fail it, or undefined for normal handling. */
    intercept?: (call: Call, messages: FakeMessage[]) => Reply | undefined;
    clientOptions?: Partial<SlackClientOptions>;
}): {
    client: SlackClient;
    calls: Call[];
    messages: FakeMessage[];
    writes: [string, string][];
    routes: Record<string, Route>;
};
/** An error a fake `fetch` can throw to look like a request that timed out. */
declare const timeoutError: () => Error;

export { AUTH, type Call, type FakeMessage, type Reply, type Route, fakeChannel, fakeClient, fakeSlack, fakeSleep, timeoutError };
