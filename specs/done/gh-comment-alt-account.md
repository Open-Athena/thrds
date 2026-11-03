# `ghpr`: perform comment/review writes as an alternate GitHub account

## Motivation

`ghpr` (= `thrds github`) shells out to a bare `gh …` for every GitHub call, so it always acts as the active `gh` account. We want PR/issue **author-visible writes** — opening PRs/issues, editing their description/body, and comment + review-thread writes — to *optionally* be performed as a **different** GitHub account (e.g. a bot `rbw-bot`), so the bot can open and iterate on PRs/issues without acting as the user — while the **gist mirror** (owned by the user; the bot's token can't edit it) and **all reads** stay on the default account.

The user's framing: "gh comment ops (but not gists or others)", later extended to "bot should be able to open PRs and issues too, but always optionally / config'able per call".

## The write-vs-gist-vs-read split

Exactly which `gh` invocations switch identity:

**Route through the alternate account (author-visible writes):**
- **Open a PR** (`gh pr create`) — `commands/create.py`.
- **Open an issue** (`gh issue create`) — `commands/create.py`.
- PR/issue **description/body edit** (`gh pr edit` / `gh issue edit`) — `commands/push.py`. (A bot-opened PR's later body edits are thus also the bot's.)
- Top-level PR/issue comment **POST** (post a new comment) — `commands/push.py`.
- Top-level PR/issue comment **PATCH** (edit an existing comment) — `commands/push.py`.
- Review-thread **reply POST** — `api.reply_to_review_comment`.
- Review-comment **body PATCH** — `api.update_review_comment`.
- Review-thread **resolve / unresolve** GraphQL mutations — `api.resolve_review_thread` / `unresolve_review_thread`.

**Never route (stay on the default `gh` account):**
- The **gist mirror** — creating/updating/pushing the owner's gist (`gist.py`, `push.sync_to_gist`). The bot token typically can't edit the owner's gist.
- **Every read** — `pr/issue view`, `pr/issue list` (locating a just-created item), comment/thread listing, repo-visibility lookup, fetch/clone/pull, `gh api user`-style probes.

The split is enforced narrowly: the alternate token is injected **only** into the `env` of the specific write subprocess calls, as `GH_TOKEN=<token>`. Everything else runs with the ambient environment untouched, so a pure no-op results when no alternate account is configured. **Everything is gated per-call**: routing happens only when an identity is active for that invocation; with none set, the bot never opens/edits anything.

> Not yet implemented in the codebase, but if/when added, "request re-review" and other author-visible review writes should route the same way (thread the identity `env` into their `gh` call).

## Login selection (precedence high → low)

`identity.select_login(as_login)`:

1. `--as <login>` flag (on `push` and `sync`).
2. `GHPR_AS` env var.
3. per-clone git config `pr.as` (mirrors the existing `pr.gist` mechanism).
4. none set → `None` → **unchanged behavior** (act as the active `gh` account). This is a pure no-op.

## Token resolution (pluggable sources, first non-empty wins)

`identity.resolve_token(login)` tries `TOKEN_SOURCES` in order — add a source by appending a `(login) -> str | None` callable:

1. **Explicit PAT** in `$GHPR_AS_TOKEN` — direct token, no keyring needed.
2. **`gh auth token -u <login>`** — the gh multi-account keyring (the recommended path).
3. **`git config pr.as-token-cmd`** — a user-configured shell command that prints a token, e.g. on macOS:
   `security find-generic-password -a rbw-bot -s gh-rbw-bot -w`.

## Verify before any write

`identity.resolve_identity(as_login)`:

- Selects the login; returns `None` if none set.
- Resolves a token; **raises** if none resolves (never silently falls back to the user's identity).
- Runs `gh api user` with `GH_TOKEN=<token>` and confirms the reported `login == <login>`; **raises** on mismatch.
- On success returns a frozen `Identity(login, token)` whose `.env()` is `{**os.environ, 'GH_TOKEN': token}` (subprocess `env=` replaces the environment wholesale, so we carry the full ambient env with only the token swapped).

`push()` resolves the identity once up front and threads `bot_env = identity.env()` into the description-edit + comment/review write calls only. When an identity is active, the ownership gate's `current_user` is set to `identity.login` (so the bot can edit/reply on its *own* comments; others' comments still need `-C`). `create_new_pr` / `create_new_issue` resolve the identity the same way for the `gh … create` call, and pass `as_login` down through `_finalize_created_item` → `push()` so the body edit of the freshly-opened item routes too.

## Code surface

| File | Change |
|---|---|
| `platforms/github/identity.py` | **New.** `select_login`, token sources + `resolve_token`, `verify_login`, `Identity`, `resolve_identity`. |
| `platforms/github/api.py` | `reply_to_review_comment` / `update_review_comment` / `resolve_review_thread` / `unresolve_review_thread` gain `env: dict | None = None`, forwarded to `proc.json`. |
| `platforms/github/reviews.py` | `push()`, `_patch_body`, `_post_reply` gain `env=`; threaded into the four review-write calls. Reads unchanged. |
| `platforms/github/commands/push.py` | Resolve identity at top; `bot_env` on the description edit, the two direct comment writes, and into `reviews.push(...)`; `current_user` honors `identity.login`; new `-a/--as` option. |
| `platforms/github/commands/create.py` | `create` / `create_new_pr` / `create_new_issue` resolve identity and put `bot_env` on the `gh … create` call; `as_login` threaded through `_finalize_created_item` → `push` (body edit); new `-a/--as` option. |
| `platforms/github/commands/sync.py` | `sync()` + `-a/--as` thread `as_login` into `push`. |

## Config / flag / env surface

- Flag: `ghpr push -a <login>` / `ghpr sync -a <login>` / `ghpr create -a <login>` (alias `--as`).
- Env: `GHPR_AS=<login>`, `GHPR_AS_TOKEN=<pat>`.
- Git config (per clone): `pr.as = <login>`, `pr.as-token-cmd = <shell command printing a token>`.

## Setup recipes

Second gh account in the keyring (recommended):
```bash
gh auth login            # log in as rbw-bot (adds it to the gh multi-account keyring)
cd gh/<num>
git config pr.as rbw-bot # or: export GHPR_AS=rbw-bot, or: ghpr {create,push} --as rbw-bot
ghpr create              # PR/issue opened as rbw-bot; gist stays you
ghpr push                # body/comments/replies pushed as rbw-bot; gist stays you
```

Explicit PAT (no keyring):
```bash
export GHPR_AS=rbw-bot GHPR_AS_TOKEN=ghp_xxx
ghpr push
```

macOS Keychain via a command:
```bash
git config pr.as rbw-bot
git config pr.as-token-cmd 'security find-generic-password -a rbw-bot -s gh-rbw-bot -w'
ghpr push
```

## Tests

`tests/github/test_identity.py` (exact-equality throughout):
- `select_login` precedence (flag > env > config > none).
- Each token source + `resolve_token` ordering + all-miss.
- `verify_login` passes the token via `GH_TOKEN`; `resolve_identity` success / login-mismatch refusal / no-token refusal / `None` when unset.
- `api` write helpers thread `env`; read helpers never do.
- `reviews.push`: resolve/edit/reply writes carry the bot env; the comment + thread reads carry none; with no identity, no call carries an env override.
- `push()` command: top-level comment POST and PATCH **and the `gh issue edit` description edit** route as the bot; the same-endpoint comments read stays default; with no identity nothing carries an override.
- `create()` command: `gh pr create` / `gh issue create` route as the bot (and `as_login` is threaded into `_finalize_created_item` for the body edit); with no identity the open call carries no override.

## Implemented (2026-11-03)

Landed as specified, no deviations. Summary of the final state:

- **`platforms/github/identity.py`** (new): `select_login` (flag > `GHPR_AS` > `pr.as` config > `None`), `TOKEN_SOURCES` (`$GHPR_AS_TOKEN` > `gh auth token -u` > `pr.as-token-cmd`) + `resolve_token`, `verify_login` (`gh api user` under `GH_TOKEN=`, login-match or raise), frozen `Identity(login, token)` with `.env()`, and `resolve_identity` (raises on no-token / login-mismatch; `None` when unset).
- **`api.py`**: the four review-write helpers take `env: dict | None = None`, forwarded to `proc.json`; reads untouched.
- **`reviews.py`**: `push` / `_patch_body` / `_post_reply` thread `env=` into the writes only.
- **`commands/push.py`**: resolves the identity once, threads `bot_env` into the body edit + the two top-level comment writes + `reviews.push`, sets the ownership gate's `current_user` to `identity.login`, adds `-a/--as`.
- **`commands/create.py`**: `create_new_pr` / `create_new_issue` route the `gh … create` call as the bot and thread `as_login` → `_finalize_created_item` → `push` for the body edit; adds `-a/--as`.
- **`commands/sync.py`**: `-a/--as` threaded into `push`.

Gist mirror and every read stay on the default account — a pure no-op when no identity is configured.

**Tests**: `tests/github/test_identity.py` — 33 new, exact-equality throughout; full `tests/github/` suite green (233 passed). Live smoke-test against a real second `gh` account (`rbw-bot`) deferred to first real use.
