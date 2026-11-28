# `promote` must be append-only in threads it doesn't own

## Incident (2026-08-19, #marin-alerts thread `1786980761.357209`)

First real `slck promote` (`grug-deleted`, session `cw-quickwins`) into an existing ops thread **edited one prior message and deleted three others**, all posted earlier with the same user token (two previously-promoted slugs + one manually-posted confirmation carrying approval reactions, which are unrecoverable). Foreign users' messages were untouched.

Three compounding bugs:

1. **`promote_thread` converges the whole target thread.** It calls core `sync(desired, thread_ts=target.thread_ts)`; the only guard is `editable=False` on *other users'* messages. Every message our token ever posted in that thread is "ours" to reconcile, so with `desired = [1 message]` the algorithm edited the first and deleted the rest — exactly its spec. The docstring's model ("the other person's messages are left untouched") never considered *our own* prior messages in the thread.
2. **`promote -n` never computes a plan.** The CLI prints the draft body and returns *before* calling `promote_thread`; `dry_run=True` + `SyncResult.format_preview()` exist but are never used. The confirmed real run was the first time the converge ever saw the thread, and it printed no actions either.
3. **`posted_ts` recorded the thread root** (`result.thread_id`), not our new message — contradicting `ThreadEntry.posted_ts`'s own docstring — so `posted_url` pointed at the foreign OP.

## Fix

1. **Scope the reconcile to the slug's own messages.** New `SyncOptions.only_ids: set[str] | None` — when set, messages not in the set are treated like foreign ones (preserved in place, never counted against desired slots). `promote_thread` passes:
   - replying into an existing thread (`target.thread_ts` set): `only_ids = set(entry.posted_msg_ts or legacy)` where `legacy = [entry.posted_ts]` if it's a real our-message ts (not equal to `target.thread_ts` — bug 3 wrote roots), else `[]`. First promote ⇒ empty set ⇒ **append-only**.
   - own new-thread promote: `None` (the whole thread is this slug's; foreign replies are already protected).
2. **Track per-slug message ids.** `ThreadEntry.posted_msg_ts: list[str]` — written from `result.message_ids` on every real promote; the whitelist for re-promotes. `posted_ts`/`posted_url` = first of ours, not the root.
3. **CLI shows the plan before anything fires.** `promote` always runs `promote_thread(dry_run=True)` first and prints `format_preview()` (SKIP/EDIT/POST/DELETE with diffs). `-n` stops there; otherwise confirm, then the real call. `-y` skips the prompt but never the plan.

## Follow-ups (not this change)

- `promote --no-finalize` (or per-thread `finalize_terminal`) to leave the staged copy editable after posting, saving a `reopen` when edits are expected.
- Notify/DM path unchanged.

## Restoration runbook for the damaged thread (after this fix ships + is trusted)

Slack cannot re-insert messages at historical ts (server-assigned, identity == position), so:

1. Edit the surviving slot `1786986608.845949` (currently vandalized with the 05 body) to the **concatenation of the original 02 + 03 content** (sources: gist mirror `02-cw-summary.md`, `03-cw-mpu.md`; staging copies hold the exact mrkdwn).
2. Re-post 04 (`04-cuda-graph.md`) at thread end with a note that it's a re-post after a scripting error deleted the original (original approvals: Russell/Matt in-thread messages still stand; the reactions are gone).
3. Post 05 (`grug-deleted`) properly — as a plain new reply.
4. Correct `thrds.json`: `grug-deleted.state` back to `draft` until 3 lands; fix `posted_ts`/`posted_url` fields that recorded the thread root.

## Final state (2026-11-28 triage)

All three fixes landed: `SyncOptions.only_ids` scopes the reconcile (`thrds/core.py`, computed in `promote_thread`), our own message ids are recorded (now `RemotePointer.msg_ts`), and `promote` always prints its plan first. Tests: `tests/test_promote_foreign_thread.py`, `tests/test_promote_cli.py`. The `posted_ts`-records-the-root bug was fixed in `32c4c72`.

Not built: `promote --no-finalize` (only the session / remote-level `StagingChrome.finalize_terminal` exists). The restoration runbook was an operations step, not code.
