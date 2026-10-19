# Mastodon platform

## Motivation

`$hccs/crashes` wants to syndicate its `#crash-bot` Slack channel somewhere public. Bluesky was the long-time candidate, but its **lack of a post-edit API** is a persistent pain: thrds can only reconcile a changed bsky post by delete+repost (losing the post's id, likes, boosts, and reply anchoring). Mastodon has had a **first-class edit API since v3.5** (`PUT /api/v1/statuses/:id`), which makes it the better public target for a bot whose messages get corrected/updated after the fact.

This spec adds Mastodon as a thrds platform, mirroring the phase-1 shape of `discord` / `bsky` (init + render + lint + open, gist-mirrored trajectory) **plus** a full `ThreadClient` in `thrds/mastodon.py` whose `edit()` is a real edit — the differentiator that motivated the whole effort.

## What Mastodon is (for the record — we'd never used it)

- **Fediverse / ActivityPub**: many independent instances (servers) that federate. You pick or run an instance; your handle is `@you@instance.tld`.
- **API**: simple REST + Bearer token. A single-account token comes from **Preferences → Development → New application** (scopes `read:statuses write:statuses`) — no full OAuth dance needed for one's own account.
- **Posts** ("statuses"): default **500-char** limit, instance-configurable (`GET /api/v1/instance` → `configuration.statuses.max_characters`). Content is authored as plain text; vanilla Mastodon **does not parse markdown** (some forks/Glitch do). Bare URLs auto-link; `[text](url)` renders literally.
- **Threading**: reply chains via `in_reply_to_id`. A "thread" is a status plus its descendants.
- **Custom emoji**: instance/admin-managed (`:shortcode:` → image, ≤256KB PNG); no per-user upload, no Discord-style `<:name:id>`.
- **Editing**: `PUT /api/v1/statuses/:id` edits in place and keeps an edit history; the id (and its engagement + replies) survive.
- **Hosting**: run your own (Rails + Postgres + Redis + Sidekiq, ≥4GB RAM) vs. managed (masto.host, ~€6–19/mo) vs. just an account on a public instance. For crashes-syndication, an account on a public instance (or a small managed one) is plenty; self-hosting is not required.

## Implemented (this increment)

### `thrds/mastodon.py` — `MastodonClient` (`ThreadClient`)

Stdlib-only (urllib; zero extra deps, like the Slack client — a `mastodon = []` extra in `pyproject.toml`). Every request carries a `User-Agent` (some instances sit behind Cloudflare, which 403s the default `Python-urllib` agent — the same gotcha we hit with Discord).

- `post(content, thread_id=None, ...)` → `POST /api/v1/statuses`; `thread_id` sets `in_reply_to_id`. Default visibility `public` (constructor-configurable). Enforces the char limit. Sender-override kwargs + `images` **raise** `NotImplementedError` (parity with `BskyClient` — Mastodon has no per-message sender; images are deferred, below).
- `edit(message_id, content)` → `PUT /api/v1/statuses/:id`. **Real edit**, id preserved, no `EditRateLimited` fallback. This is the crown jewel vs. bsky.
- `delete(message_id)` → `DELETE /api/v1/statuses/:id`.
- `list_messages(thread_id)` → OP + `/context` descendants, chronological. Our own statuses get exact author text from `/api/v1/statuses/:id/source` (so sync's positional diff is reliable) and `editable=True`; foreign statuses are HTML-stripped (`_html_to_text`) and `editable=False`, so sync preserves them in place.
- `sync(...)` wrapper (default pace 0.5s, matching bsky's gentler posture).

**Threading is flat** for v1: every reply addresses the OP (`in_reply_to_id = OP`), matching `BskyClient`'s explicit flat-thread choice. Mastodon renders the OP + its direct replies as one thread. `list_messages` reconstructs our sequence by filtering `/context` descendants to our account, chronologically — so it would read a self-reply *chain* correctly too, if we later post one.

### `MastodonLinter` (`thrds/lint.py`)

Same two rules as `BskyLinter` (vanilla Mastodon shares bsky's no-markdown failure modes), longer limit:

- `mastodon/post-too-long` — per-paragraph length vs. **500** (`MASTODON_POST_LIMIT`). Warning, not error (raise-able per instance).
- `mastodon/masked-link` — `[text](url)` renders literal; use a bare URL.

### `thrds mastodon` CLI subgroup (`thrds/cli.py`)

`init` / `render` / `lint` / `open`, mirroring `bsky` exactly (session dir under `mastodon/<slug>/`, gist-mirrored, no live `push` verb yet). `mastodon` added to `state.VALID_PLATFORMS`.

### Tests

- `tests/test_lint.py` — `MastodonLinter` (length at/over 500, the 300–500 gap vs. bsky, separators, masked links, code-fence skip, combined sorted report).
- `tests/test_mastodon.py` — `MastodonClient` driven through a stateful in-memory `_request` emulator: request shaping (endpoint / `in_reply_to_id` / visibility / char limit), **real edit preserves id + never deletes**, ours-vs-foreign `list_messages`, sync edits-in-place (SKIP+EDIT, no DELETE), flat-thread creation, sender/image guards, `_html_to_text`.

## Deferred / follow-ups

- **Live `push` verb** for `thrds mastodon` (like `slack push` / `discord push`), wiring the CLI to `MastodonClient.sync` with a configured instance URL + token (env/rc, e.g. `THRDS_MASTODON_INSTANCE` + a token). The client is ready; only the CLI glue + config plumbing + a live-account smoke test remain. **This is the natural next step** — it's what unlocks the actual crashes-syndication use case, and it's coherent here (unlike bsky) precisely because edits work.
- **Live-account verification**: no Mastodon account existed when this was written, so the client is unit-tested against an emulator, not a live instance. Before relying on `push`, smoke-test against a real instance (create an app token, post → edit → delete a throwaway thread).
- **Images/media**: `POST /api/v2/media` (async processing) → attach via `media_ids[]`. Deferred in v1 (raises), same as bsky; wire into the unified `Image` surface (`specs/unified-image-attachments.md`) when needed — crashes posts may want screenshots.
- **Self-reply chains** instead of flat threading (each post replies to the previous), if the flat rendering reads poorly for long crash threads. `list_messages` already tolerates chains; only `sync`/`post` would need to thread the previous-posted id.
- **Idempotency-Key** header on `POST /statuses` to dedupe retried posts (sync doesn't retry posts today, so low priority).
- **Instance `max_characters` discovery** — fetch `configuration.statuses.max_characters` at client init to set `post_limit` (and a matching lint mode) instead of assuming 500.
- **README + compat-matrix** rows for Mastodon (labeled-link / emoji-in-label behavior; masked-link literal like bsky).
