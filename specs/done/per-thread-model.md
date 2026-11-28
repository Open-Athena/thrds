# One file per thread, per-thread destinations, and staging-only chrome

Design settled with Ryan over a live session (2026-08-17) while drafting CoreWeave-cleanup replies in `#cw-quickwins`. The current model held up fine for the original use case and broke down on this one; this spec is the generalization that covers both.

## What broke

thrds was built for **#oa-amazon-trainium**: draft 6 top-level messages (plus replies) locally, then batch-post them to *one* channel. That shape is encoded in the current design:

- one doc `.md` holds **many threads**, separated by `===` (with `+++` for replies within a thread);
- `thrds.json` carries a single session-level `prod_channel`;
- `push --prod` pushes **the whole doc** to **one channel**, then auto-archives the staging PC.

Today's use was different: iterating on replies to *other people's* messages, whack-a-mole, as new threads appeared — potentially across `#marin-eng` and `#marin-alerts`. Three drafts accumulated in one staging PC, each destined for a **different** target. The existing model has nowhere to put that, and `push --prod` would have fired all three — including two that weren't ready — at a single channel, then torn down the scratchpad.

A second problem surfaced in the same session: with N threads in one file, the gist's git history interleaves unrelated drafts, so a commit reads as "the doc changed" rather than "*this message* went v2→v3". Since the gist history **is** the artifact — these sessions are being collected as voice examples for `$c/voice` — that conflation is the costly part.

## Model

```
private ephemeral channel (PEC)  ↔  gist  ↔  thrds session  ↔  N threads
                                              thread  ↔  one tracked file
```

- **Session** = one PEC + one gist + one local dir. Unchanged.
- **Thread** = one Slack thread (an OP plus its replies) = **one file**, `NN-slug.md`. `+++` still separates replies *within* the file, since replies genuinely are one thread's content. `===` goes away.
- Numbering gives deterministic ordering for the batch case and costs nothing for the reply case.

The payoff: per-file git history is exactly that message's revision trajectory, which is what a reader of the examples wants.

## Per-thread destination

The unifying insight: **destination is a property of the thread, not the session.** That collapses both use cases into one shape.

```jsonc
// thrds.json
"threads": {
  "01-cw-quickwins": {
    "staging_ts": "1786840558.331079",
    "target": { "channel": "#marin-alerts", "thread_ts": "1786980761.357209" },
    "state": "draft"
  },
  "02-cw-mpu": {
    "staging_ts": "1786983442.254669",
    "target": { "channel": "#marin-alerts" },   // no thread_ts → top-level post
    "state": "ready"
  }
}
```

- trainium: 6 threads, all `{channel: "#oa-amazon-trainium"}`, no `thread_ts`. The batch case stops being special.
- today: 3 threads, 3 different targets, some replies.

Session-level `prod_channel` becomes a *default* for new threads, not the authority.

## Prod push is per-thread, never whole-doc

`push --prod` must not exist in its current form. Replace with an explicit, single-thread verb that:

1. resolves the target from the thread's metadata (erroring if unset);
2. prints the resolved destination and the exact rendered body;
3. posts only that thread;
4. **does not** archive the PEC (other drafts are still live).

Archiving becomes its own deliberate verb once every thread is `posted` or `dropped`.

## Ready-state

Moved to `specs/reactions.md` (§3) on 2026-11-28: not built, and it's the same OP-reaction machinery as that spec.

## Staging-only chrome

Two things should be visible in staging and absent from prod:

1. **Gist link** — a subtle `⤴` linking to the gist, so the versions being captured are auditable from Slack. Include the thread's **file basename**, which is meaningful now that thread↔file.
2. **Target link** — a user-visible pointer to the message this drafts a reply to. Editable in Slack, which makes "rebase this draft onto another message" just an edit that `pull` captures as a version.

**Both live in metadata, never in doc content.** Rationale: the prod body is then byte-identical to what was reviewed, with no strip-step that could fail open and publish a secret-gist URL. Render them at push time as a Slack **context block** — structurally distinct from body text, so `pull` can discard them reliably rather than text-matching.

```jsonc
"staging_chrome": { "gist_link": true, "target_link": true, "style": "context_block" }
```

## `pull --write` semantics

Already correct and worth pinning down: `pull --write` reconstructs the doc from Slack's current state and auto-commits to the gist. Consequences to preserve:

- Editing a message in Slack → next pull captures it as a version.
- **Deleting a reply in Slack → the deletion is captured as a version too.** That's how a draft gets retracted without losing the record that it existed.
- Chrome (above) is stripped on pull and never round-trips into content.

## Migration: replay the trainium gist

The trainium gist should be ported to the new layout, and — settled after some back-and-forth — **history rewrite is the right call here**, contra the usual instinct.

The argument: this is a *format* migration, not a content or version rewrite. Every version's content is preserved exactly; only its distribution across files changes. And the audience matters — someone reading these as voice examples should not have to learn an obsolete `===`-multi-thread-per-file syntax to parse the history. thrds' internal bookkeeping evolution is not the lesson being compiled.

Mechanically: replay each commit, splitting the doc into `NN-slug.md` per thread, preserving commit message, timestamp and author; force-push. Retarget metadata can be backfilled to the single channel it used.

## Open questions

- Does `state` belong in `thrds.json`, or is the Slack reaction the single source of truth (with `thrds.json` a cache)? Slack-as-truth is more robust to hand edits but requires a fetch to know state.
- Should `posted` threads keep their staging message (with a link to the prod one), or be marked and left alone? Leaning: keep and annotate — the staging thread is the trajectory.
- Multi-channel sessions: is one PEC per *topic* right, or should a session be able to span channels freely? Today's case suggests topic, and the destinations just happen to differ.

## Final state (2026-11-28 triage)

Landed (`1e8f473` → `0e5b1f4`): one file per thread (`thrds/threadfile.py`), per-thread destinations (now `ThreadEntry` remote pointers, `thrds/state.py`), prod push per thread (`promote`; `push --prod` refused on per-thread sessions), `archive` gated on pending threads (plus `drop` / `reopen`), staging-only chrome with the gist and target links (a footer line rather than a `context` block), chrome edits in Slack retargeting or renaming (`pull_chrome_edits`), and `slck migrate` / `slck replay`.

Open questions, as answered: posted threads keep their staging copy, annotated with a ✅ permalink (`specs/done/chrome-condense-posted.md`); `state` stays in `thrds.yml`. The ready-state section moved to `specs/reactions.md`.
