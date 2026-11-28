# Rewrite plans: `post` and `delete` actions

From disky's r2 session (2026-11-27), for disky's `specs/digest-thread-variant.md` phase 2: switching a digest thread between reply styles from an admin page. That posts a new set of replies into a thread and deletes the old set, which isn't 1:1, so `edit` and `repost` can't express it.

## Actions

Add two action kinds to the rewrite plan (`thrds_rewrite_plan`, Python and TS):

- `post`: a new message. `{channel, thread_ts, desired}`: `desired` carries text/blocks and the sender override, as `repost`'s does. Its id is a plan-assigned key (no ts yet), stable across a re-plan of the same desired content.
- `delete`: an existing message. `{ts, old, hash}`: `old` is the content shown in review, and `hash` is checked before deleting, as for `edit`. `blocked` for a message with replies of its own (orphans) and for another author's message.

## Apply

- Order within a plan: every `post` before any `delete` (the digest's rule: a failure leaves a duplicate, never a loss). Add a plan flag `delete_after_posts: true` so a `delete` runs only if every `post` in the plan is `done` or `already`. Without the flag, a failed post still stops the deletes.
- `post` receipts record the new ts. `already` for a `post` means a receipt exists, since there's no message to compare against before it is posted. A re-run never double-posts.
- `delete`: `gone` if the message has already been deleted; `stale` if its hash moved.
- The outcome report gains `posted` (key → ts) so the app can write its own state.

## Review (`PlanView`)

- `post` rows show only the new side, and `delete` rows show only the old side, struck. Filters gain both kinds. Counts in the header read, e.g., "5 to post · 27 to delete".
- Selection: an app can mark a plan `atomic` (the digest's will be), in which case the view selects all or nothing, since a partial switch (some deletes without their posts) is what the ordering rule exists to prevent.

## Tests

Plan round-trip with the new kinds; ordering and `delete_after_posts` (a failed post leaves every delete `pending`); receipts make a re-run skip `done` posts; `PlanView` renders and filters both kinds; `rewriteHandler` caps requests per batch (`maxBatch`) with posts counted.
