import { d as MsgLike } from './core-mTIXjUC4.js';

/**
 * `@open-athena/thrds/receiver`: the inbound half of a Slack app (Events API, interactivity, slash commands), on Web
 * APIs only (`Request` / `Response` / `crypto.subtle`), so it serves from a Worker or Node alike.
 *
 * - `verifySlackSignature` / `verifySlackRequest`: v0 HMAC-SHA256 with a replay window and a constant-time compare.
 * - `parseSlackBody`: Events API JSON, interaction payloads and slash commands, as one tagged union.
 * - `respond`: reply through a `response_url`.
 * - `slackHandler`: verify, answer `url_verification`, dispatch, and ack, in one `fetch`-style handler.
 */

interface VerifyInput {
    signingSecret: string;
    /** The raw request body, exactly as received. */
    body: string;
    /** `X-Slack-Request-Timestamp`. */
    timestamp: string | null;
    /** `X-Slack-Signature` (`v0=<hex>`). */
    signature: string | null;
    nowS?: number;
    /** Reject requests older (or newer) than this, against replays. Default 300 s, Slack's recommendation. */
    toleranceS?: number;
}
type VerifyFailure = "missing_secret" | "missing_headers" | "stale" | "bad_signature";
type VerifyResult = {
    ok: true;
} | {
    ok: false;
    reason: VerifyFailure;
};
/** `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret. */
declare function slackSignature(signingSecret: string, timestamp: string, body: string): Promise<string>;
declare function verifySlackSignature(input: VerifyInput): Promise<VerifyResult>;
/** Verify a `Request` from Slack; on success, its raw body (the request's body is consumed). */
declare function verifySlackRequest(request: Request, signingSecret: string, options?: {
    nowS?: number;
    toleranceS?: number;
}): Promise<{
    ok: true;
    body: string;
} | {
    ok: false;
    reason: VerifyFailure;
}>;
interface SlashCommand {
    command: string;
    text: string;
    userId: string;
    userName: string;
    channelId: string;
    channelName: string;
    teamId: string;
    triggerId: string;
    responseUrl: string;
}
interface InteractionUser {
    id: string;
    username?: string;
    name?: string;
    team_id?: string;
}
interface InteractionMessage {
    ts: string;
    text?: string;
    user?: string;
    bot_id?: string;
    thread_ts?: string;
    blocks?: unknown[];
    attachments?: unknown[];
    [k: string]: unknown;
}
interface ViewState {
    id: string;
    hash?: string;
    callback_id?: string;
    external_id?: string;
    private_metadata?: string;
    state?: {
        values: Record<string, Record<string, unknown>>;
    };
    [k: string]: unknown;
}
interface BlockAction {
    action_id: string;
    block_id?: string;
    value?: string;
    type: string;
    [k: string]: unknown;
}
/** An interaction payload (`block_actions`, `view_submission`, `view_closed`, `shortcut`, `message_action`, …). */
interface Interaction {
    type: string;
    user?: InteractionUser;
    trigger_id?: string;
    response_url?: string;
    actions?: BlockAction[];
    view?: ViewState;
    callback_id?: string;
    channel?: {
        id: string;
        name?: string;
    };
    message?: InteractionMessage;
    container?: Record<string, unknown>;
    [k: string]: unknown;
}
/** A button / select click in a message or view. */
interface BlockActionsPayload extends Interaction {
    type: "block_actions";
    user: InteractionUser;
    trigger_id: string;
    actions: BlockAction[];
}
interface ViewSubmissionPayload extends Interaction {
    type: "view_submission";
    user: InteractionUser;
    view: ViewState;
}
/** A message shortcut ("…" menu on a message). */
interface MessageActionPayload extends Interaction {
    type: "message_action";
    user: InteractionUser;
    callback_id: string;
    trigger_id: string;
    response_url: string;
    channel: {
        id: string;
        name?: string;
    };
    message: InteractionMessage;
}
/** A global shortcut (lightning-bolt menu). */
interface ShortcutPayload extends Interaction {
    type: "shortcut";
    user: InteractionUser;
    callback_id: string;
    trigger_id: string;
}
declare const isBlockActions: (p: Interaction) => p is BlockActionsPayload;
declare const isViewSubmission: (p: Interaction) => p is ViewSubmissionPayload;
declare const isMessageAction: (p: Interaction) => p is MessageActionPayload;
declare const isShortcut: (p: Interaction) => p is ShortcutPayload;
type SlackBody = {
    kind: "url_verification";
    challenge: string;
} | {
    kind: "event";
    event: Record<string, unknown> & {
        type: string;
    };
    eventId: string;
    teamId: string;
    raw: Record<string, unknown>;
} | {
    kind: "interaction";
    payload: Interaction;
} | {
    kind: "command";
    command: SlashCommand;
    raw: Record<string, string>;
} | {
    kind: "unknown";
    raw: unknown;
};
/** Parse a (verified) request body by its content type; a malformed one is `unknown`, never a throw. */
declare function parseSlackBody(body: string, contentType: string | null): SlackBody;
/**
 * A view submission's input values, flattened (text, selects, dates, checkboxes): by `action_id` (default), or by
 * `block_id` when every input shares one action id and blocks tell them apart.
 */
declare function viewValues<T extends Record<string, unknown> = Record<string, unknown>>(payload: Interaction, options?: {
    by?: "action" | "block";
}): T;
interface RespondOptions {
    /** Default `ephemeral` (only the user who acted sees it). */
    responseType?: "ephemeral" | "in_channel";
    replaceOriginal?: boolean;
    deleteOriginal?: boolean;
    threadTs?: string;
    fetch?: typeof fetch;
}
/** Reply through an interaction's or command's `response_url` (valid 30 min, up to 5 times). */
declare function respond(responseUrl: string, m: MsgLike | null, options?: RespondOptions): Promise<void>;
/** A view submission's field errors (keyed by block id): Slack shows them inline instead of closing the modal. */
declare const viewErrors: (errors: Record<string, string>) => Record<string, unknown>;
interface HandlerContext {
    /** The request (its body is already read: use the parsed payload). */
    request: Request;
    /** Slack's delivery retry (`X-Slack-Retry-Num`), or 0 for a first delivery. */
    retryNum: number;
    retryReason: string | null;
    /** Run work after the ack (a Worker's `ctx.waitUntil`); awaited inline when none was given. */
    waitUntil(p: Promise<unknown>): void;
}
/** What an interaction / command handler returns: nothing (plain ack), a `Response`, or a JSON body. */
type HandlerReply = void | undefined | Response | Record<string, unknown>;
interface SlackHandlerOptions {
    signingSecret: string;
    /** Events API callbacks. Acked immediately; the handler runs after (via `waitUntil` when given). */
    onEvent?: (body: Extract<SlackBody, {
        kind: "event";
    }>, ctx: HandlerContext) => Promise<void> | void;
    /** Must finish within Slack's 3 s; defer slow work with `ctx.waitUntil` and reply via `respond`. */
    onInteraction?: (payload: Interaction, ctx: HandlerContext) => Promise<HandlerReply> | HandlerReply;
    onCommand?: (command: SlashCommand, ctx: HandlerContext) => Promise<HandlerReply> | HandlerReply;
    /**
     * Run work after the ack: a Worker's `ctx.waitUntil`, or Next.js's `after` from `next/server`. Without one, deferred
     * work is awaited before the response is returned, which on Node can blow Slack's 3 s ack budget.
     */
    waitUntil?: (p: Promise<unknown>) => void;
    /** Drop Events API retries (Slack re-sends when an ack is late). Default true: handlers needn't be idempotent. */
    ignoreEventRetries?: boolean;
    nowS?: () => number;
    /** Failures in deferred work (default `console.error`: never swallowed silently). */
    onError?: (e: unknown) => void;
}
/** A `fetch`-style handler for one Slack request URL (events, interactivity and commands can share it). */
declare function slackHandler(options: SlackHandlerOptions): (request: Request) => Promise<Response>;

export { type BlockAction, type BlockActionsPayload, type HandlerContext, type HandlerReply, type Interaction, type InteractionMessage, type InteractionUser, type MessageActionPayload, type RespondOptions, type ShortcutPayload, type SlackBody, type SlackHandlerOptions, type SlashCommand, type VerifyFailure, type VerifyInput, type VerifyResult, type ViewState, type ViewSubmissionPayload, isBlockActions, isMessageAction, isShortcut, isViewSubmission, parseSlackBody, respond, slackHandler, slackSignature, verifySlackRequest, verifySlackSignature, viewErrors, viewValues };
