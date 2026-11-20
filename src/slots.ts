/**
 * Slotted threads: a parent message plus named replies, each posted once and edited in place when its content
 * changes, with the message ids kept in a pluggable store instead of re-read from Slack.
 *
 * This is the shape most bots hand-roll: an activity burst (parent + `details` + `kind:<k>` replies), a weekly digest
 * (week OP + one reply per day), a form bot's per-person echo under a prompt. Single-message upsert is the degenerate
 * case (a parent, no slots).
 *
 * Crash safety: a `pending` record is saved before every post, and every post is tagged in its metadata with its key
 * and slot. A run that finds a leftover `pending` looks for the tagged message and adopts it instead of posting twice.
 * A post Slack definitely refused (`ok:false`, a 4xx) clears its `pending` at once: nothing landed.
 */
import { SlackApiError } from "./api";
import { THRDS_HASH, msgHash, toMsg, type Message, type Msg, type MsgLike } from "./core";
import { hash53Bytes } from "./hash";
import {
  FILE_HASHES,
  swapFiles,
  toBytes,
  withFiles,
  type AttachedFile,
  type FileSpec,
  type FilesSwap,
  type SlackClient,
  type SlackMessage,
} from "./slack";

/** Where a slot's message lives, and a hash of what was last sent there (`""`: unknown, so the next run edits once). */
export interface SlotRecord {
  ts: string;
  hash: string;
  /** The file ids attached to the message (`Msg.files`), so a later run can delete the ones it replaces. */
  files?: string[];
  /** Their content hashes, in the same order (from the message's `FILE_HASHES` metadata), so unchanged ones are reused. */
  fileHashes?: string[];
}

/** A record, with `files` (and `fileHashes`, when they line up) only when there are some. */
function slotRecord(ts: string, hash: string, files: string[] | undefined, fileHashes: unknown): SlotRecord {
  if (files === undefined || files.length === 0) return { ts, hash };
  const aligned = Array.isArray(fileHashes) && fileHashes.length === files.length && fileHashes.every((h) => typeof h === "string");
  return aligned ? { ts, hash, files, fileHashes: fileHashes as string[] } : { ts, hash, files };
}

const fileHashesOf = (m: Msg): unknown => m.metadata?.event_payload?.[FILE_HASHES];

export interface SlotState {
  /** The channel the thread lives in. A run in a different channel starts a new thread there. */
  channel?: string;
  parent?: SlotRecord;
  slots: Record<string, SlotRecord>;
  /** A post that started but wasn't recorded. `slot` null is the parent; `at` is epoch seconds. */
  pending?: { slot: string | null; hash: string; at: number };
}

/**
 * Persistence for slot state, by thread key. `put` with a `lease` must fail (return false) once the lease is no longer
 * held. The lease methods are optional: a store without them can't fence concurrent runs (fine for a cron job).
 */
export interface SlotStore {
  get(key: string): Promise<SlotState | undefined>;
  put(key: string, state: SlotState, lease?: string): Promise<boolean>;
  claim?(key: string, leaseS: number, nowS: number): Promise<string | null>;
  /** Extend a held lease; false if it's no longer held. Called before each Slack write. */
  renew?(key: string, lease: string, leaseS: number, nowS: number): Promise<boolean>;
  release?(key: string, lease: string): Promise<void>;
  /** A run that lost the claim marks the key, so the holder runs again (re-rendering) before releasing. */
  markDirty?(key: string): Promise<void>;
  /** Clear the mark, returning whether it was set. */
  takeDirty?(key: string, lease: string): Promise<boolean>;
}

/** What `syncSlots` needs from a client; `SlackClient` is one. */
export interface SlotClient {
  readonly channel: string;
  post(msg: MsgLike, threadTs?: string): Promise<Message>;
  edit(ts: string, msg: MsgLike): Promise<Message>;
  delete(ts: string, options?: { orphansOk?: boolean }): Promise<void>;
  list(threadTs: string): Promise<SlackMessage[]>;
  find(hit: (m: SlackMessage) => boolean, options?: { threadTs?: string; oldest?: string }): Promise<SlackMessage | null>;
  /** Cheap existence check; `list` is used without it. */
  message?(ts: string): Promise<SlackMessage | null>;
}

export class LeaseLostError extends Error {
  constructor(public readonly key: string) {
    super(`slot lease lost for ${key}: another run took over`);
    this.name = "LeaseLostError";
  }
}

export interface SlotSpec {
  slot: string;
  msg: MsgLike;
  /** Sent instead when Slack rejects `msg` (`invalid_blocks`, …), e.g. without an image it can't fetch yet. */
  fallback?: MsgLike;
}

/**
 * The parent:
 * - a message (`MsgLike`): ours, posted once and edited when it changes;
 * - `{ keep: msg }`: posted if there's none yet, never edited (its content can come later, e.g. once replies exist);
 * - `{ ts }`: someone else's message, replied under and never touched;
 * - `{ ts, msg }`: an existing message we edit in place but never post (a pinned message made by hand).
 */
export type SlotParent = MsgLike | { keep: MsgLike } | { ts: string } | { ts: string; msg: MsgLike };

export interface SlotThreadSpec {
  parent: SlotParent;
  /** Named replies, in post order. */
  slots?: SlotSpec[];
  /** Sent instead of the parent when Slack rejects it. */
  parentFallback?: MsgLike;
  /** Delete stored slots no longer desired. Default false: a slot dropped from `slots` is left alone. */
  prune?: boolean;
}

export interface SlotThread extends SlotThreadSpec {
  /** The thread's identity in the store (`burst:123`, `week:2026-11-13`). */
  key: string;
}

/** A thread rendered from its current state: called after the lease is claimed and crash recovery has run. */
export interface RenderedSlotThread {
  key: string;
  render: (state: SlotState) => SlotThreadSpec | Promise<SlotThreadSpec>;
}

export interface SlotSyncOptions {
  /** Claim the key for this long first (needs a store with `claim`). A busy key returns `status: "busy"`. */
  leaseS?: number;
  /** Seconds between Slack writes. */
  pace?: number;
  dryRun?: boolean;
  /** Edit even when the stored hash matches (repair a message edited by hand, or re-send after a render change). */
  force?: boolean;
  /**
   * A message deleted on Slack's side: `repost` it (a parent's replies move to the new thread; the default), `forget`
   * it (drop its record and report `GONE`), or `throw`. An existing parent we don't own (`{ ts }`, `{ ts, msg }`) is
   * never re-posted: `repost` acts as `throw` for it.
   */
  onGone?: "repost" | "forget" | "throw";
  /**
   * A post left `pending` by an interrupted run: `scan` Slack for it (needs a history scope; a failed scan throws),
   * `scan-or-post` (scan, but if the scan itself can't run, assume it didn't land: at-least-once), or `post`.
   */
  recover?: "scan" | "scan-or-post" | "post";
  /** How far back (s) before a `pending` post's start to look for it in channel history. Default 120. */
  recoverWindowS?: number;
  /** With `create: false`, a missing parent isn't posted: the result is `status: "missing"`. */
  create?: boolean;
  /** Re-runs for keys marked dirty by losing claimants, before giving up. Default 3. */
  maxReruns?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type SlotActionType = "POST" | "EDIT" | "SKIP" | "DELETE" | "ADOPT" | "REPOST" | "GONE" | "FALLBACK" | "UNRESOLVED";

export interface SlotAction {
  type: SlotActionType;
  /** null for the parent. */
  slot: string | null;
  ts?: string;
}

export interface SlotSyncResult {
  /** `busy`: another run holds the key (and will re-run for us, with a store that supports it). */
  status: "synced" | "busy" | "missing" | "gone";
  /** The parent's ts (empty when there's none, or `<new>` in a dry run). */
  ts: string;
  slots: Record<string, string>;
  actions: SlotAction[];
}

/** Metadata payload fields that tag a message with its slot. */
export const SLOT_KEY = "thrds_key";
export const SLOT_NAME = "thrds_slot";

/** Slack error codes meaning "this message's content was rejected" (so a `fallback` is worth trying). */
export const REJECTED = new Set(["invalid_blocks", "invalid_blocks_format", "invalid_attachments", "msg_too_long", "invalid_metadata_format"]);

/** `msg` with its key and slot in its metadata (keeping a caller's own `event_type` and payload). */
export function tagSlot(m: MsgLike, key: string, slot: string | null): Msg {
  const msg = toMsg(m);
  return {
    ...msg,
    metadata: {
      event_type: msg.metadata?.event_type ?? "thrds_slot",
      event_payload: { ...msg.metadata?.event_payload, [SLOT_KEY]: key, [SLOT_NAME]: slot ?? "" },
    },
  };
}

/** The partial result a `syncSlots` failure carries: what landed before it threw. */
export const partialOf = (e: unknown): SlotSyncResult | undefined =>
  (e as { partial?: SlotSyncResult } | null)?.partial;

const isRef = (p: SlotParent): p is { ts: string } | { ts: string; msg: MsgLike } =>
  typeof p !== "string" && !("text" in p) && "ts" in p;
const isKeep = (p: SlotParent): p is { keep: MsgLike } => typeof p !== "string" && "keep" in p;

const isGone = (e: unknown): boolean => e instanceof SlackApiError && e.code === "message_not_found";
const isThreadGone = (e: unknown): boolean =>
  e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found");
const isRejected = (e: unknown): boolean => e instanceof SlackApiError && REJECTED.has(e.code);

/** Internal: a reply write found its thread deleted. */
class ParentGone extends Error {}
/** Internal: a message was gone and `onGone: "forget"` dropped it. */
class Forgotten extends Error {
  constructor(public readonly slot: string | null) {
    super("forgotten");
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function syncSlots(
  client: SlotClient,
  store: SlotStore,
  thread: SlotThread | RenderedSlotThread,
  options: SlotSyncOptions = {},
): Promise<SlotSyncResult> {
  const {
    leaseS,
    pace = 0,
    dryRun = false,
    force = false,
    onGone = "repost",
    recover = "scan",
    recoverWindowS = 120,
    create = true,
    maxReruns = 3,
    now = Date.now,
    sleep = defaultSleep,
  } = options;
  const { key } = thread;
  const nowS = (): number => Math.floor(now() / 1000);
  const render = async (state: SlotState): Promise<SlotThreadSpec> => ("render" in thread ? thread.render(state) : thread);

  let lease: string | undefined;
  if (leaseS !== undefined && !dryRun) {
    if (!store.claim) throw new TypeError("syncSlots: `leaseS` needs a store with `claim` (memoryStore, d1Store)");
    const got = await store.claim(key, leaseS, nowS());
    if (got === null) {
      await store.markDirty?.(key);
      return { status: "busy", ts: "", slots: {}, actions: [] };
    }
    lease = got;
  }

  const actions: SlotAction[] = [];
  let state: SlotState = { slots: {} };
  let parentTs = "";
  let status: SlotSyncResult["status"] = "synced";
  let desired: SlotSpec[] = [];
  const result = (): SlotSyncResult => {
    const slots: Record<string, string> = {};
    if (status === "synced") {
      for (const { slot } of desired) {
        const record = state.slots[slot];
        if (record) slots[slot] = record.ts;
        else if (dryRun) slots[slot] = "<new>";
      }
    }
    return { status, ts: parentTs, slots, actions };
  };
  try {
    state = (await store.get(key)) ?? { slots: {} };
    let unsaved = false;
    const save = async (): Promise<void> => {
      if (dryRun) return;
      if (!(await store.put(key, state, lease))) throw new LeaseLostError(key);
      unsaved = false;
    };
    let wrote = false;
    /** Before each Slack write: pace, and keep the lease. */
    const beforeWrite = async (): Promise<void> => {
      if (wrote && pace > 0) await sleep(pace * 1000);
      wrote = true;
      if (lease !== undefined && store.renew && !(await store.renew(key, lease, leaseS!, nowS()))) throw new LeaseLostError(key);
    };
    const tagged = (m: SlackMessage, slot: string | null): boolean =>
      m.editable !== false && m.metadata?.event_payload?.[SLOT_KEY] === key && m.metadata.event_payload[SLOT_NAME] === (slot ?? "");

    // A thread recorded in another channel (the bot moved, or a test stack): start over here, leaving it be.
    if (state.channel !== undefined && state.channel !== client.channel) {
      state = { slots: {} };
      unsaved = true;
    }

    // A post that may have landed before the last run recorded it: adopt it if Slack has it.
    if (state.pending && !dryRun) {
      const { slot, hash, at } = state.pending;
      let found: SlackMessage | null = null;
      if (recover !== "post") {
        const first = await render(state);
        const threadTs = slot === null ? undefined : isRef(first.parent) ? first.parent.ts : state.parent?.ts;
        try {
          found =
            slot === null
              ? await client.find((m) => tagged(m, null), { oldest: String(at - recoverWindowS) })
              : threadTs !== undefined
                ? await client.find((m) => tagged(m, slot), { threadTs })
                : null;
        } catch (e) {
          if (!(e instanceof SlackApiError && e.definite)) throw e;
          if (recover !== "scan-or-post") {
            throw new Error(
              `syncSlots: can't check whether ${key}'s interrupted post landed (${e.code}); grant a history scope ` +
                `(channels:history / groups:history), or pass recover: "scan-or-post"`,
              { cause: e },
            );
          }
          actions.push({ type: "UNRESOLVED", slot });
        }
      }
      if (found) {
        // Record what's live: a post with files lands stamped without them if the attaching edit didn't.
        const stamped = found.metadata?.event_payload?.[THRDS_HASH];
        const live = typeof stamped === "string" ? stamped : hash;
        if (slot === null) state.parent = { ts: found.id, hash: live };
        else state.slots[slot] = { ts: found.id, hash: live };
        actions.push({ type: "ADOPT", slot, ts: found.id });
      }
      delete state.pending;
      await save();
    }

    const record = (slot: string | null, r: SlotRecord): void => {
      if (slot === null) state.parent = r;
      else state.slots[slot] = r;
    };

    const post = async (msg: Msg, slot: string | null, threadTs?: string, fallback?: MsgLike): Promise<{ ts: string; fell: boolean }> => {
      if (dryRun) return { ts: "<new>", fell: false };
      state.channel = client.channel;
      state.pending = { slot, hash: msgHash(msg), at: nowS() };
      await save();
      await beforeWrite();
      let sent = msg;
      let ts: string;
      try {
        ts = (await client.post(msg, threadTs)).id;
      } catch (e) {
        if (slot !== null && isThreadGone(e)) {
          delete state.pending;
          await save();
          throw new ParentGone();
        }
        if (!(e instanceof SlackApiError && e.definite)) throw e;
        // Slack refused it outright: nothing landed, so there's nothing to recover.
        delete state.pending;
        await save();
        if (fallback === undefined || !isRejected(e)) throw e;
        sent = tagSlot(fallback, key, slot);
        state.pending = { slot, hash: msgHash(sent), at: nowS() };
        await save();
        ts = (await client.post(sent, threadTs)).id;
      }
      record(slot, slotRecord(ts, msgHash(sent), sent.files, fileHashesOf(sent)));
      delete state.pending;
      await save();
      return { ts, fell: sent !== msg };
    };

    const threadGone = async (ts: string): Promise<boolean> => {
      try {
        if (client.message) return (await client.message(ts)) === null;
        await client.list(ts);
        return false;
      } catch (e) {
        if (isThreadGone(e)) return true;
        throw e;
      }
    };

    interface Mode {
      threadTs?: string;
      fallback?: MsgLike;
      keep?: boolean;
      /** An existing message we only edit. */
      editOnly?: string;
    }

    /** Bring one message up to date: SKIP, EDIT, POST, FALLBACK, REPOST (or GONE via `Forgotten`). */
    const reconcile = async (msg: Msg, slot: string | null, current: SlotRecord | undefined, mode: Mode): Promise<{ ts: string; reposted: boolean }> => {
      const hash = msgHash(msg);
      if (current === undefined && mode.editOnly === undefined) {
        const { ts, fell } = await post(msg, slot, mode.threadTs, mode.fallback);
        actions.push({ type: fell ? "FALLBACK" : "POST", slot, ts });
        return { ts, reposted: false };
      }
      const target = current ?? { ts: mode.editOnly!, hash: "" };
      if (mode.keep || (!force && target.hash === hash)) {
        actions.push({ type: "SKIP", slot, ts: target.ts });
        return { ts: target.ts, reposted: false };
      }
      if (dryRun) {
        actions.push({ type: "EDIT", slot, ts: target.ts });
        return { ts: target.ts, reposted: false };
      }
      let sentHash = hash;
      let sentFiles = msg.files;
      let sentFileHashes = fileHashesOf(msg);
      let fell = false;
      try {
        await beforeWrite();
        try {
          await client.edit(target.ts, msg);
        } catch (e) {
          if (mode.fallback === undefined || !isRejected(e)) throw e;
          const fb = tagSlot(mode.fallback, key, slot);
          await client.edit(target.ts, fb);
          sentHash = msgHash(fb);
          sentFiles = fb.files;
          sentFileHashes = fileHashesOf(fb);
          fell = true;
        }
      } catch (e) {
        if (!isGone(e)) throw e;
        // A reply that vanished may mean its whole thread did.
        if (slot !== null && mode.threadTs !== undefined && (await threadGone(mode.threadTs))) throw new ParentGone();
        if (onGone === "forget") {
          if (slot === null) state = { slots: {} };
          else delete state.slots[slot];
          unsaved = true;
          actions.push({ type: "GONE", slot });
          throw new Forgotten(slot);
        }
        if (onGone === "throw" || mode.editOnly !== undefined) throw e;
        const { ts, fell: refell } = await post(msg, slot, mode.threadTs, mode.fallback);
        actions.push({ type: refell ? "FALLBACK" : "REPOST", slot, ts });
        return { ts, reposted: true };
      }
      // An edit without `files` leaves the attached ones in place.
      record(
        slot,
        sentFiles !== undefined
          ? slotRecord(target.ts, sentHash, sentFiles, sentFileHashes)
          : slotRecord(target.ts, sentHash, current?.files, current?.fileHashes),
      );
      state.channel = client.channel;
      // An edit needs no write-ahead: a lost hash only means one more edit next run.
      unsaved = true;
      actions.push({ type: fell ? "FALLBACK" : "EDIT", slot, ts: target.ts });
      return { ts: target.ts, reposted: false };
    };

    /** One pass over the rendered thread. */
    const pass = async (spec: SlotThreadSpec): Promise<void> => {
      desired = spec.slots ?? [];
      const names = new Set<string>();
      for (const { slot } of desired) {
        if (names.has(slot)) throw new TypeError(`syncSlots: duplicate slot ${JSON.stringify(slot)}`);
        names.add(slot);
      }
      const parentFallback = spec.parentFallback !== undefined ? { fallback: spec.parentFallback } : {};
      const start = actions.length;
      for (let attempt = 0; ; attempt++) {
        try {
          const parent = spec.parent;
          if (isRef(parent)) {
            parentTs = parent.ts;
            if ("msg" in parent) {
              await reconcile(tagSlot(parent.msg, key, null), null, state.parent, { editOnly: parent.ts, ...parentFallback });
            } else if (state.channel === undefined && !dryRun) {
              state.channel = client.channel;
              unsaved = true;
            }
          } else {
            if (state.parent === undefined && !create) {
              status = "missing";
              parentTs = "";
              return;
            }
            const keep = isKeep(parent);
            const r = await reconcile(tagSlot(keep ? parent.keep : parent, key, null), null, state.parent, { keep, ...parentFallback });
            parentTs = r.ts;
            if (attempt > 0) actions[start]!.type = "REPOST";
            // A re-posted parent is a new thread: its replies go there too.
            if (r.reposted) {
              state.slots = {};
              unsaved = true;
            }
          }
          for (const { slot, msg, fallback } of desired) {
            try {
              await reconcile(tagSlot(msg, key, slot), slot, state.slots[slot], {
                threadTs: parentTs,
                ...(fallback !== undefined ? { fallback } : {}),
              });
            } catch (e) {
              // A forgotten reply is dropped; the rest of the thread carries on.
              if (!(e instanceof Forgotten)) throw e;
            }
          }
          break;
        } catch (e) {
          if (e instanceof Forgotten) {
            status = "gone";
            parentTs = "";
            return;
          }
          if (!(e instanceof ParentGone)) throw e;
          if (onGone === "forget") {
            state = { slots: {} };
            unsaved = true;
            actions.push({ type: "GONE", slot: null });
            status = "gone";
            parentTs = "";
            return;
          }
          // Someone else's message can't be re-posted; and a parent gone twice in one run isn't a race to retry.
          if (isRef(spec.parent) || onGone === "throw" || attempt > 0) {
            throw new SlackApiError("conversations.replies", "thread_not_found", 200);
          }
          actions.length = start;
          delete state.parent;
          state.slots = {};
          await save();
        }
      }

      if (spec.prune) {
        for (const [slot, r] of Object.entries(state.slots)) {
          if (names.has(slot)) continue;
          actions.push({ type: "DELETE", slot, ts: r.ts });
          if (dryRun) continue;
          await beforeWrite();
          try {
            await client.delete(r.ts, { orphansOk: true });
          } catch (e) {
            if (!isGone(e)) throw e;
          }
          delete state.slots[slot];
          unsaved = true;
        }
      }
    };

    try {
      await pass(await render(state));
      // Runs that lost the claim meanwhile marked the key: render and sync again so their update isn't lost.
      for (let rerun = 0; lease !== undefined && rerun < maxReruns && (await store.takeDirty?.(key, lease)); rerun++) {
        if (unsaved) await save();
        await pass(await render(state));
      }
      if (unsaved) await save();
    } catch (e) {
      // Keep what landed (edited hashes), so the next run doesn't redo it.
      if (unsaved && !(e instanceof LeaseLostError)) await save().catch(() => undefined);
      throw e;
    }
    return result();
  } catch (e) {
    if (e !== null && typeof e === "object") Object.assign(e, { partial: result() });
    throw e;
  } finally {
    if (lease !== undefined) await store.release?.(key, lease);
  }
}

export interface UpsertOptions extends SlotSyncOptions {
  /** An existing message to keep up to date (edit only, never post), e.g. a pinned leaderboard made by hand. */
  ts?: string;
}

/**
 * One message kept in place under `key`: posted the first time, edited when it changes, skipped otherwise. With
 * `create: false` it never posts (`status: "missing"` until a record exists); with `ts` it only edits that message.
 */
export async function upsert(
  client: SlotClient,
  store: SlotStore,
  key: string,
  msg: MsgLike,
  options: UpsertOptions = {},
): Promise<{ status: SlotSyncResult["status"]; ts: string; action: SlotActionType | null }> {
  const { ts, ...rest } = options;
  const parent: SlotParent = ts !== undefined ? { ts, msg } : msg;
  const result = await syncSlots(client, store, { key, parent }, rest);
  return { status: result.status, ts: result.ts, action: result.actions.at(-1)?.type ?? null };
}

export type UpsertResult = Awaited<ReturnType<typeof upsert>>;

/**
 * One message kept in place under `key` with live attached files (`Msg.files`), e.g. an hourly status card whose
 * panels phone users can download. Each file is hashed; one whose bytes the message already has is reused, the rest
 * are uploaded (waiting until Slack has processed them). Then `msg` is upserted with exactly those files, in order, and
 * the files it no longer has are deleted. The store's record keeps the attached ids and hashes; the hashes are also
 * stamped into the message's metadata (`FILE_HASHES`). Unchanged bytes and message: no uploads, and the upsert skips.
 * Failures follow `swapFiles` (no orphaned uploads). With `create: false` and no record, nothing happens.
 */
export async function upsertFiles(
  client: SlotClient & Pick<SlackClient, "upload" | "deleteFile">,
  store: SlotStore,
  key: string,
  msg: MsgLike,
  files: readonly FileSpec[],
  options: UpsertOptions & { concurrency?: number } = {},
): Promise<UpsertResult & FilesSwap> {
  const { concurrency, ...upsertOptions } = options;
  const record = (await store.get(key))?.parent;
  if (record === undefined && options.create === false && options.ts === undefined) {
    return { ...(await upsert(client, store, key, msg, upsertOptions)), fileIds: [], uploaded: [], deleted: [], undeleted: [] };
  }
  const previous: AttachedFile[] = (record?.files ?? []).map((id, i) => {
    const hash = record?.fileHashes?.[i];
    return hash === undefined ? { id } : { id, hash };
  });
  const desired = await Promise.all(
    files.map(async ({ name, data, ...uploadOptions }) => {
      const bytes = await toBytes(data);
      return { hash: hash53Bytes(bytes), upload: () => client.upload(name, bytes, uploadOptions) };
    }),
  );
  const hashes = desired.map((d) => d.hash);
  const { result, ...swap } = await swapFiles(
    client,
    previous,
    desired,
    (ids) => upsert(client, store, key, withFiles(msg, ids, hashes), upsertOptions),
    concurrency !== undefined ? { concurrency } : {},
  );
  return { ...result, ...swap };
}

/** `upsertFiles` with one file; `fileId` is null only when nothing was posted (`create: false`). */
export async function upsertFile(
  client: SlotClient & Pick<SlackClient, "upload" | "deleteFile">,
  store: SlotStore,
  key: string,
  msg: MsgLike,
  file: FileSpec,
  options: UpsertOptions = {},
): Promise<UpsertResult & FilesSwap & { fileId: string | null }> {
  const r = await upsertFiles(client, store, key, msg, [file], options);
  return { ...r, fileId: r.fileIds[0] ?? null };
}

/** Seed a store with messages posted before thrds managed them (hash unknown: each is edited once on the next run). */
export async function importAnchor(
  store: SlotStore,
  key: string,
  anchor: { channel?: string; parent?: string; slots?: Record<string, string> },
): Promise<void> {
  const state: SlotState = { slots: {} };
  if (anchor.channel !== undefined) state.channel = anchor.channel;
  if (anchor.parent !== undefined) state.parent = { ts: anchor.parent, hash: "" };
  for (const [slot, ts] of Object.entries(anchor.slots ?? {})) state.slots[slot] = { ts, hash: "" };
  await store.put(key, state);
}

const newLease = (): string => globalThis.crypto.randomUUID();

/** An in-process store (tests, single-isolate bots, or a cache in front of something slower). */
export function memoryStore(initial: Record<string, SlotState> = {}): Required<SlotStore> & { dump(): Record<string, SlotState> } {
  const states = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const leases = new Map<string, { token: string; until: number }>();
  const dirty = new Set<string>();
  return {
    async get(key) {
      const s = states.get(key);
      return s === undefined ? undefined : (JSON.parse(s) as SlotState);
    },
    async put(key, state, lease) {
      if (lease !== undefined && leases.get(key)?.token !== lease) return false;
      states.set(key, JSON.stringify(state));
      return true;
    },
    async claim(key, leaseS, nowS) {
      const held = leases.get(key);
      if (held && held.until > nowS) return null;
      const token = newLease();
      leases.set(key, { token, until: nowS + leaseS });
      return token;
    },
    async renew(key, lease, leaseS, nowS) {
      const held = leases.get(key);
      if (held?.token !== lease) return false;
      held.until = nowS + leaseS;
      return true;
    },
    async release(key, lease) {
      if (leases.get(key)?.token === lease) leases.delete(key);
    },
    async markDirty(key) {
      dirty.add(key);
    },
    async takeDirty(key, lease) {
      if (leases.get(key)?.token !== lease) return false;
      return dirty.delete(key);
    },
    dump() {
      return Object.fromEntries([...states].map(([k, v]) => [k, JSON.parse(v) as SlotState]));
    },
  };
}

/**
 * A store over one record the app already keeps (an activity row, a Durable Object field): `syncSlots` sees it under
 * any key. The app keeps its own lease, so this one has none.
 */
export function oneKeyStore(io: {
  get(): SlotState | undefined | Promise<SlotState | undefined>;
  put(state: SlotState): boolean | void | Promise<boolean | void>;
}): SlotStore {
  return {
    async get() {
      return io.get();
    },
    async put(_key, state) {
      return (await io.put(state)) !== false;
    },
  };
}

/**
 * A store that keeps nothing: slot state is rebuilt from the thread itself, since every slot post carries its key, slot
 * and content hash in its metadata. For bots with no database that reply under a known thread (one echo per person
 * under a prompt). A post that landed before a crash is simply found on the next read, so there's no `pending` to keep.
 * No leases: two concurrent runs can both post a new slot.
 */
export function threadStore(client: SlotClient, threadTs: string): SlotStore {
  return {
    async get(key) {
      let messages: SlackMessage[];
      try {
        messages = await client.list(threadTs);
      } catch (e) {
        if (isThreadGone(e)) return undefined;
        throw e;
      }
      const state: SlotState = { slots: {} };
      for (const m of messages) {
        const payload = m.metadata?.event_payload;
        if (!payload || payload[SLOT_KEY] !== key || !m.editable) continue;
        const stamped = payload[THRDS_HASH];
        const r = { ts: m.id, hash: typeof stamped === "string" ? stamped : "" };
        const slot = payload[SLOT_NAME];
        if (slot === "") state.parent = r;
        else if (typeof slot === "string" && !(slot in state.slots)) state.slots[slot] = r;
      }
      return state;
    },
    async put() {
      return true;
    },
  };
}
