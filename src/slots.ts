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
 */
import { SlackApiError } from "./api";
import { THRDS_HASH, msgHash, toMsg, type Msg, type MsgLike } from "./core";
import type { SlackClient, SlackMessage } from "./slack";

/** Where a slot's message lives, and a hash of what was last sent there. */
export interface SlotRecord {
  ts: string;
  hash: string;
}

export interface SlotState {
  parent?: SlotRecord;
  slots: Record<string, SlotRecord>;
  /** A post that started but wasn't recorded. `slot` null is the parent; `at` is epoch seconds. */
  pending?: { slot: string | null; hash: string; at: number };
}

/**
 * Persistence for slot state, by thread key. `put` with a `lease` must fail (return false) once the lease is no longer
 * held. `claim` / `release` are optional: a store without them can't fence concurrent runs (fine for a cron job).
 */
export interface SlotStore {
  get(key: string): Promise<SlotState | undefined>;
  put(key: string, state: SlotState, lease?: string): Promise<boolean>;
  claim?(key: string, leaseS: number, nowS: number): Promise<string | null>;
  release?(key: string, lease: string): Promise<void>;
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
}

export interface SlotThread {
  /** The thread's identity in the store (`burst:123`, `week:2026-11-13`). */
  key: string;
  /** Our parent message, or an existing message (someone else's prompt) to reply under without managing it. */
  parent: MsgLike | { ts: string };
  /** Named replies, in post order. */
  slots?: SlotSpec[];
  /** Delete stored slots no longer desired. Default false: a slot dropped from `slots` is left alone. */
  prune?: boolean;
}

export interface SlotSyncOptions {
  /** Claim the key for this long first (needs a store with `claim`). A busy key returns `status: "busy"`. */
  leaseS?: number;
  /** Seconds between Slack writes. */
  pace?: number;
  dryRun?: boolean;
  /** How far back (s) before a `pending` post's start to look for it in channel history. Default 120. */
  recoverWindowS?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type SlotActionType = "POST" | "EDIT" | "SKIP" | "DELETE" | "ADOPT" | "REPOST";

export interface SlotAction {
  type: SlotActionType;
  /** null for the parent. */
  slot: string | null;
  ts?: string;
}

export interface SlotSyncResult {
  status: "synced" | "busy";
  /** The parent's ts (empty when busy, or `<new>` in a dry run). */
  ts: string;
  slots: Record<string, string>;
  actions: SlotAction[];
}

/** Metadata payload fields that tag a message with its slot. */
export const SLOT_KEY = "thrds_key";
export const SLOT_NAME = "thrds_slot";

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

const isRef = (p: MsgLike | { ts: string }): p is { ts: string } =>
  typeof p !== "string" && !("text" in p) && "ts" in p;

const isGone = (e: unknown): boolean => e instanceof SlackApiError && e.code === "message_not_found";

const isThreadGone = (e: unknown): boolean =>
  e instanceof SlackApiError && (e.code === "thread_not_found" || e.code === "message_not_found");

/** Internal: a reply write found its thread deleted. */
class ParentGone extends Error {}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function syncSlots(
  client: SlackClient,
  store: SlotStore,
  thread: SlotThread,
  options: SlotSyncOptions = {},
): Promise<SlotSyncResult> {
  const { leaseS, pace = 0, dryRun = false, recoverWindowS = 120, now = Date.now, sleep = defaultSleep } = options;
  const { key } = thread;
  const nowS = (): number => Math.floor(now() / 1000);

  let lease: string | undefined;
  if (leaseS !== undefined && !dryRun) {
    if (!store.claim) throw new TypeError("syncSlots: `leaseS` needs a store with `claim` (memoryStore, d1Store)");
    const got = await store.claim(key, leaseS, nowS());
    if (got === null) return { status: "busy", ts: "", slots: {}, actions: [] };
    lease = got;
  }
  try {
    const state: SlotState = (await store.get(key)) ?? { slots: {} };
    const actions: SlotAction[] = [];
    let wrote = false;
    const save = async (): Promise<void> => {
      if (dryRun) return;
      if (!(await store.put(key, state, lease))) throw new LeaseLostError(key);
    };
    const paced = async (): Promise<void> => {
      if (wrote && pace > 0) await sleep(pace * 1000);
      wrote = true;
    };
    const tagged = (m: SlackMessage, slot: string | null): boolean =>
      m.metadata?.event_payload?.[SLOT_KEY] === key && m.metadata.event_payload[SLOT_NAME] === (slot ?? "");

    // A post that may have landed before the last run recorded it: adopt it if Slack has it.
    if (state.pending && !dryRun) {
      const { slot, hash, at } = state.pending;
      const parentTs = slot === null ? undefined : isRef(thread.parent) ? thread.parent.ts : state.parent?.ts;
      const found =
        slot === null
          ? await client.find((m) => tagged(m, null), { oldest: String(at - recoverWindowS) })
          : parentTs !== undefined
            ? await client.find((m) => tagged(m, slot), { threadTs: parentTs })
            : null;
      if (found) {
        if (slot === null) state.parent = { ts: found.id, hash };
        else state.slots[slot] = { ts: found.id, hash };
        actions.push({ type: "ADOPT", slot, ts: found.id });
      }
      delete state.pending;
      await save();
    }

    const post = async (msg: Msg, slot: string | null, threadTs?: string): Promise<string> => {
      const hash = msgHash(msg);
      if (dryRun) return "<new>";
      state.pending = { slot, hash, at: nowS() };
      await save();
      await paced();
      let ts: string;
      try {
        ts = (await client.post(msg, threadTs)).id;
      } catch (e) {
        // The thread is gone: this post didn't land, so there's nothing pending.
        if (slot !== null && isThreadGone(e)) {
          delete state.pending;
          await save();
          throw new ParentGone();
        }
        throw e;
      }
      if (slot === null) state.parent = { ts, hash };
      else state.slots[slot] = { ts, hash };
      delete state.pending;
      await save();
      return ts;
    };

    /** Bring one message up to date: SKIP, EDIT, or POST (REPOST when an edit finds it deleted). */
    const reconcile = async (
      msg: Msg,
      slot: string | null,
      record: SlotRecord | undefined,
      threadTs?: string,
    ): Promise<{ ts: string; reposted: boolean }> => {
      const hash = msgHash(msg);
      if (record === undefined) {
        const ts = await post(msg, slot, threadTs);
        actions.push({ type: "POST", slot, ts });
        return { ts, reposted: false };
      }
      if (record.hash === hash) {
        actions.push({ type: "SKIP", slot, ts: record.ts });
        return { ts: record.ts, reposted: false };
      }
      if (dryRun) {
        actions.push({ type: "EDIT", slot, ts: record.ts });
        return { ts: record.ts, reposted: false };
      }
      try {
        await paced();
        await client.edit(record.ts, msg);
      } catch (e) {
        if (!isGone(e)) throw e;
        // A reply that vanished may mean its whole thread did.
        if (slot !== null && threadTs !== undefined && (await threadGone(threadTs))) throw new ParentGone();
        const ts = await post(msg, slot, threadTs);
        actions.push({ type: "REPOST", slot, ts });
        return { ts, reposted: true };
      }
      record.hash = hash;
      await save();
      actions.push({ type: "EDIT", slot, ts: record.ts });
      return { ts: record.ts, reposted: false };
    };

    const threadGone = async (ts: string): Promise<boolean> => {
      try {
        await client.list(ts);
        return false;
      } catch (e) {
        if (isThreadGone(e)) return true;
        throw e;
      }
    };

    const desired = thread.slots ?? [];
    const names = new Set<string>();
    for (const { slot } of desired) {
      if (names.has(slot)) throw new TypeError(`syncSlots: duplicate slot ${JSON.stringify(slot)}`);
      names.add(slot);
    }

    let parentTs = "";
    const start = actions.length;
    for (let attempt = 0; ; attempt++) {
      try {
        if (isRef(thread.parent)) {
          parentTs = thread.parent.ts;
        } else {
          const parent = await reconcile(tagSlot(thread.parent, key, null), null, state.parent);
          parentTs = parent.ts;
          if (attempt > 0) actions[start]!.type = "REPOST";
          // A re-posted parent is a new thread: its replies go there too.
          if (parent.reposted) {
            state.slots = {};
            await save();
          }
        }
        for (const { slot, msg } of desired) {
          await reconcile(tagSlot(msg, key, slot), slot, state.slots[slot], parentTs);
        }
        break;
      } catch (e) {
        if (!(e instanceof ParentGone)) throw e;
        // Someone else's message can't be re-posted; and a parent gone twice in one run isn't a race to retry.
        if (isRef(thread.parent) || attempt > 0) throw new SlackApiError("conversations.replies", "thread_not_found", 200);
        actions.length = start;
        delete state.parent;
        state.slots = {};
        await save();
      }
    }

    if (thread.prune) {
      for (const [slot, record] of Object.entries(state.slots)) {
        if (names.has(slot)) continue;
        actions.push({ type: "DELETE", slot, ts: record.ts });
        if (dryRun) continue;
        await paced();
        try {
          await client.delete(record.ts, { orphansOk: true });
        } catch (e) {
          if (!isGone(e)) throw e;
        }
        delete state.slots[slot];
        await save();
      }
    }

    const slots: Record<string, string> = {};
    for (const { slot } of desired) {
      const record = state.slots[slot];
      slots[slot] = record ? record.ts : "<new>";
    }
    return { status: "synced", ts: parentTs, slots, actions };
  } finally {
    if (lease !== undefined) await store.release?.(key, lease);
  }
}

/** One message kept in place under `key`: posted the first time, edited when it changes, skipped otherwise. */
export async function upsert(
  client: SlackClient,
  store: SlotStore,
  key: string,
  msg: MsgLike,
  options: SlotSyncOptions = {},
): Promise<{ status: "synced" | "busy"; ts: string; action: SlotActionType | null }> {
  const result = await syncSlots(client, store, { key, parent: msg }, options);
  return { status: result.status, ts: result.ts, action: result.actions.at(-1)?.type ?? null };
}

const newLease = (): string => globalThis.crypto.randomUUID();

/** An in-process store (tests, single-isolate bots, or a cache in front of something slower). */
export function memoryStore(initial: Record<string, SlotState> = {}): SlotStore & { dump(): Record<string, SlotState> } {
  const states = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const leases = new Map<string, { token: string; until: number }>();
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
    async release(key, lease) {
      if (leases.get(key)?.token === lease) leases.delete(key);
    },
    dump() {
      return Object.fromEntries([...states].map(([k, v]) => [k, JSON.parse(v) as SlotState]));
    },
  };
}

/**
 * A store that keeps nothing: slot state is rebuilt from the thread itself, since every slot post carries its key, slot
 * and content hash in its metadata. For bots with no database that reply under a known thread (one echo per person
 * under a prompt). A post that landed before a crash is simply found on the next read, so there's no `pending` to keep.
 * No leases: two concurrent runs can both post a new slot.
 */
export function threadStore(client: SlackClient, threadTs: string): SlotStore {
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
        const record = { ts: m.id, hash: typeof stamped === "string" ? stamped : "" };
        const slot = payload[SLOT_NAME];
        if (slot === "") state.parent = record;
        else if (typeof slot === "string" && !(slot in state.slots)) state.slots[slot] = record;
      }
      return state;
    },
    async put() {
      return true;
    },
  };
}
