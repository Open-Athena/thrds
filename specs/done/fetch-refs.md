# `fetch` + remote-tracking refs: give Slack a merge base

Slack channels are pseudo-remotes: mutable shared state with no version tracking, no compare-and-swap, and no way to ask "has this changed since I last looked?" other than reading it. A thrds session dir is already a git repo, so we can supply the missing half locally — a ref recording *our view* of each pseudo-remote, exactly as `origin/main` records our view of a real one.

Modeled on [`ghpr`]'s `refs/ghpr/remote` + `ghpr fetch` ([`d119a07`]), which solved the same problem for GitHub PRs. Two things below go beyond it; they're marked.

## Why

Three concrete defects today, all the same root cause — nothing records what Slack last looked like:

1. **`pull` clobbers.** `cli.py:806` is an unconditional `tf.path.write_text(text)` with no dirty-worktree check, followed by `_autocommit`. Uncommitted local edits to a thread file are destroyed silently, recoverable only from the nested repo's reflog by someone who noticed.
2. **`diff` can't say which side moved.** It reports local-vs-Slack and calls it "what `pull` would change", but a hunk is equally "Slack edited this" and "you edited this and `pull` is about to eat it". Those want opposite actions. With a base, the same comparison becomes three-way: local-only (push it), remote-only (pull it), both (conflict).
3. **`push` has no upstream gate.** It writes to Slack without ever establishing that Slack still looks the way we last saw it. This is the guarantee a real git server gives for free — a non-fast-forward rejection — and it is the one we most want, because our writes include `chat.delete`, which Slack cannot undo. The 2026-08-19 promote incident permanently lost approval reactions.

## Refs

Under `refs/remotes/<platform>/`, not `refs/thrds/`:

    refs/remotes/slack/staging     what staging says (draft threads)
    refs/remotes/slack/prod        what each target says (posted threads)
    refs/remotes/slack/remote      the composite `pull` reconciles onto

Reason for the namespace: git only auto-enables reflogs for `refs/heads`, `refs/remotes`, `refs/notes`, and `HEAD`, so a ref under `refs/thrds/` would silently have no history of its own movements — and "what did Slack look like before this fetch" is precisely what we want recoverable. Under `refs/remotes/` we also get `git branch -r`, `git log slack/staging`, and `git diff slack/staging HEAD` for free, all reading exactly as what they are. Cost: `git remote` won't list `slack`, since there's no config section for it (deliberately — a URL-less remote would break `git fetch --all`). `<platform>` generalizes to `discord/`, `bsky/`.

None is ever checked out.

**The composite is the merge base; the sources are for diagnosis.** Never rebase onto staging or prod individually: drafts exist only in staging, posted threads are canonical in prod (`e62fa81`), so each source tree is partial. `slack/remote` is their union under the precedence `pull` already applies, and it's the only ref for which `slack/remote..HEAD` means "local commits Slack hasn't seen". The sources are nearly free — `fetch` already makes both API calls separately (`pull_threads_staging` / `pull_promoted_threads`) — and they buy `git diff slack/staging slack/prod -- 04-cuda-graph.md`: *has the frozen staged copy drifted from what's live?*, which is the promote-incident class of question.

The gist stays a genuine remote (`refs/remotes/g/main`). So: `g` is the mirror we push, `slack/*` is the pseudo-remote we fetch.

## `fetch`

    slck fetch [-n]

Build a commit whose tree is Slack's current state, parented on the current ref; advance the ref. Never touches the working tree, index, or branch. `-n` reports without advancing.

No `--staging` / `--prod`: a partial fetch would leave the composite describing a mix of two moments, and the composite is the thing `pull` reconciles against. Both sources are read on every fetch — `pull` already makes both API calls — and all three refs move together.

**Nop semantics.** The comparison is content equality of the projected tree: stage the rebuilt files, and commit only if `git diff --cached` is non-empty. So `fetch` is a nop iff Slack projects byte-identically to what we last recorded, and otherwise the ref moves and there is an implied commit whose diff *is* the remote delta — `git diff slack/remote@{1} slack/remote`, or `git show slack/remote`. That is the model asked for, and it's what ghpr already does.

One honest limit: content equality means a remote change that projects to the same markdown (an edit reverted before we looked, whitespace Slack normalizes away) is indistinguishable from no change. That's the right call — content is our unit of concern — but it is not the same as a version token, and no Slack API offers one.

**Bootstrap** for sessions predating this: don't assume `HEAD == remote` the way ghpr's `ensure_remote_ref` must. We can just look. The first fetch builds the observed tree and commits it *parented on HEAD*, so `slack/remote..HEAD` is empty (nothing to replay, correct for a bootstrap) and history stays connected. Honest from the first command, no warning banner needed.

**Bootstrap divergence (lesson from ghpr, 2026-08-21).** ghpr implemented its version of the above and found the sharp edge: when local and remote *already disagree* at bootstrap, there is no base and the ambiguity is symmetric — "remote is ahead" reverts unpushed local work; "local is ahead" pushes a stale HEAD over a newer remote. Neither guess is safe, so ghpr refuses to invent one: it adopts the guess only when the first fetch comes back identical to HEAD (the guess is *confirmed* — the common case), and otherwise errors with the ref left unset, naming the two explicit resolutions (`pull -m overwrite` = remote wins; `push` = local wins), both allowed through as deliberate statements of authority.

thrds' overlay composite narrows this but does not eliminate it: the bootstrap snapshot records Slack's threads over HEAD's tree, so a first `pull`'s three-way merge (base = that snapshot, ours = HEAD, theirs = re-fetch) sees a local edit as ours-vs-base and keeps it — the merge mechanic, unlike a commit-range rebase, doesn't need the base to predate the divergence. But it resolves the ambiguity silently in *local's* favor, which is still a guess. Step 3 should follow ghpr: per thread, if HEAD and the bootstrap snapshot disagree, refuse with the two named outs rather than auto-preferring either side. (thrds also has evidence ghpr lacks: the last `thrds: push/pull staging` auto-commit in session history *is* an observation of Slack at that time and could seed a real base. Worth considering in step 3; not assumed here.)

## `push`: the upstream gate

**New — ghpr does not do this, and should.** Its `push` only advances the ref (`push.py:478`, gated on "was anything held back"); nothing refuses when the remote moved underneath.

`push` begins with an implicit `fetch`. Then:

- **If the fetch moved the ref**, Slack has state we haven't merged. Refuse, naming the threads: `03-cw-mpu.md changed in staging since your last pull`. `slck pull` to reconcile, or `--force` to overwrite deliberately.
- **If the ref is not an ancestor of `HEAD`**, local history diverged from the recorded remote (a `reset --hard` past it, a rebase that dropped it). Refuse. Cheap to check, rare, and silent corruption otherwise.

**Detect per thread; refuse the whole push.** Compute the refusal set precisely — `git diff --name-only <old-ref> <new-ref>` ∩ the paths this push would write — because that's what makes the error message actionable (`03-cw-mpu.md moved in staging; 01, 02 are clean`). But having computed it, refuse *everything*, rather than pushing the clean threads and holding back the moved one.

Partial application is wrong here for two reasons. The weaker one is least surprise: `slck push` means "make Slack match my working tree", and half-doing that while reporting success has no honest answer to "did my change land?". The stronger one is that threads are not actually independent — `refs.py` resolves `[text](#slug)` cross-refs between them, so pushing `01` while holding back `03` can publish a link whose target doesn't yet say what the link promises. A commit that touches both threads means both, and the gate shouldn't quietly decide otherwise.

The escape hatch is explicit, not implicit: `slck push <slug>...` to deliberately scope a push to a subset, and `--force` to overwrite a moved thread on purpose. Both are the user saying "yes, partially" — which is fine — rather than the tool assuming it.

## `push`: post-write verification

**Also new.** ghpr advances the ref to `HEAD` — i.e. to *assumed* remote state. For thrds that's wrong twice over.

First, our writes are a *projection*, not a copy: Slack normalizes mrkdwn, resolves emoji, adds unfurls, and holds things thrds can't represent (foreign messages, reactions). So `HEAD` is never exactly what Slack now contains, and recording it as such guarantees the next `fetch` reports a spurious remote-only delta — which then makes the nop-on-unchanged property, and therefore the push gate built on it, cry wolf on every cycle.

Second, recording assumed state is the same error ghpr's "don't advance if anything was held back" rule guards against, generalized: the ref's whole value is that it's a truthful record.

So `push` ends by re-reading the threads it touched and advancing the ref to the **observed** projection. Cost is one `conversations.replies` per touched thread — proportional to the write, not to the session. If observed differs from intended, say so on stderr (that's the interference signal) but still record observed. Truth over intent; the delta shows up in the next `diff` either way.

This makes "a fetch right after a push is a nop" actually hold, which is what the gate needs.

## TOCTOU

There is no server-side CAS, so we cannot be atomic; we can only narrow windows and make detection reliable after the fact.

- **Narrow:** the implicit fetch immediately precedes the write, so the window is the push's own duration rather than "since you last ran something".
- **Detect:** post-write verification catches interference that landed inside the window, after the fact but before it can compound.
- **Refuse, where it's unrecoverable:** `DELETE` gets a stricter rule than the rest. Slack deletion is irreversible and takes reactions with it, so never delete a message whose current text differs from what the plan read — re-read immediately before the call and abort that action if it moved. `EDIT` is recoverable from our own history, so it gets the ordinary gate.

Cheap, and it's a second line of defense under the `only_ids` scoping fix — that one addressed a logic bug, this addresses the race.

## `pull` = fetch + reconcile

    slck pull [-n] [-m rebase|merge|overwrite]

Default `rebase`, overridable via `git config thrds.pullMode`. `slack/remote..HEAD` is the set of local commits Slack hasn't seen, so a rebase replays exactly those onto the fetched state.

`rebase` and `merge` **abort on a dirty working tree** rather than overwriting it, printing the `git rebase --onto <new> <old> <branch>` needed to finish by hand — the ref is already advanced, so manual reconciliation is always available. `overwrite` is today's behavior, retained explicitly and reporting how many local commits it discards plus the SHA they're recoverable at.

This is the fix for defect 1.

## `diff`, three-way

With a base, `slck diff` classifies each thread instead of merely showing a delta:

| `local vs base` | `remote vs base` | reported as |
| --- | --- | --- |
| — | — | unchanged (silent) |
| changed | — | local-only — `push` will send it |
| — | changed | remote-only — `pull` will apply it |
| changed | changed | **conflict** — both moved since the base |

Same output format as today (`diff_texts`, `NN-slug.md (local)` / `(slack)` headers); the classification is a one-line prefix per thread. This is the fix for defect 2, and it's the payoff that most directly upgrades work already shipped ([[per-thread-diff]]).

## thrds-specific divergences from ghpr

1. **`thrds.json` stays out of the mirrored tree.** ghpr's whole tree is content; ours carries state. Rebasing local commits onto a fetched `thrds.json` means merge conflicts in JSON, far worse than conflicts in prose. The refs track `*.md` only; state reconciliation stays as it is.

   Known gap, named rather than papered over: chrome-driven retargets and renames land in `thrds.json`, so those remain clobber-prone. Revisit if it bites.

2. **`promote` needs the same treatment as `push`.** It's per-thread and it's the verb that touches prod, so: implicit fetch of that thread's target, per-thread gate, post-write verification, and advance `slack/prod` only for the slug it converged.

3. **Legacy single-doc sessions** get the same refs with a one-file tree, or are simply excluded until migrated. Excluded is fine — `migrate` exists.

## Implementation notes (step 1, 2026-08-20)

Landed as `thrds/tracking.py` — not `refs.py`, which is taken by the cross-thread `#slug` resolver.

**Plumbing, not a scratch worktree.** ghpr needs one because it reuses the same file-writing code that normally targets the working tree. We build the projection ourselves, so `hash-object` / `mktree` / `commit-tree` suffice: nothing outside the object database and the ref is touched. That makes `-n` side-effect-free *by construction* rather than by remembering to honour a flag — which is the bug this whole design exists to prevent — and leaves no worktree to leak if we die mid-fetch.

**The composite overlays HEAD's tree; the sources stay sparse.** Caught by live-running against a copy of `cw-quickwins`, where `git diff slack/remote HEAD` reported `README.md`, `thrds.json` and two `emoji-*.png` as files HEAD had and the remote didn't. Cosmetic in a diff, fatal in step 3: `git rebase --onto slack/remote` replays commits onto that tree, so every file absent from it would be **deleted**. The composite is therefore "what the tree would look like after `pull`" — HEAD's tree with observed threads written over it, and threads Slack has dropped removed. Pruning is scoped to names that parse as thread files, so an unrelated file is never a removal candidate. The source refs stay sparse, because they're observations: `slack/prod` holds the posted threads and nothing else, since that's all the target channel has.

**The drift query is `git diff --diff-filter=M slack/staging slack/prod`.** The two sources are sparse in different ways, so a plain diff reports every draft as "deleted from prod". Restricting to files present in both leaves exactly the posted threads whose frozen staged copy has diverged from what's live.

**Reporting** distinguishes three cases, because "initialized" and "unchanged" are different facts: `initialized (N files)` / `initialized empty` on a first fetch (nothing to have changed *from*, so listing every file says nothing), `up to date`, or `N files (names…)`.

Verified live against a throwaway copy of `cw-quickwins` (remotes stripped, `THRDS_NO_PUSH=1`): `fetch -n` moves no ref, `fetch` creates all three, a second `fetch` is a clean nop on all three, HEAD and `git status` are byte-identical throughout, `git diff slack/remote HEAD` is empty, and `git reflog slack/remote` works — the payoff for the `refs/remotes/` namespace.

33 tests (`test_tracking.py`, `test_fetch_cli.py`); suite at 973.

## Implementation notes (step 2, 2026-08-20)

As specified, with one refinement: **a local-only change flips the diff's direction.** The two-way convention was local → slack ("what `pull` would change"), but a hunk classified *changed locally* is `push`'s to send, and printing it as something Slack would remove says the opposite of what's true. So: changed-in-Slack and CONFLICT read local → slack; changed-locally reads slack → local. Each changed thread gets one stderr line naming the verb; unchanged threads stay silent, including the both-changed-to-the-same-content case (converged is converged). A thread absent from the base (pushed since the last fetch) classifies against an empty base — if local and Slack then disagree, CONFLICT is the honest answer.

Without a fetched base, `diff` keeps the two-way behavior and prints a one-line stderr hint naming `slck fetch` — only when there's a diff to classify, so clean sessions stay silent. `diff` reads Slack but never advances the refs: `fetch` is the verb that moves the base.

Verified live in a throwaway copy of `cw-quickwins`: silent before and after `fetch` (clean), a local edit classifies as `changed locally — \`push\` sends it` with the flipped direction (both bare `diff` and `diff <slug>`), and reverting returns to silence.

## Implementation notes (step 3, 2026-08-21)

`pull -m rebase|merge|overwrite`, default from `git config thrds.pullMode`, else `rebase`; non-git sessions are always `overwrite` (and asking for another mode there is an error, not a silent downgrade). The reconcile is `git merge-tree --write-tree` — base = last-fetched composite, ours = HEAD, theirs = the fresh fetch — with only thread files materialized from the merged tree (`thrds.json` in there is HEAD's copy; in-memory state supersedes it). One round of API reads feeds both the refs and the reconcile.

Deviations from the section above, each learned the hard way:

- **A conflict must not advance the composite.** If the base moves to the fetched state before the reconcile succeeds, the next pull finds base == remote, concludes "nothing to do", and the conflict silently evaporates — remote's side never lands. So the pull path previews the composite (`write_composite=False`), and the base advances only after the merge does; a test pins that retrying a conflicted pull reproduces the conflict.
- **Conflicts abort with the file list; nothing is written.** Conflict markers in a thread file would be posted to Slack by a later `push`. The message names the outs: `-m overwrite` (Slack wins) or resolve locally and `push` (local wins).
- **Bootstrap follows ghpr's confirmed-or-refuse** (see the bootstrap-divergence section): an ambiguous first fetch withholds the composite and `rebase`/`merge` refuse with the same two outs. `-m overwrite` resolves and establishes the base.
- **The composite re-points at the new HEAD after every write-mode pull** (`_refresh_composite`, no API reads): threads as fetched, passthrough files from the commit the pull just made — otherwise every pull leaves `git diff slack/remote HEAD` dangling on its own `thrds.json` commit.
- **`merge` mode commits via plumbing** (`commit-tree` with the fetched snapshot as second parent) because `git merge` insists on driving the reconcile itself. `rebase` keeps today's linear autocommit shape, so gist-mirror history is unchanged for the default path.

Verified live in a throwaway copy of `cw-quickwins`: bootstrap confirmed silently, a committed local edit survives a pull (the old `pull` reverted exactly this) and reads as local-only in `git diff slack/remote HEAD`, a dirty WT aborts, and re-pulls are clean nops. 13 new tests (`test_pull_modes.py` + the bootstrap-withhold case); suite at 993.

## Implementation notes (steps 4–5, 2026-08-21)

**`push` gate.** One `pull_threads_staging` read at push start, compared against `slack/staging`: threads Slack changed since our last fetch ∩ threads this push would rewrite → refuse the whole push naming the files (`-f`/`--force` overrides; a thread whose local copy already matches the move doesn't count). Two refinements over the section above:

- **The refusing fetch still advances `slack/staging`** — it's an observation, and recording it is what lets the next `diff`/`pull` classify the very change that caused the refusal.
- **The ancestor check is dropped.** It was ghpr-flavored: their rebase makes the ref an ancestor of HEAD; our composite is deliberately a side chain (snapshots parented on each other, not on branch commits), so ancestry is meaningless here and the content-level gate subsumes what it was for.
- **Bootstrap: an ungated push is the design, not a gap.** With no prior fetch there's nothing to compare against, and `push` *is* the explicit "local wins" resolution the ambiguous-bootstrap error tells you to run.

**Push is now commit-first (remotes-model: push reads HEAD).** The auto-commit moved from after the Slack write to before it, so what goes out is exactly a commit's content; the state the push itself produces (`staging_ts`, chrome targets) is folded into that same commit via `--amend` — safe because the gist push runs after, so nothing external has seen the SHA. One commit per push, clean tree after, `git show HEAD:<file>` = what Slack received.

**Post-write verification** re-reads staging and advances the refs to the **observed** state, warning when it differs from what was sent (normalization or interference — the signal either way). This is what makes "a fetch right after a push is a nop" hold, which is the property the gate rests on; there's a test asserting exactly that sequence.

**`promote` gate (step 5).** Only re-promotes are gated — a first promote is append-only (empty `only_ids`), nothing of ours at the target to clobber. The target's current copy of *our* messages is compared against `slack/prod`'s record; a difference means a hand-edit landed at the target since our last pull, and converging would overwrite it. Foreign replies can never trip the gate: `pull_promoted_threads` reads only our own message ids. `slack/prod` updates file-at-a-time (each posted slug has its own target), the refusing fetch records its observation like `push`'s, and the post-promote verify records observed prod state + refreshes the composite from the refs alone.

**Deferred, deliberately: the per-action `DELETE` pre-flight re-read.** The TOCTOU window is now a single command's span — gate fetch → `sync`'s own message read → the action, with the plan preview shown in between — and the incident this section was written under turned out to be a scoping bug (`only_ids`, fixed), not a race. Threading a re-read callback into `core.sync` buys milliseconds of window at real complexity cost; revisit if an actual race is ever observed.

## Phasing

1. ~~`tracking.py` + `fetch` with `-n`, nop semantics, honest bootstrap.~~ **Done** — `git diff slack/remote HEAD` works today.
2. ~~`diff` three-way classification.~~ **Done.**
3. ~~`pull` reconcile modes + dirty-worktree abort.~~ **Done.**
4. ~~`push` gate + post-write verification.~~ **Done.**
5. ~~`promote` gate.~~ **Done** (`DELETE` pre-flight deferred, above).

[`ghpr`]: https://github.com/runsascoded/ghpr
[`d119a07`]: https://github.com/runsascoded/ghpr/commit/d119a07

## Final state (2026-11-28 triage)

All five phases landed, then were reshaped by later work:
- Ref names: `refs/remotes/{staging,prod}` plus `refs/heads/upstream` (`thrds/tracking.py`), settled in `specs/remotes-model.md`, not the `refs/remotes/slack/*` names above.
- "The ancestor check is dropped" no longer holds: the gate's base is now `refs/heads/base/<name>`, what HEAD has incorporated (`specs/done/push-gate-ancestry.md`), after the content-level gate was found to self-clear.

Not built: the per-action `DELETE` pre-flight re-read (deferred above), and `slck push <slug>...` for a deliberately partial push (`slack_push` takes only the doc). Either gets its own spec if it's wanted.
