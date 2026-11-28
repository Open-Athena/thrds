# Named remotes: the unifying abstraction under thrds and ghpr

Ryan's framing (2026-08-21), correcting this session's claim that thrds and ghpr "genuinely differ where it counts" (staging/prod lifecycle vs. a single canonical GitHub item):

> "staging" and "prod" Slack channels are each a "remote" that should be fetch/pull/push-able, just like a GH "item". For dscrd we've discussed using our own server as a "staging" "remote"; the semantics and naming around specific "remotes" should be flexible, just like with real Git remotes. In principle a GH item could have a staging "remote": a throwaway issue or PR in an ephemeral private repo created for the purpose. […] they should get hooked in to Git vocabulary at a low level ("remotes"), and then offer Git-like semantics on top of that.

He's right. What I called a model difference is a **remote-topology difference**: thrds sessions conventionally have two pseudo-remotes (staging PC, per-thread prod targets); ghpr items have one (the GitHub item). Nothing in git privileges `origin` — conventions do — and the same holds here. Everything thrds treats as lifecycle re-derives from two git-native ideas:

- **A remote** is anywhere content can be fetched from / pushed to: a Slack channel, a Discord server, a GH issue/PR, a gist. Some are provisionable (a PEC; an ephemeral private repo for GH staging) — that's `git remote add` plus a creation hook.
- **Per-item upstream** is which remote is canonical for a thread right now. `draft` ⇒ upstream = staging; `posted` ⇒ upstream = prod. `promote` = *first push of a thread to its prod remote, plus flipping its upstream* — `git push -u prod <thread>`, morally. `pull`'s prod-over-staging precedence is just "pull from upstream". `ThreadEntry.state` is a projection of the upstream pointer, not an extra concept.

Checked against the features that looked lifecycle-specific — each is a per-remote property, not a model exception:

| feature | in remotes vocabulary |
| --- | --- |
| staging-only chrome footer | a rendering option of the staging remote |
| promote's append-only-in-shared-threads (`only_ids`) | write-scoping property of pushing into a remote you don't own |
| PEC creation on first push | provisionable remote (`remote add` + create hook) |
| `posted_msg_ts` whitelist | per-remote tracking of which messages are ours |
| frozen staged copy after promote | the non-upstream remote is no longer converged, only observed |
| cross-thread `#slug` refs | resolved per-remote (permalinks differ per channel) |

## Open (2026-11-28 triage)

The sections below are this spec's history; what's left of it:
- Unification step 1, merge the two refs modules, with `ghpr diff`'s three-way classification (below).
- Unification step 4, merge the two gist mirrors (`thrds/platforms/github/gist.py` + `commands/pull.py`, and `thrds/mirror.py`); the GitHub side should honor `THRDS_NO_PUSH` as `mirror.py` does.
- Unification step 5, named remotes on the GitHub side (item and gist as two remotes).
- The target package layout (`thrds/{sync,doc,platforms/{slack,discord,bsky}}`); only `platforms/github` exists.
- `pull -r`, `promote -r`, and `promote` as sugar for `push -u prod`.
- Per-target prod refs: one `prod` ref still covers every thread's target.
- Find the session by walking up from the cwd, as ghpr does (`SessionState.load` reads only `<cwd>/thrds.yml`).
- Discord, Bluesky and Mastodon have no `fetch` / `pull`: the sync model is Slack's and GitHub's so far.

## What's already aligned

`refs/remotes/<platform>/{staging,prod}` (`tracking.py`) is this structure in embryo — one tracking namespace per pseudo-remote. The composite `slack/remote` is, in remotes terms, the **upstream projection**: each thread's content as its upstream remote reports it, materialized as one tree because the session reconciles as one branch. It's an implementation detail of "pull from upstream", not a third remote; possibly worth renaming (`slack/upstream`?) once the vocabulary lands, though `remote` is currently converged with ghpr.

## What this implies (roadmap, not this week)

1. **Remotes become named config, not hardcoded roles.** A `remotes` section (in `thrds.json`, or literally `git config`-shaped) mapping name → `{platform, address, options}`; `staging`/`prod` become the *default* topology `slck init` writes, not the only one. Discord's own-server staging and multi-prod-target sessions fall out for free.
2. **Verbs take an optional remote**, defaulting sensibly: `fetch` (all), `pull` (upstream), `push [<remote>]` (staging today; `promote` becomes sugar for `push -u prod <thread>` + the safety plan).
3. **ghpr converges by adopting the same layer**: its item is one remote, the gist a second; a staging remote (throwaway item in an ephemeral private repo) becomes *possible* rather than architectural. This dissolves the strongest argument against eventual unification — the remaining differences (content layout, comment files) are platform adapters, exactly like `slack.py` vs `discord.py`.

## Push reads HEAD, not the working tree (settled)

The second corrected claim: I called ghpr's Contract A (push from HEAD) vs thrds' push-from-WT "a real behavioral fork". Asked whether there's a good reason for the difference — there isn't. Git pushes commits; HEAD is correct. thrds' WT-push is an accident of ordering: `push` writes WT content to Slack *then* auto-commits, so the commit records what was pushed after the fact. The fix is to reorder, not to drop the auto-commit UX: **`push` auto-commits first, then pushes HEAD.** Same effective behavior when the WT is dirty (it all gets committed anyway, as today), but the pushed state is exactly a commit — so the post-write verification and ref advance (fetch-refs step 4) refer to a commit, pushes become transactional, and the HEAD-vs-WT fork with ghpr disappears. The remaining difference — thrds auto-commits, ghpr requires a manual commit — is a per-tool UX choice sitting *on top* of identical push semantics, which is where differences belong.

Lands with fetch-refs step 4 (the push gate), which touches the same code.

## Audit: does the fetch-refs work (steps 1–5) fight this vision? (2026-08-21)

Structurally no — per-remote tracking refs, per-remote write gates, push-from-HEAD are this model's foundation. Four frictions, two of them real:

1. **`slack/remote` is misnamed.** The composite isn't a remote; it's the *upstream projection* — each thread's content as its per-thread upstream reports it, materialized as one tree because the session reconciles as one branch. That's also why it (correctly, but confusingly for a "remote") carries HEAD's passthrough files. `slack/upstream` says what it is. Cheap to rename now (refs are local; migrate on read, as ghpr did for its namespace move) — but "remote" is the name currently converged with ghpr, so the rename should be proposed to both sides rather than done unilaterally.
2. **`slack/prod` conflates N remotes into one ref.** Targets are per-thread; a session can promote different threads to different channels, and "prod" flattens what the model says are distinct remotes into one tree. The file-at-a-time update in `_update_prod_ref` already tacitly admits this. Fine at current scale; a named-remotes implementation would give each target its own `refs/remotes/<name>/` and derive today's behavior as the one-prod-remote special case.
3. **Roles are hardcoded.** `STAGING`/`PROD` constants, `push`→staging, `promote`→prod. Compatible as the default topology `init` writes, which is what the model asks — but `_gate_push`/`_verify_push` bake the staging role in, so the "verbs take a remote" step is a refactor, not a parameter.
4. **`fetch` is all-or-nothing.** Justified originally by composite coherence, but the composite can rebuild from stored refs without API reads (the promote verify already does exactly this), so per-remote fetch becomes legitimate whenever named remotes land. The constraint is an implementation convenience, not a semantic one.

Bootstrap-outs message wording (`slck push` = local wins) is push/staging-scoped and would generalize to "push/promote to the disagreeing remote" — cosmetic.

## Step 1 landed: the resolution layer + per-remote fetch (2026-08-21)

`thrds/remotes.py` is now the seam between verbs and roles: `Remote(name, role, channel)` with `resolve(state)` deriving the default topology (staging from `staging_channel`; prod as the per-thread-targets role) in composite-merge order — prod last, which states the "prod is canonical for a posted thread" rule exactly once. `observe(remote, …)` is the one place that knows how a role is read, replacing four duplicated render-observed blocks in `cli.py`.

- **Friction 3 (hardcoded roles) resolved at the helper layer.** `_gate_push`/`_verify_push`/`_gate_promote`/`_verify_promote`/`_update_remote_file` all take a `Remote`; only the *verbs* still choose one (`push` → staging, `promote` → prod), which is the model's own "default topology" claim. Their error messages interpolate `remote.name`, so today's output is byte-identical.
- **Friction 4 (all-or-nothing fetch) resolved.** `slck fetch [staging|prod]...` reads only the named remotes; a skipped remote keeps its ref un-advanced and feeds the composite from its stored tree (`_merged_observations` — the same no-API rebuild the promote verify already did). Guard: a skipped remote that *has threads but no ref yet* is refused, because with nothing stored its threads would be misrecorded as deleted in the composite.
- **`fetch remote` is refused by name** with a pointer that the composite is derived, refreshed on every fetch.

**Config section deferred, deliberately.** A `remotes:` section in `thrds.json` that names remotes the readers can't honor would be config that lies: a second staging-role remote needs its own slug → ts map (per-remote thread pointers) and channel-parameterized pulls in `slack.py`. That data-model work is the real prerequisite for both the config section and `push [<remote>]`/`pull [<remote>]` args, so those land together, after it.

## Ref naming settled: `refs/remotes/{staging,prod}` + `refs/heads/upstream` (2026-08-21)

The `slack/remote` → `slack/upstream` proposal went to ghpr's session, which agreed with the diagnosis but refuted the name as fixing only half: git's own shape is `refs/remotes/<remote>/…` — the **remote's name** is the first component — so `slack/staging` had the namespace inverted, and a thing we ourselves established is *not* a remote shouldn't live under `refs/remotes/` at all. Adopted in full:

- `refs/remotes/staging`, `refs/remotes/prod` — `git branch -r` now reads as exactly the remote list, and `git diff staging prod` is the drift question verbatim. (Verified: single-level refs under `refs/remotes/` list in `branch -r`, resolve by bare name, and get auto-reflogs.)
- `refs/heads/upstream` — the composite as a locally computed branch, never checked out: honest about being a projection, still auto-reflogged, and `git diff upstream HEAD` reads perfectly.
- Legacy `refs/remotes/<platform>/{staging,prod,remote}` migrates on first touch of any refs verb (`tracking.migrate_refs`, reported one line per moved ref).

The platform prefix is gone entirely: a session is single-platform (stamped at init), so it was namespace noise. ghpr's own `github/remote` stays put for now — theirs genuinely is one remote's state, so it's a cosmetic wart on their side, and they migrated that namespace once already this week.

## Per-remote thread pointers — schema + YAML landed; readers next

The prerequisite everything else queues behind (config section, `push`/`pull` remote args, per-remote chrome). Today `ThreadEntry` hardcodes the two-remote topology in its field names: `staging_ts` is "my ts at the staging remote", and `target`/`posted_ts`/`posted_msg_ts` are "my location and message ids at the prod remote". Generalized:

```jsonc
// ThreadEntry
{
  "state": "posted",
  "upstream": "prod",              // which remote is canonical now (today: derived from state)
  "remotes": {                     // remote name → this thread's pointers there
    "staging": {"ts": "1.1"},
    "prod": {"channel": "C0PROD", "thread_ts": "0.1", "ts": "9.9", "msg_ts": ["9.9"], "url": "…"}
  }
}
```

- One pointer shape for both roles: `ts` (our root message), `msg_ts` (our message ids — the re-promote whitelist), `channel`+`thread_ts` (where, and what we replied into; staging omits them, inheriting the session's staging channel). `posted_url` folds in as `url`.
- `entry.state` stays (it carries `ready`/`dropped`, which aren't upstream facts) but `posted` becomes verifiable against `upstream != 'staging'`.
- **Migration**: on load, old fields rewrite to `remotes` entries (`staging_ts` → `remotes.staging.ts`, `target`+`posted_*` → `remotes.prod.*`); saved back on the next state write. Old fields dropped after migration — BC shim lives in `__post_init__` only.
- **Readers become channel-parameterized**: `pull_threads_staging` / `pull_promoted_threads` collapse toward one `pull_thread_states(remote, …)` keyed off each thread's pointers at that remote — which is what makes a second staging-role remote (Discord's own-server staging) or N prod targets real rather than declared.
- Then the `remotes:` session config section lands honestly, `promote` becomes `push -u prod <thread>` sugar, and audit friction 2 (`prod` ref conflating N targets) resolves per-remote.

### Landed 2026-08-21: the storage half

`ThreadEntry` is now `{state, remotes: {name → RemotePointer(ts, msg_ts, channel, thread_ts, url)}}`; `upstream` is a derived property (`posted` → prod, else staging) rather than stored, so there's one source of truth until a thread can name one of several prods. The pre-pointers names (`staging_ts`, `target`, `posted_*`) survive as constructor kwargs + read/write properties over the map — legacy files load through them, and call sites migrate to remote-parameterized access in the readers step rather than big-bang.

**State file is now `thrds.yml`** (Ryan: YAML "generally seems nicer to read and edit by humans"), and the extension change is the deliberate version boundary: old code can't half-read new state, new code migrates the JSON explicitly — `load` reads either, `save` writes YAML and unlinks the JSON, and `_stage_paths` adds the tracked-but-deleted `thrds.json` to the next commit so the gist records the swap. YAML footgun handled: `safe_dump` quotes number-like strings on the way out, and an unquoted hand-edited ts (which YAML parses as a float, silently losing precision) is **refused on load** with a quoting hint. `None`s are pruned on save (load restores defaults; empty strings/containers are kept — `channel_prefix: ''` ≠ unset).

**Why the tracked state file stays (vs ghpr having none)**: it's the multi-machine record — the gist-mirror restoration (2026-08-19 incident) worked because state is tracked and mirrored. ghpr needs none only because its remote topology is implicit in the clone; a gthb session with named remotes / per-item upstreams / chrome config converges *toward* this file, not away from it.

### Landed 2026-08-21: the readers step

`pull_threads_staging` / `pull_promoted_threads` are gone; `pull_thread_states(remote, …)` is the one reader, and everything remote-specific comes from the `Remote` and the thread's pointer at `remote.name`. Role is the behavior bundle, stated once:

- **staging role**: observe the whole channel (`remote.channel` — `state.staging_channel` is no longer consulted), every thread with a root pointer there, foreign replies included.
- **prod role**: read only threads whose **upstream is this remote** — the old `state == 'posted'` gate restated in remotes vocabulary, and it's load-bearing: `reopen` keeps prod pointers while flipping upstream back to staging, so a reopened thread's frozen prod copy is not pulled over the revision in progress. Only *our own* messages (`msg_ts`, falling back to root `ts`); channel from the pointer, falling back to `remote.channel` (a prod-role remote with one fixed target channel now works).

A second staging-role remote (Discord's own-server staging shape) is now real at the reader level — pinned by a unit test that reads a `scratch` remote's own channel via its own pointers. `remotes.observe`, `pull`, and `diff` all go through the one reader (diff iterates remotes in resolve order, which *is* the prod-over-staging precedence).

### Landed 2026-08-22: the `remotes:` config section + chrome presets

Roadmap item 1, honestly this time — the readers exist, so declared remotes work. `thrds.yml`:

```yaml
remotes:
  staging: {chrome: none}                            # defaults accept channel/chrome overrides; roles fixed
  scratch: {role: staging, channel: C0SCRATCH}       # staging-role extras must name their channel
  archive: {role: prod}                              # prod-role extras may (pointers carry their own)
```

- **Chrome resolution**: explicit `chrome:` (preset name `footer`/`none`, or a `StagingChrome` mapping) > session-level `staging_chrome` for the default staging remote (the existing knob keeps working) > role preset (staging → `footer`, prod → `none`). The five chrome sites in `slack.py` now read the resolved staging remote's chrome, and a resolved `None` disables rendering — "prod messages carry no chrome" is now prod's chrome config, not a hardcoded rule. Platform-keyed presets (gthb item → gist-link footer; dscrd like slck) are the extension point when those platforms land.
- **Validation at the door**: `resolve` raises on unknown keys, bad roles, a role override on a default, a channel-less staging-role extra, `upstream` as a name, unknown presets; `_load_state` surfaces it once as a usage error.
- **Composite honesty for extras**: order is all staging-role remotes then all prod-role (within a role: defaults, then declaration order); `pull`'s composite refresh goes through `_merged_observations` so extras' stored refs feed the merge base; and both `fetch`'s partial guard and a `_fetch_refs` backstop (for `pull`, which only reads the default remotes) refuse when a declared remote has thread pointers but no stored observation — its threads would be misrecorded as deleted.
- What extras can *do* today: `fetch <name>` fully, feed `diff`'s classification and the merge base, carry chrome config. `pull`/`promote` still address the defaults.

### Landed 2026-08-22: the writer side + `push -r <remote>`

`sync_threads_staging(remote=…)` (the staging-role writer): posts go to `remote.channel` (only the default staging remote is provisionable — extras declare their channel at config time), pointers read/write at `remote.name`, chrome from `remote.chrome`, and **terraform scope is per-remote** — staleness is judged by pointers at the pushed remote, so a thread staged only at the default remote survives a `push -r scratch` untouched. `push -r` picks any staging-role remote; the gate, commit message, and post-write verification all follow it (`-r prod` points at `promote`; unknown names list the session's remotes). Remaining verb args: `pull -r` (needs a multi-staging reconcile-precedence decision — which staging-role copy feeds a thread's merge when several hold it; today declaration order decides the composite, which is fine for observation but underspecified for a write-back) and `promote -r` (a prod-role remote arg wants the per-thread target/pointer interplay settled). Both deliberately deferred until a real second-remote workflow exercises them.

## Observations are now write-free (2026-08-21)

The one leak in "fetch touches nothing": staging/prod pulls download `emoji-*` files into the session dir as a side effect of custom-emoji substitution. Fixed via `download_emoji=False` on the pull methods — the substituted text only depends on the deterministic filename (`emoji-<name>.<ext>` from the workspace URL), not on the file existing, so an observation renders byte-identically to what `pull` would write while writing nothing. `remotes.observe` (feeding `fetch` and the push/promote gates) and `diff` pass it; `pull` still downloads, since it writes and commits the files anyway. Divergence window: a download that would *fail* leaves `pull`'s text literal where an observation substituted — transient, and the next pull surfaces it as an honest delta.

## Chrome is a per-remote property (2026-08-21, Ryan)

> we should be able to configure msg "chrome" on a per-remote basis, e.g.: slck: staging-channel msgs get footer MD, prod msgs don't; gthb: "item" remotes get (in)visible footer Gist link; dscrd: maybe same as slck

The feature table above already hinted at this ("staging-only chrome footer | a rendering option of the staging remote") — this makes it a design commitment: chrome config hangs off the *remote*, not the platform or the lifecycle state. Today's `StagingChrome` is then the staging remote's chrome block, and "prod messages carry no chrome" stops being a hardcoded rule and becomes the prod remote's (empty) chrome config. The ghpr case shows why remote-level is the right altitude: its *item* remotes carry a gist-link footer (ghpr's existing visible/HTML-comment footer modes ≈ the `(in)visible` knob), while its gist remote carries none — same tool, different chrome per remote. Lands with the `remotes:` config section: `{name: {role, channel, chrome: {...}}}`, with `render`/`parse` (`thrds.chrome`) taking the remote's chrome config instead of reading session-level `staging_chrome`. Migration: session-level `staging_chrome` becomes the default chrome block `init` writes onto staging-role remotes.

## Landed 2026-08-23: ghpr merged in as the `github` platform adapter (Ryan)

The convergence recorded above was a *protocol* convergence maintained by hand across two repos: verb surface, `pull -m` modes, `refs/remotes/<name>`, the truthful-ref rule, the push gate, gist-as-record. Ryan rejected leaving it there —

> i don't like the idea of the 2 libraries just staying in sync (re: "protocol") without sharing code. it was a lot of work and back and forth b/w the 2 to get to this state, we should lock in the convergence now. factoring a shared core to its own library seems like polyrepo-overkill; that core may as well exist in one of the existing repos.

— and the argument this session made for waiting does not survive its own evidence. "Rule of three hasn't fired" was false (slack/discord/bsky are already three adapters, ghpr the fourth implementation of the sync discipline); "ghpr is more mature/published" is immaterial at ~0 external users; and "the interface is still being discovered" cuts the other way, since discovery happens here and every discovery had to be hand-carried across by spec round-trip. The drift was already concrete: **ghpr's push gate moved to `merge-base --is-ancestor`** after catching the content-level check self-clearing (a refusal advances the ref, so the retry sees nothing new and the overwrite lands), and flagged that thrds' gate inherits the same property. That is still open here — see below.

**Layout.** The seam both sides independently found is `{filename: content}` — `remotes.observe()` returns it, ghpr's `build_snapshot()` builds from it — so the sync engine never needs to know what a remote *is*. Target shape:

```
thrds/
  sync/       refs, fetch, reconcile, gate, bootstrap, mirror, remotes, pointers
  doc/        md parse/serialize, file-layout interface, lint
  platforms/  slack/ discord/ bsky/ github/
```

**How the merge was done.** `git mv` relocation as one commit on top of `ghpr/main` (built here, since a sibling session owns that working tree), then `git merge --allow-unrelated-histories`. Conflict-free — only four tracked paths collided (`pyproject.toml`, `uv.lock`, `README.md`, the release workflow), and `specs/`, `tests/`, and the source trees are disjoint. Deliberately *not* `filter-repo --to-subdirectory-filter`: that rewrites every ghpr SHA, and this spec and `converge-fetch-refs-ux.md` cross-reference several by hash. ghpr's SHAs are ancestors of HEAD and `git log --follow` walks through the rename.

**What landed:** the relocation + merge; `utz` as a dep; `ghpr` as a console script pointing at the group `thrds github` mounts (same arrangement as `slck`, so the name and the `ghprc`/`ghprd`/`ghprp` aliases outlive the distribution); a `_LazyGroup` that defers the `utz` import (~400ms of pandas/IPython) off every `slck` invocation; and per-platform session dirs (`slck/`, `dscrd/`, `bsky/`, `capture/`) converging with `gh/`. 1264 tests passing, both suites in one run.

**Explicitly not done yet — the unification itself**, bottom-up, each step deleting one of two implementations:

1. **Refs** — `ghpr/refs.py` + `thrds/tracking.py` → one module. Smallest and most converged; do it first. With it, `ghpr diff` gets the Slack side's three-way classification (`_diff_threads`: "changed on GitHub / changed locally / CONFLICT", a local-only change flipping the printed direction, local == remote silent), moved here from `specs/done/converge-fetch-refs-ux.md` §2.
2. ~~**The push gate**~~ — **done 2026-08-24**, ahead of the refs merge because it was a live bug rather than a cleanup. thrds' gate self-cleared exactly as ghpr's had; the answer for a side-chain composite turned out to be a second ref (`refs/heads/base/<name>`) recording what HEAD has *incorporated*, which is the same standing question `--is-ancestor` asks without needing the composite to be an ancestor. Both adapters now refuse a second time. `specs/done/push-gate-ancestry.md`.
3. ~~**Bootstrap ambiguity**~~ — **already converged; checked 2026-08-24, no code needed.** Both earlier claims about this were wrong: thrds does *not* "sidestep structurally", and it is not a hole in the gate. `_fetch_refs` withholds the composite when a first fetch disagrees with HEAD and names both resolutions (`slck pull -m overwrite` / `slck push`), which is `bootstrap_is_ambiguous`'s rule verb for verb; `pull -m rebase|merge` refuses without a base; and `push` proceeding with no base is the *documented* "local wins" answer, which ghpr allows for the same reason. The one thing worth pinning was the interaction with the new base ref — a disagreeing observation must not become the gate's base — now covered in `test_ambiguous_bootstrap_withholds_the_composite`.
4. **The gist mirror** — `ghpr/gist.py`'s mirror half + `thrds/mirror.py`.
5. **Named remotes on the GitHub side** — item and gist become two remotes, at which point ghpr's (in)visible gist-link footer is per-remote chrome exactly as the section above predicts.

**Also converge, noticed in passing:** ghpr locates its clone by walking parent dirs for `gh/<n>/` plus git config (`pr.owner`/`pr.repo`/`pr.number`), so its verbs work anywhere inside a clone; thrds' `_load_state` reads `thrds.yml` from the cwd and errors otherwise. ghpr's is the better behavior.

**ghpr's repo** archives; the PyPI distribution `ghpr-py` gets a deprecation note rather than a yank (yanking breaks anyone pinned and buys nothing). The `ghpr` *command* is unaffected — it ships from here now.
