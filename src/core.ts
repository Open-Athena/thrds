import { hash53, stableStringify } from "./hash";

export type ActionType = "SKIP" | "EDIT" | "POST" | "DELETE";

export class EditRateLimited extends Error {
  constructor(message?: string) {
    super(message ?? "edit rate limited");
    this.name = "EditRateLimited";
  }
}

export class OrphanedRepliesError extends Error {
  constructor(
    public readonly messageId: string,
    public readonly replyCount: number,
  ) {
    super(
      `Refusing to delete message ${messageId}: it has ${replyCount} ` +
        `thread replies that would be orphaned. Pass orphansOk=true to delete anyway.`,
    );
    this.name = "OrphanedRepliesError";
  }
}

export interface Action {
  type: ActionType;
  index: number;
  messageId?: string;
  /** The desired message's text. */
  content?: string;
  priorContent?: string;
}

/** Who a message is posted as. Slack applies it at post time only: an edit keeps the original sender. */
export interface Sender {
  username?: string;
  /** An https image URL Slack can fetch. Wins over `iconEmoji`. */
  iconUrl?: string;
  iconEmoji?: string;
}

export interface MessageMetadata {
  event_type: string;
  event_payload: Record<string, unknown>;
}

/** Link / media unfurling for one message: a boolean sets both. */
export type Unfurl = boolean | { links?: boolean; media?: boolean };

/** A message with everything a post can carry. A bare string is shorthand for `{ text }`. */
export interface Msg extends Sender {
  /** The message text; with `blocks`, Slack's notification / fallback text. */
  text: string;
  blocks?: unknown[];
  /** Legacy attachments (colored side bars, cards). `[]` clears them on an edit. */
  attachments?: unknown[];
  metadata?: MessageMetadata;
  /**
   * Uploaded file ids (`SlackClient.upload`) attached below the message, sent as `chat.update` `file_ids`: an edit
   * replaces the message's attached files with these, and omitting it leaves them as they were. `chat.postMessage`
   * takes no `file_ids`, so a post with files is a post followed by an edit. On Slack's phone apps only an attached file
   * offers Download / Save; an `image` block doesn't, even one on a Slack-hosted file.
   */
  files?: string[];
  /** Also show a thread reply in the channel. Applies at post time. */
  replyBroadcast?: boolean;
  /** Overrides the client's unfurl setting for this message. */
  unfurl?: Unfurl;
  /**
   * Stamp a content hash into this message's metadata so a later `sync` can compare it (default true for rich
   * messages). Set false for one-off posts that will never be synced, or edits of messages that aren't the bot's.
   */
  stamp?: boolean;
}

export type MsgLike = string | Msg;

export const toMsg = (m: MsgLike): Msg => (typeof m === "string" ? { text: m } : m);

/** The `metadata.event_payload` field a sent message's content hash is stamped into. */
export const THRDS_HASH = "thrds_hash";

/** Hash of what a re-send can change: text, blocks, attachments, files and metadata (not the sender, fixed at post). */
export function msgHash(m: MsgLike): string {
  const msg = toMsg(m);
  const payload = msg.metadata ? { ...msg.metadata.event_payload } : undefined;
  if (payload) delete payload[THRDS_HASH];
  return hash53(
    stableStringify({
      text: msg.text,
      blocks: msg.blocks,
      attachments: msg.attachments,
      files: msg.files,
      metadata: msg.metadata ? { event_type: msg.metadata.event_type, event_payload: payload } : undefined,
    }),
  );
}

/** Whether `m` is compared by a stamped hash rather than its text (it has blocks, attachments, files or metadata). */
export const isRich = (m: MsgLike): boolean =>
  typeof m !== "string" &&
  (m.blocks !== undefined || m.attachments !== undefined || m.files !== undefined || m.metadata !== undefined);

/**
 * How `sync` compares a desired message with a live one. Plain text compares as itself (so threads written by the
 * Python `thrds` reconcile the same way); a rich message as `thrds:<hash>`, because Slack rewrites blocks on readback.
 */
export const contentKey = (m: MsgLike): string =>
  isRich(m) ? `thrds:${msgHash(m)}` : toMsg(m).text;

export interface Thread {
  messages: MsgLike[];
}

export interface Message {
  id: string;
  /** The message text. */
  content: string;
  editable?: boolean;
  /** Comparable content as read back (`contentKey`); `content` when absent. */
  key?: string;
}

export interface SyncResult {
  threadId: string;
  messageIds: string[];
  actions: Action[];
}

export interface SyncOptions {
  dryRun?: boolean;
  pace?: number;
  jitter?: number;
  suppressEmbeds?: boolean;
  suppressUnfurls?: boolean;
}

export interface ThreadClient {
  list(threadId: string): Promise<Message[]>;
  post(msg: MsgLike, threadId?: string): Promise<Message>;
  edit(messageId: string, msg: MsgLike): Promise<Message>;
  delete(messageId: string): Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function sync(
  client: ThreadClient,
  desired: Thread,
  threadId?: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const { dryRun = false, pace = 0, jitter = 0 } = options;
  const actions: Action[] = [];
  const messageIds: string[] = [];
  let mutated = false;

  const doPace = async (): Promise<void> => {
    if (mutated && pace > 0) {
      const delay = pace + Math.random() * jitter;
      await sleep(delay * 1000);
    }
    mutated = true;
  };

  const allExisting: Message[] =
    threadId !== undefined ? await client.list(threadId) : [];
  const existing = allExisting.filter((m) => m.editable !== false);

  const M = desired.messages.length;
  const N = existing.length;

  // Phase 1: delete editable extras from the end (backwards, OP last)
  if (M < N) {
    for (let i = N - 1; i >= M; i--) {
      const msg = existing[i]!;
      actions.push({
        type: "DELETE",
        index: i,
        messageId: msg.id,
        priorContent: msg.content,
      });
      if (!dryRun) {
        await doPace();
        await client.delete(msg.id);
      }
    }
  }

  // Phase 2: edit overlapping messages (skip unchanged)
  const overlap = Math.min(M, N);
  let repostFrom: number | null = null;
  for (let i = 0; i < overlap; i++) {
    const ex = existing[i]!;
    const want = desired.messages[i]!;
    if ((ex.key ?? ex.content) === contentKey(want)) {
      actions.push({
        type: "SKIP",
        index: i,
        messageId: ex.id,
        content: toMsg(want).text,
      });
      messageIds.push(ex.id);
      continue;
    }
    actions.push({
      type: "EDIT",
      index: i,
      messageId: ex.id,
      content: toMsg(want).text,
      priorContent: ex.content,
    });
    if (dryRun) {
      messageIds.push(ex.id);
      continue;
    }
    try {
      await doPace();
      const result = await client.edit(ex.id, want);
      messageIds.push(result.id);
    } catch (e) {
      if (e instanceof EditRateLimited) {
        repostFrom = i;
        break;
      }
      throw e;
    }
  }

  // Phase 2b: delete+repost fallback when an edit rate-limited
  if (repostFrom !== null) {
    for (let j = overlap - 1; j >= repostFrom; j--) {
      const msg = existing[j]!;
      actions.push({
        type: "DELETE",
        index: j,
        messageId: msg.id,
        priorContent: msg.content,
      });
      await doPace();
      await client.delete(msg.id);
    }
    for (let j = repostFrom; j < M; j++) {
      const want = desired.messages[j]!;
      actions.push({ type: "POST", index: j, content: toMsg(want).text });
      await doPace();
      const result = await client.post(want, threadId);
      messageIds.push(result.id);
    }
    return {
      threadId: threadId ?? "",
      messageIds,
      actions,
    };
  }

  // Phase 3: post new messages at the end (creating thread if needed)
  let finalThreadId = threadId;
  if (M > N) {
    let start = N;
    if (threadId === undefined && N === 0) {
      const want = desired.messages[0]!;
      actions.push({ type: "POST", index: 0, content: toMsg(want).text });
      if (dryRun) {
        messageIds.push("<new>");
        finalThreadId = "<new>";
      } else {
        await doPace();
        const result = await client.post(want);
        finalThreadId = result.id;
        messageIds.push(result.id);
      }
      start = 1;
    }
    for (let i = start; i < M; i++) {
      const want = desired.messages[i]!;
      actions.push({ type: "POST", index: i, content: toMsg(want).text });
      if (dryRun) {
        messageIds.push("<new>");
      } else {
        await doPace();
        const result = await client.post(want, finalThreadId);
        messageIds.push(result.id);
      }
    }
  }

  return {
    threadId: finalThreadId ?? "",
    messageIds,
    actions,
  };
}
