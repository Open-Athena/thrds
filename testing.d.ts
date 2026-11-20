import { l as SlackClientOptions, k as SlackClient } from './slack-Czh9-JyB.js';
import './core-BNb_OG-w.js';

/**
 * `@open-athena/thrds/testing`: fakes for testing Slack code without a network: a recording `fetch` for
 * slack.com/api (`fakeSlack`), a stateful fake channel that behaves like Slack (`fakeChannel`: ts assignment,
 * threads, metadata, `message_not_found`, with an `intercept` hook to inject failures), and a no-op `sleep`.
 * Pair with `sqliteD1` (`/d1`) over `node:sqlite` to run `d1Store` against real SQL.
 */

interface Call {
    method: string;
    http: string;
    /** Parsed JSON or form body (POST), or query parameters (GET and upload POSTs). */
    body: Record<string, unknown>;
    /** The bytes of a file upload (a POST to an upload URL, whose method is `upload_url`). */
    bytes?: Uint8Array;
}
interface Reply {
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
}
/** A route: one reply for every call, a queue (one per call, in order), or a function of the call. */
type Route = Reply | Reply[] | ((call: Call) => Reply);
/**
 * A fake `fetch` for slack.com/api: replies per method, every call recorded (method, HTTP verb, body). A request to
 * any other path (a file's upload URL) is method `upload_url`.
 */
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
    /** Attached files, as Slack lists them on a message (here just `id` and `name`). */
    files?: Array<{
        id: string;
        name: string;
    }>;
}
/** An uploaded file in a `fakeChannel`. */
interface FakeFile {
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
declare function fakeChannel(options?: {
    messages?: FakeMessage[];
    /** Runs first for every call: return a reply to answer it, throw to fail it, or undefined for normal handling. */
    intercept?: (call: Call, messages: FakeMessage[]) => Reply | undefined;
    clientOptions?: Partial<SlackClientOptions>;
    /** How many `files.info` reads report an upload unprocessed (`mimetype: ""`) before it's ready. Default 0. */
    processedAfter?: number;
}): {
    client: SlackClient;
    calls: Call[];
    messages: FakeMessage[];
    files: Map<string, FakeFile>;
    writes: [string, string][];
    routes: Record<string, Route>;
};
/** An error a fake `fetch` can throw to look like a request that timed out. */
declare const timeoutError: () => Error;

export { AUTH, type Call, type FakeFile, type FakeMessage, type Reply, type Route, fakeChannel, fakeClient, fakeSlack, fakeSleep, timeoutError };
