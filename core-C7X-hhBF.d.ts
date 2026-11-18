type ActionType = "SKIP" | "EDIT" | "POST" | "DELETE";
declare class EditRateLimited extends Error {
    constructor(message?: string);
}
declare class OrphanedRepliesError extends Error {
    readonly messageId: string;
    readonly replyCount: number;
    constructor(messageId: string, replyCount: number);
}
interface Action {
    type: ActionType;
    index: number;
    messageId?: string;
    /** The desired message's text. */
    content?: string;
    priorContent?: string;
}
/** Who a message is posted as. Slack applies it at post time only: an edit keeps the original sender. */
interface Sender {
    username?: string;
    /** An https image URL Slack can fetch. Wins over `iconEmoji`. */
    iconUrl?: string;
    iconEmoji?: string;
}
interface MessageMetadata {
    event_type: string;
    event_payload: Record<string, unknown>;
}
/** A message with everything a post can carry. A bare string is shorthand for `{ text }`. */
interface Msg extends Sender {
    /** The message text; with `blocks`, Slack's notification / fallback text. */
    text: string;
    blocks?: unknown[];
    metadata?: MessageMetadata;
    /** Also show a thread reply in the channel. Applies at post time. */
    replyBroadcast?: boolean;
}
type MsgLike = string | Msg;
declare const toMsg: (m: MsgLike) => Msg;
/** The `metadata.event_payload` field a sent message's content hash is stamped into. */
declare const THRDS_HASH = "thrds_hash";
/** Hash of what a re-send can change: text, blocks and metadata (not the sender, which Slack fixes at post). */
declare function msgHash(m: MsgLike): string;
/** Whether `m` is compared by a stamped hash rather than its text (it has blocks or metadata). */
declare const isRich: (m: MsgLike) => boolean;
/**
 * How `sync` compares a desired message with a live one. Plain text compares as itself (so threads written by the
 * Python `thrds` reconcile the same way); a rich message as `thrds:<hash>`, because Slack rewrites blocks on readback.
 */
declare const contentKey: (m: MsgLike) => string;
interface Thread {
    messages: MsgLike[];
}
interface Message {
    id: string;
    /** The message text. */
    content: string;
    editable?: boolean;
    /** Comparable content as read back (`contentKey`); `content` when absent. */
    key?: string;
}
interface SyncResult {
    threadId: string;
    messageIds: string[];
    actions: Action[];
}
interface SyncOptions {
    dryRun?: boolean;
    pace?: number;
    jitter?: number;
    suppressEmbeds?: boolean;
    suppressUnfurls?: boolean;
}
interface ThreadClient {
    list(threadId: string): Promise<Message[]>;
    post(msg: MsgLike, threadId?: string): Promise<Message>;
    edit(messageId: string, msg: MsgLike): Promise<Message>;
    delete(messageId: string): Promise<void>;
}
declare function sync(client: ThreadClient, desired: Thread, threadId?: string, options?: SyncOptions): Promise<SyncResult>;

export { type Action as A, EditRateLimited as E, type Message as M, OrphanedRepliesError as O, type Sender as S, THRDS_HASH as T, type ActionType as a, type MessageMetadata as b, type Msg as c, type MsgLike as d, type SyncOptions as e, type SyncResult as f, type Thread as g, type ThreadClient as h, contentKey as i, isRich as j, msgHash as m, sync as s, toMsg as t };
