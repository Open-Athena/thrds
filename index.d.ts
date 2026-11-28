export { A as Action, a as ActionType, E as EditRateLimited, M as Message, b as MessageMetadata, c as Msg, d as MsgLike, O as OrphanedRepliesError, S as Sender, e as SyncOptions, f as SyncResult, T as THRDS_HASH, g as Thread, h as ThreadClient, U as Unfurl, i as contentKey, j as isRich, m as msgHash, s as sync, t as toMsg } from './core-BNb_OG-w.js';
import { t as SlackClient } from './slack-CBVpZ3hd.js';
export { A as AttachedFile, a as Auth, B as BulletFn, C as CHANNEL_TTL_MS, b as CallOptions, c as CustomSenderFilesError, F as FILE_HASHES, d as FileNotProcessedError, e as FileSpec, f as FileSwap, g as FileSwapError, h as FilesNotAttachedError, i as FilesSwap, L as LinkedSyncResult, j as LinkedThread, M as MAX_CACHED_USERS, N as NON_IDEMPOTENT, k as NOT_FOUND_TTL_MS, R as Reaction, l as RetryInfo, S as SLACK_API, m as SLACK_BLOCKS_LIMIT, n as SLACK_MESSAGE_LIMIT, o as SLACK_SECTION_LIMIT, p as Section, q as SectionBlock, r as SenderOverrides, s as SlackApiError, u as SlackClientOptions, v as SlackDeleteOptions, w as SlackErrorKind, x as SlackMessage, y as SlackPostOptions, z as SlackResponse, D as SlackSyncOptions, E as SlackUser, T as Transport, G as TransportOptions, U as USERNAME_MAX, H as USER_TTL_MS, I as UploadData, J as UploadOptions, K as assertFilesAttachable, O as attachedFiles, P as buildDetailMessages, Q as buildSummaryMessages, V as codePoints, W as collect, X as defaultBullet, Y as definitelyNotAttached, Z as fallbackText, _ as isProcessed, $ as paginate, a0 as sectionBlocks, a1 as senderOverrides, a2 as slackApi, a3 as slackCall, a4 as splitBody, a5 as swapFiles, a6 as toBytes, a7 as webClientTransport, a8 as withFiles } from './slack-CBVpZ3hd.js';
import { q as RewriteReceipts, n as RewriteOutcome, p as RewritePost, o as RewritePlan, l as RewriteFound, j as Render, i as RawSlackMessage, B as Block } from './rewrite-CdcxTFzS.js';
export { a as ButtonOptions, D as DEFAULT_BATCH, b as DEFAULT_PACE_MS, c as Delete, d as Desired, e as DiffLine, P as PLAN_VERSION, f as PRIVATE_METADATA_MAX, g as PlannedAction, R as REWRITE_KINDS, h as REWRITE_STATUSES, k as RewriteContent, m as RewriteKind, r as RewriteSender, s as RewriteStatus, t as RichStyle, S as Skip, u as actions, v as applyOrder, w as bound, x as button, y as contentHash, z as contentOf, A as context, C as date, E as datePicker, F as decodePrivateMetadata, G as describeSender, H as divider, I as encodePrivateMetadata, J as escape, K as fitsPrivateMetadata, L as header, M as image, N as imageElement, O as input, Q as lineDiff, T as link, U as memoryReceipts, V as mention, W as modal, X as mrkdwnText, Y as option, Z as parsePlan, _ as plainText, $ as plainTextInput, a0 as planCounts, a1 as postRewrite, a2 as postedOf, a3 as pyJsonDumps, a4 as rich, a5 as sameContent, a6 as section, a7 as senderChanged, a8 as senderOf, a9 as staticSelect, aa as substitute, ab as usersSelect, ac as verifyPlan, ad as versionedUrl, ae as withoutImages, af as writes, ag as writesSummary } from './rewrite-CdcxTFzS.js';
export { L as LeaseLostError, R as REJECTED, a as RenderedSlotThread, S as SLOT_KEY, b as SLOT_NAME, c as SlotAction, d as SlotActionType, e as SlotClient, f as SlotParent, g as SlotRecord, h as SlotSpec, i as SlotState, j as SlotStore, k as SlotSyncOptions, l as SlotSyncResult, m as SlotThread, n as SlotThreadSpec, U as UpsertOptions, o as UpsertResult, p as importAnchor, q as memoryStore, r as oneKeyStore, s as partialOf, t as syncSlots, u as tagSlot, v as threadStore, w as upsert, x as upsertFile, y as upsertFiles } from './slots-BakJ4fdg.js';

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

/**
 * A rendered `text` / `blocks` as Python's `SlackClient.post` / `edit` send it, under Slack's 4,000 on `text`. Text
 * over `SLACK_MESSAGE_LIMIT` beside blocks becomes its `fallbackText`; text-only over it goes out as
 * `sectionBlocks(text, { lines: true })` with that fallback. Throws when Slack can't take it: a line over the section
 * limit, or more than `SLACK_BLOCKS_LIMIT` blocks. Python's `thrds.rewrite.sendable`.
 */
declare function sendable(text: string, blocks: Block[] | null): {
    text: string;
    blocks: Block[] | null;
};
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
interface PlanOptions {
    /** Allow a repost that moves a message to the end of its channel / thread. */
    reorderOk?: boolean;
    /** New messages, posted in this order after the found messages' writes. */
    posts?: Iterable<RewritePost>;
    /** See `RewritePlan.delete_after_posts`. */
    deleteAfterPosts?: boolean;
    /** See `RewritePlan.atomic`. */
    atomic?: boolean;
}
/** One action per found message, then one `post` per `posts`; no Slack calls. A sender change is a `repost`, `blocked`
 *  when the message has replies (they'd orphan), when it isn't the newest in its container (`reorderOk` allows it), or
 *  when it has files and the new sender is an override (Slack shows no files on those). A `Delete` is `blocked` when
 *  the message has replies. `render` runs only on this app's own posts. Python's `plan`. */
declare function plan(found: Iterable<RewriteFound>, render: Render, options?: PlanOptions): Promise<RewritePlan>;
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
 * Carry out the plan's writes (`only`: just these ids: a message's ts, a post's key), in `applyOrder`: the plan's
 * order, with every `delete` after the rest. A dry run by default: each action is still checked against its message
 * (`pending` / `stale` / `gone` / `already`), but nothing is written. A repost posts the new message before deleting
 * the old one, so a failed delete leaves a duplicate (`undeleted`), never a loss; likewise a `post` that fails holds the
 * run's deletes (left `pending`), and with `delete_after_posts` a delete waits for every post in the plan. A real run
 * with posts needs `receipts`, so a re-run never posts twice. Python's `apply`.
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
 * `GET …/plan` → `{path, plan}` (with `counts`), `POST …/check` / `…/apply` `{ids}` → `{outcomes, posted}` (a dry
 * run for `check`; `posted`: each post's key → its ts, as `postedOf`). A POST must be `application/json` and, when the
 * browser sends an `Origin`, same-origin; ids must be the plan's writes (a message's ts, a post's key), at most
 * `maxBatch`. A plan with posts needs `receipts` to apply.
 */
declare function rewriteHandler(request: Request, options: RewriteHandlerOptions): Promise<Response>;

export { type ApplyOptions, Block, type FindOptions, type FoundPermalink, type MessageRef, type PlanOptions, RawSlackMessage, Render, RewriteFound, type RewriteHandlerOptions, RewriteOutcome, RewritePlan, RewritePost, RewriteReceipts, SlackClient, apply, buildPermalink, findHistory, findIds, findThread, hash53, parsePermalink, permalinksIn, plan, readMessage, rewriteHandler, sendable, stableStringify, withoutPermalinks };
