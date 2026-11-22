export { A as Action, a as ActionType, E as EditRateLimited, M as Message, b as MessageMetadata, c as Msg, d as MsgLike, O as OrphanedRepliesError, S as Sender, e as SyncOptions, f as SyncResult, T as THRDS_HASH, g as Thread, h as ThreadClient, U as Unfurl, i as contentKey, j as isRich, m as msgHash, s as sync, t as toMsg } from './core-BNb_OG-w.js';
export { A as AttachedFile, a as Auth, B as BulletFn, C as CHANNEL_TTL_MS, b as CallOptions, c as CustomSenderFilesError, F as FILE_HASHES, d as FileNotProcessedError, e as FileSpec, f as FileSwap, g as FileSwapError, h as FilesNotAttachedError, i as FilesSwap, L as LinkedSyncResult, j as LinkedThread, M as MAX_CACHED_USERS, N as NON_IDEMPOTENT, k as NOT_FOUND_TTL_MS, R as Reaction, l as RetryInfo, S as SLACK_API, m as SLACK_MESSAGE_LIMIT, n as Section, o as SenderOverrides, p as SlackApiError, q as SlackClient, r as SlackClientOptions, s as SlackDeleteOptions, t as SlackErrorKind, u as SlackMessage, v as SlackPostOptions, w as SlackResponse, x as SlackSyncOptions, y as SlackUser, T as Transport, z as TransportOptions, U as USERNAME_MAX, D as USER_TTL_MS, E as UploadData, G as UploadOptions, H as assertFilesAttachable, I as attachedFiles, J as buildDetailMessages, K as buildSummaryMessages, O as collect, P as defaultBullet, Q as definitelyNotAttached, V as isProcessed, W as paginate, X as senderOverrides, Y as slackApi, Z as slackCall, _ as splitBody, $ as swapFiles, a0 as toBytes, a1 as webClientTransport, a2 as withFiles } from './slack-DsYQB40e.js';
export { B as Block, a as ButtonOptions, D as DiffLine, P as PLAN_VERSION, b as PRIVATE_METADATA_MAX, c as PlannedAction, R as REWRITE_KINDS, d as REWRITE_STATUSES, e as RewriteContent, f as RewriteKind, g as RewriteOutcome, h as RewritePlan, i as RewriteSender, j as RewriteStatus, k as RichStyle, l as actions, m as bound, n as button, o as context, p as date, q as datePicker, r as decodePrivateMetadata, s as describeSender, t as divider, u as encodePrivateMetadata, v as escape, w as fitsPrivateMetadata, x as header, y as image, z as imageElement, A as input, C as lineDiff, E as link, F as mention, G as modal, H as mrkdwnText, I as option, J as parsePlan, K as plainText, L as plainTextInput, M as planCounts, N as rich, O as section, Q as senderChanged, S as staticSelect, T as usersSelect, U as versionedUrl, V as withoutImages, W as writes } from './rewrite-D8KfbPDU.js';
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

export { type FoundPermalink, type MessageRef, buildPermalink, hash53, parsePermalink, permalinksIn, stableStringify, withoutPermalinks };
