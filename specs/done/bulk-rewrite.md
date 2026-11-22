# Bulk rewrite: find a bot's messages, re-render them, review the diff, apply

From disky (2026-11-22, Ryan): a deployment changes how its Slack posts look (an emoji vocabulary, a label, a layout) and wants every message that carries the old look brought up to date, reviewed first. disky already re-renders some of its own messages from data (the digest's `/api/digest-reapply`, the scan-run threads' converge, the fleet post's hourly edit), each with its own ad-hoc preview. thrds should own the generic part: plan → review → apply over existing messages, with a preview UI an app can extend.

## Shape

thrds already splits planning from applying (`migrate.py`: `plan_migration` pure, `apply_migration` effectful) and computes per-message actions with a formatted preview (`sync(…, dry_run=True)` → `SyncResult.actions`). This generalizes that to messages thrds didn't post itself, chosen by the app.

1. **Find** (`Finder`): the messages in scope, from the platform. Built-ins: a channel's history (with `oldest`/`latest`), a thread's replies, an explicit list of ids. Ownership: only the app's own messages (bot id, never the per-message `username`, which custom senders change). Each found message carries its current text, blocks, sender (`username`, icon) and its thread.
2. **Render** (app code, pure): `render(found) -> Desired | Skip(reason)`. The app re-derives the message from its own data or rewrites the text (e.g. a substitution map); thrds doesn't guess.
3. **Plan** (pure, serializable JSON): per message one action:
   - `edit`: text and/or blocks change; the sender is unchanged.
   - `repost`: the desired sender differs (Slack can't change `username`/`icon_*` with `chat.update`): delete + post. Refused for a message with replies of its own (they'd orphan) and for a thread head unless it's the channel's newest thread (reposting moves it); those become `blocked(reason)`.
   - `noop`, `skip(reason)` (the app's), `blocked(reason)` (Slack can't: another app's message, too old to edit where a platform limits that, a file share under a custom sender, …).
   A plan records each message's current content hash, so apply can refuse a message that changed since planning (`stale`).
4. **Review**: `Plan.format_preview()` (terminal, as `SyncResult`) and a JSON form for a UI: per action the old and new text (and a rendered form per platform: Slack mrkdwn → HTML), a text diff, and the sender change.
5. **Apply**: the plan's actions in order, rate-limited (Slack tier 3 for `chat.update`), resumable (a receipt per action, so a re-run skips what's done), each checked against its content hash first. Dry run by default; applying takes an explicit flag. A report: done / stale / failed per message.

## Surfaces

- Library: `find`, `plan(found, render)`, `apply(plan, …)`; the plan is a dataclass with `to_json` / `from_json`.
- CLI: `thrds slack rewrite plan --channel C… [--thread TS] [--oldest …] --render MODULE:FN -o plan.json`, `thrds slack rewrite show plan.json`, `thrds slack rewrite apply plan.json [--yes]`.
- UI: the preview server (`thrds/preview`) gains a plan view: the actions list with filters (edit / repost / blocked / skip), each with side-by-side rendered old/new and a text diff, and select-and-apply. The bundle stays prebuilt package data. For apps that embed it: a React component package (`PlanView`) with slots for the app's own renderers (e.g. a custom card for a message kind) and an `onApply(selected)` hook, so an app's admin page can host the same view behind its own auth and call its own backend (which runs `apply`).

## Out of scope here

The app's data and its `render`. Which messages an app may touch beyond "its own". Scheduling.

## Open

- Discord: same model (webhook messages edit by webhook; a bot's by the bot); repost is cheaper (no thread-order concern in channels with threads as objects) but has its own limits.
- Large channels: `find` pages through history; a plan over thousands of messages should stream to the UI.

## Phase 1, implemented (Python, `py`): library + CLI

`thrds/rewrite.py`, `thrds/rewrite_cli.py` (mounted as `thrds slack rewrite` / `slck rewrite`), `tests/test_rewrite.py` (17 tests, against a stateful fake channel), README "Bulk rewrite (Slack)".

- **Find**: `find_history(client, channel, oldest=, latest=, include_replies=, include_foreign=)`, `find_thread`, `find_ids`. `Found` has `content` (`Content`: wire `text`, `blocks`, `Sender`, file ids), `thread_ts` (a reply's parent, else `None`), `ours` (bot / user id), `last` (newest in its channel's top level or its thread, read separately when `latest` bounds the history), `reply_count`, `subtype`, `metadata`, `raw`. A `bot_message`'s sender is its `username` plus `icons.emoji` or an `icons.image_*` URL; a plain post has no override.
- **Render**: `Desired(text, blocks=None, sender=None)`: `blocks=None` means text only (an edit sends `blocks: []`), `sender=None` keeps the sender. `Skip(reason)`. Built-in `substitute(mapping)`: replaces in the text and in the blocks' strings, renames `emoji` elements (`:a:` → `:b:`), and drops blocks that are only `rich_text` so Slack re-derives them. Anything else from `render` raises `TypeError`.
- **Plan**: `plan(found, render, reorder_ok=False)`. Comparison ignores `block_id`s, and a text-only `Desired` matches live `rich_text`-only blocks (`same_content`). `blocked` reasons: another author, a non-post subtype, text over 4000 chars, and for a sender change: replies (orphans), not last in its container (unless `reorder_ok`; this rule covers replies too, not just thread heads, since a reposted reply also moves to the thread's end), files under a new override. `render` isn't called for blocked authors. `Plan.to_json` / `from_json` (versioned `thrds_rewrite_plan: 1`; a recorded `hash` that doesn't match the action's `old` raises), `save` / `load`, `format_preview(kinds=)`, `review_json()` (adds each action's text diff and the counts: the UI's input).
- **Apply**: `apply(plan, client, dry_run=True, only=, receipts=, pace=1.2, jitter=, on_outcome=)`. Per action: re-read the message (`conversations.replies` by ts), then `gone` / `already` (it shows the new content) / `stale` (hash moved; for a repost also: it gained replies, or it's no longer last) / `pending` (dry run) / `done` / `failed` (Slack's error code) / `undeleted` (repost posted but the delete failed). A repost posts first, then deletes: a failure leaves a duplicate, never a loss. It carries the old message's `metadata`, `reply_broadcast` for a broadcast reply, and re-attaches files by `chat.update` `file_ids` (only possible without an override). A sender override on a user token fails (Slack would drop it). Receipts are JSONL, appended per outcome on a real run; a re-run skips `done` / `already`.
- **CLI**: `plan -c CHANNEL [-t TS | -i TS… | -a OLDEST -b LATEST -w] [-f] [-m] (-s OLD=NEW… | -r MODULE:FN | -r FILE.py:FN) [-o plan.json]`; `show PLAN [-k KIND…] [-j]`; `apply PLAN [-y] [-i TS…] [-p PACE] [-r RECEIPTS]` (receipts default `PLAN.receipts.jsonl`; exits 1 on `failed` / `undeleted`). The plan's actions must be in one channel.

## Phase 2, implemented: the review UI

Decided (Ryan): one source, in React on the `ts` branch, vendored here.

- **`ts`** (`1752583`, `200dd56`): `src/rewrite.ts` types the plan JSON (`RewritePlan`, `PlannedAction`, `RewriteContent`, `RewriteOutcome`, …) with `parsePlan`, `planCounts`, `writes`, `senderChanged`, `describeSender` and an LCS `lineDiff`, exported from the root. `@open-athena/thrds/plan-view` exports `PlanView`, with React ≥ 18 as an optional peer that's kept external:
  - kind chips (all but `noop` at first) and a text / ts filter;
  - per row: the message before and after, rendered as Slack would (`SlackMessage`: mrkdwn and Block Kit as React elements, no raw HTML), or by the app's `renderContent(content, side, action)` when it returns something; a Rendered / Diff toggle; the sender change; the outcome;
  - selection of edits and reposts, `onCheck` (dry run) and `onApply`, with an in-view confirmation. The view never writes itself, so it can sit behind an app's auth;
  - `emoji` map (custom emoji URLs), `messageHref`, `PLAN_VIEW_CSS` (`tpv-` classes, light and dark), `unstyled`.

  DOM typing lives in `tsconfig.plan-view.json`, so the main tsconfig keeps Node's `fetch` types. `pnpm build:review` bundles the standalone page (`src/plan-view/review.tsx` + `review.html`, React included) into `dist/review/`, outside `build`, so npm consumers don't get it.
- **`py`**: `thrds/rewrite_review/` vendors that bundle (`dist/`, `BUNDLE_PROVENANCE`) and serves it: `GET /plan` (the review form), and `POST /check` / `POST /apply` (`{"ids": [...]}` → `{"outcomes": [...]}`). Those take only the plan's edit / repost ts, require `Content-Type: application/json` and a same-origin `Origin`, and bind 127.0.0.1. `slck rewrite review PLAN [-p PORT] [-r RECEIPTS] [-O]` (default port 3078) creates the Slack client on the first check or apply, using the same receipts as `apply`. Tests: `tests/test_rewrite_review.py`. Checked in Chrome against a fake channel: render, diff, check, select, confirm, apply, and phone width.

Still open: Discord, streaming for very large plans, and TS parity for find / plan / apply (only the plan types are in TS today; disky's digest uses Python).
