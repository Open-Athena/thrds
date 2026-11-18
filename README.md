# thrds (TypeScript)

A Slack toolkit for bots: a hardened Web API transport, rich messages with per-message senders, declarative thread sync, slotted threads kept in place over a pluggable store (memory, Cloudflare D1, KV), a request receiver (signatures, events, interactivity, slash commands), and badged sender avatars. Web APIs only (`fetch`, `crypto.subtle`), so it runs on Cloudflare Workers and Node ≥ 22.

> The Python impl lives on the [`py` branch][py-branch] (and on PyPI as [`thrds`][pypi]). [`specs/slack-toolkit-reuse.md`][toolkit-spec] maps which pieces replace which hand-written code in OA projects.

## Install

```bash
pnpm add @open-athena/thrds
```

(Scoped because npm blocks the bare name as "too similar" to `three`.)

| Import | What | Loads |
|---|---|---|
| `@open-athena/thrds` | transport, `SlackClient`, `sync`, `syncSlots` / `upsert` + `memoryStore`, mrkdwn / Block Kit helpers, permalinks | — |
| `@open-athena/thrds/d1` | `d1Store` (leased slot state), `d1AvatarStore`, `SCHEMA` | a D1 binding |
| `@open-athena/thrds/kv` | `kvStore`, `kvAvatarStore` | a KV binding |
| `@open-athena/thrds/receiver` | `verifySlackRequest`, `parseSlackBody`, `slackHandler`, `respond`, `viewValues` | — |
| `@open-athena/thrds/avatar` | `badgedSvg`, `BADGES`, identicons, `publishAvatar` / `avatarResponse`, `badgedAvatarUrl` | your rasterizer |

## Transport

```ts
import { slackApi, SlackApiError } from "@open-athena/thrds";

await slackApi(token, "chat.postMessage", { channel, text: "hi" });
await slackApi(token, "users.lookupByEmail", { email }, { get: true });
```

It retries HTTP 429 (per `Retry-After`) and `{ok: false, error: "ratelimited"}` bodies, and applies a 30 s timeout. Failures throw `SlackApiError` with `.code` set to Slack's error string, `http_<status>` or `timeout`. 5xx and timeout retries are opt-in (`retryServerErrors`): a write that timed out may already have landed, and retrying `chat.postMessage` blindly would post it twice. `paginate` walks any cursor-paginated method lazily.

## `SlackClient`

```ts
import { SlackClient, section, context, mention } from "@open-athena/thrds";

const slack = new SlackClient({ token, channel: "C0884476QSC", username: "weekly-update-bot", parse: "none" });

// A per-message sender overrides the client's (needs `chat:write.customize`; `await slack.canCustomizeSender()`).
const as = await slack.senderFor("U2CERLKJA", { suffix: " (weekly update)" });
await slack.post({ text: "Ann submitted their update", blocks: [section("*Did:* …"), context(mention.user("U2CERLKJA"))], ...as }, threadTs);
```

The client also covers:
- Threads: paginated `list(threadTs)` (with metadata, reactions, senders), `history()`, `find` / `findByMetadata`, `postEphemeral`, `react` / `unreact` (both idempotent), `permalink`.
- People and channels: cached `userInfo` / `userByEmail` (found: 1 h; not found: 1 min), `users()`, `channelId("#eng")`, `openDm`.
- Views: `openView` / `pushView` / `updateView` / `publishHome`.
- Retargeting: `in(channel)` gives a sibling client with the same token and caches, aimed at another channel.

Senders are fixed when a message is posted. `chat.update` ignores `username` / `icon_url`, so an edit keeps the message's original sender.

### Declarative sync

```ts
const { threadId } = await slack.sync({ messages: ["OP", "Reply 1", { text: "Reply 2", blocks }] });
await slack.sync({ messages: ["OP", "Reply 1 (edited)"] }, { threadTs: threadId }); // edits 1, deletes 2
```

Given desired messages `M` and the thread's existing messages `N`, sync deletes our extras from the end, edits changed overlaps, then posts the rest. Other people's messages are left in place. Plain text compares as text, the same as in the Python impl. A message with blocks or metadata compares by a content hash that `thrds` stamps into its metadata (`event_payload.thrds_hash`), because Slack rewrites blocks on readback.

### Linked summary threads

`syncLinked(linked)` posts summary bullets that link to detail messages in the same thread. It posts with placeholder links first, then edits the summaries once the real permalinks exist.

## Slotted threads: `syncSlots` / `upsert`

Most bots keep a parent message plus *named* replies up to date: a burst's `details` and `kind:<k>` replies, a week's per-day replies, one echo per person under a prompt. `syncSlots` posts each slot once, edits it when its content changes, and skips it otherwise. It keeps message ids in a store, so no Slack reads are needed.

```ts
import { syncSlots, upsert, memoryStore } from "@open-athena/thrds";
import { d1Store } from "@open-athena/thrds/d1";

const store = d1Store(env.DB); // run `SCHEMA` (or `slotsSchema()`) in a migration
const r = await syncSlots(slack, store, {
  key: `burst:${burst.id}`,
  parent: { text: headline, username: actor.name, iconUrl: face },
  slots: [{ slot: "details", msg: details }, ...kinds.map((k) => ({ slot: `kind:${k}`, msg: lines(k) }))],
}, { leaseS: 60 }); // r.status === "busy" if another isolate holds the key

await upsert(slack, store, "fleet-status", fleetMessage); // one message, kept in place
```

- **Crash-safe.** A `pending` record is saved before each post, and every post carries its key and slot in its metadata. A run that finds a leftover `pending` adopts the message that landed instead of posting it again.
- **Self-healing.** A parent deleted on Slack's side is re-posted, and its slots move to the new thread. `parent: { ts }` replies under someone else's message without managing it.
- **`prune: true`** deletes slots that are no longer desired. `dryRun` plans without writing anything.
- **Stores:**
  - `memoryStore()`: in-process.
  - `d1Store(db)`: compare-and-swap leases, for isolates that race. `LeaseLostError` stops a run that was taken over.
  - `kvStore(kv)`: no leases, so use it only when runs are already serialized.
  - Your own: implement `SlotStore`'s `get` / `put` (+ optional `claim` / `release`).

## Receiver

```ts
import { slackHandler, respond, viewErrors, viewValues } from "@open-athena/thrds/receiver";

export default {
  fetch: (request, env, ctx) =>
    slackHandler({
      signingSecret: env.SLACK_SIGNING_SECRET,
      waitUntil: (p) => ctx.waitUntil(p),
      onEvent: async ({ event }) => { /* acked first; Slack's retries are dropped by default */ },
      onInteraction: async (p, c) => {
        if (p.type === "view_submission" && !viewValues(p)["did"]) return viewErrors({ did_block: "Required" });
        c.waitUntil(respond(p.response_url!, "Working on it…"));
      },
      onCommand: (cmd) => ({ response_type: "ephemeral", text: `got ${cmd.text}` }),
    })(request),
};
```

`verifySlackSignature` is v0 HMAC-SHA256, with a 300 s replay window and a constant-time compare. It's tested against Slack's published vector. `parseSlackBody` returns a tagged union: `url_verification`, `event`, `interaction` or `command`. `encodePrivateMetadata` (main entry) enforces Slack's 3000-char `private_metadata` cap.

## Avatars

Post as a person while marking the message as automated: their photo with a badge folded into the corner.

```ts
import { BADGES, badgedAvatarUrl, avatarResponse } from "@open-athena/thrds/avatar";
import { d1AvatarStore } from "@open-athena/thrds/d1";

const avatars = d1AvatarStore(env.DB);
const iconUrl = await badgedAvatarUrl(user.image, BADGES.automated, {
  store: avatars,
  origin: "https://bot.example.org",
  rasterize: (svg) => new Resvg(svg).render().asPng(),           // Workers: resvg-wasm
  // rasterize: (svg) => sharp(Buffer.from(svg)).png().toBuffer(), // Node: sharp
  memo,
});
// …and serve them: `/a/<sha256>.png`, immutable, 404 for anything else.
if (url.pathname.startsWith("/a/")) return avatarResponse(avatars, request);
```

- **What `badgedAvatarUrl` returns:** a URL, or null when the avatar can't be made. A post never waits on, or fails over, its avatar.
- **Badges:** `BADGES` has presets (`automated`, `succeeded`, `failed`, `running`, …). `GLYPHS` holds the raw glyph paths. A badge can also be `{ color, image }`, e.g. a bot's own logo.
- **Fallback faces:** `identiconPng(await identiconSeed(secret, email))` and `serviceIconPng()` are deterministic PNGs for people without a photo and for jobs.

## Generic sync

```ts
import { sync, type ThreadClient } from "@open-athena/thrds";
const result = await sync(client, { messages: ["OP", "Reply"] }); // result.actions: POST / EDIT / DELETE / SKIP
```

## Development

`tests/fixtures/sync.json` is shared with the Python impl as the cross-language contract for the sync algorithm (`git checkout py -- tests/fixtures/` to pull updates). The D1 adapter is tested against real SQL through a `node:sqlite` shim.

## Publishing

CI on tag `ts-vX.Y.Z` publishes to npm via [OIDC trusted publishing][npm-tp], so there's no long-lived `NPM_TOKEN`. Every push to `ts` also builds the [`ts-dist`][ts-dist] branch, installable by SHA.

[py-branch]: https://github.com/Open-Athena/thrds/tree/py
[pypi]: https://pypi.org/project/thrds
[toolkit-spec]: https://github.com/Open-Athena/thrds/blob/ts/specs/done/slack-toolkit-reuse.md
[npm-tp]: https://docs.npmjs.com/trusted-publishers
[ts-dist]: https://github.com/Open-Athena/thrds/tree/ts-dist
