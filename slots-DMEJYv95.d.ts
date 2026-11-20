import { d as MsgLike, M as Message, c as Msg } from './core-BNb_OG-w.js';
import { l as SlackMessage } from './slack-1TMyg3SF.js';

/** Where a slot's message lives, and a hash of what was last sent there (`""`: unknown, so the next run edits once). */
interface SlotRecord {
    ts: string;
    hash: string;
}
interface SlotState {
    /** The channel the thread lives in. A run in a different channel starts a new thread there. */
    channel?: string;
    parent?: SlotRecord;
    slots: Record<string, SlotRecord>;
    /** A post that started but wasn't recorded. `slot` null is the parent; `at` is epoch seconds. */
    pending?: {
        slot: string | null;
        hash: string;
        at: number;
    };
}
/**
 * Persistence for slot state, by thread key. `put` with a `lease` must fail (return false) once the lease is no longer
 * held. The lease methods are optional: a store without them can't fence concurrent runs (fine for a cron job).
 */
interface SlotStore {
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
interface SlotClient {
    readonly channel: string;
    post(msg: MsgLike, threadTs?: string): Promise<Message>;
    edit(ts: string, msg: MsgLike): Promise<Message>;
    delete(ts: string, options?: {
        orphansOk?: boolean;
    }): Promise<void>;
    list(threadTs: string): Promise<SlackMessage[]>;
    find(hit: (m: SlackMessage) => boolean, options?: {
        threadTs?: string;
        oldest?: string;
    }): Promise<SlackMessage | null>;
    /** Cheap existence check; `list` is used without it. */
    message?(ts: string): Promise<SlackMessage | null>;
}
declare class LeaseLostError extends Error {
    readonly key: string;
    constructor(key: string);
}
interface SlotSpec {
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
type SlotParent = MsgLike | {
    keep: MsgLike;
} | {
    ts: string;
} | {
    ts: string;
    msg: MsgLike;
};
interface SlotThreadSpec {
    parent: SlotParent;
    /** Named replies, in post order. */
    slots?: SlotSpec[];
    /** Sent instead of the parent when Slack rejects it. */
    parentFallback?: MsgLike;
    /** Delete stored slots no longer desired. Default false: a slot dropped from `slots` is left alone. */
    prune?: boolean;
}
interface SlotThread extends SlotThreadSpec {
    /** The thread's identity in the store (`burst:123`, `week:2026-11-13`). */
    key: string;
}
/** A thread rendered from its current state: called after the lease is claimed and crash recovery has run. */
interface RenderedSlotThread {
    key: string;
    render: (state: SlotState) => SlotThreadSpec | Promise<SlotThreadSpec>;
}
interface SlotSyncOptions {
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
type SlotActionType = "POST" | "EDIT" | "SKIP" | "DELETE" | "ADOPT" | "REPOST" | "GONE" | "FALLBACK" | "UNRESOLVED";
interface SlotAction {
    type: SlotActionType;
    /** null for the parent. */
    slot: string | null;
    ts?: string;
}
interface SlotSyncResult {
    /** `busy`: another run holds the key (and will re-run for us, with a store that supports it). */
    status: "synced" | "busy" | "missing" | "gone";
    /** The parent's ts (empty when there's none, or `<new>` in a dry run). */
    ts: string;
    slots: Record<string, string>;
    actions: SlotAction[];
}
/** Metadata payload fields that tag a message with its slot. */
declare const SLOT_KEY = "thrds_key";
declare const SLOT_NAME = "thrds_slot";
/** Slack error codes meaning "this message's content was rejected" (so a `fallback` is worth trying). */
declare const REJECTED: Set<string>;
/** `msg` with its key and slot in its metadata (keeping a caller's own `event_type` and payload). */
declare function tagSlot(m: MsgLike, key: string, slot: string | null): Msg;
/** The partial result a `syncSlots` failure carries: what landed before it threw. */
declare const partialOf: (e: unknown) => SlotSyncResult | undefined;
declare function syncSlots(client: SlotClient, store: SlotStore, thread: SlotThread | RenderedSlotThread, options?: SlotSyncOptions): Promise<SlotSyncResult>;
interface UpsertOptions extends SlotSyncOptions {
    /** An existing message to keep up to date (edit only, never post), e.g. a pinned leaderboard made by hand. */
    ts?: string;
}
/**
 * One message kept in place under `key`: posted the first time, edited when it changes, skipped otherwise. With
 * `create: false` it never posts (`status: "missing"` until a record exists); with `ts` it only edits that message.
 */
declare function upsert(client: SlotClient, store: SlotStore, key: string, msg: MsgLike, options?: UpsertOptions): Promise<{
    status: SlotSyncResult["status"];
    ts: string;
    action: SlotActionType | null;
}>;
/** Seed a store with messages posted before thrds managed them (hash unknown: each is edited once on the next run). */
declare function importAnchor(store: SlotStore, key: string, anchor: {
    channel?: string;
    parent?: string;
    slots?: Record<string, string>;
}): Promise<void>;
/** An in-process store (tests, single-isolate bots, or a cache in front of something slower). */
declare function memoryStore(initial?: Record<string, SlotState>): Required<SlotStore> & {
    dump(): Record<string, SlotState>;
};
/**
 * A store over one record the app already keeps (an activity row, a Durable Object field): `syncSlots` sees it under
 * any key. The app keeps its own lease, so this one has none.
 */
declare function oneKeyStore(io: {
    get(): SlotState | undefined | Promise<SlotState | undefined>;
    put(state: SlotState): boolean | void | Promise<boolean | void>;
}): SlotStore;
/**
 * A store that keeps nothing: slot state is rebuilt from the thread itself, since every slot post carries its key, slot
 * and content hash in its metadata. For bots with no database that reply under a known thread (one echo per person
 * under a prompt). A post that landed before a crash is simply found on the next read, so there's no `pending` to keep.
 * No leases: two concurrent runs can both post a new slot.
 */
declare function threadStore(client: SlotClient, threadTs: string): SlotStore;

export { LeaseLostError as L, REJECTED as R, SLOT_KEY as S, type UpsertOptions as U, type RenderedSlotThread as a, SLOT_NAME as b, type SlotAction as c, type SlotActionType as d, type SlotClient as e, type SlotParent as f, type SlotRecord as g, type SlotSpec as h, type SlotState as i, type SlotStore as j, type SlotSyncOptions as k, type SlotSyncResult as l, type SlotThread as m, type SlotThreadSpec as n, importAnchor as o, memoryStore as p, oneKeyStore as q, partialOf as r, syncSlots as s, tagSlot as t, threadStore as u, upsert as v };
