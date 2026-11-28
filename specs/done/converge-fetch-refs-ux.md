# Converge fetch/refs UX with thrds (and three upstream-able improvements)

From the thrds session (`~/c/thrds`, 2026-08-20). thrds implemented its analog of `d119a07` — `slck fetch` + remote-tracking refs for Slack channels-as-pseudo-remotes (`thrds/tracking.py`, spec `~/c/thrds/specs/fetch-refs.md`) — deliberately copying ghpr's UX surface, and found three things along the way that ghpr should adopt, plus one bootstrap edge worth testing before the 0.3.0 release.

## Already converged — keep these pinned

Anyone using both tools should be able to transfer the mental model wholesale. These are identical today; treat them as contract:

- `fetch` verb, `-n` for a side-effect-free preview that still shows what it would do.
- `pull -m rebase|merge|overwrite`, default `rebase`, overridable via `git config <tool>.pullMode`.
- The merge-base ref is named `…/remote`; `<base>..HEAD` = "local commits the remote hasn't seen".
- The ref only ever records *truthful* remote state (ghpr: don't advance when anything was held back; thrds: advance to post-write *observed* state).

## 1. `refs/ghpr/remote` has no reflog — move to `refs/remotes/` — DONE

git auto-enables reflogs (`core.logAllRefUpdates`) only for `refs/heads/`, `refs/remotes/`, `refs/notes/`, and `HEAD`. `refs/ghpr/remote` is outside all of them, so the ref keeps **no history of its own movements**: `git reflog ghpr/remote` is empty, and "what did GitHub look like before this fetch" — half the point of keeping the ref — is unanswerable. Each fetch commit's *parent* chain survives, but the reflog is what makes `ghpr/remote@{1}` and "when did it move" queries work, and what `git gc` uses to protect recent states.

Proposal: `refs/remotes/github/remote`. Also buys `git branch -r` listing it and `git log github/remote` reading naturally. There's deliberately no `[remote "github"]` config section (a URL-less remote would break `git fetch --all`) — thrds confirmed this shape works fine.

Migration is one line at `ensure_remote_ref` time: if the legacy ref exists and the new one doesn't, `git update-ref refs/remotes/github/remote <old>` + delete the old one.

(thrds uses `refs/remotes/slack/{staging,prod,remote}` — three refs because a session has two sources, staging and per-thread prod targets, plus their composite. ghpr's single ref is correct for its single-source shape; only the namespace is worth changing.)

## 2. `diff` should consume the base: three-way classification — TODO

ghpr built the merge base but `ghpr diff` doesn't read it yet. A two-way diff structurally can't say which side moved — a hunk is equally "GitHub edited this" and "you edited this and `pull` is about to eat it", and those want opposite verbs. With the base, compare each side against it instead and emit one stderr line per changed item:

    DESCRIPTION.md: changed on GitHub — `pull` applies it
    z-123-alice.md: changed locally — `push` sends it
    pr#8356.md: CONFLICT — both sides changed since the last fetch

Two details from the thrds implementation (`slck diff`, `~/c/thrds/thrds/cli.py` `_diff_threads`) worth copying:

- **A local-only change flips the printed diff's direction** (remote → local, "what `push` sends"). The pull-direction rendering would show your own edit as something the remote removes — the exact misreading the classification exists to prevent.
- **local == remote stays silent regardless of the base** — both-changed-to-the-same-content is converged, not a conflict.

## 3. `push` upstream gate — DONE

`push.py`'s ref handling is still advance-only (`set_remote_ref('HEAD')` gated on "was anything held back"); nothing refuses when the remote moved underneath. Sequence: fetch at push-start; if the ref moves, someone (rjpower, say) edited since your last pull — refuse, naming the changed files, with `pull` / `--force` as the outs. ghpr's writes are less destructive than thrds' (no hard deletes), but a PATCH on a comment whose body moved still stomps the newer edit, and the gate is ~free once fetch exists.

Detect per file for the error message; refuse the whole push rather than partially applying (a commit that touched two files means both — see the thrds spec's "Detect per thread; refuse the whole push" section for the reasoning).

## 4. Bootstrap edge to test before 0.3.0 — DONE (fixed differently)

`ensure_remote_ref` initializes the ref to HEAD, assuming local == remote, with a warning. If HEAD has **unpushed local content** at that moment, the first `pull -m rebase` computes `base..HEAD = ∅` (nothing to replay), and the branch lands on the fetched snapshot — the old commits survive as ancestors but their content is reverted in the tree, and the next push propagates the reversion. That is byte-for-byte the failure `d119a07`'s own commit message opens with ("an unpushed local commit survived as an ancestor but its content was reverted — and then pushed"), recreated on the one path where the base is a guess rather than an observation.

thrds sidestepped this structurally (its composite tree overlays HEAD, so local-only content passes through a first pull unharmed, then `push` sends it). For ghpr the cheap fix might be: on bootstrap, *fetch first* and set the ref to the observed snapshot parented on HEAD — the warning becomes unnecessary and the first pull behaves like every later one. Worth a test either way; the `8356-66` live datapoint being waited on exercises fetch+rebase but (probably) not this bootstrap-with-local-delta path.

## Status

**§1, §3, §4, §5 done; §6 resolved. §2 is the only one still open.**

§1 landed as specified. Verified the premise first: `refs/ghpr/remote` accumulates 0 reflog entries across two `update-ref`s while `refs/remotes/github/remote` accumulates 2, and only the latter answers `@{1}` or appears in `git branch -r`. Migration happens inside `read_remote_ref()`, so any command that reads the base migrates it.

One correction to the framing: "what did GitHub look like before this fetch" was already answerable without the reflog, because every snapshot is committed on top of the previous base, so `git log github/remote` *is* the history of remote states. What the reflog adds is `@{1}` addressing, movement timestamps, and gc protection if that chain is ever broken. Worth doing regardless — the namespace is simply the right one — but the ref was not as history-less as stated.

**§4 was fixed, but not as proposed.** Setting the ref to the fetched snapshot parented on HEAD doesn't close the hole: the snapshot has HEAD as an ancestor, so `base..HEAD` is *still* empty and the next reconcile still lands the branch on remote content. It only appears to work when the remote hasn't moved.

The deeper point is that bootstrap ambiguity is symmetric, and the spec only names one horn:

- assume GitHub is ahead (`base := HEAD`) → unpushed local work is reverted, then pushed;
- assume local is ahead (skip the reconcile) → `push` sends a stale HEAD over a newer remote.

Neither is safe without evidence, so ghpr now refuses to invent one. `resolve_base()` returns `(HEAD, is_bootstrap=True)`, the fetch runs, and `bootstrap_is_ambiguous()` adopts the guess only if the snapshot came back identical to HEAD (i.e. the guess is *confirmed*, the common case for a repo that was in sync). Otherwise it errors with the ref left unset — so the next run still sees an honest bootstrap rather than a base ghpr made up — and names the two commands that constitute an answer: `ghpr pull -m overwrite` (remote wins) or `ghpr push` (local wins). Both are allowed through the check, since each is an explicit statement of which side is authoritative.

Tests in `tests/test_fetch_pull.py`: `TestBootstrap` (local delta not reverted, clean bootstrap adopted, each resolution path, `fetch` alone refuses) and `TestLegacyRefMigration`. 192 passing.

Note on §3 for whenever it's picked up: `pull` already fetches immediately before calling `push`, so a naive fetch-at-push-start would double-fetch on every pull. The gate wants the already-computed snapshot threaded through rather than a second fetch.

## 5. `pull` should stop pushing to GitHub (from thrds, 2026-08-21) — DONE

Ryan asked whether pull/push composition is consistent between the tools. It isn't — they're exactly inverted:

| after fetch+reconcile, `pull` … | platform write-back | gist mirror |
| --- | --- | --- |
| ghpr | **always** (tail-calls full `push`) | default-on once a gist exists (see correction) |
| thrds | never | **always** (auto-commit + push) |

**Correction (from this session's review, accepted by thrds):** the original row said "only with `-g`", which is wrong — `push.py` mirrors whenever a gist exists (`should_add_footer = has_gist` gates the sync block; `gist or has_gist` inside). `-g` only matters for *creating* the first gist, or after `-F`. So the "opt-in bookkeeping has gaps" concern doesn't apply; the piece actually missing is the env-var escape hatch.

Proposal: converge on the thrds shape — **`pull` = fetch + reconcile + mirror; platform write-back is `push`'s job, exclusively.**

- git's own `pull` doesn't push; `ghpr pull` quietly mutating GitHub is the one place the git analogy is broken.
- It dissolves the §3 objection: the push-gate's fetch is only "redundant" because `pull` tail-calls `push`. Drop the tail call and the gate's implicit fetch is exactly where the freshness check belongs, no snapshot-threading needed.
- Dry-run stops meaning two things in one command (the `-n` staging bug fixed in `d119a07` was exactly this shape of confusion).
- Anyone wanting the old behavior gets it as an explicit `ghpr sync` (= pull + push).

On the mirror column: the gist is bookkeeping, and opt-in bookkeeping is bookkeeping with gaps — a mirror that's only current when someone remembered `-g` can't be trusted as the record (thrds' 2026-08-19 incident restoration leaned on the gist mirror being complete). Suggest defaulting it on, with an env-var escape hatch (thrds uses `THRDS_NO_PUSH=1`, which announces itself on stderr rather than skipping silently).

## 6. The deeper convergence: named remotes (pointer, 2026-08-21)

Ryan rejected the thrds session's claim that the tools "genuinely differ" (staging/prod lifecycle vs. single canonical item): staging and prod are just *remotes*, and both tools should hook into git vocabulary at that level — named pseudo-remotes, per-item upstream, promote = first-push-plus-upstream-flip. A GH item could even grow a staging remote (throwaway item in an ephemeral private repo, like a thrds PEC). Full writeup: `~/c/thrds/specs/remotes-model.md`. Also settled there: push reads HEAD, not the WT — ghpr's Contract A was the correct side of that fork, and thrds is adopting it (auto-commit first, then push HEAD).

**Resolved 2026-08-21 — ref naming converged, thrds side implemented.** thrds proposed `slack/remote` → `slack/upstream`; this session refuted the name as half a fix (remote name should be the *first* component, per git's own `refs/remotes/<remote>/…`; and a non-remote shouldn't live under `refs/remotes/` at all). thrds adopted the counter-proposal in full: `refs/remotes/{staging,prod}` + `refs/heads/upstream` (computed branch, never checked out), legacy `refs/remotes/<platform>/*` migrating on first touch. `git branch -r` now lists exactly the remotes; `git diff staging prod` / `git diff upstream HEAD` read verbatim. ghpr's `github/remote` can stay (it genuinely is one remote's state); if/when ghpr grows named remotes, `refs/remotes/<item-remote-name>` + `refs/heads/upstream` is the converged shape to match.

Also new in `remotes-model.md`: **chrome as a per-remote property** (Ryan) — footer/chrome config hangs off each remote, not the platform or lifecycle: slck staging gets the footer, prod none; ghpr *item* remotes get the (in)visible gist-link footer, the gist remote none; dscrd like slck. Worth folding into ghpr's config model when named remotes land there.

## Status: §3 + §5, and the ref-shape follow-through (ghpr, 2026-08-21)

**§5 landed as proposed.** `pull` = fetch + reconcile + gist mirror; `ghpr sync` (new, `commands/sync.py`) is `pull` + `push`. Aliases: `ghprl` stays `pull`, `ghprs`/`ghprsn` are `sync`/`sync -n`. Two things fell out that the proposal didn't anticipate:

- **`pull` had to stop keying its reconcile off `snap.changed`.** With the gate in place, a refused push advances the ref without moving HEAD, so the next `pull` fetches, sees *nothing new*, and under the old logic returned early — leaving the local commits un-replayed and the divergence standing. The condition is now `merge-base --is-ancestor <ref> HEAD`: "is the branch on top of the remote state", which is a different question from "did this fetch see anything new". (The gate ended up needing the same distinction, for the same reason — see below.) Pinned by `TestPushGate::test_refusal_does_not_strand_local_work`.
- **`sync` passes `no_gate=True`.** Its own `pull` fetched seconds earlier, so gating would re-ask an answered question and double the API cost of every round trip. The residual TOCTOU is the same window any push has between its gate and its writes.

The gist-mirror side of §5 is a no-op in practice: `push` already mirrored whenever a gist existed, and `pull` now does the same via `mirror_to_gist`. The env-var escape hatch thrds suggested is still unbuilt — worth adding when there's a reason to skip a mirror, not before.

**§3 landed, materially simplified by §5.** `_gate_upstream` fetches once at push start and refuses the whole push (never partially applying), naming what changed and offering `ghpr pull` / `ghpr push -G`. No snapshot threading was needed — the objection recorded above under §4 was entirely an artifact of `pull` tail-calling `push`, exactly as thrds predicted. Adopted from thrds' step 4: a refusal still advances the ref (the fetch is an observation, and recording it is what makes `git diff HEAD refs/remotes/github` show the cause), and bootstrap pushes are ungated (nothing to compare against, and `push` *is* the "local wins" resolution `bootstrap_is_ambiguous` names).

**The gate's test is ancestry, not "did the remote move".** First implemented the spec's phrasing — refuse if this fetch saw something new — and caught it live: the refusal advances the ref, so the *second* `push` fetches, sees nothing new, passes, and overwrites the remote edit the first one refused to touch. A one-shot speed bump, not a gate. The condition is now `merge-base --is-ancestor <ref> HEAD`, which is precisely git's non-fast-forward rule: stateless, un-self-clearing, and cleared only by actually incorporating the remote state (any `pull` mode does, `-m overwrite` included). Pinned by `TestPushGate::test_re_running_push_still_refuses`.

Worth flagging back to thrds: their step 4 deliberately "dropped the spec's ancestor check — it was ghpr-flavored … our composite is a side chain by design", keeping the content-level since-last-fetch comparison. That's defensible where a side chain makes ancestry meaningless, but it inherits the same self-clearing property — a refusal records the fetch, and the retry finds nothing new. Whatever stands in for "HEAD contains what the remote currently says" there is the durable form of the check.

**Ref shape, following thrds' `eca5304`.** `refs/remotes/github/remote` → `refs/remotes/github`. Same reasoning as their `refs/remotes/{staging,prod}`: the first component is the remote's *name*, and the branch component has nothing to name when there is one state per item. `github/remote` said "remote" twice; `git diff github HEAD` and `git log github` now read verbatim. Verified single-level refs under `refs/remotes/` behave fully (listed by `git branch -r`, resolve bare, auto-reflog, `@{1}`). Both older names migrate on read — and must delete-then-create, since `refs/remotes/github/remote` and `refs/remotes/github` are a git directory/file conflict.

200 tests passing.

## Final state (2026-11-28 triage)

§1, §3, §4 and §5 landed on the ghpr side, which is now `thrds/platforms/github/` in this repo (merged at `664968f`). §6 became `specs/remotes-model.md`.

Still open, moved to `specs/remotes-model.md` (unification step 1, where the two refs modules merge): §2, `ghpr diff`'s three-way classification (`thrds/platforms/github/commands/diff.py` is still a two-way diff and never reads the base). Also small: the GitHub side's gist mirror doesn't honor `THRDS_NO_PUSH` (`thrds/mirror.py` does).
