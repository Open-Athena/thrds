# Spec: Discord push — bot-token CLI verbs + webhook-execution transport

Discord is the one platform where thrds's library is far ahead of its CLI. This spec closes that gap in two independent tracks — a **bot-token push** exposed properly in the `thrds discord` verb tree (the certain part), and a **webhook-execution transport** for per-message sender identity (the exploratory part) — and records the live prior art we should be converging with.

## Where we actually are (correcting the record)

The earlier framing that "Discord is paste-only because self-bots are banned" is true only of the **CLI surface**, not the library — but the library is less finished than a first read suggests:

- [`DiscordClient`][discord.py] (`thrds/discord.py`) has all the bot-API **primitives**: `post`, `edit`, `delete`, `create_thread`, `list_messages`, plus `sync` / `sync_linked`. Token is auto-prefixed `Bot `. Present since the first commit ("declarative thread sync for Slack **and Discord**").
- **But `create_thread` is called nowhere in the sync flow.** `core.sync` (core.py:536–552), for a fresh thread, posts the OP and then sets `thread_id = <the OP's message id>` and posts replies against it. That is correct for Slack (`thread_ts` == the OP's ts, and posting with it threads the reply), but **wrong for Discord**: a message id is not a channel, so `POST /channels/{op_message_id}/messages` is invalid. Discord requires an explicit `create_thread` off the OP, then posting into the returned thread channel. So the end-to-end "OP → open a thread → post replies into it" flow — the thing the Marin bot actually does — is **not wired through thrds's sync today**. discord-agent hand-rolls it precisely because sync doesn't.
- The `thrds discord` CLI group exposes only `init / lint / open / preview / render` — render-then-paste. No `push` / `sync`.
- The paste-for-prod rule (`specs/done/discord-platform.md`) was a *product* decision for the "post **as me**" use case: Discord bans user-token automation, so there was no clean "post as the user." It does **not** apply when the sender is a bot by design — which is the common case (digests, reports, announcements).

So Part 1 is **wire Discord thread-creation into the push, then expose it** — not merely surface an already-working path.

### Live prior art: `Open-Athena/discord-agent` ("Marin Bot")

The "don't we already do this?" instinct is correct. [`discord-agent`][discord-agent] posts the **Marin weekly digest to `#marin-bot` fully automatically**: `summarize.py` posts an OP, `create_thread`s off it, posts the summary + detail chunks *into* the thread, then edits the summary back with real permalinks (`summarize.py:481–543`). That is a line-for-line reinvention of thrds's `DiscordClient.sync_linked` — bot-token, single "Marin Bot" identity, `suppress_embeds=True`. It carries its own private copies of `discord_post` / `discord_edit` / `discord_create_thread` (in both `discord_api.py` and `summarize.py`).

thrds and discord-agent are **already half-merged**: thrds vendors discord-agent's Discord-markdown preview renderer (discord-agent commit `8d2a8e9` "Standalone preview build target, for thrds to vendor"; thrds's `discord preview` uses that bundle). This is the same posture ghpr was in before thrds subsumed it.

**Decided: invert the ownership.** thrds owns the Discord transport; discord-agent consumes it. DA's `discord_api.py` posting helpers and `summarize.py`'s private copies of them are a strict subset of `DiscordClient`; once the thread-creation seam (below) makes `sync`/`sync_linked` do the real OP→thread→replies flow, DA imports `thrds.DiscordClient` + `sync_linked` and deletes both copies. The clean split: **thrds = transport + reconcile + preview-render; discord-agent = archive/fetch, DB build, LLM summarize, D1 sync** (none of which belong in thrds). The preview renderer already flows DA→thrds, so this completes a direction already begun. Part 1 is the prerequisite.

## Identity models — why "both" is the answer, not "pick one"

The two transports are not competing implementations of the same thing; they're exclusive on different axes, so we want both:

| | bot token (have it) | webhook execution (new) |
|---|---|---|
| per-message sender (name + avatar) | ❌ one bot identity | ✅ `username` / `avatar_url` per message |
| create a thread | ✅ `POST …/messages/{id}/threads` | ❌ webhooks can't create threads |
| post *into* an existing thread | ✅ | ✅ via `?thread_id=` |
| edit a message | ✅ `PATCH …/messages/{id}` | ✅ `PATCH /webhooks/{id}/{token}/messages/{id}` |
| reactions / delete / list | ✅ | partial (delete yes; list/reactions still need bot token) |

So: a digest whose *value* is a per-contributor avatar mosaic (the way the Slack Shape-C digest works) wants webhook execution; a threaded report posted under one bot identity wants the bot token. A future hybrid could open the thread with the bot token, then fan replies into it via the webhook's `?thread_id=` for per-sender avatars.

## Part 1 — expose bot-token push in the CLI tree (do now)

Bring `thrds discord` up to parity with the session-verb half of `thrds slack`, backed by the existing `DiscordClient`.

**Config resolution** (mirroring `THRDS_SLACK_BOT_TOKEN` and discord-agent's `_resolve` precedence — CLI flag → env → session state):

- Token: `THRDS_DISCORD_BOT_TOKEN` (never echoed; script-wrapper only per the token-handling rule).
- `channel_id`: `--channel` / `THRDS_DISCORD_CHANNEL` / state.
- `guild_id`: `--guild` / `THRDS_DISCORD_GUILD` / state (required for `sync_linked` permalinks).
- `thread_id`: persisted in state after first push (so re-push reconciles the same thread), like Slack's `prod_threads`.

**State.** Discord sessions need their own small config rather than borrowing Slack's PEC/channel-prefix machinery. Add Discord-relevant optional fields to `SessionState` (or a nested `discord:` block) — `channel_id`, `guild_id`, `thread_id`, `thread_name` — pruned-when-default by the existing slim serializer, so a fresh Slack session is unaffected. Platform guard stays `_load_state(expected_platform='discord')`.

**Thread-creation wiring (the actual work) — a one-line seam, not a fork.** The reconcile in `core.sync` is genuinely platform-neutral: it touches messages only through the four `ThreadClient` methods (`list_messages`/`post`/`edit`/`delete`), and there is no Slack-specific logic in it. Exactly **one** line is Slack-shaped — `core.py:552`, `thread_id = result_msg.id` after the OP post. Slack's thread handle *is* the OP's ts, so replies address it directly; Discord's thread is a separate channel that must be `create_thread`d off the OP.

The fix is a thin per-client seam, not a reconcile fork and not a duplicated standalone impl:

- Add a client method `open_thread(op_id, name) -> reply_target`. Default (protocol/Slack): returns `op_id` — **byte-identical to today, zero Slack regression**. `DiscordClient` overrides it to `create_thread(op_id, name)` and returns the new thread-channel id.
- `core.sync` calls the seam in place of the hardcoded line 552. This fixes `sync` *and* `sync_linked` for Discord in one move; Slack's path and tests are untouched.

Store the created thread's channel id in `discord_thread_id` so re-push reconciles the same thread. Slack behavior must be pinned by a before/after test asserting the OP-then-replies call sequence is unchanged.

**Sender-override: raise, don't drop.** `post()`'s `username`/`icon_url`/`icon_emoji` are protocol kwargs (so `core.sync` can pass `Msg` overrides uniformly). Discord's bot API can't honor them, so — per "loud error, not silent drop" — `DiscordClient.post` **raises** when any override is actually non-None (bare-`str` threads pass none, so normal pushes are unaffected), with a message pointing at the webhook client (Part 2). Remove the `_sender_warned` warn-once machinery. Bluesky's silent-ignore should raise for the same reason.

**Known gap (log, out of scope here):** `DiscordClient.list_messages` marks every type-0 message `editable=True`, so it doesn't distinguish foreign (human) replies the way Slack's `list_messages` does — a hazard for mixed-author Discord threads, to be closed before any Discord push runs against a channel real people post into.

**Verbs** (subset of Slack's that map cleanly; skip PEC-specific ones like `promote` / `adopt` / `migrate`):

- `push` — reconcile the session doc into the thread via `sync` (or `sync_linked` when the doc has linked-summary structure), creating the thread on first push and storing `thread_id`. `-n/--dry-run`, `--pace`, `--jitter`, `--suppress-embeds`, `--thread-name`.
- `pull` — `list_messages` → write thread back to the doc (round-trip parity with `slack pull`).
- `diff` — dry-run reconcile, print the plan.
- `thread` — dump the live thread (debug / assertion aid).
- Keep `render` / `preview` as the paste path; `push` is additive, not a replacement.

**Tests** (exact-equality / parsed-structure per the testing rules): a `FakeDiscordTransport` recording `(method, path, data)` calls; assert the push of a 2-message doc yields exactly `[create_message(OP), create_thread, create_message(reply)]`, dry-run yields the plan with zero writes, re-push of identical content is a no-op, edited content yields a scoped edit. Reuse the `sync` test harness where it already covers this.

## Part 2 — webhook-execution transport (explore / experiment)

Once the bot client *raises* on sender overrides (Part 1), the webhook client becomes the actual way to *do* per-message sender on Discord — the transport that legitimately honors `username`/`avatar_url`, rather than pretending the bot API can.

- New `DiscordWebhookClient(webhook_url, thread_id=None)`: `post` → `POST {webhook_url}?wait=true[&thread_id=…]` with `username` / `avatar_url` / `content` / `flags`; `edit` → `PATCH {webhook_url}/messages/{id}`; `delete` likewise. Same `_curl` + backoff + 429/`EditRateLimited` handling as `DiscordClient` (factor the shared HTTP core out into a base, so the two clients read as one transport with two identity models).
- A `Msg` with sender overrides syncs cleanly through this client where the same thread would raise through the bot client — the caller's choice of client *is* the choice of identity model, made explicit.
- **Thread interplay.** Webhook posts can't *open* a thread. For a threaded, per-sender digest: open the thread with the bot token, then post replies via the webhook with `?thread_id=<that thread>`. Prove this combination works before committing to it.
- **Experiment target.** `#marin-bot-dbg` (private; member list is the user + one other). Needs a channel webhook (Integrations → Webhooks); store as `THRDS_DISCORD_WEBHOOK` / a `gcs-discord-webhook-staging` secret — the URL is a secret, never printed. Channel + webhook creation is the user's to do.
- Deliverable of the exploration: a short findings note (does `?thread_id=` edit-back work? rate-limit shape? avatar caching?) folded back into this spec before any productionization.

## Sequencing

1. Part 1 (bot-token CLI push + state + tests) — unblocks discord-agent convergence and any bot-identity report.
2. Decide subsumption vs. dependency for discord-agent (user).
3. Part 2 webhook experiment against `#marin-bot-dbg` once the user provisions the webhook.

Non-goals: reactions push, DM support, and the discord-agent archive/summarize/D1 logic (stays in that repo regardless of subsumption outcome).

## Implemented (2026-09-11)

Part 1 landed in two commits (`e48eeed` seam + raise; `d3daff8` CLI):

- **`_reply_target` seam** in `core.sync` — the one-line change described above. Slack/Bsky reply to the OP id (unchanged, pinned by `test_reply_target_default_threads_replies_to_op_id`); `DiscordClient.open_thread` opens a child thread; a lone OP opens none. `sync`/`sync_linked` now do Discord's OP→thread→replies flow.
- **Raise, don't drop**: `DiscordClient.post` and `BskyClient.post` raise `NotImplementedError` on a non-None sender override; the Discord warn-once latch is gone.
- **CLI**: `thrds discord push` (fresh: OP→channel, replies→thread; `-n` dry-run needs no token; config flag → env → state via `THRDS_DISCORD_BOT_TOKEN`/`_CHANNEL`/`_GUILD`) and `thrds discord thread` (dump). New None-default `discord_*` `SessionState` fields record where the push landed; slim serializer omits them elsewhere. README + group docstrings updated.
- Full suite green (1408 passed); tests stub `_curl` so `sync` runs for real with no network.

**Still open (this spec stays out of `specs/done/`):**

1. ~~**Re-push / edit.**~~ **Done (2026-09-13)** — see "Implemented" below. `push` now reconciles a session that already has a recorded OP.
2. ~~**`list_messages` foreign-author gap**~~ **Done (2026-09-14)** — see "Implemented: foreign-author editability" below. `list_messages` now marks each message `editable` by authorship, so a human (or other-app) reply in a thrds thread is preserved rather than reconciled.
3. ~~**Part 2** (webhook transport).~~ **Done (2026-09-13)** — `DiscordWebhookClient` built + verified live; see "Implemented: DiscordWebhookClient" below.
4. **discord-agent inversion** — decided (invert), spec written (2026-09-14) at `discord-agent/specs/thrds-transport-inversion.md` for that repo's own session to implement; a separate PR in that repo now that re-push/edit has landed (the digest edits its OP in place, so it needed #1).
5. **Hybrid orchestration + transport policy.** **Decided policy: always require a bot; the webhook is a pure additive per-sender layer on top of it — no webhook-only state.** The bot is needed for `list`/reconcile regardless (the premise of declarative sync), and custom sender is the only thing the webhook adds, so making it optional-on-top keeps two states, not three, and sidesteps an id-tracked webhook-only reconcile model entirely. Custom sender without a webhook raises descriptively (already true at the primitive level: `DiscordClient.post` raises on a sender override and points at the webhook).
   - **Library composite: done (2026-09-13)** — see "Implemented: DiscordHybridClient" below. This is the whole per-sender path at parity with Slack: per-message sender is a **programmatic `Msg` API on every platform**, driven from app code, not markdown. The motivating Slack case (the GCS-usage digest, `specs/per-message-sender.md`) is built in `marin-gcs-usage` as `Thread([Msg(...), …])` and `sync`'d; a Discord per-sender digest now builds the same `Thread` and hands it to `DiscordHybridClient` — no CLI or doc work needed for that path.
   - **CLI (Discord): done (2026-09-14)** via the doc per-sender syntax — see `specs/done/doc-sender-syntax.md`. `discord push` of a doc with `+++ as <name>` replies routes them through `DiscordHybridClient`, requiring `THRDS_DISCORD_WEBHOOK`; a custom OP sender is rejected. **Slack's CLI push per-sender is also done now (2026-09-14)** — parity across both platforms; see `specs/done/doc-sender-syntax.md`.

## Live findings (2026-09-13): thread-hybrid + reconcile semantics

Verified against a dedicated dev bot (`thrds-dev`) in a private server (`rbw dev` / `#bot-test`), driving the real `DiscordClient` plus raw webhook curl (`tmp/discord_thread_hybrid_probe.py`, `tmp/discord_op_edit_probe.py`). Two probes, all operations HTTP 200 except the one deliberate negative.

**Structural fact that reshapes reconcile: `create_thread(op_id)` returns a thread whose channel id *equals* the OP message id.** A thread created *from* a message shares that message's snowflake. Consequences, all confirmed:

- The **OP stays in the parent channel** as a normal `type=0` message with full content. `GET /channels/{thread_id}/messages` does **not** return it — it returns a `type=21` `THREAD_STARTER_MESSAGE` placeholder with empty content, which `list_messages`'s `type==0` filter drops. So `list_messages(thread_id)` yields **only the replies**, never the OP.
- Because `op_id == thread_id`, the OP is directly addressable without a channel scan: `GET/PATCH /channels/{channel_id}/messages/{thread_id}`.
- **The OP can be edited only via the parent channel.** `PATCH /channels/{channel_id}/messages/{op_id}` → OK; `PATCH /channels/{thread_id}/messages/{op_id}` → **`10008 Unknown Message`**. This is a latent bug in the current reconcile/`sync_linked` phase-4 path: `edit()` addresses `self._channel` (`_active_thread_id or channel_id`), so with `_active_thread_id` set to the thread, editing message[0] (the OP) would `10008`. Never triggered yet (Marin Bot runs discord-agent's own code), but it *will* break the first real thrds Discord re-push/`sync_linked`.

**Reconcile design that follows** (message[0] is parent-addressed, messages[1:] are thread-addressed):

- OP: read/edit via `channel_id`, id = the stored `thread_id`.
- Replies: `list_messages(thread_id)` for the diff; post/edit/delete via `thread_id`.
- To reconstruct the desired-vs-live diff, prepend the OP (fetched by id from the parent) to `list_messages(thread_id)`; otherwise the diff sees message[0] as missing and re-posts a duplicate OP.
- The single `_channel` accessor must become position-aware (or the reconcile must edit the OP through the parent explicitly).

**Part 2 — webhook × thread hybrid, all confirmed:**

- Webhook **posts per-sender replies into a bot-opened thread** via `POST {webhook}?wait=true&thread_id={tid}` — HTTP 200, distinct `username`/`avatar_url` per message, all sharing one `webhook_id` (`author.bot=True`). The digest avatar-mosaic shape works end to end.
- Webhook **edits a message inside the thread** via `PATCH {webhook}/messages/{id}?thread_id={tid}` — content updates, display sender preserved.
- The bot **sees webhook messages** in `list_messages(thread)` (`type=0`, `webhook_id` set), so a bot-token reconcile pass can diff webhook-authored replies. (Foreign-author gap #2 still applies: they'd be marked editable.)
- So the productionizable hybrid is: **bot opens the thread + owns the OP and reconcile; webhook fans per-sender replies into it via `?thread_id=`.** `DiscordWebhookClient` can share `DiscordClient`'s `_curl`/backoff base and needs only `post`/`edit`/`delete` (no `create_thread`, no `list_messages` — the bot side owns those).

## Implemented (2026-09-13): re-push reconcile (open item #1)

`thrds discord push` reconciles a session with a recorded OP instead of refusing it — the whole fix localizes to `DiscordClient`; `core.sync` is untouched (it was already platform-neutral). The discriminator needs no new state: **the OP's id equals the thread id**, and the OP lives in the parent.

- `DiscordClient.list_messages(thread_id)` **prepends the parent-channel OP** (fetched by id, `op_id == thread_id`) when listing a child thread, so `sync`'s positional diff sees `existing[0]` as the OP. Listing the base channel itself (`thread_id == channel_id`) prepends nothing.
- New `DiscordClient._channel_for(message_id)` routes edit/delete: the one message whose id equals the active thread id is the OP → address the **parent** channel; every other reply → the thread. This also fixes a latent bug in *fresh* `sync_linked` phase-4, whose OP edit would have hit `10008` (never run against Discord before).
- CLI: re-push points `sync` at `discord_thread_id` (thread case) or, for a lone OP, at the base channel scoped by `only_ids={op_id}` (in-place OP edit; growing a lone OP into a thread mid-life is refused with a clear message). A re-push dry-run reads the live thread to build the plan, so it requires a token (a fresh dry-run still doesn't).
- Verified live end-to-end against `#bot-test` (`tmp/discord_reconcile_probe.py`): fresh → edit-OP-via-parent + edit-reply + skip → add → delete, each read back exactly. 8 new CLI tests assert exact `_curl` call sequences (OP edit → parent, reply edit/post/delete → thread); full suite 1416 passed.

Remaining: #4 (discord-agent inversion, now unblocked). (#2 foreign-author gap now done — see below.)

## Implemented (2026-09-13): `DiscordWebhookClient` (open item #3)

The webhook transport — the honest way to do per-message sender on Discord, now that the bot client *raises* on overrides. The shared HTTP core (`_curl` retry/backoff, 429 + `EditRateLimited`, status parsing) is factored into a `_DiscordHTTP` base; `DiscordClient` (bot token) and `DiscordWebhookClient` (webhook execution) are two identity models over it — a refactor of the existing `_curl`, no behavior change to the bot client (its error strings still read `Discord {method} {path}`; a `label` param lets the webhook client keep its secret URL out of every error).

- `DiscordWebhookClient(webhook_url, thread_id=None, *, username=None, avatar_url=None, suppress_embeds=False)`. Write-only by design — `post` / `edit` / `delete`, **no** `create_thread` / `list_messages` (a webhook can't open a thread or read messages; `list_messages` raises pointing at the bot client). It pairs with a `DiscordClient` that owns threading + reconcile.
- `post` → `POST {webhook_url}?wait=true[&thread_id=…]` with `content` + per-message `username`/`avatar_url` (protocol `icon_url` → `avatar_url`; `icon_emoji` raises — webhooks have no emoji avatar) + `flags=4` when `suppress_embeds`. Per-message sender overrides the client-wide default (mirrors `SlackClient.post`). `edit`/`delete` → `PATCH`/`DELETE {webhook_url}/messages/{id}[?thread_id=…]`.
- The webhook URL embeds a secret token, so it is never logged: error labels carry only the method + message id.
- Verified live against `#bot-test` (`tmp/discord_webhook_client_probe.py`): the real class posts two per-sender replies into a bot-opened thread and edits one; the bot's `list_messages(thread)` reads them back (OP prepended) with exact content. 13 new unit tests assert exact request shapes + the secret-safe labels; full suite 1429 passed.
- README gained a **Platform capabilities** matrix (Slack vs. Discord-bot vs. Discord-webhook vs. Bluesky) covering post/edit/delete/read, custom sender, threading, and the "sender is fixed at post time everywhere" fact.

## Implemented (2026-09-13): `DiscordHybridClient` (library half of open item #5)

The composite that makes a threaded per-contributor digest a single declarative `sync`. It is itself a `ThreadClient` wrapping a `DiscordClient` + `DiscordWebhookClient`, routing each `core.sync` call by transport — zero `core.sync` changes.

- `list_messages` / `open_thread` → bot. Listing reuses a new `DiscordClient._list_raw` (raw dicts incl. `webhook_id`) to record which live ids are webhook-authored, so a re-push routes edits/deletes to the right transport. `list_messages` itself is now a thin wrapper over `_list_raw`.
- `post` → webhook when the desired message carries a per-sender override, else bot. The OP (posted with no `thread_id`) is the bot's single identity and **raises** on an override — it anchors the thread. *(Superseded 2026-09-14: an OP with a sender or an attachment now routes through the webhook and the bot threads off it — see `specs/done/discord-webhook-attachments.md` §3.)*
- `edit` / `delete` → the transport that authored the target (webhook messages can only be edited via the webhook; each transport deletes its own). Authorship comes from the `webhook_id` recorded at list time (re-push) or from the post routing (same run).
- `sync` sets the bot's `_active_thread_id` (so an OP edit still addresses the parent channel) and the webhook's `thread_id` (so its edits/deletes carry `?thread_id=`), restoring both after.
- Known edge, documented: a reply bot-authored on an earlier push can't be re-attributed to a sender on re-push (sender is fixed at post time everywhere) — only its content edits.
- Verified live against `#bot-test` (`tmp/discord_hybrid_probe.py`): fresh push (bot OP+thread, webhook Alice/Bob) then a re-push (`[skip, edit, skip, post]`) that webhook-edits Alice and webhook-adds Carol — read back exact. 8 new unit tests assert the exact bot-vs-webhook call split across fresh/edit/add/delete/OP-edit; README library example + capability notes updated. Full suite green.

Remaining: #4 (discord-agent inversion, now unblocked — spec handed to that repo). #5's CLI half is done (both platforms). #2 (foreign-author gap) is done — see below.

## Implemented (2026-09-14): foreign-author editability (open item #2)

`DiscordClient.list_messages` marked every message `editable=True`, so a reconcile against a thread real people post in would edit or delete a human's reply. Now it classifies by authorship, the Discord counterpart to Slack's `editable=(m.user == us or m.bot_id == us)`:

- `DiscordClient.bot_user_id` — lazy `GET /users/@me`, cached (mirrors `SlackClient.bot_ids`).
- `_authored_by_us(raw)` — ours iff no `webhook_id` and `author.id == bot_user_id`. A human, another app/bot, or a webhook post (not editable via the bot token) → not ours. `list_messages` sets `editable` from it.
- `DiscordHybridClient._is_ours` widens "ours" to include its own webhook's replies (`webhook_id` present → routed to the webhook on edit/delete); a foreign human reply (no `webhook_id`, foreign author) stays non-editable and is preserved by `core.sync`.
- Tests: a bot-only re-push preserves a human reply (no edit/delete); the hybrid preserves a human reply between the OP and a webhook reply; a unit test drives the real `bot_user_id` resolution + caching and asserts the editable split (OP/bot-reply editable; human/webhook not). Recorders stamp canned messages bot-authored unless marked, and pin the identity so classification doesn't perturb the exact call-sequence assertions.

[discord.py]: ../thrds/discord.py
[discord-agent]: https://github.com/Open-Athena/discord-agent
