# Shared Slack plumbing for Ryan's bots: `@open-athena/thrds/slack/*`

> Superseded by [`slack-toolkit-reuse.md`](slack-toolkit-reuse.md), which adopted its distinct ideas (see "Reconciled" there). Kept as written by the snippets session.

## Why

A survey on 2026-11-18 found nine TypeScript Slack integrations that each write their own plumbing:
- disky `site`, disky `fleet`, oa/auth activity
- watchy `cfw`, emoji-bot, slinky
- applitrack, oa-internal-coordination, ctbk `gbfs/api`

None of them copy code verbatim from another. What repeats is the patterns, each written separately and each with different gaps: no 429 handling in most, no timestamp-skew check in one verifier, no pagination in thrds' own `list`.

All but two run on Cloudflare Workers with raw `fetch`. applitrack is Next.js on Node with raw `fetch`. oa-internal-coordination is Node with Bolt. ctbk is the only one already on `@open-athena/thrds` (as `@rdub/thrds`).

Goal: one dependency-free, Workers- and Node-safe kit in `@open-athena/thrds`, split into small subpaths so a bot imports only what it needs. Only extract what has at least three real consumers; leave domain logic (Block Kit layouts, the activity burst model, emoji admin endpoints) where it is.

Companion: `specs/avatar-badges.md`, the `/avatar` subpath. This spec assumes it.

## Survey → what to extract

| Pattern | Who does it now (file refs from the survey) | Extract? |
|---|---|---|
| Bearer + JSON POST to `slack.com/api/<m>`, check `ok` | disky site `_lib/slack.ts:22`, disky fleet `_lib/slack.ts:71`, oa/auth `activity/slack.ts:52`, watchy ×3 (`slack.ts:276`, `summary.ts:163`, `weekly.ts:253`), emoji `bot.ts:12`, slinky `slack.ts:47`, applitrack ×6 (`slack-{events,interactive,mention,post,harvest}.ts`, `groups.ts:122`), thrds `SlackClient.request` | **Yes**: `slack/api` |
| 429 / `ratelimited` retry with `Retry-After` | only emoji `bot.ts`, applitrack `slack-harvest.ts:523` and `groups.ts:146`, thrds | **Yes**, in `slack/api` |
| `next_cursor` pagination | emoji `collector.ts:199`, applitrack `conversations.list`, oa-ic `echo.ts`; thrds `list()` doesn't paginate (bug) | **Yes**, in `slack/api` |
| v0 request-signature verification | disky site `slack.ts:75` (Web Crypto, skew), slinky `slack.ts:18` (Web Crypto, skew), applitrack `slack-events.ts:10` (Node crypto, **no skew check**) | **Yes**: `slack/verify` |
| Per-post sender (`username` + `icon_url`/`icon_emoji`), falling back when `chat:write.customize` is missing | disky `stagedSlack.ts:556` `Sender` + `slackScopes` probe `slack.ts:44`, oa/auth `actorSender`, watchy `renderActorOp`, emoji `postMessage(…, username, iconEmoji)`, slinky "repost as author", ctbk (per-client) | **Yes**: `Sender` type + `senderFields` in `slack/api`, plus `/avatar` |
| Keyed message kept in place: stored `ts` → `chat.update`, else post; skip if unchanged; repost on `message_not_found` | fleet `publish` (KV), disky `ensurePost` (D1 with claims), disky staged (D1 CAS), oa/auth sink (`ctx.save`), watchy `ensureWeeklyThread`/`updateWeeklyOp` (D1), emoji `DigestState` `{ts,text}`, oa-ic `findPromptMessage`/`postEcho` (metadata search), ctbk (R2/KV JSON + `sync`) | **Yes**: `slack/upsert`, the core of this spec |
| Cached user lookup (`users.info`, `lookupByEmail`, negative-cache TTL) | disky `slackPeople` (1h hit / 1m miss / no cache on error), applitrack Map, oa-ic `names.ts` TTL | **Yes, small**: `slack/lookup` |
| Channel name→ID, usergroup expansion | oa-ic `prompt.ts:109`, `usergroup.ts`; applitrack `groups.ts` | Fold into `slack/lookup` (2 consumers; cheap) |
| Permalink build / parse | disky `slackPermalink`, applitrack `permalinkFromTs`, slinky `command.ts:49` parse, thrds `permalink()` | **Yes, tiny**: `slack/permalink` |
| Unfurl-off on post **and edit** (Slack re-unfurls on edit) | fleet `NO_UNFURL`, oa/auth, disky, thrds | Default in `upsert` / `post` helpers |
| Block Kit layouts, mrkdwn escaping, rich_text↔markdown | disky, watchy, oa-ic `rich.ts` | **No**. Domain-specific; `escapeMrkdwn` at most (`<>&`, in oa/auth `render.ts:16` and disky) |
| Activity burst model (parent + details + per-kind replies) | disky `activity*.ts` and oa/auth `render.ts` (a port of disky's, "disky's model") | **No**, not here. That duplication should resolve by disky consuming `@open-athena/auth/activity`. Separate note for the disky/auth sessions. |
| Interactivity / modals | slinky, applitrack, disky actions, oa-ic (Bolt) | **No**. Bolt covers Node; the Workers ones are thin and app-shaped |
| Emoji admin (undocumented session endpoints) | emoji-bot only | No |

## Design

Everything is plain functions over a tiny `SlackApi` interface, so the same helpers work with raw `fetch` on Workers or with a Bolt `WebClient` on Node.

### `@open-athena/thrds/slack/api`

```ts
export interface SlackApi {
  call<T = SlackOk>(method: string, args?: Record<string, unknown>, opts?: { get?: boolean; token?: string }): Promise<T>
}
export class SlackError extends Error { code: string; method: string; response: unknown }   // `ok:false` or non-2xx
export function slackApi(o: {
  token: string
  fetch?: typeof fetch
  retries?: number          // default 3: 429 + Retry-After, `ratelimited`, 5xx (exp backoff, capped)
  timeoutMs?: number        // default 10s, AbortSignal.timeout
  log?: (msg: string) => void
}): SlackApi
export function fromWebClient(c: { apiCall(method: string, args?: object): Promise<any> }): SlackApi   // Bolt / @slack/web-api
export async function* paginate<T>(api: SlackApi, method: string, args: object, key: string): AsyncGenerator<T>
export async function scopes(api: SlackApi): Promise<Set<string>>   // auth.test X-OAuth-Scopes, memoized per api

export interface Sender { username?: string; iconUrl?: string; iconEmoji?: string }
export function senderFields(s: Sender | undefined, canCustomize: boolean): Record<string, string>  // username≤80, iconUrl beats iconEmoji, {} if !canCustomize
export const NO_UNFURL = { unfurl_links: false, unfurl_media: false } as const
```

Notes:
- **Errors throw.** disky site's `slackApi` never throws, while fleet's and oa/auth's do. Throwing is the safer default. Migrations that want the soft behavior wrap the call.
- **`get`:** some methods are GET-only for some token types (`users.info`, `users.lookupByEmail`, `conversations.replies` as used in disky). `call(…, { get: true })` sends form params.
- **`token` override:** a per-call token covers slinky's user-token `chat.delete`.
- `SlackClient` is rebuilt on top of `slackApi`, so it gets 5xx retries, a timeout and paginated `list()` for free.

### `@open-athena/thrds/slack/verify`

```ts
export async function verifySlackRequest(req: { body: string; timestamp: string | null; signature: string | null }, signingSecret: string, o?: { nowS?: number; maxSkewS?: number /* 300 */ }): Promise<boolean>
```
Web Crypto only (`crypto.subtle`, present in Node ≥18 and Workers), with a constant-time compare. This replaces disky, slinky and applitrack's copies, and fixes applitrack's missing skew check.

### `@open-athena/thrds/slack/upsert`: keyed messages kept in place

This is the pattern eight of the nine integrations reimplement. A message (or thread parent + reply) is identified by an app-level **key** (`"fleet"`, `"weekly:2026-11-16"`, `"echo:U123:2026-11-16"`, `"plan:42:reply:7"`) instead of by position the way `sync` does it.

```ts
export interface Rendered { text: string; blocks?: unknown[]; metadata?: { event_type: string; event_payload: object }; sender?: Sender; broadcast?: boolean }
export interface Placed { channel: string; ts: string; hash: string }

export interface PostStore {
  get(key: string): Promise<Placed | null>
  set(key: string, placed: Placed): Promise<void>
  /** Optional: reserve the key before posting so two isolates can't both post (disky's PENDING rows / CAS). Returns false if another holder has it. */
  claim?(key: string, ttlS: number): Promise<boolean>
  release?(key: string): Promise<void>
}

export async function upsert(api: SlackApi, store: PostStore, key: string, at: { channel: string; threadTs?: string }, msg: Rendered, o?: { canCustomize?: boolean; dryRun?: boolean }): Promise<{ action: 'post' | 'edit' | 'skip'; ts: string }>
```

Behavior, which every current copy already has in part:
1. `hash` = stable hash of `{text, blocks, metadata}`. If the store has the key with the same hash, `skip`. This is disky's `JSON.stringify(blocks)` compare and emoji's `{ts, text}` compare.
2. If the store has the key, `chat.update` (with `NO_UNFURL`, since Slack re-unfurls on edit). On `message_not_found` / `cant_update_message`, fall through to post. That's fleet's fallback.
3. Otherwise `claim` if the store supports it, then `chat.postMessage` with `senderFields`, `metadata` and `thread_ts`, then `set`. If the claim is lost after posting, delete the duplicate (disky `stagedSlack.ts:927`).
4. `sender` only applies on post. `chat.update` can't change it; document this.

Stock stores (each under ~40 lines):
- `memoryStore()` for tests.
- `kvStore(kv, prefix)`: Workers KV, for fleet and ctbk.
- `d1Store(db, table)`: a `(key PRIMARY KEY, channel, ts, hash, claimed_until)` table with CAS claim, for disky, watchy and emoji. Each app can keep its own schema by implementing `PostStore` itself; the stock one is for new bots.
- `metadataStore(api, { channel, threadTs?, eventType })`: finds the key from Slack's own message metadata via paginated `conversations.history` / `conversations.replies` with `include_all_metadata`, so it needs no database. `set` is a no-op because the metadata rides on the post. This is oa-ic's `findPromptMessage` / `pickEcho`. Its limits: O(thread) reads per lookup, and no claim. Fine for low-volume bots.

How this relates to `sync`: `sync` stays as it is, for "this thread should be exactly these N messages, positionally", which is what thrds' CLI and ctbk use. `upsert` is the keyed, block-aware primitive. Most bots really want a few named messages (weekly head, per-person reply, status card), not a positional list.

Also extend `Message`/`Thread` in `core` so `sync` can carry `blocks` and per-message `sender`. watchy already wanted metadata on thrds posts (`src/watchy/slack.py:186`, the Python side).

### `@open-athena/thrds/slack/lookup`

```ts
export function userLookup(api: SlackApi, o?: { hitTtlS?: number /*3600*/; missTtlS?: number /*60*/ }): {
  byId(id: string): Promise<SlackUser | null>       // drops deleted users and bots
  byEmail(email: string): Promise<SlackUser | null> // users_not_found → null (negative-cached); transient errors are not cached
}
export function channelId(api: SlackApi): (nameOrId: string) => Promise<string>          // "#eng" | "C…", cached
export async function usergroupMembers(api: SlackApi, handleOrId: string): Promise<string[]>
```
`SlackUser` = `{ id, name, realName, email?, image?: { 48, 192, 512 } }`. The image URLs are what `/avatar` badges.

### `@open-athena/thrds/slack/permalink`

`permalink(team: string, channel: string, ts: string, threadTs?: string): string` and `parsePermalink(url): { channel, ts, threadTs? } | null`. Use `chat.getPermalink` only when the workspace domain is unknown.

## Packaging

- Subpath exports in `package.json` and `tsup.config.ts`: `./slack/api`, `./slack/verify`, `./slack/upsert`, `./slack/lookup`, `./slack/permalink`, `./avatar`. The root export keeps `sync` / `SlackClient`.
- No runtime dependencies. Only `fetch`, `crypto.subtle`, `AbortSignal.timeout`. Test under Node; add a `@cloudflare/vitest-pool-workers` smoke test if it's cheap.
- Tests follow the exact-equality style. A fake `SlackApi` records calls, and tests assert the exact call list (`[['chat.postMessage', {…}], …]`) for each `upsert` path: post, edit, skip, not-found → repost, lost claim → delete. Also cover verify vectors from Slack's docs, and pagination over 3 pages.
- Bump to 0.2.0. Fix the stale README (`@rdub/thrds`, "not yet published").

## Adoption order (each a separate change in that repo, after 0.2.0)

Cheapest and highest-value first. "Replaces" means the code that gets deleted.

1. **disky fleet**: `upsert` + `kvStore` replaces `publish` and its private `slackApi` (about 50 lines).
2. **watchy**: `slackApi` replaces 3 transports and the fixed 1s pacing; `upsert` + `d1Store` (or its own `weekly_threads` table as a `PostStore`) replaces `ensureWeeklyThread`/`updateWeeklyOp`; avatars stay GitHub URLs.
3. **emoji-bot**: `slackApi` replaces `botApi` (same retry semantics) and `paginate` replaces the collector loops; `DigestState` maps onto a `PostStore` with `upsert`. The session/emoji-admin code stays. Note: the oa/emoji and hccs/emoji clones are the same repo with uncommitted work in oa/emoji, so migrate there.
4. **slinky**: `verify` + `slackApi` + `permalink`.
5. **ctbk gbfs**: repoint `@rdub/thrds#ts-dist` → `@open-athena/thrds`; it can stay on `sync`.
6. **oa-internal-coordination** (Bolt): `fromWebClient` + `metadataStore` + `upsert` replace `postEcho`/`pickEcho`; `/avatar` per `specs/echo-as-author.md`. Isaac's repo, so a PR.
7. **applitrack**: `slackApi` replaces 6 transports and 2 inline retry loops; `verify` fixes the missing skew check. Larger and Next.js, so last among the simple ones.
8. **disky site / oa/auth**: transport, `verify`, `lookup`, `/avatar` (already the source). Keep disky's own D1 claim tables as a custom `PostStore`, or leave `ensurePost` as is. Its activity and staged models are the most elaborate and gain the least. Resolve the activity-model duplication between disky and oa/auth separately.

Each adoption should delete more code than it adds. If one doesn't, skip it.
