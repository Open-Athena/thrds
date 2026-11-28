# Factoring audit: HTTP transport + Slack/Discord code sharing (2026-09-15)

Written from the mgu session, prompted by Ryan: "I'd think python code would use a python library for basic network reqs, and that Slack and Discord would share code paths more than they apparently do (for the ≈same actions)." Read-only audit of `py` at the current head (baseline `pytest`: 1504 passed, 6 skipped). Line refs are `thrds/<path>:<line>` at that head. Nothing here is implemented; it's the map for the thrds session to work from, priority order in §5.

## 1. HTTP transport per platform

| | Slack | Discord | Bluesky |
|---|---|---|---|
| Library | `urllib.request` — `SlackClient._request` `slack.py:233-264` | `subprocess.run(["curl", …])` — `_DiscordHTTP._curl_raw` `discord.py:91-212` | `atproto` SDK (httpx) `bsky.py:35-44` |
| Retries | 3, **only** on HTTP 429 (`Retry-After` header) `slack.py:256-261`; no 5xx/transport/non-JSON retry, no backoff | 4 attempts, EB+jitter cap 15s `discord.py:103-109`; retries curl exit≠0, unparseable status, 5xx, non-JSON 2xx, 429 (`retry_after` body), empty 2xx | none of its own |
| Error mapping | `ok:false` → `RuntimeError` `slack.py:262-263`; HTTPError → `RuntimeError` `:261` | `{code,message}` dict → 30046 `EditRateLimited` `:180-182`, 429 `:183-190`, other 4xx `:191,207-208`; 204 → `None` `:158` | SDK exceptions |
| Multipart / bytes | no multipart: 3-step external upload posts raw bytes via a second bare `urlopen` `slack.py:623-640`; emoji download bare `urlopen` `slack.py:2176-2180` | `-F payload_json=…` + `-F files[i]=@path` built by `_files_form` `discord.py:67-88`; URL images fetched with **urllib** `urlopen` `discord.py:58` | n/a |

So there are two retry policies (not one duplicated — Slack has the *weaker* one) plus four raw `urlopen` call sites with zero retry (`slack.py:253,634,2179`, `discord.py:58`). Collapse estimate: `_curl_raw` (~120 lines) + `_request` (~30) + the three bare-urlopen helpers (~20) → one `_http.py` of ~90-110 lines (request loop + ~30-line multipart encoder) + two ~15-line envelope adapters (Discord: `Authorization: Bot`, JSON error dict, `retry_after`; Slack: `ok`/`error`, `Retry-After`). Net −60 lines, but the real payoff is Slack inheriting 5xx/transport/non-JSON retry and one test seam.

**Is curl load-bearing? No.** The stated rationale (`specs/done/transport-robustness.md:20` "urllib was tried and abandoned… curl is deliberate"; `specs/done/thrds.md:83` "urllib blocked by Cloudflare") is resolved by `specs/done/discord-app-emoji.md:12`: the CF 403 is `error code: 1010`, triggered by the missing `User-Agent: DiscordBot (url, version)` header — curl's default UA happens to pass. Nothing else curl-specific is used (`-s -w %{http_code} -X -H -d -F`, `discord.py:126-136`). The same spec (`discord-app-emoji.md:45`) already records the cost: `python:3.12-slim` job images have no curl → `FileNotFoundError` on mgu's first scheduled Discord digest (2026-09-15); mgu's `a71ec49` is exactly that workaround. `pyproject.toml:31-32` advertises "Zero deps (subprocess curl)" — a shell dependency, not zero.

## 2. Message operations

- **Reconcile is genuinely shared.** `core.sync` `core.py:409-648` touches clients only via `list_messages/post/edit/delete`; `platform ==` appears only at `cli.py:350,400,437,449` (capture-vs-not init/commit), never in core. The `ThreadClient` Protocol `protocol.py:9-28` declares only those four; `open_thread` (`core.py:188`), `get_reactions` (`core.py:279`), `username/icon_url/icon_emoji` (`core.py:309-311`) are undeclared `getattr` duck-typing.
- **Sender resolution ("msg override → client default; icon as a unit") is written 3×:** `core.py:194-218` (`_resolve_sender`, used only for mismatch compare), `slack.py:464-483` (post), `discord.py:681-686` (webhook post). Slack's xoxp guard `slack.py:484-494` is correctly Slack-only.
- **Length checks: 7 identical sites** `discord.py:372,453,674,712`, `slack.py:449,526`, `bsky.py:117` (+ `slack.py:923-935`, `slack.py:885-891`/`discord.py:577-583` in ref/linked phases).
- **Capability rejections (`NotImplementedError`) written 3×:** sender `discord.py:361-366, 669-673`, `bsky.py:107-111`; images `discord.py:367-371, 455-459`, `bsky.py:112-116`.
- **`sync()` wrappers ×4**, each just building `SyncOptions`: `slack.py:716-774`, `discord.py:469-498`, `discord.py:878-914`, `bsky.py:144-166` — with divergent kwarg names (`thread_ts`/`only_ts`/`suppress_unfurls` vs `thread_id`/`only_ids`/`suppress_embeds`) that leak into the CLI (`cli.py:1055-1059` vs `cli.py:3110-3117`) and into `SyncOptions` itself (`core.py:393-394` carries both `suppress_embeds` and `suppress_unfurls`).
- **`sync_linked` ×2**: `slack.py:791-902` vs `discord.py:510-597`, same 4-phase algorithm (~70 shared lines); real differences are limit, `bullet_fn` (`slack.py:777-779` vs `linked.py:785-787`), URL fn (`permalink` API `slack.py:872` vs string `discord.py:500-508`), and Slack putting `summary_prefix` in the OP via `_skip_op` (`slack.py:809-849`) while Discord inlines it — a design divergence, not a platform constraint.
- **Push verb is forked at the CLI, not adapted.** `slack push` `cli.py:970-1085` → `sync_threads_staging` `slack.py:1463-1599` (remotes, tracking refs, gate, commit-first, chrome, permalinks, metadata). `discord push` `cli.py:2991-3143` is a separate 150-line flow: one doc, no staging/prod, no refs/tracking, no gist commit after `state.save()` (`cli.py:3125-3134`), state in five flat `discord_*` fields (`state.py:378-387`) instead of `ThreadEntry.remotes` pointers (`state.py:166-206`). `pull/fetch/diff/promote/adopt/recover` exist only for Slack; `preview` only for Discord (`cli.py:2873`); `capture` shares `_do_init` (`cli.py:366-460`) only.
- Mention suppression: Discord-only `allowed_mentions` (`discord.py:35,378,689,717`); Slack has no analogue wired. Thread-open: clean seam (`core.py:177-191` → `discord.py:390-404`).

## 3. Doc → messages pipeline

Shared and clean: `+++`/`+++ as`/`+++ @author` split `md.py:268-303`, frontmatter `sender.<name>.{name,avatar}` + `op_sender` `md.py:93-136`, `resolve_messages` `md.py:157-195`, refs `refs.py:38-123` (covered by `tests/test_doc_sender.py`, `tests/test_md_thread.py`, `tests/test_refs.py`).

Per-platform, but not as hooks:
- **Markdown**: Slack converts inside `post/edit` (`_md_to_slack` `slack.py:456,532`; reverse `slack.py:352,364`); Discord sends local md verbatim and *lints* instead (`lint.py:116`); Bsky lints (`lint.py:207`). No `render/parse` hook on the client — the axis is implicit.
- **Custom emoji, opposite directions in different layers**: Slack pull-side `:name:` → local `![:name:](emoji-*.png)` in the client `slack.py:2182-2273`; Discord push-side `:name:` → `<:name:id>` in the CLI `cli.py:2966-2988`.
- **Cross-refs** (`[text](#slug)`): validated/resolved only on Slack (`slack.py:905-996`); `discord push` never calls `validate_refs` — a `#slug` link posts literally. Silent gap.
- **Images**: `resolve_messages(lift_images=True)` only from `cli.py:3033-3036`; Slack folds into content (`slack.py:593-621`). Deliberate per `specs/done/unified-image-attachments.md`, but the flag is a hidden platform axis chosen by the caller.

## 4. State / reconcile

`SessionState` `state.py:338-387` = shared skeleton + ~10 Slack-shaped fields (staging/prod channels, chrome, remotes, `workspace_emoji`, `channel_names`) + the `discord_*` bolt-on. `remotes.py`, `tracking.py` (refs/snapshots/`merge_trees`), `mirror.py` are platform-neutral but only Slack verbs use them (`cli.py:1020-1085`). `SyncResult.format_preview` shared; `_print_sync_summary` Slack-only, Discord prints `format_preview()` directly (`cli.py:3118`). Net: reconcile diff is shared; *session* state and pull/fetch are forked.

## 5. Factoring opportunities (priority order)

1. **`thrds/_http.py` on `urllib.request`** (+ multipart encoder; `User-Agent: DiscordBot (…)` set in the Discord adapter). Replaces `discord.py:91-212`, `slack.py:233-264,633-635,2178-2180`, `discord.py:58`. ~100 lines in, ~170 out. Risk low-med: keep the 200-HTML-interstitial retry (`tests/test_transport.py:182`), the 204/empty-body distinction (`:245,:256`). Tests: `tests/test_transport.py:160-256` (8 tests stub `subprocess.run` with `CompletedProcess` — the only tests that must be rewritten); `tests/test_discord_webhook.py:23-56`, `tests/test_discord_hybrid.py:33-48`, `tests/test_discord_cli.py:211-268` stub `_curl`/`_curl_raw` and survive if those stay as thin wrappers; Slack tests stub `_request` (`tests/test_transport.py:16-33`, `tests/test_sender.py`, `tests/test_doc_sync.py`, `tests/test_slack_upload.py`). Also drops curl from `pyproject.toml:32` and from mgu's job image.
2. **One `sync()` entry + one option vocabulary** (`thread_id`/`only_ids`/`suppress_previews`): collapse the four wrappers (`slack.py:716-774`, `discord.py:469-498,878-914`, `bsky.py:144-166`). ~60 lines. Risk: public kwarg BC (`thread_ts=`/`only_ts=` are library API used by consumers like mgu). Tests: `tests/test_sync.py`, `tests/test_doc_sync.py`, `tests/test_discord_cli.py`, `tests/test_bsky.py`.
3. **Shared post-side helpers**: reuse `core._resolve_sender` in `slack.py:464-483`/`discord.py:681-686`; one `check_limit`; declared capability flags replacing the six `NotImplementedError` blocks. ~50 lines. Risk low. Tests: `tests/test_sender.py:40-160`, `tests/test_attachments.py:60-80`, `tests/test_bsky.py:143`.
4. **`sync_linked` → one impl in `linked.py`** parameterized by (limit, bullet_fn, placeholder, url_fn, op_mode). ~80 shared replacing ~200. Risk med: Slack's OP-separate mode must stay a parameter. Tests: `tests/test_linked.py:201`, `tests/test_transport.py:35-130`.
5. **Doc-pipeline seams**: (a) `render`/`parse` hook on the client (Slack = mrkdwn, Discord = identity); (b) move `_rewrite_app_emoji` `cli.py:2966-2988` into `DiscordClient`; (c) call `validate_refs` (and ideally resolve them) on the Discord push. Risk low; (c) is a bug fix. Tests: `tests/test_mrkdwn.py`, `tests/test_discord_app_emoji.py`, `tests/test_refs.py`.
6. **Platform-neutral session layer** (the honest answer to "same actions, different paths"): move `ThreadEntry.remotes` pointers, commit-first/tracking, `_print_sync_summary`, ref phase-3 out of `SlackClient` (`slack.py:904-2554`, ~1650 lines of orchestration) and `discord_push` into a module with per-platform hooks (provision channel, permalink, pull). Large, high risk; do after 1-5. Tests: `tests/test_slack_cli.py`, `tests/test_push_gate.py`, `tests/test_pull_modes.py`, `tests/test_tracking.py`, `tests/test_remotes.py`, `tests/test_discord_cli.py`.

## 6. Correctly platform-specific — leave alone

- Thread addressing: Slack `thread_ts` vs Discord child channel — `open_thread`/`_channel_for`/`_list_raw` OP-prepend (`discord.py:290-329,390-404`); the `_reply_target` seam is the right shape.
- Discord bot/webhook identity split and `DiscordHybridClient` routing (`discord.py:741-914`) — forced by Discord (`specs/done/discord-push.md` table); the shared HTTP core under both is exactly what `_DiscordHTTP` already does.
- Slack Block Kit image blocks + 3-step external upload vs Discord multipart attachments (`specs/done/unified-image-attachments.md`); Slack md↔mrkdwn converter (`mrkdwn.py`) and the Discord/Bsky linters (`lint.py`) — the *work* is per-platform, only hook placement should be shared.
- Slack staging chrome (`chrome.py`, `slack.py:554-591,1256-1461`), private staging channels, metadata `recover` scan (`slack.py:1038-1060,1943-2104`), `users.info` author resolution — no Discord analogue exists (paste-for-prod, `specs/done/discord-platform.md`).
- Wire fields `flags=4`/`allowed_mentions` vs `unfurl_links/media`: unify the *option name* (item 2), not the payloads.
- Bluesky's no-edit → `EditRateLimited` fallback (`bsky.py:133-135`) and its `atproto` optional dep — keep out of `_http.py`.

## mgu's stake

Item 1 lets mgu drop `curl` from its job image again and makes the Slack digest's transport as resilient as the Discord one. Item 2's kwarg rename touches `gcs_usage/weekly.py` and `digest.py` (`DiscordWebhookClient(..., suppress_embeds=)`), so flag it before landing; mgu pins thrds by commit and will bump. Item 5(b) lets mgu delete `discordify()`'s emoji rewrite; 5(c) doesn't affect mgu (no `#slug` refs in its docs).
