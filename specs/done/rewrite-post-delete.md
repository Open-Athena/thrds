# Rewrite plans: `post` and `delete` actions

From disky's r2 session (2026-11-27), for disky's `specs/digest-thread-variant.md` phase 2: switching a digest thread between reply styles from an admin page. That posts a new set of replies into a thread and deletes the old set, which isn't 1:1, so `edit` and `repost` can't express it.

Done in Python (`thrds.rewrite`) and TS (`src/rewrite.ts`, `src/rewrite-slack.ts`, `PlanView`), with one plan format: `tests/fixtures/rewrite-plan-switch.json` (ts) is written by `scripts/rewrite_ts_fixtures.py` and planned identically on both sides.

## Actions

Two action kinds in the rewrite plan (`thrds_rewrite_plan` 1; a reader without them refuses the kind):

- `post`: a new message, from `plan(found, render, posts=[Post(channel, thread_ts, Desired(…), key=None, broadcast=False, metadata=None)])` (TS: `plan(found, render, { posts: [{ channel, threadTs, desired, key? }] })`). Posts follow the found messages' actions, in the order given. `old` is `null`; `new` carries text / blocks and the sender override, as `repost`'s does, through `sendable` (so a post Slack can't take is `blocked`, like an edit). `hash` is the new content's.
  - **Its id is its key, carried in the action's `ts`** (and the outcome's, the receipts', `only` / `ids`), until it has a ts: every place that keys by ts takes a post unchanged. The key is the app's (`wk-2026-10-27`), or `post-<content hash>` with `-2`, `-3`… for repeats, so a re-plan of the same content keeps it. A ts-shaped key (`\d+\.\d+`) or one already in the plan is refused at planning; `Plan.from_json` / `parsePlan` refuse plans whose actions share an id.
- `delete`: an existing message, from `render` returning `Delete(reason=None)` (TS: `{ delete: true, reason? }`). `{ts, old, hash}`, `new: null`. `blocked` for a message with replies (they'd orphan); another author's message is `blocked` before `render` runs, as for every kind.

## Apply

- **Order:** `apply_order` / `applyOrder`: the plan's order, with every `delete` after every other write. A digest's rule: a failure leaves a duplicate, never a loss.
- **Holds:** in a real run, a `post` that doesn't end `done` / `receipt` holds the rest of the run's deletes: `pending`, error `held: post <keys> not done`. With the plan flag `delete_after_posts: true`, a delete also waits for every `post` in the plan, by receipt, across runs and batches (a page sends 10 ids per request). A dry run never holds: it checks each delete against its message.
- **Receipts:** a post's receipt records its `new_ts`. A re-run reports it as `receipt` with that `new_ts` (the spec draft said `already`; `receipt` is what every kind's earlier-run outcome is). A real run with posts and no receipts raises, so a re-run can never post twice. `RewriteReceipts.done()` (TS) is now a `Map` of id → posted ts; `d1Receipts` reads it with `json_group_array` (no `all()` added to `D1Like`).
- **Post checks:** `gone` when its thread's parent is gone; `failed` for a sender override on a user token. **Delete checks:** `gone` if already deleted (also when `chat.delete` says `message_not_found`); `stale` if its hash moved or it now has replies.
- **`posted`:** `Report.posted` / `postedOf(outcomes)`: each post's key → its ts (done now or by receipt), so the app can write its own state. `rewriteHandler` and `slck rewrite review` return `{outcomes, posted}`.

## Review (`PlanView`)

- A `post` row shows only the new message ("New"); a `delete` row only the old one, struck (`tpv-struck`). Rendered / Diff toggles only on edits and reposts.
- The header reads the writes' counts (`writesSummary`): "2 to post · 5 to delete". The `post` / `delete` filter chips show only when the plan has them.
- Selection goes to `onCheck` / `onApply` in `applyOrder`; `postRewrite`'s doc says to pass ids in that order.
- An `atomic` plan (`plan(…, atomic=True)`) has no per-row selection: "All N: this plan applies as a whole". The confirmation names how many deletes can't be undone.

## Tests

- Python `tests/test_rewrite_post_delete.py`: planning (kinds, JSON round-trip, keys, a delete with replies, a post over Slack's limits), `from_json` checks, the preview text, apply order with receipts and a re-run, a failed post holding the deletes, `delete_after_posts` across runs, stale / gone deletes, a post into a gone thread or with an override on a user token.
- TS `tests/rewrite-slack.test.ts` "post and delete": parity with the Python plan, the same apply cases, `d1Receipts` keeping a post's ts, and `rewriteHandler` taking post keys and returning `posted`. `tests/rewrite.test.ts`: `parsePlan` checks, `applyOrder`, `postedOf`, `writesSummary`. `tests/plan-view.test.tsx`: post / delete rows, the header, atomic, chips hidden without posts / deletes.
- Checked in Chrome on `slck rewrite review`'s page over a fake thread switch (5 deletes, 2 posts): check, then apply; a failed post held all five deletes; atomic applied whole, posts first by receipt.
