# Discord application emoji + app-owned webhooks (finding from the mgu digest twin)

Written from the mgu session on 2026-09-14 after staging `gcs-usage digest -P discord` (spec: `marin-gcs-usage/specs/done/discord-digest-twin.md`). Two small asks at the end; the finding matters for the README capability matrix.

## Finding: custom emoji in webhook messages depend on who owns the webhook

- Application emoji (`POST /applications/{app}/emojis`, the Slack-workspace-emoji analog thrds recommended) render as `<:name:id>` only when the **poster can use them**: the bot itself, or a webhook **whose `application_id` is that app** (one the bot created via `POST /channels/{id}/webhooks`).
- Through a user-created webhook (`application_id: null` — what a channel's "Integrations → Webhooks → New" produces, and what mgu's `#marin-bot-dbg` staging webhook is) Discord **silently rewrites** `<:arrow_degm30:123…>` to the bare text `:arrow_degm30:` on ingest. No error, no 4xx; the readback content is already stripped.
- Guild emoji work from any webhook in that guild, but need `CREATE_GUILD_EXPRESSIONS` and land in the server's picker.
- Creating an app-owned webhook needs `MANAGE_WEBHOOKS` on the channel (Marin Bot has none today, so the mgu twin is parked on a grant).
- Emoji names are `[A-Za-z0-9_]{2,32}` — no `-`, so mgu maps Slack's `arrow_deg-30` to `arrow_degm30`.
- Unrelated but bit us: bot REST calls from `urllib` get a Cloudflare 403 (`error code: 1010`) without a `DiscordBot (url, version)` User-Agent; curl's default UA is fine, which is why thrds never saw it.

Suggested matrix rows / footnote: "Custom emoji in text: Slack `:name:` (workspace) · Discord `<:name:id>` — app emoji only from the bot or an app-owned webhook; user-created webhooks strip them to `:name:`."

## Asks (small)

1. `DiscordClient.create_webhook(name, *, avatar=None) -> str` (returns the webhook URL; `GET /channels/{id}/webhooks` first to reuse an existing app-owned one by name). Lets a consumer bootstrap the hybrid pair from a bot token alone, and guarantees app-emoji access.
2. `DiscordClient.app_emojis() -> dict[str, str]` + `upload_app_emoji(name, png)`; optionally a doc-side `:name:` → `<:name:id>` rewrite in `discord push` using that map (Slack's `:name:` stays as-is). mgu carries these three calls in `gcs_usage/discord_api.py` today and would delete them.

Neither blocks mgu; both are pure additions.

## Implemented (2026-09-14): the three primitives

`DiscordClient` gains `application_id` (lazy `GET /applications/@me`, cached — the app, distinct from `bot_user_id`) and:

- **`create_webhook(name, *, avatar=None) -> str`** — `GET /channels/{id}/webhooks`, reuse an existing webhook that matches `name` **and** is app-owned (`application_id == self.application_id`), else `POST` a new one; returns `https://discord.com/api/webhooks/{id}/{token}`. A same-name *user-created* webhook (app-id null) is deliberately **not** reused (it can't post app emoji). Needs `MANAGE_WEBHOOKS`.
- **`app_emojis() -> dict[str, str]`** — `{name: id}` from `GET /applications/{app}/emojis` (handles the `{"items": […]}` envelope).
- **`upload_app_emoji(name, png) -> str`** — `POST /applications/{app}/emojis` with a `data:image/png;base64,…` body; validates `name` against `[A-Za-z0-9_]{2,32}` (raises on `-`) and returns the new id.

These three are what mgu deletes from `gcs_usage/discord_api.py`. Tests in `test_discord_app_emoji.py` assert exact request shapes (create/reuse/ignore-user-webhook, the emoji map, the data-URI upload, the name guard).

### `discord push` defaults to `create_webhook` (2026-09-14)

When no `THRDS_DISCORD_WEBHOOK` env URL is set, an image/per-sender `discord push` now bootstraps an **app-owned** webhook from the bot token (`bot.create_webhook('thrds')`, reused by name) instead of erroring — so the hybrid pair comes from a bot token alone, and the webhook is app-owned (app emoji render). Falls back to a clear `UsageError` if the bot lacks `MANAGE_WEBHOOKS` (grant it, or set the env URL). Tests: auto-create happy path + the create-fails error.

### The doc-side `:name:` → `<:name:id>` rewrite (2026-09-14)

Shipped. `discord push` rewrites `:name:` → `<:name:id>` for names in `bot.app_emojis()`; unknown shortcodes (standard emoji, stray colons) pass through, so only the app's own custom emoji are touched. The rewrite is push-only (the doc keeps the readable `:name:`; there's no Discord pull) and idempotent because it's **gated on transport safety** — applied only when every message round-trips the ref: a bot-only push, or a webhook thrds **auto-created** (app-owned). A user-supplied env webhook strips `<:name:id>` back to `:name:` on ingest, which would re-edit every push, so the rewrite is skipped there (and no `app_emojis` lookup happens) — `:name:` stays literal; drop the env URL to get the auto-created app-owned webhook and full rendering. mgu can now delete its rewrite too. Tests: bot-only rewrite (with an unknown shortcode passthrough) + the env-webhook skip.

This closes the whole `specs/discord-app-emoji.md` ask (all three primitives + the create_webhook default + the rewrite).

## Ask 3 (2026-09-15): don't hard-require `curl`

`_curl_raw` shells out to `curl`; a `python:3.12-slim`-based job image has none, and the first scheduled run of mgu's Discord digest died with `FileNotFoundError: [Errno 2] No such file or directory: 'curl'` (the Slack client, on urllib, posted fine in the same run). mgu now installs curl in its image, but a `urllib`/`http.client` fallback (or primary) for the JSON + multipart paths would remove a silent deployment footgun for every consumer — and a `shutil.which('curl')` check at client construction with a clear error would at least fail at the start of a run, not at the first edit.
