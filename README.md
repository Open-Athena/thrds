# thrds (TypeScript)

A Slack toolkit for bots. It includes:
- a hardened Web API transport;
- rich messages with per-message senders;
- declarative thread sync;
- slotted threads kept in place over a pluggable store (memory, Cloudflare D1, KV, Durable Objects, SQLite);
- a request receiver (signatures, events, interactivity, slash commands);
- badged sender avatars;
- fakes for testing.

It uses only Web APIs (`fetch`, `crypto.subtle`), so it runs on Cloudflare Workers and on Node ≥ 22, including under Bolt via `webClientTransport`.

> The Python impl lives on the [`py` branch][py-branch] (and on PyPI as [`thrds`][pypi]). [`specs/done/slack-toolkit-reuse.md`][toolkit-spec] maps which pieces replace which hand-written code in OA projects. Each of those projects has a `specs/adopt-thrds-toolkit.md`.

## Install

```bash
pnpm add @open-athena/thrds
```

(Scoped because npm blocks the bare name as "too similar" to `three`.)

| Import | What |
|---|---|
| `@open-athena/thrds` | transport, `SlackClient`, `sync`, `syncSlots` / `upsert` + `memoryStore` / `threadStore` / `oneKeyStore`, mrkdwn / Block Kit / rich_text / modal builders, permalinks |
| `@open-athena/thrds/d1` | `d1Store` (leased slot state), `d1AvatarStore`, `sqliteD1` (the same stores over local SQLite), `SCHEMA` |
| `@open-athena/thrds/kv` | `kvStore`, `kvAvatarStore`, `durableObjectStore` |
| `@open-athena/thrds/receiver` | `verifySlackRequest`, `parseSlackBody`, `slackHandler`, `respond`, `viewValues`, payload types + guards |
| `@open-athena/thrds/avatar` | `badgedSvg`, `BADGES`, identicons, content-addressed (`publishAvatar`) and stateless (`derivedAvatarUrl`) hosting |
| `@open-athena/thrds/testing` | `fakeSlack` (recording `fetch`), `fakeChannel` (a stateful fake channel with failure injection), `fakeSleep` |
| `@open-athena/thrds/schema/thrds.sql` | the D1/SQLite schema, for wrangler migrations |

## Transport

```ts
import { slackApi, SlackApiError } from "@open-athena/thrds";

await slackApi(token, "chat.postMessage", { channel, text: "hi" });
await slackApi(token, "users.lookupByEmail", { email }, { get: true });
await slackApi(token, "usergroups.users.update", { usergroup, users }, { form: true });
```

- **Retries.** HTTP 429 (per `Retry-After`) and `{ok: false, error: "ratelimited"}` are always retried, since Slack refused the request. A 5xx or timeout is retried only with `retryServerErrors`, and never for `NON_IDEMPOTENT` writes (`chat.postMessage`, …): their first attempt may have landed, and a retry would post twice.
- **Budgets.** `maxRetryWaitMs` caps any single wait, and `deadlineMs` caps the whole call; past either, the call throws `ratelimited` with `retryAfterS`. There's a 30 s per-request timeout by default.
- **Policy.** `beforeCall(method, body)` runs before every request; throw from it to veto the call, e.g. a channel blocklist. `token` overrides the token per call, and `baseUrl` / `headers` are configurable.
- **Errors.** Failures throw `SlackApiError`. `.code` is Slack's error, `http_<status>`, `timeout` or `transport_error`. `.kind` is `slack`, `http`, `timeout` or `transport`. `.definite` is true when the request certainly did nothing. `.message` never echoes an unexpected error string.
- **Paging.** `paginate` walks any cursor-paginated method lazily.

## `SlackClient`

```ts
import { SlackClient, section, context, mention } from "@open-athena/thrds";

const slack = new SlackClient({ token, channel: "C0884476QSC", username: "weekly-update-bot", parse: "none" });

// A per-message sender overrides the client's (needs `chat:write.customize`; `await slack.canCustomizeSender()`).
const as = await slack.senderFor("ann@example.org", { suffix: " (weekly update)" });
await slack.post({ text: "Ann submitted their update", blocks: [section("*Did:* …"), context(mention.user("U2CERLKJA"))], ...as }, threadTs);
```

- **Messages (`Msg`):**
  - `text`, `blocks`, `attachments`, `metadata`, a sender (`username` / `iconUrl` / `iconEmoji`), `replyBroadcast`, and `unfurl` (`boolean | {links, media}`).
  - `stamp: false` skips the content-hash metadata that rich messages carry for `sync`. Ephemerals never carry it.
  - `username` is capped at Slack's 80 characters.
- **Client options:**
  - `unfurl`: `false` (the default) / `true` / `{links, media}` / `"omit"`.
  - `parse`, `linkNames`.
  - `minIntervalMs`: pacing between writes.
  - `userCacheSize`.
  - All transport options; per-call ones go on `api(method, body, options)`.
- **Threads:**
  - Paginated `list(threadTs)` (with metadata, reactions, senders, files).
  - `message(ts)`, a cheap single read.
  - `history()`, and `messages({ includeReplies })` to walk threads too.
  - `find` / `findByMetadata`.
  - `postEphemeral`, `react` / `unreact` (idempotent), `permalink`, `replyCount`.
- **People and channels:**
  - `userInfo` / `userByEmail`: cached (found: 1 h, not found: 1 min), deduped in flight, `{ fresh: true }` to bypass the cache.
  - `senderFor`, `users()`, `usergroupMembers("@handle")`, `openDm`.
  - `channelId("#eng")`, cached 1 h; `invalidateChannels()` to drop the cache.
- **Views:** `openView` / `pushView` / `updateView` / `publishHome`.
- **Siblings:** `in(channel)` and `with(options)` give a client that shares this one's token and caches.
- **Bolt:** `new SlackClient({ token, channel, transport: webClientTransport(app.client) })` runs over Bolt's `WebClient`.

Senders are fixed when a message is posted: `chat.update` ignores `username` / `icon_url`, so an edit keeps the original sender. `delete` refuses to orphan thread replies; that check needs a history scope on the deleting token.

### Editable images

A bot that keeps one message current (an hourly status card, a leaderboard) can show an image in it two ways. Both are edited in place: same `ts`, no new notification.

| | Attached file (`Msg.files`) | Image block (`image(…)`) |
|---|---|---|
| Download / Save on Slack's phone apps | **Yes** | No |
| Where it sits | Below all of the message's blocks | Wherever you put the block |
| Source | An uploaded file (`upload`) | A public URL (`image_url`), or an uploaded file (`slack_file` by id or URL) |
| To change it | Attach a new file (`file_ids`), then delete the old one | A new URL (`versionedUrl`: Slack caches by URL), or another file |
| Before Slack has processed an upload | Renders as a generic file icon at first | `invalid_blocks` |

Choose the attached file when people should be able to save the image, and an image block when it has to sit between other blocks or already lives at a public URL.

**Attached files, kept current.** `upsertFiles` does the hourly pattern in one call:
1. It hashes each file. One whose bytes the message already has is reused; the rest are uploaded, waiting until Slack has processed them (`concurrency` at a time, default 1).
2. It `upsert`s the message with exactly those files, in list order.
3. It deletes the files the message no longer has.

The store's slot record keeps the attached ids and their hashes, which are also stamped into the message's metadata (`thrds_files`). If no bytes and no message field changed, it uploads nothing and the upsert skips. Reordering or inserting files re-uploads only new bytes. `upsertFile` is the one-file form.

```ts
import { upsertFiles } from "@open-athena/thrds";

const r = await upsertFiles(slack, store, "fleet-card", { text: "Fleet status", blocks }, [
  { name: "cpu.png", data: cpu },
  { name: "disk.png", data: disk },
]);
// r: { status, ts, action: "POST" | "EDIT" | "SKIP" | …, fileIds, uploaded, deleted: ["F…"], undeleted: [] }
```

Without a store, `slack.replaceFiles(ts, files, msg)` (or `replaceFile`) does the same against a message by `ts`. It reads the previous files and their hashes back from the message (a history scope), or takes them as `{ previous: [{ id, hash? }] }`.

No orphaned files:
- **Replaced files** are deleted only after the write succeeds. One that's already gone is fine, and other delete failures come back in `undeleted` rather than throwing.
- **An upload that fails partway** deletes this run's earlier uploads, and its error is rethrown.
- **A write Slack definitely refused** deletes this run's uploads, then throws `FileSwapError` (`fileIds`, `deleted: true`). Reused files are never deleted.
- **A write that may have landed** (a timeout or 5xx) keeps the uploads and throws `FileSwapError` with `deleted: false` and their ids. A write that fails with nothing newly uploaded rethrows as-is.
- **An unshared upload that never finishes processing** is deleted, and `upload` throws `FileNotProcessedError` (`fileId`, `waitedMs`, `deleted`).
- **A sender override** (`username`, `iconEmoji` or `iconUrl`) means Slack won't show the files (below), so thrds throws `CustomSenderFilesError`:
  - before anything is uploaded or written, for an override on the msg or the client, or a message read back as `bot_message`;
  - after the write, when only `chat.update`'s response shows it: its `message` is a `bot_message`, or its `files` lack the new ids. The no-orphan rules above delete the uploads.

  Post and edit the message from a client without overrides (`slack.with({ username: undefined })`).

  To keep a custom-named OP (a digest posted as "cw") and still attach downloadable images, put the files on a plain reply in its thread, posted and kept current by a client without overrides:

  ```ts
  const plain = slack.with({ username: undefined, iconEmoji: undefined, iconUrl: undefined });
  const panels = (await plain.post({ text: "Panels" }, digestTs)).id; // once; keep the ts
  // each run, with `previous` = the last run's fileIds and their content hashes (`hash53Bytes`):
  const swap = await plain.replaceFiles(panels, files, { text: "Panels" }, { previous });
  ```

  The reply is an ordinary app message, so attaching by edit should work there, but that's not yet tested on a thread reply. Pass `previous` for now: `replaceFiles` reads a message back with `conversations.replies(ts, limit: 1)`, and it isn't verified that a reply's ts returns the reply rather than the thread's parent. If it returns the parent, the old files would never be deleted. Experiment `4 vii` checks both.

The pieces:
- **`upload(name, bytes | string | Blob, opts)`** returns a file id.
  - It's unshared unless `opts.channel` is given (with `initialComment` / `threadTs`); sharing posts a file message.
  - It waits until Slack has processed the file (`isProcessed`: a `mimetype`, and `thumb_*` for an image). It polls `files.info` every 0.5 s for up to 30 s; `processed: { timeoutMs, intervalMs }` changes that, and `processed: false` skips it.
  - The bytes POST is retried like other calls (429 / 5xx / timeout / dropped connection, up to `retries`). That's safe because nothing exists until `completeUploadExternal`.
- **`Msg.files`**: file ids attached below the message, sent as `chat.update` `file_ids`.
  - On an edit they replace the message's files. Omitting `files` leaves them as they were; `[]` detaches them. A detached file still exists until `deleteFile`.
  - `chat.postMessage` takes no `file_ids`, so `post` with files posts first, then attaches by edit. If that edit fails, it throws `FilesNotAttachedError` (`ts`). The message is stamped without the files, so `sync` / `upsert` attach them on their next run.
  - Files count toward the content hash.
- **`deleteFile(id)`**: a file that's already gone is fine. Also `fileInfo(id)`, and `swapFiles(client, previous, desired, write)` for your own write step (`attachedFiles(message)` and `withFiles(msg, ids, hashes)` help with it).
- **`image(url | { slackFile } | { slackFileUrl }, alt, title?)`** builds an image block. `versionedUrl(url, version)` sets `?v=`; use a content hash or timestamp. A signed URL that changes per version works the same way.
- **Scopes:** `files:write`, `files:read` (the processing wait, `fileInfo`), and a history scope for `replaceFile` without `previous`.

What Slack does (tested by disky in a DM, 2026-11; [spec][file-replace]):
- **Processing:** `files.info` shows `mimetype: ""` until Slack has processed an upload.
  - It took about 0.5 s for a 12 KB PNG, 0.6 s for 197 KB and 4.6 s for 3 MB. Time scales with bytes more than pixels.
  - Slack's docs say there's "no need to wait" after `completeUploadExternal`, but an image block on an unprocessed file fails with `invalid_blocks`, and an attached one first renders as a generic file icon.
  - Once processed, an attached image shows large and inline with Download. That holds however the message was created: a plain post, a blocks post, or a message created by the upload.
- **`file_ids`:** the list is a full, ordered replacement. `[P]` → `[P, Q]` → `[Q]` each read back exactly so, so multiple files work and any one can be added or removed. `chat.update` accepted 11 (Slack's UI stops at 10); a higher limit is untested. Deleting a replaced file afterwards leaves the new one showing. An edit without `file_ids` keeps the files; `file_ids: []` detaches them, and the file survives.
- **What viewers see:**
  - An edit triggers no new notification.
  - Every `chat.update` sets a new `edited.ts`, even one that only changes files. The `(edited)` badge is a client rendering detail: it shows after a plain-text / `rich_text` body, but not under section blocks.
  - Image blocks offer no Download on Android, whether they point at a URL or at a Slack file (`slack_file: {id}` or `{url}`).
  - Several attached files show on the phone under an "N attachments" line as one horizontal row you swipe through, in list order. Wide images are about 60% of the screen wide, so one plus the edge of the next is visible; 11 square tiles show about 2.5 at a time. It's not a grid, and there's no "show more" (Ryan's iPhone screenshots, experiments 6–7).
- **No files on a sender override:** a message posted with `username`, or with only `icon_emoji` / `icon_url`, has subtype `bot_message` (via `chat:write.customize`), and never shows attached files.
  - `chat.update` with `file_ids` returns ok, and `files.info` even lists a share at the message's ts. But the update's own `message.files` is `[]`, and history, replies and clients show no files.
  - `chat.postMessage` with `username` and `file_ids` is ok too, and shares nothing.
  - Thread replies make no difference: a plain message with replies takes files fine (experiment 4 and gcs's repro, 2026-11-20). The earlier experiments passed only because they started from plain app messages.
- **Events:** polling `files.info` is the supported way to wait. Slack's `file_change` event ("any property of a file is changed", `files:read`) might announce processing, but that's untested: the test app has no Events API subscription.
- **Not tested:** what a message shows when a file that's still attached gets deleted.

### Declarative sync

```ts
const { threadId } = await slack.sync({ messages: ["OP", "Reply 1", { text: "Reply 2", blocks }] });
await slack.sync({ messages: ["OP", "Reply 1 (edited)"] }, { threadTs: threadId }); // edits 1, deletes 2
```

`sync` deletes our extras from the end, edits changed overlaps, then posts the rest. Other people's messages are left in place. Plain text compares as text, the same as in the Python impl. A message with blocks, attachments or metadata compares by a content hash that `thrds` stamps into its metadata (`event_payload.thrds_hash`), because Slack rewrites blocks on readback. `syncLinked(linked)` posts summary bullets that link to detail messages in the same thread.

## Slotted threads: `syncSlots` / `upsert`

Most bots keep a parent message plus *named* replies up to date. Examples: a burst's `details` and `kind:<k>` replies, a week's per-day replies, one echo per person under a prompt. `syncSlots` posts each slot once, edits it when its content changes, and skips it otherwise. Message ids live in a store.

```ts
import { syncSlots, upsert } from "@open-athena/thrds";
import { d1Store } from "@open-athena/thrds/d1";

const store = d1Store(env.DB); // `schema/thrds.sql` in a migration
const r = await syncSlots(slack, store, {
  key: `burst:${id}`,
  render: async (state) => ({ // called after the lease is claimed, with current data
    parent: { text: headline(), username: actor.name, iconUrl: face },
    slots: [{ slot: "details", msg: details() }, ...kinds().map((k) => ({ slot: `kind:${k}`, msg: lines(k) }))],
  }),
}, { leaseS: 60 });

await upsert(slack, store, "fleet-status", fleetMessage, { create: false }); // one message; never posts without a record
```

- **Parent modes:**
  - A message, posted once and edited when it changes.
  - `{ keep: msg }`: posted once, never edited.
  - `{ ts }`: someone else's message, which we reply under.
  - `{ ts, msg }` (`upsert(…, { ts })`): an existing message we edit but never post.
- **Crash-safe.** A `pending` record is saved before each post, and every post carries its key and slot in its metadata.
  - A post Slack refused clears `pending`: nothing landed.
  - A run that finds a leftover `pending` (from a timeout or crash) adopts the message that landed instead of posting it again.
  - `recover`: `scan` (the default), `scan-or-post`, or `post`.
- **Concurrent runs.** With `leaseS` and a store that has `claim`, a second run gets `status: "busy"` and marks the key dirty. The holder then re-renders and syncs again before releasing, so the newer update isn't dropped. The lease is renewed before every write, and `LeaseLostError` stops a run that was taken over.
- **Deleted messages** follow `onGone`:
  - `repost` (the default): a re-posted parent takes its slots to the new thread.
  - `forget`: reports `GONE`.
  - `throw`.

  A thread recorded in another channel starts fresh in this one.
- **Rejected content.** `fallback` (per slot) and `parentFallback` are sent when Slack rejects the message (`invalid_blocks`: an image it can't fetch yet, say; see `withoutImages`). The next run upgrades it.
- **Other options:**
  - `force` edits regardless of the stored hash.
  - `prune` deletes slots no longer desired.
  - `dryRun` plans without writing.
  - On a throw, `partialOf(e)` has what landed.
  - `importAnchor` seeds messages posted before thrds managed them (hash `""`: each is edited once).
- **Stores:**

  | Store | Where | Leases |
  |---|---|---|
  | `memoryStore()` | in-process | yes |
  | `d1Store(db)` | D1 | compare-and-swap, plus dirty marks |
  | `d1Store(sqliteD1(new DatabaseSync(path)))` | local SQLite (Node) | same as D1 |
  | `kvStore(kv, { codec })` | KV | none: only for runs that are already serialized |
  | `durableObjectStore(ctx.storage)` | a Durable Object | none needed: the object is single-writer |
  | `threadStore(client, threadTs)` | Slack itself | none: state is rebuilt from the thread's tags, for bots with no database |
  | `oneKeyStore({ get, put })` | a record the app already keeps | the app's own |
- **Scopes.** Recovering a `pending` post, and telling a deleted reply from a deleted thread, read Slack history. That needs `channels:history`, or `groups:history` for private channels. Without it, `recover: "scan"` throws an error that names the scope.
- **The hash is a contract.** Stored hashes (`msgHash`) are compared across releases, and the tests pin them. A change re-edits every stored message once, so treat it as a breaking change.

## Receiver

```ts
import { slackHandler, respond, viewErrors, viewValues, isBlockActions } from "@open-athena/thrds/receiver";

// Workers: build per request so the handler closes over `env` / `ctx`.
export default {
  fetch: (request, env, ctx) =>
    slackHandler({
      signingSecret: env.SLACK_SIGNING_SECRET,
      waitUntil: (p) => ctx.waitUntil(p),
      onEvent: async ({ event }) => { /* acked first; Slack's retries are dropped by default */ },
      onInteraction: async (p, c) => {
        if (p.type === "view_submission" && !viewValues(p)["did"]) return viewErrors({ did_block: "Required" });
        if (isBlockActions(p)) c.waitUntil(respond(p.response_url!, "Working on it…"));
      },
      onCommand: (cmd) => ({ response_type: "ephemeral", text: `got ${cmd.text}` }),
    })(request),
};
// Next.js App Router: `waitUntil: (p) => after(p)` (from `next/server`). Without a `waitUntil`, deferred work is
// awaited before the ack, which can blow Slack's 3 s budget on Node.
```

- **Verification.** `verifySlackSignature` is v0 HMAC-SHA256, with a 300 s replay window and a constant-time compare, tested against Slack's published vector. An empty secret fails as `missing_secret`.
- **Parsing.** `parseSlackBody` returns a tagged union (`url_verification`, `event`, `interaction`, `command`, `unknown`), and never throws on a malformed body. The handler answers those with 400.
- **Errors.** Deferred failures go to `onError`, which defaults to `console.error`.
- **Views.** `viewValues(p, { by: "block" })` keys values by block when every input shares one action id.

## Builders

- **mrkdwn:**
  - `escape`, `link`, `mention`, `date`.
  - `bound(text, max, { atLine })`: cuts by code point, optionally at a line break.
- **Block Kit:**
  - Blocks: `section`, `context`, `header`, `divider`, `image`, `actions`.
  - Elements: `button`.
  - Modals: `modal`, `input`, `plainTextInput`, `staticSelect`, `usersSelect`, `datePicker`.
  - `withoutImages(msg)`.
- **rich_text:** `rich.block` / `section` / `list` / `quote` / `link` / `emoji` / `user` / `date`. These keep emoji inside link anchors and give real bullet lists.
- **`private_metadata`:** `encodePrivateMetadata` / `fitsPrivateMetadata` (`PRIVATE_METADATA_MAX`).
- **Permalinks:**
  - `parsePermalink` tolerates prose punctuation, `&amp;` and slack-gov.com.
  - `buildPermalink`.
  - `permalinksIn(text)` / `withoutPermalinks(text)`.

## Avatars

Post as a person while marking the message as automated: their photo with a badge folded into the corner.

```ts
import { BADGES, badgedAvatarUrl, avatarResponse, derivedAvatarHandler, derivedAvatarUrl } from "@open-athena/thrds/avatar";
import { d1AvatarStore } from "@open-athena/thrds/d1";

// With storage: content-addressed `/a/<sha256>.png`.
const avatars = d1AvatarStore(env.DB);
const iconUrl = await badgedAvatarUrl(user.image, BADGES.automated, {
  store: avatars,
  origin: "https://bot.example.org",
  rasterize: (svg) => new Resvg(svg).render().asPng(),           // Workers: resvg-wasm
  // rasterize: (svg) => sharp(Buffer.from(svg)).png().toBuffer(), // Node: sharp
  memo,
});
if (url.pathname.startsWith("/a/")) return avatarResponse(avatars, request);

// Stateless (Cloud Run, a fresh isolate): `/avatars/<id>/<key>.png`, re-rendered from the person's current face.
const icon = derivedAvatarUrl(origin, userId, user.image, BADGES.automated);
const serve = derivedAvatarHandler({ resolveFace: async (id) => (await slack.userInfo(id))?.image ?? null, badge: BADGES.automated, rasterize });
```

- **What `badgedAvatarUrl` returns:** a URL, or null when the avatar can't be made. A post never waits on, or fails over, its avatar.
- **Badges:** `BADGES` has presets (`automated`, `succeeded`, `failed`, `running`, …). A badge can also be `{ color, glyph }` or `{ color, image }`.
- **Fallback faces:** `identiconPng(await identiconSeed(secret, email))` and `serviceIconPng()` are deterministic PNGs for people without a photo and for jobs. Pass `memoKey` so a byte face renders once.

## Testing

```ts
import { fakeChannel, fakeSlack, timeoutError } from "@open-athena/thrds/testing";

const { client, writes } = fakeChannel({
  intercept: ({ method }) => (method === "chat.postMessage" ? { body: { ok: false, error: "not_in_channel" } } : undefined),
});
```

`fakeChannel` behaves like a Slack channel: it assigns ts, keeps threads and metadata, and answers `message_not_found` / `thread_not_found`. It records every write. `intercept` injects failures: throw `timeoutError()` to simulate a post that timed out. To run `d1Store` against real SQL, use `sqliteD1(new DatabaseSync(":memory:"))` (from `/d1`).

## Development

`tests/fixtures/sync.json` is shared with the Python impl as the cross-language contract for the sync algorithm (`git checkout py -- tests/fixtures/` to pull updates).

## Publishing

CI on tag `ts-vX.Y.Z` publishes to npm via [OIDC trusted publishing][npm-tp], so there's no long-lived `NPM_TOKEN`. Every push to `ts` also builds the [`ts-dist`][ts-dist] branch, installable by SHA.

[py-branch]: https://github.com/Open-Athena/thrds/tree/py
[pypi]: https://pypi.org/project/thrds
[toolkit-spec]: https://github.com/Open-Athena/thrds/blob/ts/specs/done/slack-toolkit-reuse.md
[npm-tp]: https://docs.npmjs.com/trusted-publishers
[ts-dist]: https://github.com/Open-Athena/thrds/tree/ts-dist
[file-replace]: https://github.com/Open-Athena/thrds/blob/ts/specs/done/slack-file-replace.md
