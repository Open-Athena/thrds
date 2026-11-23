export { A as Action, a as ActionType, E as EditRateLimited, M as Message, b as MessageMetadata, c as Msg, d as MsgLike, O as OrphanedRepliesError, S as Sender, e as SyncOptions, f as SyncResult, T as THRDS_HASH, g as Thread, h as ThreadClient, U as Unfurl, i as contentKey, j as isRich, m as msgHash, s as sync, t as toMsg } from './core-BNb_OG-w.js';
import { q as SlackClient } from './slack-DsYQB40e.js';
export { A as AttachedFile, a as Auth, B as BulletFn, C as CHANNEL_TTL_MS, b as CallOptions, c as CustomSenderFilesError, F as FILE_HASHES, d as FileNotProcessedError, e as FileSpec, f as FileSwap, g as FileSwapError, h as FilesNotAttachedError, i as FilesSwap, L as LinkedSyncResult, j as LinkedThread, M as MAX_CACHED_USERS, N as NON_IDEMPOTENT, k as NOT_FOUND_TTL_MS, R as Reaction, l as RetryInfo, S as SLACK_API, m as SLACK_MESSAGE_LIMIT, n as Section, o as SenderOverrides, p as SlackApiError, r as SlackClientOptions, s as SlackDeleteOptions, t as SlackErrorKind, u as SlackMessage, v as SlackPostOptions, w as SlackResponse, x as SlackSyncOptions, y as SlackUser, T as Transport, z as TransportOptions, U as USERNAME_MAX, D as USER_TTL_MS, E as UploadData, G as UploadOptions, H as assertFilesAttachable, I as attachedFiles, J as buildDetailMessages, K as buildSummaryMessages, O as collect, P as defaultBullet, Q as definitelyNotAttached, V as isProcessed, W as paginate, X as senderOverrides, Y as slackApi, Z as slackCall, _ as splitBody, $ as swapFiles, a0 as toBytes, a1 as webClientTransport, a2 as withFiles } from './slack-DsYQB40e.js';
import { o as RewriteReceipts, m as RewriteOutcome, n as RewritePlan, k as RewriteFound, i as Render, h as RawSlackMessage } from './rewrite-CcsNOGJR.js';
export { B as Block, a as ButtonOptions, D as DEFAULT_BATCH, b as DEFAULT_PACE_MS, c as Desired, d as DiffLine, P as PLAN_VERSION, e as PRIVATE_METADATA_MAX, f as PlannedAction, R as REWRITE_KINDS, g as REWRITE_STATUSES, j as RewriteContent, l as RewriteKind, p as RewriteSender, q as RewriteStatus, r as RichStyle, S as Skip, s as actions, t as bound, u as button, v as contentHash, w as contentOf, x as context, y as date, z as datePicker, A as decodePrivateMetadata, C as describeSender, E as divider, F as encodePrivateMetadata, G as escape, H as fitsPrivateMetadata, I as header, J as image, K as imageElement, L as input, M as lineDiff, N as link, O as memoryReceipts, Q as mention, T as modal, U as mrkdwnText, V as option, W as parsePlan, X as plainText, Y as plainTextInput, Z as planCounts, _ as postRewrite, $ as pyJsonDumps, a0 as rich, a1 as sameContent, a2 as section, a3 as senderChanged, a4 as senderOf, a5 as staticSelect, a6 as substitute, a7 as usersSelect, a8 as verifyPlan, a9 as versionedUrl, aa as withoutImages, ab as writes } from './rewrite-CcsNOGJR.js';
export { L as LeaseLostError, R as REJECTED, a as RenderedSlotThread, S as SLOT_KEY, b as SLOT_NAME, c as SlotAction, d as SlotActionType, e as SlotClient, f as SlotParent, g as SlotRecord, h as SlotSpec, i as SlotState, j as SlotStore, k as SlotSyncOptions, l as SlotSyncResult, m as SlotThread, n as SlotThreadSpec, U as UpsertOptions, o as UpsertResult, p as importAnchor, q as memoryStore, r as oneKeyStore, s as partialOf, t as syncSlots, u as tagSlot, v as threadStore, w as upsert, x as upsertFile, y as upsertFiles } from './slots-CrmBIIZI.js';

/** A message's location, parsed from a permalink. `threadTs` is set for a reply link (`?thread_ts=`). */
interface MessageRef {
    channel: string;
    ts: string;
    threadTs?: string;
}
/**
 * Parse a Slack message permalink (`https://<ws>.slack.com/archives/<channel>/p<ts digits>[?thread_ts=…]`), or
 * return null for anything else.
 */
declare function parsePermalink(url: string): MessageRef | null;
/**
 * Build a permalink without an API call (applitrack's `permalinkFromTs`). `workspace` is the subdomain
 * (`openathena`) or a full origin. `chat.getPermalink` is authoritative; this is for when a call isn't worth it.
 */
declare function buildPermalink(workspace: string, ref: MessageRef): string;
/** A permalink found in text: its ref, plus the URL as written. */
interface FoundPermalink extends MessageRef {
    url: string;
}
/** Every distinct Slack message permalink in `text` (bare, or mrkdwn `<url>` / `<url|label>`), in order of appearance. */
declare function permalinksIn(text: string): FoundPermalink[];
/** `text` with its Slack permalinks (bare or `<…>`) removed, and the whitespace they leave collapsed. */
declare function withoutPermalinks(text: string): string;

/** JSON with object keys sorted at every level, so equal values always serialize equally. */
declare function stableStringify(value: unknown): string;
/**
 * A 53-bit non-cryptographic hash (cyrb53) as 14 hex digits. Change detection only: synchronous, and identical on
 * Workers and Node, unlike `crypto.subtle.digest`.
 */
declare function hash53(s: string, seed?: number): string;

interface FindOptions {
    /** Default: the client's channel. */
    channel?: string;
    /** Include others' messages (they plan as `blocked`). */
    includeForeign?: boolean;
}
/** The app's messages in the channel's history (newest first; `oldest` / `latest` bound it); with `includeReplies`,
 *  each thread's replies follow its parent (oldest first). */
declare function findHistory(client: SlackClient, options?: FindOptions & {
    oldest?: string;
    latest?: string;
    includeReplies?: boolean;
}): Promise<RewriteFound[]>;
/** The app's messages in one thread: its parent, then its replies. */
declare function findThread(client: SlackClient, threadTs: string, options?: FindOptions): Promise<RewriteFound[]>;
/** One message by ts (a reply's ts reads the reply), or null when it's gone. */
declare function readMessage(client: SlackClient, channel: string, ts: string): Promise<RawSlackMessage | null>;
/** Exactly these messages (top-level or replies), in order; others' messages included (they plan as `blocked`).
 *  Throws on one that's gone. */
declare function findIds(client: SlackClient, tss: readonly string[], options?: {
    channel?: string;
}): Promise<RewriteFound[]>;
/** One action per found message; no Slack calls. A sender change is a `repost`, `blocked` when the message has replies
 *  (they'd orphan), when it isn't the newest in its container (`reorderOk` allows it), or when it has files and the new
 *  sender is an override (Slack shows no files on those). `render` runs only on this app's own posts. */
declare function plan(found: Iterable<RewriteFound>, render: Render, options?: {
    reorderOk?: boolean;
}): Promise<RewritePlan>;
interface ApplyOptions {
    /** Default true: check each action against its message, write nothing. */
    dryRun?: boolean;
    /** Just these ts. */
    only?: Iterable<string>;
    receipts?: RewriteReceipts;
    paceMs?: number;
    jitterMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onOutcome?: (o: RewriteOutcome) => void | Promise<void>;
}
/**
 * Carry out the plan's `edit` / `repost` actions in order. A dry run by default: each action is still checked against
 * its message (`pending` / `stale` / `gone` / `already`), but nothing is written. A repost posts the new message
 * before deleting the old one, so a failed delete leaves a duplicate (`undeleted`), never a loss.
 */
declare function apply(p: RewritePlan, client: SlackClient, options?: ApplyOptions): Promise<RewriteOutcome[]>;
interface RewriteHandlerOptions {
    /** The plan to serve (parse it with `verifyPlan`). */
    plan: RewritePlan | (() => Promise<RewritePlan>);
    /** The Slack client the apply writes with (a bot token, for sender overrides); built only on a `check` / `apply`. */
    client: SlackClient | (() => SlackClient | Promise<SlackClient>);
    /** A label `GET plan` returns as `path` (the page's title). */
    name?: string;
    receipts?: RewriteReceipts;
    /** The most ids one request takes (default `DEFAULT_BATCH`). */
    maxBatch?: number;
    paceMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * `PlanView`'s backend, for a Worker / Pages Function behind the app's own auth: by the request path's last segment,
 * `GET …/plan` → `{path, plan}` (with `counts`), `POST …/check` / `…/apply` `{ids}` → `{outcomes}` (a dry run for
 * `check`). A POST must be `application/json` and, when the browser sends an `Origin`, same-origin; ids must be the
 * plan's edits / reposts, at most `maxBatch`.
 */
declare function rewriteHandler(request: Request, options: RewriteHandlerOptions): Promise<Response>;

export { type ApplyOptions, type FindOptions, type FoundPermalink, type MessageRef, RawSlackMessage, Render, RewriteFound, type RewriteHandlerOptions, RewriteOutcome, RewritePlan, RewriteReceipts, SlackClient, apply, buildPermalink, findHistory, findIds, findThread, hash53, parsePermalink, permalinksIn, plan, readMessage, rewriteHandler, stableStringify, withoutPermalinks };
