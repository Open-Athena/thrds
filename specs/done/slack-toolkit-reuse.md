# Shared Slack toolkit: what `@open-athena/thrds` should absorb

## Why this spec

Ryan asked whether a reusable Slack layer across his bots is worth building in `@open-athena/thrds`, or whether the overlap is too thin to force. Two read-only surveys (disky site+fleet, oa/auth; and watchy, emoji-bot, slinky, applitrack, oa-internal-coordination, ctbk gbfs) answered the empirical half: **nine projects, each re-implementing the same handful of Slack-posting patterns by hand, none importing another's helpers.** The duplication is real and logical, not incidental — but it is *layered*, and not every layer belongs in thrds. This spec sorts the overlap into what thrds should own, what it should expose as primitives, and what should stay per-app, with a per-project adoption map.

Companion: `specs/avatar-badges.md` (the `@open-athena/thrds/avatar` subpath). This spec subsumes its L1 "per-post sender / `iconUrl`" item and treats the badge builder as one primitive among several.

## The evidence (what's duplicated, and where)

| Capability | Projects that hand-roll it | In `ts` thrds today? |
|---|---|---|
| Raw-fetch `POST slack.com/api` (Bearer + JSON + `ok` check) | watchy ×3, emoji ×2, slinky, applitrack ×6, disky site+fleet, oa/auth, oa-ic (via Bolt) | ✅ `request()` |
| Rate-limit retry (429 + `Retry-After`) | emoji `bot.ts`, applitrack `groups.ts`/`slack-harvest.ts` | ✅ (429 only) |
| Retry on `error:"ratelimited"` body (not just HTTP 429) | emoji `bot.ts:12-43` (linear backoff) | ❌ |
| Per-post sender (`username`/`icon_url`/`icon_emoji`) | watchy, emoji, slinky, disky (`Sender` type), oa/auth (`actorSender`) | ⚠️ per-**client** only, no `icon_url` |
| Badged avatar (face + corner badge) | disky `badgedAvatar.ts` (merged #7) | ❌ → `avatar-badges.md` |
| Find-then-edit-or-post, anchor stored externally | disky (D1 `activity_posts`/`stage_replies`), fleet (KV ts), watchy (D1 `weekly_threads`), emoji (`DigestState {ts,text}`), oa-ic (metadata search), ctbk (R2/KV), oa/auth (store checkpoint) | ⚠️ `sync()` diffs the **live** thread; no external-anchor mode |
| Skip `chat.update` when content unchanged | disky (`JSON.stringify(blocks)`), emoji (text compare) | ✅ sync diffs by content |
| Message `metadata` for idempotent find | watchy, oa-ic (`include_all_metadata`) | ❌ |
| Block Kit / rich_text builders + mrkdwn escaping | disky, fleet, watchy, oa/auth, oa-ic (rich↔md converter) | ❌ text-only |
| `unfurl_links/_media:false` on post **and** edit | all | ✅ `suppressUnfurls` |
| User lookup (`users.info`/`lookupByEmail`) + cache | disky, applitrack, oa-ic, oa/auth | ❌ |
| Paginate `next_cursor` (replies/history/list) | emoji, applitrack, oa-ic, disky | ❌ `list` unpaginated |
| `chat.getPermalink` / parse permalink → channel+ts | slinky, oa-ic, disky, applitrack (local build) | ✅ `permalink()` (build only) |
| Inbound request signature verify (v0 HMAC) | slinky (Web Crypto), applitrack (Node), disky | ❌ |
| Interactivity (modals `views.open/update`, `block_actions`, `response_url`) | slinky, applitrack, oa-ic, disky | ❌ |
| Repost-as-author (user token + `chat.delete`) | slinky, disky (claim-race dedupe) | ❌ |
| DM open (`conversations.open`) | slinky, oa-ic | ❌ |
| Channel name → ID (`conversations.list`, cached) | applitrack, oa-ic | ❌ |

**Cross-project copying already happening:** oa/auth ported disky's one-thread-per-burst activity model by hand (commit `c429780`, "disky's model"; `render.ts:2`) — two divergent copies of the same burst-render + store-ts-then-edit logic. ctbk's `gbfs/api` is the one project that *already* consumes thrds (`@rdub/thrds#ts-dist`, `alerts.ts:247-251`) via `sync({messages})` + stored `threadTs` — the proof the sync model fits the "fire/resolve one thread" shape.

## Decisions (2026-11-18, Ryan: "go for all")

1. **Scope: an extensive toolkit covering ≈all the Slack interactions these projects do**, posting *and* receiving. The receiver layer (signature verify, interactivity, slash commands, `response_url`, modals) lands as a subpath (`@open-athena/thrds/receiver`), so posting-only consumers never load it.
2. **Storage is abstracted; D1 is opt-in.** Anything that persists (slot anchors, leases, hosted avatars) goes through a small store interface with a memory implementation in the core. Cloudflare D1 and KV adapters are separate subpaths (`/d1`, `/kv`), structurally typed, so there's no `@cloudflare/workers-types` dependency and a Node consumer never imports them.
3. **L2 is a slotted thread, not a single-message `upsert`.** Reading the consumers showed the real common shape: a parent plus *named* reply slots (oa/auth `details` / `kind:<k>`, emoji `<day>/<user>`, oa-ic one echo per user, watchy one reply per event). Each slot has a stored `{ts, hash}`, is posted once (which fixes its sender) and edited only when its content changes. A `pending` record is written ahead of each post so a crash never blind-reposts. emoji's `DigestState` and oa/auth's `parts` + `checkpoint` are hand-written versions of this. Single-message upsert (fleet) is the degenerate case: a parent with no slots.
4. **Dedupe disky ↔ oa/auth activity:** oa/auth's `slackActivitySink` moves onto `syncSlots`. disky (which already depends on `@open-athena/auth`) moves its activity feed onto `@open-athena/auth/activity` rather than keeping its own copy. Cross-repo, done via migration specs in those repos.
5. **Consumers get migrated** (they weren't using thrds; only ctbk was, under the old name), via a migration spec per repo, per the cross-project spec workflow.

## Design: layers, all Workers-safe (Web APIs only: `fetch`, `crypto.subtle`, `AbortSignal`)

### L0 — transport, hardened and exported

The single most-copied thing is the 10-line `slackApi(token, method, body)` wrapper (12+ copies). thrds already has it as the private `request()`. Two changes:

1. **Also retry on `{ok:false, error:"ratelimited"}`** (body-level, not just HTTP 429), with the same `Retry-After`/linear backoff — emoji-bot's `botApi` is the reference (`bot.ts:12-43`). Several projects (disky, oa/auth, watchy, slinky) have **no** retry at all and silently drop under load; this closes that gap for every adopter for free.
2. **Export a standalone `slackApi(token, endpoint, body, {fetch})`** (the same engine `request()` uses) so a project that wants *only* the transport — not sync — can delete its copy. Keep it dependency-free and Workers-safe (no Node globals), since most consumers are Cloudflare Workers.

### L1 — message primitives

Make a `Message` able to carry what real posts carry, so sync isn't text-only:

- **Per-message sender override**: `{ username?, iconUrl?, iconEmoji? }` on `Message` (and `SlackClientOptions` stays the per-client default). Needed because one sync posts messages from different people (watchy actors, emoji per-day, disky plan-vs-person, the weekly-bot echo). `iconUrl` pairs with `avatar-badges.md`. Note in docs: `chat.update` can't change a sender, so an edited message keeps its original identity; and `username`/`icon_url` need `chat:write.customize`.
- **Block Kit + metadata**: optional `blocks?: unknown[]` and `metadata?: {event_type, event_payload}` on `Message`. `post`/`edit` send them; `list` reads `metadata` back. This unlocks (a) the richer renderers every project hand-writes, and (b) **metadata-keyed idempotent find** (watchy, oa-ic) as a first-class way to locate "my" message without a DB. Content-diff for the unchanged-skip should compare blocks when present (disky already does `JSON.stringify`).
- **Paginate `list`**: follow `response_metadata.next_cursor` on `conversations.replies` (the peer flagged this gap). Without it, sync silently truncates long threads. Same cursor helper serves `conversations.history`/`users.list`.
- **User-lookup cache**: `userByEmail(email)` / `userInfo(id)` with a TTL memo (disky's token-hash+email memo and oa-ic's TTL cache are the reference). Small, universally needed, no state.

### L2 — slotted threads over a pluggable store (`syncSlots`)

thrds's `sync()` reads the live thread and reconciles a desired list against it, which suits ctbk and any "make the whole thread match" caller. The bigger cluster (fleet, watchy, emoji, oa/auth, disky, oa-ic) keeps message ids in its own DB/KV and edits a parent plus named replies in place. They don't want a full thread re-read per run, and several run in concurrent isolates.

```ts
syncSlots(client, store, {
  key,                       // the thread's identity in the store ("burst:123", "week:2026-11-13")
  parent: Msg | { ts },      // our message, or an existing one we only reply under (oa-ic's prompt)
  slots: [{ slot, msg }],    // named replies, in post order
  prune?: boolean,           // delete stored slots that are no longer desired
  leaseS?: number,           // claim the key first (stores that support leases)
}) → { ts, slots: Record<slot, ts>, actions }
```

- **State per key:** `{ parent?: {ts, hash}, slots: {[slot]: {ts, hash}}, pending?: {slot, hash, at} }`. `hash` covers what a re-send can change (text + blocks + metadata), not the sender, which Slack fixes at post time.
- **Order:** parent first, then slots. For each: no record → write `pending`, post, record, clear `pending`. Hash differs → edit. Same → skip. State is saved after every side effect, so a failure partway through resumes rather than re-posting.
- **Crash recovery without a human:** every post carries `metadata: {event_type: "thrds_slot", event_payload: {key, slot}}`. A leftover `pending` is resolved by scanning the thread (or channel, for a parent) for that metadata. Found → adopt the ts. Not found → post. This replaces emoji's "inspect before retrying" stop and disky's post-then-delete-on-lost-race dedupe.
- **Edit fallbacks:** `message_not_found` on an edit means it was deleted on Slack's side, so re-post (fleet's `publish` behaviour). Sender changes can't be applied by an edit; the docs say so and the hash deliberately ignores sender.
- **Store interface:** `get(key)`, `put(key, state, lease?) → boolean` (false = lease lost), and optional `claim(key, leaseS, nowS) → lease | null` / `release(key, lease)`. Implementations: `memoryStore()` (core), `kvStore(KVNamespace-like)` (`/kv`, no leases: KV isn't atomic), `d1Store(D1Database-like, {table})` (`/d1`, compare-and-swap leases, exported `SCHEMA` SQL).
- `upsert(client, store, key, msg)` is the one-liner for the single-message case (fleet, watchy's weekly OP, emoji's pinned leaderboard).

### Receiver — `@open-athena/thrds/receiver`

- `verifySlackSignature({signingSecret, body, timestamp, signature, nowS?, toleranceS = 300})`: v0 HMAC-SHA256, constant-time compare, skew check. It's the union of slinky's (Web Crypto) and applitrack's (Node crypto, no skew check), and disky's (300 s). `verifySlackRequest(request, secret)` does the same for a `Request` and returns the raw body.
- `parseSlackBody(body, contentType)`: interaction payload (`payload=` form field), slash command (form), or Events API JSON (incl. `url_verification` challenge), returned as a tagged union.
- `respond(responseUrl, msg, {replaceOriginal?, deleteOriginal?, ephemeral?})` for `response_url`.
- On `SlackClient`: `openView`, `updateView(view, {viewId, hash})`, `pushView`, `postEphemeral`. Plus `privateMetadata` encode/decode that enforces Slack's 3000-char cap (oa-ic `modal.ts:87-89`).

### Avatars — `@open-athena/thrds/avatar` (see `specs/avatar-badges.md`)

The builder from that spec (`badgedSvg`, `GLYPHS`, `avatarKey`), plus what disky's `publicAvatar.ts` does, with its storage abstracted:
- `identiconPng(seed, px)`, `identiconSeed(secret, actor, label)` (HMAC, so an email can't be guessed and hashed), and `serviceIconPng(px)`: deterministic PNGs with no codec dependency (stored deflate blocks).
- `publishAvatar(store, origin, {type, bytes})` → `${origin}/a/<sha256>.<ext>`, and `serveAvatar(store, pathname)` → `{type, bytes} | null` for the app's route. `AvatarStore` is content-addressed `put/get`. `memoryAvatarStore()` lives here; `d1AvatarStore(db)` (disky's `public_avatars` table, same schema) is in `/d1`, and `kvAvatarStore(kv)` is in `/kv`.

## Still out of scope

- **Rasterizing** SVG to PNG: the consumer brings resvg-wasm (Workers) or `sharp` (Node). The README shows both one-liners.
- **Repost-as-author with a user token** (slinky): slinky does it with `users.info` → per-message sender plus a user-token `SlackClient` for the `chat.delete`, both of which the toolkit now provides. The flow itself stays in slinky.
- **Domain rendering** (disky's staged-deletion cards, oa/auth's burst headline, watchy's scoreboard). The toolkit provides builders and escaping, not the cards themselves.

## Adoption map (cheapest wins first)

| Project | Adopts | Effort | Notes |
|---|---|---|---|
| **ctbk gbfs** | already on sync; repoint `@rdub/thrds` → `@open-athena/thrds` | trivial | name bump only |
| **fleet** | L0 + L2 `upsert` | low | `publish` *is* `upsert`; KV stays |
| **watchy** | L0 + L1 sender + L2 `upsert` (weekly OP) + metadata find | low-med | drops 3 fetch copies, 1s pacing stays its choice |
| **emoji-bot** | L0 (keep its `ratelimited` retry → upstream it) + L1 sender + L2 per-record upsert | medium | `DigestState` maps onto anchored upsert |
| **slinky** | L0 only | low | rest is receiver/modal — out of scope |
| **applitrack** | L0 (6 copies!) + user cache + pagination | medium | receiver/modals stay |
| **oa-ic (weekly-bot)** | L1 sender+avatar (the echo, per `echo-as-author.md`) + metadata find; optionally L2 for the echo | medium | Bolt stays for receiving |
| **disky site** | L1 sender+avatar + L0 `ratelimited` retry | medium | activity/staged claim model stays per-app |
| **oa/auth** | same primitives; its sink stays | medium | or dedupe against disky separately |

The pattern: **L0 is a near-universal, near-free win** (every raw-fetch project), **L1+L2 convert the "one weekly head edited in place" cluster** (watchy/emoji/fleet/ctbk — the clearest fit), and the **heavy activity-model projects (disky/oa-auth) take only primitives**, keeping their storage-coupled claim logic.

## Build order

1. L0 transport (`slackApi`, `SlackApiError`, retries incl. `ratelimited` bodies and optional 5xx, timeouts, `paginate`).
2. L1 `Msg` (sender, blocks, metadata, `replyBroadcast`) through `post`/`edit`/`list`/`sync`; paginated `list` with metadata; users, scopes, channels, DMs, ephemeral, reactions, permalinks; mrkdwn/Block Kit helpers.
3. L2 `syncSlots` / `upsert` + `memoryStore`, then the `/kv` and `/d1` adapters.
4. `/receiver`.
5. `/avatar` (builder + identicons + content-addressed hosting; D1/KV avatar stores).
6. README, `engines` ≥ 22 (18 and 20 are EOL), CI matrix 22/24, bump to 0.2.0.
7. A migration spec per consumer repo.

Tests per layer use exact-equality payload assertions against the fake fetch, per the testing rules. The D1 adapter is tested against real SQL through a `node:sqlite` D1 shim.

## Implemented (2026-11-18)

Five commits on `ts`, 155 tests:
- `bd4c172` L0/L1: transport, `Msg`, client.
- `408e8a9` L2 + avatars + D1/KV.
- `59e16e9` receiver, packaging, README.
- `f4955b6` `threadStore` + derived avatars.
- `b1a1731` + the builders/stores commit: hardening from the migration specs.

What came out differently from the design above:

- **`syncSlots` is the center, not `upsert`** (decision 3). Reading the consumers turned up two more shapes.
  - **DB-less bots.** oa-internal-coordination and slinky have no database, so `threadStore` rebuilds slot state from the thread's own metadata tags (the snippets session's `metadataStore`).
  - **Stateless hosts.** Cloud Run can't keep a content-addressed avatar table, so `derivedAvatarUrl` / `derivedAvatarHandler` re-render on demand and 404 stale keys.
- **The retry claim in the first draft was wrong.** The watchy and emoji specs caught it independently: `syncSlots`' `pending` record doesn't make retrying a timed-out post safe, because the retry happens inside one `client.post`. Retries are now method-aware: never a 5xx/timeout retry for `NON_IDEMPOTENT` writes.
- **Concurrency needed more than a lease.** A losing claimant's newer update was silently dropped (disky G3). It now marks the key dirty, and the holder renders the thread *after* claiming (`render(state)`) and re-runs until clean.
- **Not every failure is ambiguous.** A post Slack definitely refused (`SlackApiError.definite`) clears `pending` at once. A `pending` whose recovery scan can't run (missing history scope) no longer wedges the key: `recover: "scan-or-post"`.

### Gaps from the migration specs

Each consumer's `specs/adopt-thrds-toolkit.md` lists the gaps it found, numbered within that spec, and a "Toolkit status" section appended to each maps them to what landed. Everything blocking a migration step landed:
- **Transport:**
  - method-aware retries, `maxRetryWaitMs`, `deadlineMs`;
  - `beforeCall` (applitrack's channel blocklist), `form`, per-call `token` / options;
  - `SlackApiError` `kind` / `definite` / sanitized messages, `retryAfterS`;
  - `webClientTransport` (Bolt).
- **Client:**
  - `attachments`, per-message `unfurl` and `"omit"`, `stamp: false`, no metadata on ephemerals, `username` cap;
  - one cached `auth()` with `teamId`; `message(ts)`; `replyCount` and a clear orphan-guard error;
  - user-cache dedupe, `fresh`, and a size cap; `channelId` TTL / `includeArchived` / `invalidateChannels`;
  - `senderFor` by email, `usergroupMembers`, `messages({ includeReplies })`, `minIntervalMs`, `with()`.
- **Slots:**
  - refusal clears `pending`; `recover` modes; dirty re-runs + render-after-claim;
  - `channel` in state; `onGone`;
  - `{ keep }` / `{ ts, msg }` parents, `create: false`, `force`;
  - `fallback` / `parentFallback`, lease `renew`, batched hash saves;
  - `partialOf`, `importAnchor`, `oneKeyStore`, `SlotClient`, golden hashes.
- **Stores:** `durableObjectStore`, `kvStore` `codec`, `sqliteD1` (Node SQLite), `schema/thrds.sql`.
- **Receiver:** `missing_secret`, malformed body → 400, `onError` → `console.error`, `ctx.request`, `viewValues({ by: "block" })`, typed payloads + guards.
- **Builders:** rich_text, modal inputs, `withoutImages`, `bound({ atLine })`, `link` encoding `<`, `fitsPrivateMetadata`; `parsePermalink` leniency, `permalinksIn`, `withoutPermalinks`.
- **Testing and packaging:** `@open-athena/thrds/testing` (the fake channel), a `default` export condition, avatar `memoKey`.

**Deferred** (none block a step):
- An append-log primitive with per-slot rows for 100+-reply append-only threads (watchy G4). Whole-state JSON is fine at today's volumes.
- Per-channel×method pacing (watchy G6). `minIntervalMs` is per client family.
- A raw-message escape hatch on `SlackMessage` (applitrack G7), and lazy `auth.test` for reads (auth G8).
- `post` returning the channel Slack answered with (disky, minor).
- **Python parity** (watchy G14): `post` / `edit` with `metadata`, and paginated history with `include_all_metadata`, on the `py` branch.

### Reconciled: `specs/slack-kit.md`

The snippets session wrote a parallel spec of the same work (untracked, 2026-11-18 10:16), after this one's survey. Its design converges with this one. Its distinct ideas were adopted:
- `fromWebClient` → `webClientTransport`;
- the per-call `token` override;
- `usergroupMembers`;
- `metadataStore` → `threadStore`;
- `channel` in stored state.

Its `slack/*` subpath naming wasn't adopted: flat subpaths (`/receiver`, `/d1`, …) split by what each consumer loads.

### Migration specs (untracked in each repo, for that repo's session)

| Repo | Spec | Notes |
|---|---|---|
| hccs/ctbk | `specs/adopt-thrds-toolkit.md` | name bump to `@open-athena/thrds`; `sync` unchanged |
| disky (`wt/gcs`) | `specs/adopt-thrds-toolkit.md` | avatars, transport, verify, fleet `upsert`; activity → `@open-athena/auth/activity`; staged threads on primitives |
| oa/auth | `specs/adopt-thrds-toolkit.md` | sink on `syncSlots` over a `SlotState` checkpoint; makes auth's activity the shared implementation |
| rac/watchy | `specs/adopt-thrds-toolkit.md` | weekly OP `{ keep }` + rollup slot, event slots under `{ ts }`; builds on `specs/slack-sync.md` |
| oa/emoji | `specs/adopt-thrds-toolkit.md` | `syncDigest` → `syncSlots` over Durable Object storage; leaderboard edit-only |
| slinky | `specs/adopt-thrds-toolkit.md` | receiver + `senderFor` + user-token delete |
| oa/applitrack | `specs/adopt-thrds-toolkit.md` | 9 transport copies, receiver (fixes `url_verification` before verify), blocklist via `beforeCall` |
| oa/oa-internal-coordination | `specs/echo-as-author.md` (updated) | derived avatars + optional `syncSlots` over `threadStore` |
