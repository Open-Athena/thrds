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
