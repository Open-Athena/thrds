# Model reactions: self-reactions as desired state, others' as read-only mirror

thrds currently treats reactions only as a repost guard (`SenderChangePolicy.lose_reactions_ok`). They deserve first-class treatment, split by what the API permits:

## 1. Own reactions = desired state (push/promote converges them)

`reactions.add`/`reactions.remove` are self-scoped — you can only manage your own. That is exactly the reaction-poll use case: seed `1️⃣…9️⃣` on a poll message, iterate on the set while drafting, and have push/promote apply it automatically instead of hand-tapping nine emoji after every repost.

- **File syntax**: per-message trailing directive, invisible in rendered md:

      <!-- reactions: one two three white_check_mark -->

  HTML comments don't render in gists, are unambiguous to parse, and are stripped before the wire text. Accept Slack emoji names and/or unicode glyphs (the `emoji` dep already maps both ways).
- **Sync**: after content converge, converge each message's self-reaction set — add missing in listed order (fresh messages therefore display in seed order), remove extras. Idempotent; dry-run lists `REACT +one -two` actions in the plan preview.
- **Scopes**: needs `reactions:write` (new); `reactions:read` is already used by the repost guard.

## 2. Others' reactions = read-only mirror (pull records them)

Foreign reactions can't be pushed, but they're often the *record* — the 2026-08-19 promote incident permanently lost the 👍 approvals on a deleted message; a mirror would have preserved at least the evidence. On `pull`, store observed reactions (name → count, and user list for small counts) per posted message in `thrds.json` (not in the content files — they're not desired state). Surface them in `status` output.

## 3. Ready-state on the OP: reactions, and `@ThrdsBot` for anything with arguments

Moved from `specs/done/per-thread-model.md` (2026-11-28); not built. It needs the same `reactions:write` scope and OP-reaction reads as §1.

Two complementary controls, because they're good at different things.

**Reactions** carry one bit of state, out-of-band from content, so they never pollute the doc or risk leaking into prod, and a human can set them by hand:

- 🔴 draft / not ready
- 🟢 ready to push

Reactions attach to the thread's **OP**. 🟢 should **arm, not fire** — the watcher resolves destination + body and asks for confirmation. An accidental tap must never publish.

**Mentions** take arguments, which reactions can't:

```
@ThrdsBot push
@ThrdsBot retarget #marin-eng
@ThrdsBot retarget <permalink>     # rebase this draft onto another thread
@ThrdsBot archive
```

Posted as replies in the staging thread, so the instruction itself is visible history. Support both and let people use whichever fits their habits.

No hosted bot required: a `thrds slack watch` poller keeps this a CLI with no infra to run.

## Non-goals

- Re-creating foreign reactions after a repost (impossible).
- Treating reactions as message *content* for diff purposes — content sync and reaction sync stay separate phases.
