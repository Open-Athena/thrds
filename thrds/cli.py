"""Command-line interface for `thrds` sessions.

Platform subgroups:

- ``thrds slack …`` — the primary workflow: draft locally in `.md`, sync to
  a Slack staging PC, tweak in-Slack, pull back. Session verbs
  (`init`/`push`/`pull`/`diff`/`archive`/`open`/`list-sessions`/`recover`)
  plus low-level CRUD verbs
  (`history`/`thread`/`rm`/`post`/`edit`/`permalink`).
- ``thrds github …`` — PR/issue clones (the former `ghpr`; also mounted as
  the ``ghpr`` console script).
- ``thrds discord …`` / ``thrds bsky …`` — capture + platform-specific
  MD-compat lint; prod delivery is copy-paste (`render`).
- ``thrds capture …`` — capture-only sessions: git + gist trajectory, no
  platform target. The minimal flow is two commands for a 2-revision gist:
  ``dir=$(echo "$draft" | thrds capture init)``, then
  ``echo "$final" | thrds capture update "$dir"``.

Each session lives in its own directory (ghpr-style:
``<git-root-or-cwd>/slck/<slug>/``) with its own private git repo (nested
`.git/` is invisible to any surrounding project's git). A secret gist created
at init becomes the ``g`` remote; state-mutating verbs auto-commit + push, so
the mirror always reflects the current session state.

Platform is stamped into ``thrds.yml`` at init and every subsequent verb
guards on it: running `thrds slack push` inside a capture-inited session
errors with a clear message rather than blowing up deep inside Slack code.

Slack access is via **either** token type, set in ``THRDS_SLACK_TOKEN``
(``SLACK_THRDS_USER_TOKEN`` is a deprecated alias, still honored with a
one-time warning). The token type determines which verbs are usable:

- **User token** (``xoxp-…``) — required for the **session verbs**
  (``slack init`` / ``push`` / ``pull`` / ``diff`` / ``archive`` /
  ``list-sessions`` / ``recover`` / ``open``). The session workflow's
  point is "draft locally in `.md`, sync to a staging PC, tweak the
  posts in Slack (as you), pull back, push again"; because those
  in-Slack tweaks are your Slack user's own posts, only a token owned
  by you can ``chat.update`` them. See
  `multi-thread-posts-and-capture.md`.
- **Bot token** (``xoxb-…``) — sufficient for the ``slack`` CRUD verbs
  (``history`` / ``thread`` / ``rm`` / ``post`` / ``edit`` /
  ``permalink``) whenever the bot is only editing / deleting its own
  posts (Slack lets ``chat.update`` / ``chat.delete`` touch a bot's
  own messages fine). Also sufficient for programmatic
  ``SlackClient.sync()`` / ``sync_linked()`` when the bot owns the
  content lifecycle end-to-end (the watchy shape: bot renders mrkdwn,
  bot posts, bot reconciles later).

Required scopes (add under **OAuth & Permissions** — under **User Token
Scopes** for a user token, **Bot Token Scopes** for a bot token):

- ``chat:write`` — post + edit + delete messages (all sync + CRUD verbs)
- ``groups:write`` — create + archive staging private channels (``slack init``,
  ``push``, ``archive``); session-verb-only
- ``groups:read`` — read private channel history + resolve names to IDs
- ``channels:read`` — resolve public channel names to IDs (only if you
  push/pull to public channels)
- ``users:read`` — resolve foreign-author names on ``pull``;
  session-verb-only
- ``emoji:read`` — download custom workspace emoji on ``pull``;
  session-verb-only
- ``chat:write.customize`` — per-message sender overrides (``Msg`` with
  ``username`` / ``icon_url`` / ``icon_emoji``, or the CRUD ``post``
  verb's ``-u`` / ``-i`` / ``-e`` flags). Add if you use them.
- ``reactions:read`` — `SenderChangePolicy` pre-flight (`sync` aborts a
  sender-change repost if a target has reactions and
  ``lose_reactions_ok=False``); library-level, not used by any CLI verb.

Metadata visibility is app-scoped (Slack only returns your app's
metadata to your app); no extra scope required for ``slack recover``.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import webbrowser
from importlib import import_module
from pathlib import Path

import click

from . import mirror
from .core import ActionType
from .doc import Doc
from .chrome import split as split_chrome
from .md import diff_docs, diff_texts, parse_doc, serialize_doc, serialize_thread
from .migrate import apply_migration, plan_migration
from .replay import ReplayError, plan_replay, verify_plan, write_replay
from .slack import ScanCapReached, SlackClient
from .state import LEGACY_STATE_PATH, STATE_PATH, SessionState, ThreadTarget
from . import remotes, tracking
from .remotes import Remote
from .threadfile import (
    find_thread,
    parse_thread_filename,
    read_threads,
    slugify,
    thread_filename,
    thread_files,
)


def err(*msg):
    """stderr `print`. A plain function (not `partial(print, file=sys.stderr)`)
    so `sys.stderr` is resolved at call time — click's CliRunner patches it
    per-invocation, and a partial baked-in reference would bypass that."""
    click.echo(" ".join(str(m) for m in msg), err=True)


SLACK_TOKEN_ENV = 'THRDS_SLACK_TOKEN'
SLACK_TOKEN_ENV_DEPRECATED = 'SLACK_THRDS_USER_TOKEN'
# Optional bot token, used only to DM you when a thread is promoted. It has to
# be a *different* identity from the one that posts: a message you authored
# with your own user token is attributed to you and advances your own read
# cursor, so it never produces an unread or a push notification. A bot DM does.
SLACK_BOT_TOKEN_ENV = 'THRDS_SLACK_BOT_TOKEN'

_deprecated_env_warned = False


def _make_slack_client() -> SlackClient:
    """Instantiate a `SlackClient` from ``THRDS_SLACK_TOKEN`` (or the
    deprecated ``SLACK_THRDS_USER_TOKEN`` alias, with a one-time warning).

    Either a user token (``xoxp-…``) or a bot token (``xoxb-…``) works;
    the session verbs require a user token because they edit human-typed
    posts in Slack, while the ``slack`` CRUD verbs and programmatic
    ``SlackClient.sync()`` are fine with either token type (bot fine as
    long as the bot owns the content it's editing / deleting). See the
    module docstring for the full breakdown.

    ``channel`` is initialized to ``""`` — every doc-level method
    (``sync_doc_*``, ``pull_doc_*``) swaps ``self.channel`` internally per
    operation, so the init value doesn't matter.
    """
    global _deprecated_env_warned
    token = os.environ.get(SLACK_TOKEN_ENV)
    if not token:
        token = os.environ.get(SLACK_TOKEN_ENV_DEPRECATED)
        if token and not _deprecated_env_warned:
            err(
                f"warning: {SLACK_TOKEN_ENV_DEPRECATED} is deprecated; "
                f"rename to {SLACK_TOKEN_ENV}. Both are honored for now."
            )
            _deprecated_env_warned = True
    if not token:
        raise click.UsageError(
            f"{SLACK_TOKEN_ENV} not set — add a `xoxp-` (user) or `xoxb-` "
            f"(bot) Slack token to your env. Session verbs (init/push/pull/…) "
            f"need a user token; the `slack` CRUD verbs accept either."
        )
    return SlackClient(token=token, channel="")


def _notify_promoted(client: SlackClient, slug: str, channel: str, message_ts: str) -> None:
    """DM the user that ``slug`` just went out, via the bot token if configured.

    Best-effort by construction: a failure here must never turn a successful
    post into a command that looks failed. Warn and move on.

    Why a bot token rather than the user token already in hand: `promote` posts
    *as you*, and Slack doesn't notify you about your own messages — it marks
    them read as it posts them. A notification therefore requires a second
    identity, and a bot DM is the supported, non-deprecated way to get one.
    """
    bot_token = os.environ.get(SLACK_BOT_TOKEN_ENV)
    if not bot_token:
        err(
            f"  (no {SLACK_BOT_TOKEN_ENV} — no DM sent; posts made with your own "
            f"token don't notify you)"
        )
        return
    try:
        user_id = client.bot_ids[0]
        link = client.permalink(message_ts)
        bot = SlackClient(token=bot_token, channel=user_id)
        bot.post(f"Posted *{slug}* to <#{channel}>: {link}", raw=True)
        err(f"  DM sent to {user_id}")
    except Exception as e:  # noqa: BLE001 — notification must not fail the promote
        err(f"  warning: promote succeeded but DM failed: {e}")


def _load_state(
    expected_platform: str | None = None,
    root: Path | str = '.',
) -> SessionState:
    """Load ``thrds.yml`` from ``root`` (default CWD) or exit clearly.

    ``expected_platform`` (set by every platform-group verb to its own name)
    catches mis-platforming — running ``thrds slack push`` inside a session
    that was inited via ``thrds capture init`` errors immediately with a
    clear message, instead of blowing up deep inside slack-specific code.
    """
    try:
        state = SessionState.load(root)
    except FileNotFoundError as e:
        raise click.UsageError(str(e))
    if expected_platform is not None and state.platform != expected_platform:
        raise click.UsageError(
            f"This session was inited for platform {state.platform!r}; "
            f"use `thrds {state.platform} <verb>` instead of "
            f"`thrds {expected_platform} <verb>`."
        )
    try:
        # Validate the `remotes:` config once, at the door — every later
        # `resolve` call in this invocation sees the same state.
        remotes.resolve(state)
    except ValueError as e:
        raise click.UsageError(f'invalid remotes config in {STATE_PATH}: {e}')
    return state


def _resolve_doc_path(state: SessionState, arg: str | None) -> str:
    """Resolve the doc path: explicit arg wins, else state.doc_path, else error."""
    path = arg if arg is not None else state.doc_path
    if path is None:
        raise click.UsageError(
            "No doc path — pass DOC_PATH or run `thrds <platform> init <doc.md>` first."
        )
    return path


def _load_doc(state: SessionState, arg: str | None) -> Doc:
    """Parse the doc file identified by ``arg`` (or ``state.doc_path``)."""
    path = _resolve_doc_path(state, arg)
    return parse_doc(Path(path).read_text()).doc


def _absorb_file_chrome(
    session_dir: Path,
    threads: list,
    state: SessionState,
    client,
    dry_run: bool,
) -> dict:
    """Take a chrome line written into a thread *file* as a destination, not text.

    Hand-seeding a draft — writing the body in an editor with `→ #chan` at the
    top — is the same gesture as writing one in Slack, and should mean the same
    thing. Left alone it would post as the first line of the message, which is
    both wrong and hard to notice.

    Applies the target to ``state``, drops the line from the thread's OP, and
    rewrites the file without it: chrome's home is the staged message, which a
    push is about to render for real.
    """
    applied: dict[str, ThreadTarget] = {}
    for tf, thread in zip(thread_files(session_dir), threads, strict=True):
        ours = [m for m in thread.messages if m.author is None]
        if not ours:
            continue
        body, chrome = split_chrome(ours[0].content)
        if chrome is None:
            continue
        ours[0].content = body
        resolved = client._resolve_chrome_channel(chrome)
        if resolved is not None:
            target = ThreadTarget(channel=resolved, thread_ts=chrome.thread_ts)
            state.thread(tf.slug).target = target
            applied[tf.slug] = target
        if not dry_run:
            tf.path.write_text(serialize_thread(thread))
    if applied and not dry_run:
        # Persisted here rather than left to the sync: the target is settled
        # the moment it's read, and a sync that fails shouldn't lose it.
        state.save()
    return applied


def _print_sync_summary(kind: str, result) -> None:
    """Human-readable summary of a `DocSyncResult` to stderr."""
    err(f"{kind}: channel={result.channel}")
    if result.preamble_ts:
        err(f"  preamble: {result.preamble_ts}")
    for slug, ts in result.thread_ts_by_slug.items():
        err(f"  {slug}: {ts}")
    if result.deleted_slugs:
        err(f"  deleted (terraform): {result.deleted_slugs}")


def _stage_paths(session_dir: Path, paths: list[str]) -> list[str]:
    """``paths``, plus the legacy `thrds.json` when its deletion needs recording.

    `SessionState.save` migrates a session to `thrds.yml` by writing it and
    unlinking the JSON; the commit that follows must stage that deletion or
    the gist mirror keeps serving stale state under the old name.
    """
    if not mirror.is_git_repo(session_dir):
        return paths
    legacy = str(LEGACY_STATE_PATH)
    if (session_dir / legacy).exists() or not mirror.is_tracked(session_dir, legacy):
        return paths
    return [*paths, legacy]


def _autocommit(session_root: Path, paths: list[str], message: str) -> None:
    """Commit ``paths`` (relative to session_root) and push to gist if configured.

    No-op if ``session_root`` isn't a git repo (rare — only if user manually
    removed `.git/`). No-op if there's no `g` remote (``thrds <p> init --no-gist``).
    """
    if not mirror.is_git_repo(session_root):
        return
    try:
        mirror.commit_and_push(session_root, _stage_paths(session_root, paths), message)
    except mirror.MirrorError as e:
        err(f"warning: mirror commit/push failed: {e}")


def _exclude_state_from_git(session_dir: Path) -> None:
    """Mark the session state files git-excluded (``.git/info/exclude``).

    Used by capture inits: the state stays a local-only file, so the gist
    mirror is purely the doc and its revisions. ``.git/info/exclude`` (not a
    tracked ``.gitignore``) because the exclusion itself shouldn't appear in
    the gist either.
    """
    exclude = session_dir / '.git' / 'info' / 'exclude'
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with exclude.open('a') as f:
        f.write(f'/{STATE_PATH}\n/{LEGACY_STATE_PATH}\n')


def _do_gist_init(target: Path, state: SessionState, slug: str) -> str:
    """Create gist, add remote, align local HEAD, commit + push state.json.

    Shared between the fresh-init path and the resume path — either can leave
    the session in the same "gist populated + state.json committed" end state.
    Returns the new gist_id.
    """
    try:
        gist_id, git_url = mirror.create_gist(
            target,
            description=f'thrds: {slug}',
            files=[f'{slug}.md'],
        )
    except mirror.MirrorError as e:
        raise click.UsageError(
            f"gist creation failed:\n{e}\n\n"
            "Re-run `thrds <platform> init` with `--no-gist` to skip the gist mirror."
        )
    mirror.add_remote(target, state.gist_remote, git_url)
    mirror.align_to_remote(target, remote=state.gist_remote)
    state.gist_id = gist_id
    state.save(target)
    if state.platform != 'capture':
        mirror.commit_and_push(
            target,
            [str(STATE_PATH)],
            f'thrds: init {slug} (gist {gist_id})',
            remote=state.gist_remote,
        )
    # capture: state is a local-only, git-excluded file — the gist's seed
    # commit (just `<slug>.md`) is already the shared history.
    return gist_id


def _do_init(
    doc_path: str | None,
    no_gist: bool,
    channel_prefix: str | None,
    platform: str,
    content: str | None = None,
    slug: str | None = None,
) -> tuple[Path, SessionState, bool]:
    """Shared init flow for every platform's `init` verb.

    Handles slug derivation, target-dir resolution, auto-resume of a partial
    init (matching platform required), fresh-init doc copy/create, `git init`,
    state save, and gist creation (unless ``no_gist``).

    ``content`` seeds the doc directly (capture's stdin mode) instead of
    copying ``doc_path``; ``slug`` overrides derivation from the path stem
    (required when ``doc_path`` is None).

    Returns ``(target, state, was_resume)`` — callers use ``was_resume`` to
    decide which completion hints to print. The resume path itself prints
    only ``Gist created: …`` to stderr and does no other output.
    """
    doc_p = Path(doc_path) if doc_path is not None else None
    if slug is None and doc_p is not None:
        slug = doc_p.stem
    if not slug:
        raise click.UsageError(f"cannot derive a slug from DOC_PATH: {doc_path!r}")
    target = mirror.resolve_session_dir(Path.cwd(), slug, platform)

    if target.exists():
        if not (target / STATE_PATH).is_file() and not (target / LEGACY_STATE_PATH).is_file():
            raise click.UsageError(
                f"Target dir exists but has no {STATE_PATH} — not a thrds session dir: {target}"
            )
        try:
            existing = SessionState.load(target)
        except Exception as e:
            raise click.UsageError(f"Target session dir has an invalid {STATE_PATH}: {e}")
        if existing.platform != platform:
            raise click.UsageError(
                f"Target session dir was inited for platform {existing.platform!r}; "
                f"use `thrds {existing.platform} init` (or delete the dir to reset)."
            )
        if existing.gist_id is not None:
            raise click.UsageError(
                f"Target session dir already fully initialized (gist_id={existing.gist_id}): {target}\n"
                f"Use `thrds {platform} open` to browse, or delete the dir and re-run to reset."
            )
        if no_gist:
            # gist_id=None + --no-gist = re-running the same intent; nothing to do.
            raise click.UsageError(
                f"Target session dir already exists (no-gist mode): {target}"
            )
        err(f"Resuming partial init at {target} (gist step)...")
        gist_id = _do_gist_init(target, existing, slug)
        err(f"Gist created: https://gist.github.com/{gist_id}")
        return target, existing, True

    target.mkdir(parents=True)

    dest_md = target / f'{slug}.md'
    if content is not None:
        dest_md.write_text(content)
    elif doc_p is not None and doc_p.exists() and doc_p.is_file():
        dest_md.write_text(doc_p.read_text())
    else:
        # Empty placeholder — user edits before first push.
        dest_md.write_text('')

    state = SessionState.new(
        doc_path=f'{slug}.md',
        channel_prefix=channel_prefix,
        platform=platform,
    )
    mirror.init_repo(target)
    if platform == 'capture':
        # Capture gists exist to publish the doc's revision arc; the state
        # file has no cross-machine payload here (no slug→thread_ts maps to
        # sync), so keep it out of git history — and thus out of the gist.
        _exclude_state_from_git(target)
    # Save state.json BEFORE anything that can fail (gist creation, network,
    # `gh` auth). If a subsequent step blows up, the target dir has a
    # detectable "partial init" marker (state.json with gist_id=None) that
    # a re-run of `thrds <platform> init` picks up as resumable.
    state.save(target)

    if no_gist:
        paths = [f'{slug}.md'] if platform == 'capture' else [f'{slug}.md', str(STATE_PATH)]
        mirror.commit(target, paths, f'thrds: init {slug}')
    else:
        # Gist-mirrored path: create gist FIRST (it seeds an initial commit
        # from the doc), align local HEAD to that commit, then re-save
        # state.json (now with gist_id) as our fast-forward commit on top.
        # This way local and gist share the same history from commit 1.
        _do_gist_init(target, state, slug)

    return target, state, False


def _print_init_completion(target: Path, state: SessionState, extra_hint: str | None = None) -> None:
    """Standard end-of-fresh-init stderr hints: session id, optional
    platform-specific line, cd hint. Not called on resume."""
    err(f"Initialized session {state.session_id} at {target}")
    if extra_hint:
        err(extra_hint)
    try:
        rel = target.relative_to(Path.cwd())
        err(f"cd {rel} to work on this doc")
    except ValueError:
        # target isn't under cwd (git-root was above cwd). Print absolute.
        err(f"cd {target} to work on this doc")


def _scan_bounds(
    cursor: str | None,
    oldest_days: float | None,
    latest_days: float | None,
    max_pages: int,
) -> tuple[float | None, float | None, str | None, int | None]:
    """Validate + resolve the scan-window CLI flags.

    Returns ``(oldest_ts, latest_ts, cursor, effective_max_pages)`` — days
    are converted to unix timestamps against `time.time()` at call time,
    `max_pages=0` maps to `None` (uncapped). Raises `UsageError` on invalid
    combinations (currently just `--cursor` + `--latest-days`).
    """
    if cursor is not None and latest_days is not None:
        raise click.UsageError('--cursor and --latest-days are mutually exclusive (both specify where to start).')
    now = time.time()
    oldest_ts = now - oldest_days * 86400 if oldest_days is not None else None
    latest_ts = now - latest_days * 86400 if latest_days is not None else None
    return oldest_ts, latest_ts, cursor, (max_pages if max_pages > 0 else None)


def _scan_sessions(
    channel: str,
    oldest_ts: float | None,
    latest_ts: float | None,
    cursor: str | None,
    max_pages: int | None,
) -> 'tuple[dict[str, object], str]':
    """Run `scan_thrds_metadata` with a progress log; translate
    `ScanCapReached` to a `UsageError` after surfacing the resume cursor
    on its own stderr line. Shared between `recover` and `list-sessions`.

    Returns ``(sessions, resolved_channel_id)`` — resolving the channel
    name up front means downstream code (state writeback, doc pull) all
    use the ID consistently.
    """
    client = _make_slack_client()
    channel = _resolve_channel(client, channel)
    total_msgs = 0

    def on_page(page_num: int, msg_count: int) -> None:
        nonlocal total_msgs
        total_msgs += msg_count
        err(f'  scan page {page_num}: {msg_count} msgs (total {total_msgs})')

    try:
        sessions = client.scan_thrds_metadata(
            channel,
            oldest=oldest_ts,
            latest=latest_ts,
            cursor=cursor,
            max_pages=max_pages,
            on_page=on_page,
        )
    except ScanCapReached as e:
        # Cursor on its own line — easy to grep out of the surrounding text.
        if e.next_cursor:
            err(f'  next cursor: {e.next_cursor}')
        raise click.UsageError(str(e))
    return sessions, channel


def _print_sessions_table(sessions: dict, channel: str) -> None:
    """Emit a newest-first table of `{sid: RecoveredSession}` to stderr.

    Header + rows aligned by fixed-width columns. Used by both the
    `list-sessions` command (unconditionally) and `recover` (when >1
    session in the channel forces disambiguation).
    """
    err(f'  {"session_id":<40}  {"doc_slug":<24}  threads  newest_ts')
    for sid, sess in sorted(sessions.items(), key=lambda kv: float(kv[1].newest_ts), reverse=True):
        err(f'  {sid:<40}  {sess.doc_slug:<24}  {sess.thread_count:>7}  {sess.newest_ts}')


def _resolve_channel(client, ref: str) -> str:
    """Resolve a channel reference to a Slack channel ID (``C…``).

    Accepts:
    - Bare Slack ID (``C…`` / ``G…``): passthrough. Detection: first char
      is uppercase — Slack channel names are always lowercase, so an
      uppercase-starting ref cannot be a name. Cheap + unambiguous.
    - ``#name`` or ``name``: looked up via
      :meth:`SlackClient.list_channels_by_name`, case-insensitive.

    Raises :class:`click.UsageError` on missing scope (``channels:read``
    or ``groups:read``) or unknown name — with a hint listing the first
    few names the token *can* see.
    """
    if ref and ref[0].isupper():
        return ref
    name = ref.lstrip('#').lower()
    try:
        channels = client.list_channels_by_name()
    except RuntimeError as e:
        if 'missing_scope' in str(e):
            raise click.UsageError(
                f'Channel-name lookup requires `channels:read` (public) or '
                f'`groups:read` (private) scope on the token. Pass a Slack ID '
                f'(`C…`) instead, or add the scope. (Slack error: {e})'
            )
        raise
    cid = channels.get(name)
    if cid is None:
        preview = sorted(channels)[:5]
        raise click.UsageError(
            f'Channel {ref!r} not found. Pass a Slack ID (C…) or an exact '
            f'name (with or without leading #). Available (first 5 of '
            f'{len(channels)}): {preview}'
        )
    return cid


def _channel_url(channel_id: str) -> str:
    """Build the Slack workspace URL for a channel from its ID.

    Uses the auth'd workspace (via `auth.test`) so the URL points at the
    same workspace the token belongs to. The web URL takes a channel ID as
    the path segment and Slack redirects appropriately.
    """
    client = _make_slack_client()
    # `auth.test` returns `url`: `https://<workspace>.slack.com/`.
    workspace_url = client._request('auth.test', {}, method='GET')['url'].rstrip('/')
    return f'{workspace_url}/archives/{channel_id}'


# --- Low-level Slack CRUD helpers (shared by `slack {history,thread,rm,post,edit,permalink}`) ---
#
# Motivation + full design in `specs/done/slack-crud-cli.md`. Six verbs that
# wrap `SlackClient` primitives one-to-one for scripting and ad-hoc CRUD, so
# throwaway `_request` heredocs stop reappearing. Deliberate divergence from
# the session verbs: `post`/`edit` default to **raw mrkdwn** (no `to_slack()`
# md→mrkdwn conversion), with `-m/--markdown` to opt into the session-verb
# behavior. See `specs/done/raw-mrkdwn-passthrough.md` for the underlying
# `raw=` kwarg.

_CRUD_TS_MAX_TEXT = 100


def _crud_client(channel_ref: str) -> SlackClient:
    """Build a `SlackClient` with `self.channel` resolved from ``channel_ref``.

    Every CRUD verb ends up making at least one call that reads
    ``self.channel`` (delete / post / edit / permalink); centralize the
    resolve + assignment so each verb stays a one-liner.
    """
    client = _make_slack_client()
    client.channel = _resolve_channel(client, channel_ref)
    return client


def _crud_sender(msg: dict) -> str:
    """Compact "sender" column for `slack history` / `slack thread` display.

    Preference order: explicit ``username`` (per-message override, e.g. a
    ``chat.postMessage`` with ``username=…``) → ``user`` (Slack user ID
    ``U…``) → ``bot_id`` (``B…`` for bot-authored posts). Falls back to
    ``?`` if none present (should be rare). No `users.info` resolution
    here — the CRUD CLI is a low-level view; ``-j/--json`` gives the full
    dict if the caller wants the resolved name.
    """
    return (
        msg.get("username")
        or msg.get("user")
        or msg.get("bot_id")
        or "?"
    )


def _crud_first_line(text: str) -> str:
    """Return the first non-empty line of ``text`` truncated to a display width.

    The ``history`` / ``thread`` tables show one line per message; long
    messages get elided with ``…`` at ``_CRUD_TS_MAX_TEXT`` chars. Empty
    messages (image-only / edited-to-empty) render as an empty string
    so the row still lines up.
    """
    for line in text.splitlines():
        stripped = line.rstrip()
        if stripped:
            if len(stripped) > _CRUD_TS_MAX_TEXT:
                return stripped[: _CRUD_TS_MAX_TEXT - 1] + "…"
            return stripped
    return ""


def _crud_render_messages(msgs: list[dict]) -> str:
    """Render a table of ``ts  sender  text`` lines from raw Slack msg dicts.

    Sender column is left-padded to the max sender width seen this call,
    so rows align without depending on a fixed magic number (channels
    with only long custom sender names look OK; bot-heavy channels stay
    tight).
    """
    if not msgs:
        return ""
    senders = [_crud_sender(m) for m in msgs]
    sender_w = max(len(s) for s in senders)
    lines = []
    for m, sender in zip(msgs, senders):
        ts = m.get("ts", "?")
        text = _crud_first_line(m.get("text", "") or "")
        lines.append(f"{ts}  {sender:<{sender_w}}  {text}")
    return "\n".join(lines)


_LAZY_SUBGROUPS = {
    # name → (module, attribute, short help for `thrds --help`)
    'github': (
        '.platforms.github.cli', 'cli',
        'GitHub PR/issue clones (the former `ghpr`).',
    ),
}


class _LazyGroup(click.Group):
    """Top-level group whose heavier subgroups import on first use.

    `thrds github` reaches ghpr's code, which imports `utz` — ~400ms, nearly
    all of it pandas and IPython pulled in by `utz/__init__`. Eagerly mounting
    the group would bill that to every `slck` invocation for verbs it never
    touches, so the import is deferred to the point a `github` verb actually
    runs. The cost of deferring is the short help duplicated in
    `_LAZY_SUBGROUPS`: `thrds --help` has to list the group without importing
    it, so that one string is the thing to keep in sync.
    """

    def list_commands(self, ctx):
        return sorted([*super().list_commands(ctx), *_LAZY_SUBGROUPS])

    def get_command(self, ctx, name):
        if (lazy := _LAZY_SUBGROUPS.get(name)) is not None:
            module, attr, _ = lazy
            return getattr(import_module(module, __package__), attr)
        return super().get_command(ctx, name)

    def format_commands(self, ctx, formatter):
        rows = []
        for name in self.list_commands(ctx):
            if (lazy := _LAZY_SUBGROUPS.get(name)) is not None:
                rows.append((name, lazy[2]))
                continue
            cmd = super().get_command(ctx, name)
            if cmd is not None and not cmd.hidden:
                rows.append((name, cmd.get_short_help_str(45)))
        if rows:
            with formatter.section('Commands'):
                formatter.write_dl(rows)


@click.group(cls=_LazyGroup)
def cli():
    """`thrds`: draft threaded posts locally; sync to a platform, or capture-only.

    Subgroups: ``slack`` (Slack session + CRUD verbs), ``discord``, ``bsky``,
    ``github`` (PR/issue clones — the former `ghpr`), ``capture`` (gist-only
    trajectory, no platform target). Every session's platform is stamped
    into `thrds.yml` at init and enforced on subsequent verbs.
    """
    pass


# ============================================================================
# `thrds slack …` subgroup — session verbs + low-level CRUD.
# ============================================================================


@cli.group("slack")
def slack_cli():
    """Slack workflow: `init`/`push`/`pull`/`diff`/`archive`/`open`/`list-sessions`/`recover`
    plus low-level CRUD (`history`/`thread`/`rm`/`post`/`edit`/`permalink`).

    Session verbs draft locally in `.md`, sync to a staging PC in Slack, let
    you tweak in-Slack, pull back. CRUD verbs wrap `SlackClient` primitives
    one-to-one (post/edit default to raw mrkdwn; pass `-m` to opt into local
    md → mrkdwn conversion — reverse of the session verbs' default).
    """
    pass


@slack_cli.command("init")
@click.option('-G', '--no-gist', is_flag=True, help='Skip gist creation; local git repo only.')
@click.option('-p', '--prefix', help='Staging PC channel-name prefix override (else `THRDS_CHANNEL_PREFIX` env, else empty).')
@click.argument('doc_path')
def slack_init(no_gist: bool, prefix: str | None, doc_path: str):
    """Initialize a `thrds slack` session for DOC_PATH (a `.md` file).

    Creates ``<git-root-or-cwd>/slck/<slug>/`` (ghpr-style), copies or
    creates the doc there, `git init`s the session dir, and by default
    creates a secret gist and adds it as the ``g`` remote.

    Auto-resume: if the target dir already exists and holds a valid
    ``thrds.yml`` (matching platform) with ``gist_id: null``, finishes
    the gist-creation step instead of refusing (recovers from an earlier
    init that failed at the gist step — e.g. network hiccup, `gh` unauth'd).
    """
    target, state, was_resume = _do_init(doc_path, no_gist, prefix, platform='slack')
    if was_resume:
        return
    _print_init_completion(
        target, state,
        extra_hint=f"Staging PC name (on first push): {state.staging_channel_name()}",
    )


def _ensure_refs(session_dir: Path, state: SessionState) -> None:
    """Adopt the pre-named-remotes ref layout on first touch.

    `refs/remotes/<platform>/{staging,prod,remote}` →
    `refs/remotes/{staging,prod}` + `refs/heads/upstream` (converged with
    ghpr: remote-name-first, and the composite out of `refs/remotes/`
    entirely, since it isn't one). Quiet when there's nothing to move.

    Also seeds the push gate's base refs once, for sessions that predate them
    — otherwise their first push after the upgrade would be ungated. See
    `tracking.seed_base_refs`.
    """
    for old, new in tracking.migrate_refs(session_dir, state.platform):
        err(f'ref migrated: {old} → {new}')
    seeded = tracking.seed_base_refs(session_dir, list(remotes.resolve(state)))
    if seeded:
        err(f"gate base seeded from last observation: {', '.join(seeded)}")


def _stored_files(session_dir: Path, state: SessionState, name: str) -> dict[str, str]:
    """A remote's last-observed files, from its stored ref ({} if never set)."""
    ref = tracking.ref_name(name)
    if tracking.read_ref(session_dir, ref) is None:
        return {}
    return tracking.tree_files(session_dir, ref)


def _merged_observations(
    session_dir: Path,
    state: SessionState,
    fresh: dict[str, dict[str, str]],
) -> dict[str, str]:
    """Every remote's files, merged in resolve order — ``fresh`` where this
    round observed a remote, its stored ref otherwise. No API reads."""
    merged: dict[str, str] = {}
    for name in remotes.resolve(state):
        merged.update(
            fresh[name] if name in fresh
            else _stored_files(session_dir, state, name)
        )
    return merged


def _mark_incorporated_if_synced(
    session_dir: Path,
    remote: Remote,
    observed: dict[str, str],
    sha: str,
) -> bool:
    """Advance the remote's gate base iff the observation already matches local.

    An observation that comes back identical to what we hold *is* incorporation
    — there is nothing left to pull — so it may move the base. An observation
    that differs may not, however many times it is repeated; that asymmetry is
    the entire mechanism keeping `push`'s gate from clearing itself, so this is
    the only place other than a reconcile or a completed push allowed to move
    a base ref. See `tracking.base_ref_name`.

    Compared against the working tree rather than HEAD because the gate runs
    before push's auto-commit, so the tree is what a push would send.
    """
    for name, text in observed.items():
        path = session_dir / name
        if (path.read_text() if path.exists() else '') != text:
            return False
    tracking.set_base(session_dir, remote.name, sha)
    return True


def _mark_pull_incorporated(session_dir: Path, state: SessionState) -> None:
    """After a successful reconcile, HEAD holds what each remote was observed
    to hold, so every gate base advances to its observation ref.

    This is the one thing that legitimately clears a `push` refusal — which is
    why it lives at the end of `pull`, after the reconcile has actually landed,
    and not next to the fetch that merely saw the divergence.
    """
    for name, rmt in remotes.resolve(state).items():
        if (sha := tracking.read_ref(session_dir, rmt.ref)) is not None:
            tracking.set_base(session_dir, name, sha)


def _gate_push(
    client: SlackClient,
    state: SessionState,
    session_dir: Path,
    remote: Remote,
    force: bool,
) -> None:
    """Refuse to overwrite remote state we've never seen — the non-fast-forward
    rejection a real git server gives for free.

    One read of the remote, compared against its tracking ref: threads Slack
    changed since our last fetch, intersected with what this push would
    rewrite. Detection is per-thread (that's what makes the message
    actionable) but refusal is whole-push — cross-thread `#slug` refs mean a
    partial push can publish a link whose target doesn't yet say what the link
    promises. `slck push <slug>` scoping and `--force` are the explicit outs.

    The comparison is against what HEAD has **incorporated** from this remote
    (`base_ref`), never against what we last *saw* there. Those differ exactly
    when it matters: a refusal advances the observation ref, so gating on
    "changed since I last looked" would make the refusal itself the thing the
    retry compares against — the second push would sail through and overwrite
    the edit the first one refused to touch, with nothing about the danger
    having changed. Only a reconcile (or a push of our own) moves the base, so
    only those clear the gate. See `specs/push-gate-ancestry.md`.

    With nothing incorporated yet there is nothing to gate against, and pushing
    *is* the explicit "local wins" bootstrap resolution, so it proceeds. The
    observed state advances the observation ref either way: it's an
    observation, and it's what lets `diff`/`pull` classify after a refusal.
    """
    base = tracking.read_ref(session_dir, remote.base_ref)
    observed = remotes.observe(remote, client, state, session_dir)
    snap = tracking.snapshot(
        session_dir, remote.ref, remote.name,
        tracking.build_tree(session_dir, observed),
        f'thrds: fetch {remote.name}',
    )
    _mark_incorporated_if_synced(session_dir, remote, observed, snap.sha)
    if base is None:
        return
    paths = tracking.changed_paths(session_dir, f'{base}^{{tree}}', snap.tree)
    if not paths:
        return
    would_write = set()
    for name, remote_text in observed.items():
        path = session_dir / name
        if (path.read_text() if path.exists() else '') != remote_text:
            would_write.add(name)
    hit = sorted(set(paths) & would_write)
    if not hit:
        return
    if not force:
        raise click.ClickException(
            f"changed in {remote.name} since your last pull: {', '.join(hit)}. "
            f'`slck pull` to reconcile, or `-f`/`--force` to overwrite.'
        )
    err(f"--force: overwriting {remote.name} changes in {', '.join(hit)}")


def _verify_push(
    client: SlackClient,
    state: SessionState,
    session_dir: Path,
    remote: Remote,
) -> None:
    """Advance the refs to Slack's *observed* post-push state, not to HEAD.

    Our writes are a projection — Slack normalizes mrkdwn, resolves emoji —
    so recording HEAD as remote state would make the next fetch report a
    spurious delta every cycle, and the gate built on the nop property would
    cry wolf. Reading back costs one fetch of the remote; observed-vs-intended
    drift is reported (it's the interference-or-normalization signal) but
    observed is what gets recorded. Truth over intent.
    """
    names = {f.slug: f.name for f in thread_files(session_dir)}
    observed = remotes.observe(remote, client, state, session_dir)
    staged = {
        names[slug] for slug, e in state.threads.items()
        if (p := e.remotes.get(remote.name)) is not None and p.ts is not None
        and slug in names
    }
    drift = []
    for name in sorted(staged | set(observed)):
        path = session_dir / name
        local = path.read_text() if path.exists() else None
        if local != observed.get(name):
            drift.append(name)
    if drift:
        err(
            f"note: Slack's stored copy differs from what was sent "
            f"({', '.join(drift)}); refs record the observed state"
        )
    snap = tracking.snapshot(
        session_dir,
        remote.ref, remote.name,
        tracking.build_tree(session_dir, observed),
        f'thrds: fetch {remote.name}',
    )
    # A completed push is incorporation by construction: this state is the one
    # we just sent (plus whatever Slack normalized, reported above), so the
    # gate must not fire on it next time.
    tracking.set_base(session_dir, remote.name, snap.sha)
    _refresh_composite(
        session_dir, state,
        _merged_observations(session_dir, state, {remote.name: observed}),
    )


@slack_cli.command("push")
@click.option('-c', '--channel', help='Prod channel override (legacy sessions only).')
@click.option('-f', '--force', is_flag=True, help='Push even if staging changed since the last pull (overwrites those changes).')
@click.option('-k', '--keep-staging', is_flag=True, help='Do not auto-archive the staging PC after --prod (legacy).')
@click.option('-n', '--dry-run', is_flag=True, help='Show plan without side effects.')
@click.option('-p', '--prod', is_flag=True, help='Push to prod (legacy sessions only; use `promote` instead).')
@click.option('-r', '--remote', 'remote_name', help='Staging-role remote to push to (default: staging).')
@click.argument('doc_path', required=False)
def slack_push(channel: str | None, force: bool, keep_staging: bool, dry_run: bool, prod: bool, remote_name: str | None, doc_path: str | None):
    """Push this session's threads to a staging-role remote (terraform).

    On a per-thread session, pushes every `NN-slug.md` and takes no `--prod`:
    promoting to a real channel is per-thread and deliberate, via
    `thrds slack promote <slug>`. `-r` picks a declared staging-role remote
    (`remotes:` in thrds.yml); default is the session's staging PC.

    On a git session the push is gated and transactional: it refuses if
    the remote changed since your last pull (`--force` overrides),
    auto-commits *before* writing so what goes to Slack is exactly a
    commit's content, and afterwards records Slack's observed state in the
    tracking refs.

    `--prod` remains only for legacy single-doc sessions that haven't been
    through `thrds slack migrate` yet.
    """
    state = _load_state(expected_platform='slack')
    client = _make_slack_client()

    if not state.is_legacy:
        if prod or channel is not None or keep_staging:
            raise click.UsageError(
                'Per-thread sessions push only to staging; use '
                '`thrds slack promote <slug>` to post a thread to its target.'
            )
        session_dir = Path.cwd()
        files = thread_files(session_dir)
        parsed = read_threads(session_dir)
        if not parsed:
            raise click.UsageError('No thread files (`NN-slug.md`) in this session.')
        threads = [p.thread for p in parsed]
        frontmatter_by_slug = {p.thread.slug: p.frontmatter for p in parsed}
        for slug, target in _absorb_file_chrome(session_dir, threads, state, client, dry_run).items():
            where = target.channel + (f' @ {target.thread_ts}' if target.thread_ts else '')
            err(f"targeted {slug} → {where} (from a chrome line in its file)")

        is_git = mirror.is_git_repo(session_dir)
        if is_git:
            _ensure_refs(session_dir, state)
        names = {f.slug: f.name for f in files}
        rmts = remotes.resolve(state)
        name = remote_name if remote_name is not None else tracking.STAGING
        if name not in rmts:
            raise click.UsageError(
                f"unknown remote {name!r}; this session has: {', '.join(rmts)}."
            )
        rmt = rmts[name]
        if rmt.role != tracking.STAGING:
            raise click.UsageError(
                f'remote {name!r} is prod-role; `slck promote <slug>` posts a '
                f'thread to its target.'
            )
        if is_git and not dry_run:
            _gate_push(client, state, session_dir, rmt, force)
            # Commit-first: what goes to Slack is exactly a commit's content
            # (git pushes commits, not working trees — ghpr's Contract A, the
            # correct side of that fork). The auto-commit UX survives; only
            # the ordering changes.
            content_sha = mirror.commit(
                session_dir, [f.name for f in files], f'thrds: push {rmt.name}',
            )
        result = client.sync_threads_staging(
            threads, state, dry_run=dry_run,
            filenames=names, remote=rmt,
            frontmatter_by_slug=frontmatter_by_slug,
        )
        _print_sync_summary(f'pushed to {rmt.name}' + (' (dry-run)' if dry_run else ''), result)
        if not dry_run:
            paths = _stage_paths(
                session_dir,
                [f.name for f in thread_files(session_dir)] + [str(STATE_PATH)],
            )
            if not is_git:
                return
            try:
                if content_sha is not None:
                    # Fold the state this push produced (staging_ts, targets)
                    # into the same commit; nothing external saw the SHA yet.
                    mirror.amend(session_dir, paths)
                else:
                    mirror.commit(session_dir, paths, f'thrds: push {rmt.name}')
                mirror.push(session_dir)
            except mirror.MirrorError as e:
                err(f"warning: mirror commit/push failed: {e}")
            _verify_push(client, state, session_dir, rmt)
        return

    if remote_name is not None:
        raise click.UsageError('-r/--remote applies to per-thread sessions only.')
    doc = _load_doc(state, doc_path)
    if not prod and channel is not None:
        raise click.UsageError('--channel requires --prod.')
    if not prod and keep_staging:
        raise click.UsageError('--keep-staging requires --prod.')
    if channel is not None:
        channel = _resolve_channel(client, channel)
    if prod:
        result = client.sync_doc_prod(
            doc, state,
            channel=channel,
            keep_staging=keep_staging,
            dry_run=dry_run,
        )
        mode = 'prod'
    else:
        result = client.sync_doc_staging(doc, state, dry_run=dry_run)
        mode = 'staging'
    _print_sync_summary(f'pushed to {mode}' + (' (dry-run)' if dry_run else ''), result)
    if prod and not dry_run and not keep_staging and state.staging_channel is not None:
        err(f"  archived staging PC: {state.staging_channel}")
    if not dry_run:
        doc_rel = _resolve_doc_path(state, doc_path)
        _autocommit(
            Path.cwd(),
            [doc_rel, str(STATE_PATH)],
            f'thrds: push {mode}',
        )


def _refresh_composite(
    session_dir: Path,
    state: SessionState,
    files: dict[str, str],
) -> tracking.Snapshot:
    """Advance `upstream` after a write verb's commit: threads as observed
    (``files``, every remote's contribution already merged in resolve order —
    see `_merged_observations`), passthrough files from the *new* HEAD. No API
    reads — the thread content is a fetch the verb already did. Without this,
    every pull leaves `git diff upstream HEAD` dangling on the
    `thrds.yml` the pull itself committed."""
    return tracking.snapshot(
        session_dir,
        tracking.ref_name(tracking.COMPOSITE),
        tracking.COMPOSITE,
        _composite_tree(session_dir, files),
        f'thrds: fetch {tracking.COMPOSITE}',
    )


def _reconcile_pull(
    session_dir: Path,
    state: SessionState,
    mode: str,
    comp_snap: "tracking.Snapshot",
    renames: list[tuple[Path, Path]],
    adopted: list,
) -> None:
    """Bring thread files onto the fetched state, preserving local commits.

    Three-way merge (`merge_trees`) of base = last-fetched composite, ours =
    HEAD, theirs = the fresh fetch. A conflict aborts before writing anything:
    conflict markers in a thread file would be *posted to Slack* by a later
    sync, so refusal is the only safe rendering — and the composite ref is
    deliberately still at the old base (see `_fetch_refs`), so retrying
    reproduces the conflict instead of forgetting it.

    Only thread files are materialized from the merged tree. `thrds.yml` is
    in there too, but it's HEAD's copy — the in-memory state (chrome edits,
    adoptions) supersedes it and is saved separately.
    """
    base, fetched = comp_snap.base, comp_snap.sha
    written: list[str] = []
    deleted: list[str] = []
    if base is not None and fetched != base:
        merge = tracking.merge_trees(session_dir, base, 'HEAD', fetched)
        if merge.conflicts:
            raise click.ClickException(
                f"CONFLICT in {', '.join(merge.conflicts)} — Slack and local "
                f'commits both changed since the last fetch. `slck pull -m '
                f'overwrite` (Slack wins), or resolve locally and `slck push` '
                f'(local wins); `git diff staging HEAD` shows both sides.'
            )
        in_tree = {
            n for n in tracking.tree_names(session_dir, merge.tree)
            if parse_thread_filename(n) is not None
        }
        on_disk = {tf.name for tf in thread_files(session_dir)}
        for name in sorted(in_tree | on_disk):
            path = session_dir / name
            new = (
                tracking.read_tree_file(session_dir, merge.tree, name)
                if name in in_tree else None
            )
            cur = path.read_text() if path.exists() else None
            if new == cur:
                continue
            if new is None:
                path.unlink()
                deleted.append(name)
            else:
                path.write_text(new)
                written.append(name)

    for src, dst in renames:
        src.rename(dst)
    for a in adopted:
        (session_dir / a.filename).touch()
    state.save()

    if written or deleted:
        parts = []
        if written:
            parts.append(f"updated {len(written)}: {', '.join(written)}")
        if deleted:
            parts.append(f"deleted {len(deleted)}: {', '.join(deleted)}")
        err(f"{'; '.join(parts)} (local commits preserved)")
    else:
        err('no content changes from Slack')

    emoji_paths = [p.name for p in session_dir.glob('emoji-*') if p.is_file()]
    removed = [src.name for src, _ in renames]
    added = [dst.name for _, dst in renames]
    paths = _stage_paths(
        session_dir,
        [*written, *deleted, *removed, *added, str(STATE_PATH), *emoji_paths],
    )
    if mode == 'merge' and base is not None and fetched != base:
        # The commit records the fetched snapshot as its second parent — the
        # branch's history connects to the remote state it reconciled against.
        try:
            mirror.commit_merge(session_dir, paths, 'thrds: pull staging', fetched)
            mirror.push(session_dir)
        except mirror.MirrorError as e:
            err(f"warning: mirror commit/push failed: {e}")
    else:
        _autocommit(session_dir, paths, 'thrds: pull staging')


PULL_MODES = ('rebase', 'merge', 'overwrite')


def _resolve_pull_mode(mode: str | None, session_dir: Path, is_git: bool) -> str:
    """The reconcile mode: flag, else `git config thrds.pullMode`, else rebase.

    Non-git sessions have no refs to reconcile against, so they're always
    `overwrite` — today's write-what-Slack-says behavior — and asking for
    anything else there is an error rather than a silent downgrade.
    """
    if mode is None:
        if not is_git:
            return 'overwrite'
        mode = tracking.config_get(session_dir, 'thrds.pullMode') or 'rebase'
        if mode not in PULL_MODES:
            raise click.UsageError(
                f'git config thrds.pullMode is {mode!r}; '
                f"expected one of: {', '.join(PULL_MODES)}"
            )
        return mode
    if not is_git and mode != 'overwrite':
        raise click.UsageError(
            f'-m {mode} needs a git session (no refs to reconcile against).'
        )
    return mode


def _dirty_tracked(session_dir: Path) -> list[str]:
    """Tracked files with uncommitted changes (untracked drafts don't count)."""
    r = subprocess.run(
        ['git', 'status', '--porcelain', '--untracked-files=no'],
        cwd=session_dir, capture_output=True, text=True,
    )
    return [line[3:] for line in r.stdout.splitlines() if line.strip()]


@slack_cli.command("pull")
@click.option('-c', '--channel', help='Prod channel override (only with --prod).')
@click.option('-m', '--mode', type=click.Choice(PULL_MODES), default=None, help='Reconcile fetched state with local content (default: `git config thrds.pullMode`, else rebase; non-git sessions are always overwrite).')
@click.option('-n', '--dry-run', is_flag=True, help='Print the pulled state to stdout instead of writing files.')
@click.option('-p', '--prod', is_flag=True, help='Pull from prod channel.')
@click.argument('doc_path', required=False)
def slack_pull(channel: str | None, mode: str | None, dry_run: bool, prod: bool, doc_path: str | None):
    """Pull the doc's current state from Slack. Default: staging PC.

    On a per-thread git session this is fetch + reconcile: the tracking refs
    advance to what Slack says, then local content is brought onto that state
    per `--mode`. `rebase` (default) three-way merges against the last-fetched
    base, so a local edit Slack hasn't seen survives instead of being silently
    overwritten — a genuine conflict (both sides changed) aborts with the file
    list rather than writing conflict markers a later `push` would post.
    `merge` is the same reconcile but the commit records the fetched snapshot
    as a second parent. `overwrite` is the old behavior: Slack wins, stated
    explicitly.

    Auto-commits + pushes to the gist mirror — the mirror image of ``push``.
    With ``--dry-run`` the pulled state is printed to stdout (frontmatter
    omitted), refs are previewed but not moved, and nothing is written.
    """
    write = not dry_run
    state = _load_state(expected_platform='slack')
    if not prod and channel is not None:
        raise click.UsageError('--channel requires --prod.')
    if mode is not None and state.is_legacy:
        raise click.UsageError('-m/--mode applies to per-thread sessions only.')
    client = _make_slack_client()
    if channel is not None:
        channel = _resolve_channel(client, channel)
    session_dir = Path.cwd()

    if not state.is_legacy:
        if prod:
            raise click.UsageError(
                'Per-thread sessions pull from staging only; a promoted thread '
                'is tracked by its `posted_ts`.'
            )
        is_git = mirror.is_git_repo(session_dir)
        if is_git:
            _ensure_refs(session_dir, state)
        mode = _resolve_pull_mode(mode, session_dir, is_git)
        if write and mode != 'overwrite':
            if dirty := _dirty_tracked(session_dir):
                raise click.ClickException(
                    f"{len(dirty)} file(s) with uncommitted changes; `-m {mode}` "
                    f"reconciles committed state and would mix them in: "
                    f"{', '.join(dirty)}. Commit them (or `-m overwrite`)."
                )

        rmts = remotes.resolve(state)
        threads = client.pull_thread_states(
            rmts[tracking.STAGING], state, session_dir=session_dir,
        )
        files = {f.slug: f.name for f in thread_files(session_dir)}
        renames: list[tuple[Path, Path]] = []
        for slug, edit in client.pull_chrome_edits(state, files).items():
            if edit.target_now is not None:
                where = edit.target_now.channel + (
                    f' @ {edit.target_now.thread_ts}' if edit.target_now.thread_ts else ''
                )
                err(f"retargeted {slug} → {where} (edited in Slack)")
            if edit.renamed_to is not None:
                renames.append((session_dir / files[slug], session_dir / edit.renamed_to))
                err(f"renamed {files[slug]} → {edit.renamed_to} (edited in Slack)")

        adopted = client.adopt_new_staging_threads(state, session_dir)
        for a in adopted:
            err(f"adopted {a.filename} (written straight into staging)")

        by_slug = {t.slug: t for t in threads}
        by_slug.update({a.slug: a.thread for a in adopted})
        # Promoted threads: prod is canonical (hand-edits happen there), so it
        # overrides whatever the frozen staging copy says. Staging is NOT
        # re-synced to match — the staged copy is a drafting artifact.
        prod_threads = client.pull_thread_states(
            rmts[tracking.PROD], state, session_dir=session_dir,
        )
        for t in prod_threads:
            by_slug[t.slug] = t
            err(f"pulled prod state for {t.slug} (posted)")

        # The same fetched content feeds the refs and the reconcile — one
        # round of API reads, never two views of a moving target.
        comp_snap: tracking.Snapshot | None = None
        if is_git:
            def render(ts) -> dict[str, str]:
                return {
                    files.get(t.slug, f'{t.slug}.md'): serialize_thread(t)
                    for t in ts if t.messages
                }
            staging_files = render(threads)
            staging_files.update({
                a.filename: serialize_thread(a.thread) for a in adopted
            })
            comp_snap = _fetch_refs(
                session_dir, state,
                {tracking.STAGING: staging_files, tracking.PROD: render(prod_threads)},
                write=write,
                # The base advances only after a successful reconcile; see
                # `_fetch_refs` for why moving it first would eat conflicts.
                write_composite=(mode == 'overwrite'),
            )

        if not write:
            for tf in thread_files(session_dir):
                thread = by_slug.get(tf.slug)
                if thread is None:
                    continue
                click.echo(f'--- {tf.name} ---', err=True)
                click.echo(serialize_thread(thread), nl=False)
            return

        if mode == 'overwrite' or not is_git:
            for src, dst in renames:
                src.rename(dst)
            for a in adopted:
                (session_dir / a.filename).touch()
            written: list[str] = []
            for tf in thread_files(session_dir):
                thread = by_slug.get(tf.slug)
                if thread is None:
                    continue
                tf.path.write_text(serialize_thread(thread))
                written.append(tf.name)
            state.save()
            err(f"wrote {len(written)} thread file(s): {', '.join(written)}")
            emoji_paths = [p.name for p in session_dir.glob('emoji-*') if p.is_file()]
            removed = [src.name for src, _ in renames]
            _autocommit(
                session_dir,
                [*written, *removed, str(STATE_PATH), *emoji_paths],
                'thrds: pull staging',
            )
            if is_git:
                _refresh_composite(session_dir, state, _merged_observations(
                    session_dir, state,
                    {tracking.STAGING: staging_files, tracking.PROD: render(prod_threads)},
                ))
                _mark_pull_incorporated(session_dir, state)
            return

        # rebase / merge: reconcile committed state onto the fetched base.
        if comp_snap is None:
            raise click.ClickException(
                f'no sync base — this session\'s first fetch found Slack and '
                f'HEAD disagreeing; {_bootstrap_outs()}.'
            )
        _reconcile_pull(
            session_dir, state, mode, comp_snap,
            renames=renames, adopted=adopted,
        )
        _refresh_composite(session_dir, state, _merged_observations(
            session_dir, state,
            {tracking.STAGING: staging_files, tracking.PROD: render(prod_threads)},
        ))
        _mark_pull_incorporated(session_dir, state)
        return

    doc = (
        client.pull_doc_prod(state, channel=channel, session_dir=session_dir)
        if prod
        else client.pull_doc_staging(state, session_dir=session_dir)
    )
    text = serialize_doc(doc)
    if write:
        path = _resolve_doc_path(state, doc_path)
        Path(path).write_text(text)
        # Persist any new custom emoji entries pulled into state.workspace_emoji.
        state.save()
        err(f"wrote pulled doc to {path}")
        mode = 'prod' if prod else 'staging'
        # Emoji files (`emoji-*.<ext>`) newly-downloaded by pull_doc_* land at
        # session root; add them to the auto-commit so the gist mirror carries them.
        emoji_paths = [p.name for p in session_dir.glob('emoji-*') if p.is_file()]
        _autocommit(session_dir, [path, str(STATE_PATH), *emoji_paths], f'thrds: pull {mode} → {path}')
    else:
        click.echo(text, nl=False)


def _thread_slug_arg(arg: str) -> str:
    """The slug an argument names, accepting a filename as well as a bare slug.

    ``diff 05-grug.md`` is what shell completion produces and what anyone
    looking at the directory listing types, so both spellings resolve.
    """
    name = Path(arg).name
    parsed = parse_thread_filename(name if name.endswith('.md') else f'{name}.md')
    return parsed[1] if parsed is not None else name


def _base_texts(session_dir: Path) -> dict[str, str] | None:
    """slug → text at the last-fetched composite; None if `fetch` never ran.

    The merge base is what turns a two-way diff into a classification: a hunk
    in local↔Slack is equally "Slack edited this" and "you edited this", and
    those want opposite verbs. Comparing each side against the base instead
    says which one moved.
    """
    ref = tracking.ref_name(tracking.COMPOSITE)
    base = tracking.read_ref(session_dir, ref)
    if base is None:
        return None
    texts: dict[str, str] = {}
    for name in tracking.tree_names(session_dir, f'{base}^{{tree}}'):
        parsed = parse_thread_filename(name)
        if parsed is not None:
            texts[parsed[1]] = tracking.read_tree_file(session_dir, base, name)
    return texts


def _diff_threads(
    client: SlackClient,
    state: SessionState,
    session_dir: Path,
    slug_arg: str | None,
) -> None:
    """Print each staged thread's local↔Slack diff; nothing for unchanged ones."""
    if mirror.is_git_repo(session_dir):
        _ensure_refs(session_dir, state)
    files = {tf.slug: tf for tf in thread_files(session_dir)}
    tracked = {
        slug for slug, e in state.threads.items()
        if e.staging_ts is not None or (e.state == 'posted' and e.target is not None)
    }

    if slug_arg is not None:
        slug = _thread_slug_arg(slug_arg)
        if slug not in files and slug not in tracked:
            available = ', '.join(sorted(files)) or '(none)'
            raise click.UsageError(
                f"No thread {slug!r} in this session; available: {available}"
            )
        if slug not in tracked:
            err(f"{slug}: never pushed to Slack — nothing to compare against.")
            return
        wanted = [slug]
    else:
        # File order first (the NN prefix is post order), then any thread that
        # exists in state but has no file — a locally-deleted draft still has a
        # Slack side, and "pull would restore it" is exactly what diff reports.
        wanted = [tf.slug for tf in sorted(files.values()) if tf.slug in tracked]
        wanted += sorted(tracked - set(files))
        if not wanted:
            err('No staged threads to diff.')
            return

    # `diff` is read-only: emoji substitution runs off the deterministic
    # filenames without downloading anything. Remotes are read in resolve
    # order — same precedence `pull` applies: for a promoted thread prod is
    # canonical and overrides the frozen staging copy, and diffing against
    # staging instead would report a hand-edit made at the target as a change
    # `pull` would undo.
    threads = {}
    for rmt in remotes.resolve(state).values():
        threads.update({
            t.slug: t
            for t in client.pull_thread_states(
                rmt, state, session_dir=session_dir, slugs=wanted, download_emoji=False,
            )
        })
    bases = _base_texts(session_dir)
    hinted = False
    for slug in wanted:
        tf = files.get(slug)
        name = tf.name if tf is not None else f'{slug}.md'
        local = tf.path.read_text() if tf is not None else ''
        thread = threads.get(slug)
        # A thread whose OP was deleted in Slack comes back with no messages;
        # `serialize_thread` of that is a lone newline, which would read as
        # "one blank line remains" rather than "it's gone".
        remote = serialize_thread(thread) if thread is not None and thread.messages else ''
        if local == remote:
            # Includes both-changed-to-the-same-content: converged is converged.
            continue
        # `pull` applies Slack's side, so its diff reads local → slack; a
        # local-only change is `push`'s to send, so that one reads slack → local.
        pull_diff = diff_texts(local, remote, f'{name} (local)', f'{name} (slack)')
        if bases is None:
            if not hinted:
                err('(run `slck fetch` first to classify changes as local vs. Slack-side)')
                hinted = True
            click.echo(pull_diff, nl=False)
            continue
        base = bases.get(slug, '')
        if base == local:
            err(f'{name}: changed in Slack — `pull` applies it')
            click.echo(pull_diff, nl=False)
        elif base == remote:
            err(f'{name}: changed locally — `push` sends it')
            click.echo(
                diff_texts(remote, local, f'{name} (slack)', f'{name} (local)'),
                nl=False,
            )
        else:
            err(f'{name}: CONFLICT — both sides changed since the last fetch')
            click.echo(pull_diff, nl=False)


def _composite_tree(session_dir: Path, files: dict[str, str]) -> str:
    """HEAD's tree with the observed threads overlaid — the merge base's tree.

    ``prune`` is every thread file HEAD carries, so a thread Slack has dropped
    disappears while `README.md` and friends pass through untouched.
    """
    head = tracking.read_ref(session_dir, 'HEAD')
    if head is None:
        return tracking.build_tree(session_dir, files)
    tracked = {
        name for name in tracking.tree_names(session_dir, f'{head}^{{tree}}')
        if parse_thread_filename(name) is not None
    }
    return tracking.overlay_tree(session_dir, f'{head}^{{tree}}', files, tracked)


def _bootstrap_outs(mode_hint: str = '') -> str:
    return (
        f'resolve with `slck pull -m overwrite` (Slack wins) or `slck push` '
        f'(local wins){mode_hint}'
    )


def _fetch_refs(
    session_dir: Path,
    state: SessionState,
    fetched: dict[str, dict[str, str]],
    write: bool,
    write_composite: bool | None = None,
) -> tracking.Snapshot | None:
    """Snapshot the tracking refs from already-fetched content.

    ``fetched`` maps remote name → observed files. A resolved remote absent
    from it was not read this round: its stored ref feeds the composite
    unchanged, and its ref doesn't move — no observation, no advance. (`slck
    fetch <remote>`; `pull` and a bare `fetch` always fetch everything.)

    Returns the composite's `Snapshot`, or **None when an ambiguous bootstrap
    withheld it**: on a first fetch whose threads differ from HEAD's copies,
    there is no evidence of which side is ahead — "remote is ahead" reverts
    unpushed local work, "local is ahead" pushes stale content over a newer
    remote — so no base is invented (ghpr's `bootstrap_is_ambiguous`, arrived
    at after refuting the alternatives; see specs/fetch-refs.md). The source
    refs are always set: they're pure observations, safe regardless.

    ``write_composite=False`` previews the composite while still writing the
    sources — `pull -m rebase/merge` needs this, because advancing the merge
    base *before* the reconcile succeeds would make a conflict evaporate: the
    next pull would find base == remote, conclude "nothing to do", and never
    apply the remote's side. The base moves only after the merge lands.
    """
    if write_composite is None:
        write_composite = write
    dry = '[dry-run] ' if not write else ''
    merged: dict[str, str] = {}
    for name, rmt in remotes.resolve(state).items():
        label = rmt.name
        if name not in fetched:
            ref_set = tracking.read_ref(session_dir, rmt.ref) is not None
            if not ref_set and remotes.has_threads(rmt, state):
                # Backstop for `pull`, which reads only the default remotes:
                # with no stored observation, this remote's threads would be
                # misrecorded as deleted in the composite (`slck fetch` has
                # its own earlier guard with the same rule).
                raise click.ClickException(
                    f'{label} has threads but has never been fetched; run '
                    f'`slck fetch {name}` first.'
                )
            files = _stored_files(session_dir, state, name)
            err(f"{label}: skipped ({'last observation kept' if ref_set else 'never fetched'})")
        else:
            files = fetched[name]
            snap = tracking.snapshot(
                session_dir,
                rmt.ref, label,
                tracking.build_tree(session_dir, files),
                f'thrds: fetch {name}',
                write=write,
            )
            if write:
                # A fetch that comes back matching local is the one kind of
                # observation that also incorporates: it says HEAD already
                # holds what the remote does. A fetch that comes back
                # *different* deliberately leaves the gate's base where it
                # is — looking at a divergence is not resolving it.
                _mark_incorporated_if_synced(session_dir, rmt, files, snap.sha)
            err(f'{dry if snap.changed else ""}{snap.label}: {snap.summary()}')
        merged.update(files)

    comp_ref = tracking.ref_name(tracking.COMPOSITE)
    comp_label = tracking.COMPOSITE
    comp_tree = _composite_tree(session_dir, merged)
    head = tracking.read_ref(session_dir, 'HEAD')
    if tracking.read_ref(session_dir, comp_ref) is None and head is not None:
        diverged = tracking.changed_paths(session_dir, f'{head}^{{tree}}', comp_tree)
        if diverged:
            err(
                f'{comp_label}: not set — first fetch and HEAD disagree '
                f"({', '.join(diverged)}); {_bootstrap_outs()}"
            )
            return None
    snap = tracking.snapshot(
        session_dir, comp_ref, comp_label, comp_tree,
        f'thrds: fetch {tracking.COMPOSITE}', write=write and write_composite,
    )
    err(f'{dry if snap.changed else ""}{snap.label}: {snap.summary()}')
    return snap


@slack_cli.command("fetch")
@click.option('-n', '--dry-run', is_flag=True, help="Report what would be fetched, without moving any ref.")
@click.argument('remote_names', metavar='[REMOTE]...', nargs=-1)
def slack_fetch(dry_run: bool, remote_names: tuple[str, ...]):
    """Record Slack's current state in remote-tracking refs.

    The read-only half of `pull`: it advances `refs/remotes/{staging,prod}`
    and `refs/heads/upstream`, touching nothing else — not the working tree,
    not the index, not the branch. `git diff upstream HEAD` afterwards is "what
    have I changed that Slack hasn't seen"; `git show upstream` is "what
    changed on Slack since I last looked".

    With REMOTE names (`staging`, `prod`) only those are read; a skipped
    remote keeps its last observation and still feeds the composite from its
    stored ref, so `slck fetch staging` costs no prod API reads.

    A nop when Slack projects byte-identically to what the refs already hold.
    """
    state = _load_state(expected_platform='slack')
    if state.is_legacy:
        raise click.UsageError(
            'Remote-tracking refs are per-thread only; run `thrds slack migrate` first.'
        )
    session_dir = Path.cwd()
    if not mirror.is_git_repo(session_dir):
        raise click.UsageError(
            f'{session_dir} is not a git repo; nothing to track refs in.'
        )
    _ensure_refs(session_dir, state)
    rmts = remotes.resolve(state)
    wanted = list(dict.fromkeys(remote_names)) or list(rmts)
    unknown = sorted(set(wanted) - set(rmts))
    if unknown:
        hint = (
            f" ({tracking.COMPOSITE!r} is the derived merge base — it "
            f'refreshes on every fetch, not by name)'
            if tracking.COMPOSITE in unknown else ''
        )
        raise click.UsageError(
            f"unknown remote(s): {', '.join(unknown)}; this session has: "
            f"{', '.join(rmts)}.{hint}"
        )
    for name in rmts:
        if name in wanted:
            continue
        rmt = rmts[name]
        if (
            tracking.read_ref(session_dir, rmt.ref) is None
            and remotes.has_threads(rmt, state)
        ):
            raise click.UsageError(
                f'{rmt.name} has threads but has never been '
                f'fetched; skipping it would misrecord them as deleted in the '
                f'composite. Run a full `slck fetch` first.'
            )
    client = _make_slack_client()
    fetched = {
        name: remotes.observe(rmts[name], client, state, session_dir)
        for name in wanted
    }
    _fetch_refs(session_dir, state, fetched, write=not dry_run)


@slack_cli.command("diff")
@click.option('-c', '--channel', help='Prod channel override (only with --prod).')
@click.option('-p', '--prod', is_flag=True, help='Diff against prod channel (legacy sessions only).')
@click.argument('target', required=False)
def slack_diff(channel: str | None, prod: bool, target: str | None):
    """Show how local content and Slack's current state differ, per thread.

    Per-thread sessions diff each thread that has a `staging_ts` against its
    own file, emitting one unified diff per changed thread and nothing for
    unchanged ones. TARGET restricts that to a single thread (slug or
    filename). Always exits 0 — this is a report, not a gate.

    With a fetched base (`slck fetch`), each changed thread is also classified
    by which side moved: changed in Slack (`pull` applies it, diff reads
    local → slack), changed locally (`push` sends it, diff reads slack →
    local), or CONFLICT (both moved since the last fetch). Without one, a hunk
    is equally "Slack edited this" and "you edited this and `pull` will eat
    it" — and those want opposite verbs. Reads Slack but moves no refs;
    `fetch` is the verb that advances the base.

    The local side is the working-tree file verbatim, not its canonical
    re-serialization, because `pull` overwrites the file: local formatting
    that doesn't survive a round trip *is* a pending change, and canonicalizing
    first would hide it.

    Legacy single-doc sessions diff DOC_PATH against the whole staging (or,
    with `--prod`, prod) doc.
    """
    state = _load_state(expected_platform='slack')
    if not prod and channel is not None:
        raise click.UsageError('--channel requires --prod.')
    client = _make_slack_client()
    if channel is not None:
        channel = _resolve_channel(client, channel)
    session_dir = Path.cwd()

    if not state.is_legacy:
        if prod:
            raise click.UsageError(
                'Per-thread sessions diff against staging only; a promoted thread '
                'is tracked by its `posted_ts`.'
            )
        _diff_threads(client, state, session_dir, target)
        return

    local_doc = _load_doc(state, target)
    slack_doc = (
        client.pull_doc_prod(state, channel=channel, session_dir=session_dir)
        if prod
        else client.pull_doc_staging(state, session_dir=session_dir)
    )
    click.echo(diff_docs(local_doc, slack_doc, from_label='local', to_label='slack'), nl=False)


@slack_cli.command("archive")
@click.option('-f', '--force', is_flag=True, help='Archive even with threads still pending.')
def slack_archive(force: bool):
    """Archive this session's staging PC (reversible via Slack UI/API `unarchive`).

    Refuses while any thread is still `draft` or `ready` — tearing down the
    scratchpad with live drafts in it is exactly the failure the per-thread
    model exists to prevent, and it's why prod push no longer auto-archives.
    Mark stragglers with `thrds slack drop <slug>`, or pass `-f`.

    Idempotent — subsequent invocations no-op via the ``state.staging_archived``
    flag. Auto-commits + pushes the flag change to the gist mirror.
    """
    state = _load_state(expected_platform='slack')
    if state.staging_channel is None:
        err("No staging PC to archive.")
        return
    if state.staging_archived:
        err(f"Already archived: {state.staging_channel}")
        return
    pending = state.pending_threads()
    if pending and not force:
        raise click.UsageError(
            f"{len(pending)} thread(s) still pending: {', '.join(pending)}. "
            f"Promote or drop them first, or pass -f to archive anyway."
        )
    client = _make_slack_client()
    client.archive_channel(state.staging_channel)
    state.staging_archived = True
    state.save()
    err(f"archived staging PC: {state.staging_channel}")
    _autocommit(Path.cwd(), [str(STATE_PATH)], f'thrds: archive {state.staging_channel}')


def _require_per_thread(state: SessionState) -> None:
    """Reject a legacy session on a per-thread verb, pointing at `migrate`."""
    if state.is_legacy:
        raise click.UsageError(
            'This session is still on the legacy single-doc layout; '
            'run `thrds slack migrate` first.'
        )


def _observed_text(
    client: SlackClient,
    state: SessionState,
    session_dir: Path,
    remote: Remote,
    slug: str,
    name: str,
) -> str:
    """One slug's current copy at ``remote``, rendered as `pull` would write it."""
    return remotes.observe(
        remote, client, state, session_dir, slugs=[slug],
    ).get(name, '')


def _update_remote_file(
    session_dir: Path,
    state: SessionState,
    remote: Remote,
    name: str,
    text: str,
) -> None:
    """Record one file's observed state in ``remote``'s ref (other files kept).

    A prod-role remote is fetched per thread (each posted slug has its own
    target), so its ref updates file-at-a-time rather than wholesale.
    """
    files = _stored_files(session_dir, state, remote.name)
    if text:
        files[name] = text
    else:
        files.pop(name, None)
    tracking.snapshot(
        session_dir,
        remote.ref, remote.name,
        tracking.build_tree(session_dir, files),
        f'thrds: fetch {remote.name}',
    )


def _gate_promote(
    client: SlackClient,
    state: SessionState,
    session_dir: Path,
    remote: Remote,
    slug: str,
    name: str,
    force: bool,
) -> None:
    """Refuse a re-promote over target state we've never seen.

    Only re-promotes are gated: a first promote is append-only (empty
    `only_ids` scope), so there is nothing of ours at the target to clobber.
    For a posted thread, compare the target's current copy of *our* messages
    against the remote ref's record — a difference means someone hand-edited
    the posted message since our last pull, and converging would overwrite it.
    Foreign replies never trip this: the prod-role reader reads only our
    own message ids.

    The observation is recorded either way, like `push`'s gate.
    """
    entry = state.threads.get(slug)
    if entry is None or entry.state != 'posted':
        return
    ref = remote.ref
    if tracking.read_ref(session_dir, ref) is None:
        return
    if name not in tracking.tree_names(session_dir, ref):
        return
    last = tracking.read_tree_file(session_dir, ref, name)
    observed = _observed_text(client, state, session_dir, remote, slug, name)
    if observed == last:
        return
    _update_remote_file(session_dir, state, remote, name, observed)
    if not force:
        raise click.ClickException(
            f'{name} changed at the target since your last pull (hand-edited '
            f'in {remote.name}?). `slck pull` to reconcile, or `-f`/`--force` '
            f'to overwrite.'
        )
    err(f'--force: overwriting {remote.name} changes in {name}')


def _verify_promote(
    client: SlackClient,
    state: SessionState,
    session_dir: Path,
    remote: Remote,
    slug: str,
    name: str,
) -> None:
    """Record the target's observed post-promote state; refresh the composite.

    Same truth-over-intent rule as `_verify_push`: the ref gets what Slack
    reports holding, not what we sent. Composite passthrough files come from
    the refs — no additional API reads beyond the one target read.
    """
    _update_remote_file(
        session_dir, state, remote, name,
        _observed_text(client, state, session_dir, remote, slug, name),
    )
    _refresh_composite(
        session_dir, state, _merged_observations(session_dir, state, {}),
    )


@slack_cli.command("promote")
@click.option('-c', '--channel', help='Override the thread\'s recorded target channel.')
@click.option('-f', '--force', is_flag=True, help='Promote even if the prod copy changed since the last pull (overwrites the hand-edit).')
@click.option('-n', '--dry-run', is_flag=True, help='Resolve and render; post nothing.')
@click.option('-t', '--thread-ts', help='Post as a reply into this existing thread.')
@click.option('-y', '--yes', is_flag=True, help='Skip the confirmation prompt.')
@click.argument('slug')
def slack_promote(channel: str | None, force: bool, dry_run: bool, thread_ts: str | None, yes: bool, slug: str):
    """Post a single thread (SLUG) to its target channel.

    The per-thread replacement for the old `push --prod`, which fired the
    *whole doc* at one channel and then archived the staging PC — wrong when
    the session holds several drafts at different readiness, bound for
    different places (see ``specs/per-thread-model.md``).

    Resolves the destination from the thread's own metadata (falling back to
    the session's `prod_channel`), prints it alongside the exact body that
    will be posted, and asks before sending. Posts only this thread, and
    never archives the staging channel — other drafts are still live.

    With a target `thread_ts` (recorded, or passed via `-t`), the messages go
    into that existing thread as replies; the other person's messages are
    left untouched.
    """
    state = _load_state(expected_platform='slack')
    _require_per_thread(state)

    try:
        tf, parsed = find_thread(Path.cwd(), slug)
    except ValueError as e:
        raise click.UsageError(str(e))
    thread = parsed.thread

    target = state.target_for(slug)
    if channel is not None:
        target = ThreadTarget(channel=channel, thread_ts=thread_ts or (target.thread_ts if target else None))
    elif thread_ts is not None:
        if target is None:
            raise click.UsageError(
                f'No target channel for {slug!r} — pass --channel alongside --thread-ts.'
            )
        target = ThreadTarget(channel=target.channel, thread_ts=thread_ts)
    if target is None:
        raise click.UsageError(
            f'No target for thread {slug!r} — pass --channel, or set the session\'s '
            f'prod_channel, before promoting.'
        )

    client = _make_slack_client()
    resolved = _resolve_channel(client, target.channel)
    target = ThreadTarget(channel=resolved, thread_ts=target.thread_ts)

    entry = state.thread(slug)
    kind = 'reply into' if target.thread_ts else 'new thread in'
    err(f"promote {slug} → {kind} {target.channel}"
        + (f" @ {target.thread_ts}" if target.thread_ts else ''))
    if entry.state == 'posted':
        err(f"  note: already posted (ts {entry.posted_ts}) — this will sync it in place")

    # ALWAYS compute and show the real action plan (a dry-run sync against the
    # live thread) before anything fires. Rendering only the draft body once
    # let a promote silently edit and delete unrelated messages — the plan is
    # the thing being approved, not the prose. See
    # specs/promote-shared-thread-safety.md.
    plan = client.promote_thread(slug, thread, target, state, dry_run=True, frontmatter=parsed.frontmatter)
    err('  ---')
    err(plan.format_preview(color=sys.stderr.isatty(), prefix='  '))
    err('  ---')
    destructive = [a for a in plan.actions if a.type in (ActionType.EDIT, ActionType.DELETE)]
    if destructive:
        err(f"  ⚠ plan touches {len(destructive)} existing message(s) "
            f"({', '.join(a.type.name for a in destructive)}) — all must be this thread's own prior posts")

    if dry_run:
        err('(dry run — nothing posted)')
        return
    session_dir = Path.cwd()
    is_git = mirror.is_git_repo(session_dir)
    if is_git:
        _ensure_refs(session_dir, state)
    # The verb's default remote (specs/remotes-model.md: promote is morally
    # `push -u prod <thread>`); the gate and verify are remote-agnostic.
    rmt = remotes.resolve(state)[tracking.PROD]
    if is_git:
        # Gate before the confirm prompt: don't ask for approval of a plan
        # the gate is about to refuse.
        _gate_promote(client, state, session_dir, rmt, slug, tf.name, force)
    if not yes:
        click.confirm('Apply this plan?', abort=True, err=True)

    result = client.promote_thread(slug, thread, target, state, frontmatter=parsed.frontmatter)
    state.save()
    err(f"posted {slug}: {entry.posted_ts}")
    _notify_promoted(client, slug, target.channel, entry.posted_ts)
    _autocommit(session_dir, [str(STATE_PATH)], f'thrds: promote {slug} → {target.channel}')
    if is_git:
        _verify_promote(client, state, session_dir, rmt, slug, tf.name)


@slack_cli.command("replay")
@click.option('-b', '--branch', default='per-thread', show_default=True, help='Branch to write the rewritten history to.')
@click.option('-n', '--dry-run', is_flag=True, help='Plan and verify; write no branch.')
@click.option('-r', '--ref', default='HEAD', show_default=True, help='Ref whose history to rewrite.')
def slack_replay(branch: str, dry_run: bool, ref: str):
    """Rewrite this session's git history into the per-thread layout.

    `migrate` converts the working tree; `replay` converts the *history*, so a
    session collected as a writing example can be read without learning the
    retired `===` syntax. Every commit is rebuilt with the doc split into
    `NN-slug.md` files, preserving message, author, committer, and dates.

    Indices are assigned globally, from the final commit's ordering — a slug
    keeps one number for all time, and a commit where the thread doesn't exist
    yet just has a gap. Numbering each commit independently would renumber
    every thread below an insertion, and a rename breaks the per-file history
    this layout exists to produce.

    Verifies before writing: for every commit, the new files must parse back to
    exactly the threads the old doc parsed to. Writes a new branch and never
    force-pushes — inspect it, then move the remote yourself.
    """
    state = _load_state(expected_platform='slack')
    doc_path = state.doc_path
    if doc_path is None:
        raise click.UsageError(
            'This session has no `doc_path` — its history is already per-thread, '
            'or it was migrated before replaying (replay reads the legacy doc).'
        )
    repo = Path.cwd()
    try:
        plans, index_by_slug = plan_replay(repo, ref, doc_path)
        problems = verify_plan(repo, plans, doc_path)
    except ReplayError as e:
        raise click.UsageError(str(e))

    err(f'replay {ref}: {len(plans)} commit(s), {len(index_by_slug) - 1} thread(s)')
    for slug, i in sorted(index_by_slug.items(), key=lambda kv: kv[1]):
        err(f'  {thread_filename(i, slug)}')
    for plan in plans:
        err(f'  {plan.sha[:8]} {plan.subject[:48]:<48s} {len(plan.md_names)} file(s)')

    if problems:
        err('verification FAILED:')
        for p in problems:
            err(f'  {p}')
        raise click.UsageError('Refusing to write a rewrite that loses content.')
    err('verification: every commit round-trips identically')

    if dry_run:
        err('(dry run — no branch written)')
        return
    head = write_replay(repo, plans, branch)
    err(f'wrote {branch} → {head[:8]}')
    err(f'inspect with: git log --stat {branch}')


@slack_cli.command("adopt")
@click.option('-c', '--channel', required=True, help='Channel the message already lives in.')
@click.option('-t', '--ts', required=True, help='Timestamp of the existing prod message.')
@click.option('-T', '--in-thread', help='Parent thread ts, if the message is a reply.')
@click.option('-V', '--no-verify', is_flag=True, help='Skip the permalink check on TS.')
@click.argument('slug')
def slack_adopt(channel: str, ts: str, in_thread: str | None, no_verify: bool, slug: str):
    """Record an existing prod message as SLUG's posted result, without posting.

    For threads that went out before thrds was tracking them — posted by hand,
    or by an older version that never recorded `prod_threads`. Marks the thread
    `posted`, pins its target, and stores the message ts, so `status` and the
    archive gate see reality.

    Posts nothing. By default resolves the ts to a permalink first, since a
    mistyped ts would otherwise be recorded silently and only surface later as
    a `promote` syncing against a message that doesn't exist. That permalink is
    also kept (as `posted_url`), so staging chrome and `status` can link to the
    real message without another API call; `-V` skips the check and therefore
    records no URL.

    `-T` records that the message is a *reply* in an existing thread — the
    "considered response to someone else's post" case, where TS is our message
    and `-T` is the message we answered. Omitted, an existing target's parent
    thread in the same channel is kept rather than silently flattened to
    top-level.
    """
    state = _load_state(expected_platform='slack')
    _require_per_thread(state)
    try:
        find_thread(Path.cwd(), slug)
    except ValueError as e:
        raise click.UsageError(str(e))

    client = _make_slack_client()
    resolved = _resolve_channel(client, channel)
    entry = state.thread(slug)
    if entry.state == 'posted':
        err(f"note: {slug} was already posted (ts {entry.posted_ts}); overwriting")

    link = None
    if not no_verify:
        prev, client.channel = client.channel, resolved
        try:
            link = client.permalink(ts)
        except Exception as e:  # noqa: BLE001 — surface the API's own complaint
            raise click.UsageError(f"Could not resolve {ts} in {resolved}: {e}")
        finally:
            client.channel = prev
        err(f"  {link}")

    parent = in_thread
    if parent is None and entry.target is not None and entry.target.channel == resolved:
        parent = entry.target.thread_ts
    entry.target = ThreadTarget(channel=resolved, thread_ts=parent)
    entry.posted_ts = ts
    entry.posted_url = link
    entry.state = 'posted'
    state.save()
    err(f"adopted {slug} → {resolved} @ {ts}"
        + (f" (in thread {parent})" if parent else ''))
    _autocommit(Path.cwd(), [str(STATE_PATH)], f'thrds: adopt {slug} → {resolved}')


@slack_cli.command("reorder")
@click.option('-n', '--dry-run', is_flag=True, help='Show the renames; touch nothing.')
@click.argument('slugs', nargs=-1)
def slack_reorder(dry_run: bool, slugs: tuple[str, ...]):
    """Renumber thread files to a gapless `01..NN` in their current order.

    Pass SLUGS to put those threads first, in that order; anything unnamed
    keeps its relative position after them. With no SLUGS this just compacts
    gaps left by adding and dropping threads.

    Only files move. `thrds.yml` is keyed by slug, not by index, so the
    staging messages, targets and posted timestamps all follow their thread
    without being touched — the number says where a thread sorts, nothing more.
    """
    state = _load_state(expected_platform='slack')
    _require_per_thread(state)
    session_dir = Path.cwd()
    files = thread_files(session_dir)
    if not files:
        err('No thread files in this session.')
        return

    by_slug = {f.slug: f for f in files}
    unknown = [s for s in slugs if s not in by_slug]
    if unknown:
        raise click.UsageError(
            f"No thread(s) {', '.join(unknown)} in this session; "
            f"available: {', '.join(f.slug for f in files)}"
        )
    named = list(dict.fromkeys(slugs))
    order = [by_slug[s] for s in named] + [f for f in files if f.slug not in set(named)]

    moves = [
        (f, thread_filename(i, f.slug))
        for i, f in enumerate(order, start=1)
        if f.name != thread_filename(i, f.slug)
    ]
    if not moves:
        err('Already gapless and in order; nothing to do.')
        return
    for f, new_name in moves:
        err(f"  {f.name} → {new_name}")
    if dry_run:
        err('(dry run — nothing renamed)')
        return

    # Two-phase, because a reorder is a permutation: renaming 01→02 directly
    # would clobber the file already at 02.
    staged: list[tuple[Path, Path]] = []
    for f, new_name in moves:
        tmp = session_dir / f'.{f.name}.reorder'
        f.path.rename(tmp)
        staged.append((tmp, session_dir / new_name))
    for tmp, dst in staged:
        tmp.rename(dst)

    err(f"renumbered {len(moves)} file(s)")
    _autocommit(
        session_dir,
        [f.name for f, _ in moves] + [n for _, n in moves],
        'thrds: reorder thread files',
    )


@slack_cli.command("drop")
@click.argument('slug')
def slack_drop(slug: str):
    """Mark thread SLUG as abandoned (`dropped`) without posting it.

    The other terminal state besides `posted`. Exists so the archive gate has
    a way to say "this draft is finished business" about a thread that is
    never going out — without deleting the file, since the trajectory of a
    draft that got abandoned is still part of the record.
    """
    state = _load_state(expected_platform='slack')
    _require_per_thread(state)
    entry = state.thread(slug)
    if entry.state == 'posted':
        raise click.UsageError(
            f"Thread {slug!r} was already posted (ts {entry.posted_ts}); refusing to mark it dropped."
        )
    entry.state = 'dropped'
    state.save()
    err(f"dropped {slug}")
    _autocommit(Path.cwd(), [str(STATE_PATH)], f'thrds: drop {slug}')


@slack_cli.command("reopen")
@click.option('-s', '--state', 'to_state', default='draft', show_default=True,
              type=click.Choice(['draft', 'ready']), help='State to return the thread to.')
@click.argument('slug')
def slack_reopen(to_state: str, slug: str):
    """Move a terminal thread (SLUG) back to `draft`/`ready` so it can be revised.

    The counterpart to finalizing: once a thread is `posted` or `dropped` its
    staged copy re-renders with chrome in a block, which Slack makes
    uneditable. That's the signal, and this is the way out of it — the next
    `push` unlocks the staged message.

    Keeps `posted_ts` and the target: reopening says "I want to revise this",
    not "this never happened". A subsequent `promote` therefore syncs the
    already-posted message in place rather than posting a second one.
    """
    state = _load_state(expected_platform='slack')
    _require_per_thread(state)
    entry = state.thread(slug)
    if not entry.is_terminal:
        err(f"{slug} is already {entry.state}; nothing to reopen.")
        return
    was = entry.state
    entry.state = to_state
    state.save()
    err(f"reopened {slug}: {was} → {to_state}"
        + (f" (still posted at {entry.posted_ts})" if entry.posted_ts else ''))
    err('  run `thrds slack push` to unlock its staged copy')
    _autocommit(Path.cwd(), [str(STATE_PATH)], f'thrds: reopen {slug}')


@slack_cli.command("status")
def slack_status():
    """List this session's threads: file, state, destination, posted permalink.

    Four tab-separated columns, always — the last is empty for anything not
    posted, so `cut -f4` stays honest.
    """
    state = _load_state(expected_platform='slack')
    _require_per_thread(state)
    files = thread_files(Path.cwd())
    if not files:
        err('No thread files in this session.')
        return
    for tf in files:
        entry = state.threads.get(tf.slug)
        st = entry.state if entry is not None else 'draft'
        target = state.target_for(tf.slug)
        if target is None:
            dest = '(no target)'
        elif target.thread_ts:
            dest = f'{target.channel} @ {target.thread_ts}'
        else:
            dest = target.channel
        url = entry.posted_url if entry is not None and entry.posted_url else ''
        click.echo(f'{tf.name}\t{st}\t{dest}\t{url}')


@slack_cli.command("migrate")
@click.option('-n', '--dry-run', is_flag=True, help='Print the plan; write nothing.')
def slack_migrate(dry_run: bool):
    """Split this session's single doc into per-thread `NN-slug.md` files.

    Converts a legacy one-doc-many-threads session to the per-thread model
    (see ``specs/per-thread-model.md``): each ``=== slug`` section becomes its
    own file, and `thrds.yml` gains a `threads` map carrying each thread's
    staging ts, destination, and state. A preamble becomes ``00-preamble.md``.

    The payoff is per-file git history — a commit reads as "*this message*
    went v2→v3" rather than "the doc changed", which is what makes a session's
    gist usable as a revision trajectory.

    Content is preserved verbatim; only its distribution across files changes.
    Threads already posted to prod migrate as ``posted`` with their actual
    channel pinned; everything else stays ``draft`` and inherits the
    session-level ``prod_channel`` as a default.
    """
    state = _load_state(expected_platform='slack')
    if not state.is_legacy:
        if state.threads:
            raise click.UsageError(
                'This session is already on the per-thread model '
                f'({len(state.threads)} thread(s) in thrds.yml).'
            )
        raise click.UsageError('Nothing to migrate: this session has no threads recorded.')

    doc_path = _resolve_doc_path(state, None)
    parsed = parse_doc(Path(doc_path).read_text())
    try:
        plan = plan_migration(parsed.doc, state, doc_path, parsed.frontmatter)
    except ValueError as e:
        raise click.UsageError(str(e))

    err(f"migrate {doc_path} → {len(plan.threads)} thread file(s):")
    for t in plan.threads:
        target = t.entry.target
        dest = f" → {target.channel}" if target is not None else ''
        if target is not None and target.thread_ts is not None:
            dest += f" (reply to {target.thread_ts})"
        err(f"  {t.filename}  [{t.entry.state}]{dest}")

    if dry_run:
        err('(dry run — nothing written)')
        return

    try:
        touched = apply_migration(Path.cwd(), state, plan)
    except ValueError as e:
        raise click.UsageError(str(e))
    state.save()
    err(f"removed {doc_path}; wrote {len(plan.threads)} file(s)")
    _autocommit(
        Path.cwd(),
        [p.name for p in touched] + [str(STATE_PATH)],
        f'thrds: migrate {doc_path} → per-thread files',
    )


@slack_cli.command("open")
@click.option('-p', '--prod', is_flag=True, help='Open the prod channel (default: gist).')
@click.option('-s', '--staging', is_flag=True, help='Open the staging PC (default: gist).')
@click.option('-U', '--no-open', is_flag=True, help='Print the URL, do not launch browser.')
def slack_open(prod: bool, staging: bool, no_open: bool):
    """Open this session's gist (default), staging PC, or prod channel in the browser.

    Mirrors ``ghpr open [-g]`` — with three targets instead of two, since a
    thrds session tracks a gist + a staging channel + (once pushed) a prod
    channel. Pass ``-U`` to just print the URL (useful in scripts).
    """
    if prod and staging:
        raise click.UsageError('--prod and --staging are mutually exclusive.')
    state = _load_state(expected_platform='slack')

    if staging:
        if state.staging_channel is None:
            raise click.UsageError(
                'No staging channel — run `thrds slack push` first to create one.'
            )
        url = _channel_url(state.staging_channel)
        label = f'staging PC {state.staging_channel}'
    elif prod:
        if state.prod_channel is None:
            raise click.UsageError(
                'No prod channel recorded on this session.'
            )
        url = _channel_url(state.prod_channel)
        label = f'prod channel {state.prod_channel}'
    else:
        if state.gist_id is None:
            raise click.UsageError(
                'No gist recorded — session was init\'d with --no-gist.'
            )
        url = f'https://gist.github.com/{state.gist_id}'
        label = f'gist {state.gist_id}'

    err(f'Opening {label}: {url}')
    if not no_open:
        webbrowser.open(url)


@slack_cli.command('list-sessions')
@click.option('-c', '--cursor', help='Slack pagination cursor to resume from.')
@click.option('-d', '--oldest-days', type=float, help='Only scan messages posted in the last N days.')
@click.option('-D', '--latest-days', type=float, help='Skip messages newer than N days ago.')
@click.option('-m', '--max-pages', type=int, default=50, show_default=True, help='Cap on `conversations.history` pages fetched. Pass 0 to disable.')
@click.argument('channel')
def slack_list_sessions(cursor, oldest_days, latest_days, max_pages, channel):
    """List thrds sessions found in CHANNEL by scanning message metadata.

    Same scan machinery as `thrds slack recover` (same window / cap / cursor
    flags), but read-only — never writes state or pulls the doc. Useful
    to figure out which session_id you actually want before running
    `slack recover -i <sid>`, or just to see what's in a channel.
    """
    oldest_ts, latest_ts, cur, cap = _scan_bounds(cursor, oldest_days, latest_days, max_pages)
    sessions, channel = _scan_sessions(channel, oldest_ts, latest_ts, cur, cap)
    if not sessions:
        err(f'No thrds-metadata sessions found in {channel}.')
        return
    err(f'{len(sessions)} session{"s" if len(sessions) != 1 else ""} in {channel}:')
    _print_sessions_table(sessions, channel)


@slack_cli.command("recover")
@click.option('-c', '--cursor', help='Slack pagination cursor to resume from (printed by a prior `ScanCapReached`).')
@click.option('-d', '--oldest-days', type=float, help='Only scan messages posted in the last N days (default: unbounded).')
@click.option('-D', '--latest-days', type=float, help='Skip messages newer than N days ago (Slack `latest` upper bound). Pair with `--oldest-days` to scan a window.')
@click.option('-i', '--session-id', help='Session ID to recover (required if channel holds >1 session).')
@click.option('-m', '--max-pages', type=int, default=50, show_default=True, help='Safety cap on `conversations.history` pages fetched (200 msgs/page). Pass 0 to disable.')
@click.option('-s', '--staging', is_flag=True, help='Route recovered pointers to staging_threads (default: prod_threads[channel]).')
@click.option('-W', '--no-write-doc', is_flag=True, help='Skip the doc-pull step; write thrds.yml only.')
@click.argument('channel')
def slack_recover(
    cursor: str | None,
    oldest_days: float | None,
    latest_days: float | None,
    session_id: str | None,
    max_pages: int,
    staging: bool,
    no_write_doc: bool,
    channel: str,
):
    """Rebuild `thrds.yml` (and DOC.md) from Slack metadata in CHANNEL.

    Every ``thrds`` post carries ``event_type='thrds'`` metadata (session_id,
    doc_slug, thread_slug, kind); ``recover`` scans CHANNEL for those tags
    and reassembles the local session state — the durability story for the
    write-through cache in ``thrds.yml``.

    Run inside an empty session dir. Refuses to overwrite an existing
    ``thrds.yml`` (that's a live session, not a recovery target).

    Bare invocation lists sessions found in the channel and exits (code 2)
    if there's more than one — pass ``-i/--session-id`` to pick one; a
    single-session channel auto-selects.

    Scan cost: Slack does not index message metadata, so scanning is the
    only path. Default cap is 50 pages (10k messages). For busy channels,
    narrow with ``-d/--oldest-days N`` — the cheapest lever.
    """
    session_dir = Path.cwd()
    if (session_dir / STATE_PATH).is_file() or (session_dir / LEGACY_STATE_PATH).is_file():
        raise click.UsageError(
            f'{STATE_PATH} already exists in {session_dir} — refusing to overwrite. '
            'cd into a fresh session dir before running `thrds slack recover`.'
        )
    oldest_ts, latest_ts, cur, cap = _scan_bounds(cursor, oldest_days, latest_days, max_pages)
    sessions, channel = _scan_sessions(channel, oldest_ts, latest_ts, cur, cap)
    if not sessions:
        raise click.UsageError(
            f'No thrds-metadata messages found in {channel}. '
            "Either the channel has no thrds posts, or a different token/app "
            'made the posts (Slack only returns metadata to the posting app).'
        )
    if session_id is None:
        if len(sessions) == 1:
            session_id = next(iter(sessions))
            err(f'Auto-selecting the only session in {channel}: {session_id}')
        else:
            err(f'{len(sessions)} thrds sessions found in {channel}; pass -i/--session-id to pick one:')
            _print_sessions_table(sessions, channel)
            raise click.exceptions.Exit(2)
    if session_id not in sessions:
        raise click.UsageError(
            f'Session {session_id!r} not found in {channel}. '
            f'Available: {sorted(sessions)}'
        )
    recovered = sessions[session_id]
    # Assemble SessionState from the metadata trail. session_id is preserved
    # (not freshly minted) — that's the whole point of recovery. platform
    # defaults to 'slack' since this is `thrds slack recover`.
    state = SessionState(
        session_id=recovered.session_id,
        doc_path=f'{recovered.doc_slug}.md',
        platform='slack',
    )
    if staging:
        state.staging_channel = channel
        state.staging_preamble_ts = recovered.preamble_ts
        state.staging_threads = dict(recovered.thread_ts_by_slug)
    else:
        state.prod_channel = channel
        if recovered.preamble_ts is not None:
            state.prod_preamble_ts[channel] = recovered.preamble_ts
        state.prod_threads[channel] = dict(recovered.thread_ts_by_slug)
    state.save(session_dir)
    err(
        f'wrote {STATE_PATH} for session {session_id} '
        f'(doc_slug={recovered.doc_slug!r}, {recovered.thread_count} threads'
        f'{", preamble" if recovered.preamble_ts else ""})'
    )
    if no_write_doc:
        return
    # `_scan_sessions` made its own client; make another for the pull.
    # Cheap (no I/O in `__init__`) and keeps the helper contract clean.
    client = _make_slack_client()
    doc = (
        client.pull_doc_staging(state, session_dir=session_dir)
        if staging
        else client.pull_doc_prod(state, session_dir=session_dir)
    )
    text = serialize_doc(doc)
    doc_path = session_dir / f'{recovered.doc_slug}.md'
    doc_path.write_text(text)
    err(f'wrote pulled doc to {doc_path.name}')


# --- Slack CRUD verbs (`slack {history,thread,rm,post,edit,permalink}`) ---


@slack_cli.command("history")
@click.option("-j", "--json", "as_json", is_flag=True, help="Emit raw message dicts as JSON.")
@click.option("-n", "--limit", type=int, default=20, help="Max messages to fetch (default 20).")
@click.argument("channel")
def slack_history(as_json: bool, limit: int, channel: str):
    """List the last N messages in CHANNEL (default 20)."""
    client = _crud_client(channel)
    msgs = client.list_channel_history(client.channel, limit=limit)
    if as_json:
        import json as _json
        click.echo(_json.dumps(msgs, indent=2))
    else:
        rendered = _crud_render_messages(msgs)
        if rendered:
            click.echo(rendered)


@slack_cli.command("thread")
@click.option("-j", "--json", "as_json", is_flag=True, help="Emit raw message dicts as JSON.")
@click.argument("channel")
@click.argument("ts")
def slack_thread(as_json: bool, channel: str, ts: str):
    """Show OP + replies for the thread rooted at TS in CHANNEL."""
    client = _crud_client(channel)
    msgs = client.list_thread_raw(client.channel, ts)
    if as_json:
        import json as _json
        click.echo(_json.dumps(msgs, indent=2))
    else:
        rendered = _crud_render_messages(msgs)
        if rendered:
            click.echo(rendered)


@slack_cli.command("rm")
@click.option("-f", "--force", is_flag=True, help="Delete even if the message has thread replies (`orphans_ok=True`).")
@click.argument("channel")
@click.argument("tss", nargs=-1, required=True, metavar="TS...")
def slack_rm(force: bool, channel: str, tss: tuple[str, ...]):
    """Delete one or more messages from CHANNEL by ts."""
    from .core import OrphanedRepliesError
    client = _crud_client(channel)
    any_failed = False
    for ts in tss:
        try:
            client.delete(ts, orphans_ok=force)
            click.echo(f"{ts}: ok")
        except OrphanedRepliesError as e:
            any_failed = True
            click.echo(f"{ts}: {e} — pass --force to delete anyway", err=True)
        except RuntimeError as e:
            any_failed = True
            click.echo(f"{ts}: {e}", err=True)
    if any_failed:
        raise click.exceptions.Exit(1)


@slack_cli.command("post")
@click.option("-e", "--icon-emoji", help="Per-message `icon_emoji` override (requires `chat:write.customize`).")
@click.option("-i", "--icon-url", help="Per-message `icon_url` override (requires `chat:write.customize`).")
@click.option("-m", "--markdown", "as_markdown", is_flag=True, help="Convert local markdown → Slack mrkdwn (default: send TEXT verbatim).")
@click.option("-t", "--thread-ts", help="Reply to the thread rooted at this ts.")
@click.option("-u", "--username", help="Per-message `username` override (requires `chat:write.customize`).")
@click.argument("channel")
@click.argument("text")
def slack_post(
    icon_emoji: str | None,
    icon_url: str | None,
    as_markdown: bool,
    thread_ts: str | None,
    username: str | None,
    channel: str,
    text: str,
):
    """Post TEXT to CHANNEL; print the new message ts to stdout.

    TEXT is sent verbatim as wire mrkdwn by default (raw). Pass -m to run
    it through the local-md → Slack-mrkdwn conversion first.
    """
    client = _crud_client(channel)
    msg = client.post(
        text,
        thread_id=thread_ts,
        username=username,
        icon_url=icon_url,
        icon_emoji=icon_emoji,
        raw=not as_markdown,
    )
    click.echo(msg.id)


@slack_cli.command("edit")
@click.option("-m", "--markdown", "as_markdown", is_flag=True, help="Convert local markdown → Slack mrkdwn (default: send TEXT verbatim).")
@click.argument("channel")
@click.argument("ts")
@click.argument("text")
def slack_edit(as_markdown: bool, channel: str, ts: str, text: str):
    """Edit the message at TS in CHANNEL to TEXT (raw by default)."""
    client = _crud_client(channel)
    client.edit(ts, text, raw=not as_markdown)


@slack_cli.command("permalink")
@click.argument("channel")
@click.argument("ts")
def slack_permalink(channel: str, ts: str):
    """Print the permalink URL for the message at TS in CHANNEL."""
    client = _crud_client(channel)
    click.echo(client.permalink(ts))


# ============================================================================
# `thrds capture …` subgroup — gist-only trajectory, no platform target.
# ============================================================================


@cli.group("capture")
def capture_cli():
    """Capture-only sessions: git + gist trajectory, no platform posting.

    Same on-disk shape as slack sessions (session dir under
    ``<git-root-or-cwd>/capture/<slug>/``, git-tracked, gist-mirrored) minus
    any Slack/Discord/etc. plumbing. Useful for drafting posts you'll
    paste manually (Discord in a channel the bot can't reach, arbitrary
    forum, etc.) while still capturing iteration history to a gist.
    """
    pass


def _capture_state_paths(session_dir: Path, doc_path: str) -> list[str]:
    """Paths to stage for a capture commit: the doc, plus ``thrds.yml`` only
    in legacy sessions that already track it (new-style capture sessions
    git-exclude it — see `_exclude_state_from_git`)."""
    paths = [doc_path]
    if mirror.is_git_repo(session_dir) and mirror.is_tracked(session_dir, str(STATE_PATH)):
        paths.append(str(STATE_PATH))
    return paths


@capture_cli.command("init")
@click.option('-G', '--no-gist', is_flag=True, help='Skip gist creation; local git repo only.')
@click.option('-s', '--slug', help='Session slug (default: DOC_PATH stem, or derived from the content\'s first line).')
@click.argument('doc_path', required=False)
def capture_init(no_gist: bool, slug: str | None, doc_path: str | None):
    """Initialize a capture-only session (no platform target).

    With DOC_PATH: copy that file in, with the same auto-resume semantics as
    `slack init` (a partial init — matching platform, gist_id=None — has its
    gist step completed on re-run). Without DOC_PATH (or with `-`): read the
    doc content from stdin. Either way the session dir prints to stdout, so
    the two-command flow is::

        dir=$(echo "$draft" | thrds capture init)
        echo "$final" | thrds capture update "$dir"
    """
    content = None
    if doc_path in (None, '-'):
        if sys.stdin.isatty():
            raise click.UsageError(
                "Pass DOC_PATH, or pipe the doc content on stdin "
                "(e.g. `echo \"$draft\" | thrds capture init`)."
            )
        content = sys.stdin.read()
        doc_path = None
        if slug is None:
            slug = slugify(content)
            if not slug:
                raise click.UsageError(
                    "Cannot derive a slug from the content's first line; pass -s/--slug."
                )
    target, state, was_resume = _do_init(
        doc_path, no_gist, channel_prefix=None, platform='capture',
        content=content, slug=slug,
    )
    click.echo(target)
    if was_resume:
        return
    hint = None if state.gist_id is None else f"Gist: https://gist.github.com/{state.gist_id}"
    _print_init_completion(target, state, extra_hint=hint)


@capture_cli.command("push")
def capture_push():
    """Commit any local doc changes and push to the gist mirror.

    Capture-only sessions have no platform target — "push" here means
    the gist mirror step alone. No-op if the session was inited with
    `--no-gist` (nothing to push to).
    """
    state = _load_state(expected_platform='capture')
    session_dir = Path.cwd()
    doc_path = _resolve_doc_path(state, None)
    _autocommit(session_dir, _capture_state_paths(session_dir, doc_path), f'thrds: capture push')
    if state.gist_id is None:
        err("(no gist configured — commit only)")


@capture_cli.command("update")
@click.argument('session_dir', required=False)
def capture_update(session_dir: str | None):
    """Replace the doc with stdin; commit + push one gist revision.

    The second half of the two-command capture flow::

        dir=$(echo "$draft" | thrds capture init)
        echo "$final" | thrds capture update "$dir"

    SESSION_DIR defaults to the CWD (which must be a capture session).
    Content identical to the current doc is a no-op (no commit, no push).
    To push edits made directly to the file, use `thrds capture push`.
    """
    if sys.stdin.isatty():
        raise click.UsageError(
            "capture update reads the new doc content from stdin "
            "(e.g. `echo \"$msg\" | thrds capture update <dir>`); "
            "to push edits made directly to the file, use `thrds capture push`."
        )
    root = Path(session_dir) if session_dir is not None else Path.cwd()
    state = _load_state(expected_platform='capture', root=root)
    doc_rel = _resolve_doc_path(state, None)
    doc_file = root / doc_rel
    new = sys.stdin.read()
    if doc_file.exists() and doc_file.read_text() == new:
        err("(no changes — nothing to push)")
        return
    doc_file.write_text(new)
    _autocommit(root, _capture_state_paths(root, doc_rel), f'thrds: capture update')
    if state.gist_id is None:
        err("(no gist configured — commit only)")


@capture_cli.command("open")
@click.option('-U', '--no-open', is_flag=True, help='Print the URL, do not launch browser.')
def capture_open(no_open: bool):
    """Open this session's gist in the browser (or print with -U)."""
    state = _load_state(expected_platform='capture')
    if state.gist_id is None:
        raise click.UsageError(
            'No gist recorded — session was init\'d with --no-gist.'
        )
    url = f'https://gist.github.com/{state.gist_id}'
    err(f'Opening gist {state.gist_id}: {url}')
    if not no_open:
        webbrowser.open(url)


# ============================================================================
# `thrds discord …` subgroup — capture + MD-compat lint + bot push.
# ============================================================================
#
# Discord phase 2c (from specs/done/discord-platform.md): the render-preview
# loop for paste-as-you delivery. `render` outputs the doc's MD to stdout for
# `| pbcopy`, `lint` flags the constructs that don't render in normal Discord
# user messages (tables, raw @name; masked links, see
# specs/done/discord-masked-links-render.md). `push`/`thread` (from
# specs/discord-push.md) add bot-token delivery: post the doc as a bot with
# the OP in the channel and replies in a thread.


def _run_discord_lint(doc_text: str, doc_path: str) -> int:
    """Shared lint runner used by both `discord lint` and `discord render`.

    Prints the report to stderr; returns the number of issues found so callers
    can decide exit code / whether to still emit output.
    """
    from .lint import DiscordLinter
    report = DiscordLinter().lint(doc_text)
    if report.has_issues:
        err(report.format(path=doc_path))
    return len(report.issues)


@cli.group("discord")
def discord_cli():
    """Discord workflow: init, render/preview (for paste), lint, and bot push.

    Two delivery models. **Paste** (`render`/`preview`) is for posting *as
    you* — Discord bans user-token automation, so there's no "post as me."
    **Bot push** (`push`) posts *as a bot*: the doc's OP goes to the channel,
    replies into a thread opened off it (`thread` dumps that thread back). The
    subgroup also captures iteration history to a gist (`init`) and lints for
    constructs Discord's renderer drops (tables, raw `@name`). Per-message
    sender identity (avatars/names) needs a webhook transport, not the bot API
    — see `specs/discord-push.md`; `specs/done/discord-platform.md`.
    """
    pass


@discord_cli.command("init")
@click.option('-G', '--no-gist', is_flag=True, help='Skip gist creation; local git repo only.')
@click.argument('doc_path')
def discord_init(no_gist: bool, doc_path: str):
    """Initialize a `thrds discord` session for DOC_PATH.

    Same on-disk shape as `slack init` / `capture init` — session dir under
    ``<git-root-or-cwd>/capture/<slug>/``, optionally gist-mirrored. No Slack
    plumbing.
    """
    target, state, was_resume = _do_init(doc_path, no_gist, channel_prefix=None, platform='discord')
    if was_resume:
        return
    hint = None if state.gist_id is None else f"Gist: https://gist.github.com/{state.gist_id}"
    _print_init_completion(target, state, extra_hint=hint)


@discord_cli.command("render")
@click.option('-L', '--no-lint', is_flag=True, help='Skip the MD-compat lint pass (default: run it, warnings → stderr).')
@click.argument('doc_path', required=False)
def discord_render(no_lint: bool, doc_path: str | None):
    """Print DOC_PATH to stdout for paste-into-Discord.

    Idiomatic: ``thrds discord render | pbcopy`` (or set up the `tdc` alias
    in `.thrds-rc`). By default runs the Discord MD-compat lint first and
    prints warnings to stderr; pass ``-L`` to skip.
    """
    state = _load_state(expected_platform='discord')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    if not no_lint:
        _run_discord_lint(text, path)
    click.echo(text, nl=False)


@discord_cli.command("lint")
@click.argument('doc_path', required=False)
def discord_lint(doc_path: str | None):
    """Run the Discord MD-compat lint on DOC_PATH; print warnings to stderr.

    Exit code is 0 whether or not issues were found (warnings, not errors —
    the doc still renders, just not as intended). Rules:

    \b
    - markdown tables don't render; use a code block or bullets.
    - raw `@name` doesn't ping; needs `<@user_id>`.
    """
    state = _load_state(expected_platform='discord')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    n = _run_discord_lint(text, path)
    if n == 0:
        err(f"{path}: no issues")


@discord_cli.command("open")
@click.option('-U', '--no-open', is_flag=True, help='Print the URL, do not launch browser.')
def discord_open(no_open: bool):
    """Open this session's gist in the browser (or print with -U)."""
    state = _load_state(expected_platform='discord')
    if state.gist_id is None:
        raise click.UsageError(
            'No gist recorded — session was init\'d with --no-gist.'
        )
    url = f'https://gist.github.com/{state.gist_id}'
    err(f'Opening gist {state.gist_id}: {url}')
    if not no_open:
        webbrowser.open(url)


@discord_cli.command("preview")
@click.option('-c', '--commit', is_flag=True, help='Commit the doc to the session repo on each page save.')
@click.option('-p', '--port', type=int, default=None, help='Port to serve on (default: 3077; 0 picks an ephemeral port).')
@click.option('-U', '--no-open', is_flag=True, help='Print the URL, do not launch browser.')
def discord_preview(commit: bool, port: int | None, no_open: bool):
    """Serve a local preview of the doc, with edit-write-back.

    Renders the session's doc in a local page (no tokens, no network): edit
    in the page and Save writes the `.md` back (refused if the file changed
    on disk since the page loaded it — no clobbering); edit in your editor
    and the page reloads. Lint warnings update live. With ``-c`` each page
    save also commits to the session repo, so iterations land in the gist
    trajectory.

    Until the Discord-faithful renderer bundle lands (see
    `specs/discord-preview.md`), the render pane is a labeled stub — the
    edit/save/lint loop is live now, the faithful render drops in later.
    """
    from .lint import DiscordLinter
    from .preview import DEFAULT_PORT, serve

    state = _load_state(expected_platform='discord')
    doc_path = Path(_resolve_doc_path(state, None)).resolve()
    session_dir = Path.cwd()

    on_save = None
    if commit:
        def on_save(content: str) -> None:
            sha = mirror.commit(session_dir, [str(doc_path)], f'preview: save {doc_path.name}')
            if sha:
                err(f'committed {sha[:7]}')

    if port is None:
        port = DEFAULT_PORT
    try:
        httpd = serve(doc_path, port, lint=lambda text: DiscordLinter().lint(text).issues, on_save=on_save)
    except OSError as e:
        raise click.ClickException(
            f'port {port} unavailable ({e.strerror}) — another server running? '
            f'`kill-port {port}` or pass -p.'
        )
    url = f'http://localhost:{httpd.server_address[1]}/'
    err(f'Previewing {doc_path.name} at {url} (ctrl-c to stop)')
    if not no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        err('stopped')


DISCORD_BOT_TOKEN_ENV = 'THRDS_DISCORD_BOT_TOKEN'
DISCORD_CHANNEL_ENV = 'THRDS_DISCORD_CHANNEL'
DISCORD_GUILD_ENV = 'THRDS_DISCORD_GUILD'
DISCORD_WEBHOOK_ENV = 'THRDS_DISCORD_WEBHOOK'
# Name for the app-owned webhook `discord push` auto-creates when the env URL is
# unset — stable so it's reused across pushes (see `DiscordClient.create_webhook`).
HYBRID_WEBHOOK_NAME = 'thrds'


def _discord_client(
    state: SessionState,
    channel: str | None = None,
    guild: str | None = None,
    *,
    require_token: bool = True,
):
    """Resolve a `DiscordClient` for this session (flag → env → session state).

    Bot token from ``THRDS_DISCORD_BOT_TOKEN`` (never a flag — the token-
    handling rule). ``require_token=False`` allows a dry run to build the plan
    with no credentials (a dry run makes no API calls, so the token is never
    sent).
    """
    from .discord import DiscordClient

    token = os.environ.get(DISCORD_BOT_TOKEN_ENV)
    if not token:
        if require_token:
            raise click.UsageError(
                f'Set {DISCORD_BOT_TOKEN_ENV} to a Discord bot token to push.'
            )
        token = 'dry-run'  # never sent — a dry run posts nothing
    channel_id = channel or os.environ.get(DISCORD_CHANNEL_ENV) or state.discord_channel_id
    if not channel_id:
        raise click.UsageError(
            f'No Discord channel; pass --channel, set {DISCORD_CHANNEL_ENV}, '
            'or record one in the session.'
        )
    guild_id = guild or os.environ.get(DISCORD_GUILD_ENV) or state.discord_guild_id
    return DiscordClient(token=token, channel_id=channel_id, guild_id=guild_id)


# `:name:` shortcode — an app-emoji name is `[A-Za-z0-9_]{2,32}`.
_EMOJI_SHORTCODE_RE = re.compile(r':([A-Za-z0-9_]{2,32}):')


def _rewrite_app_emoji(messages: 'list', emoji_map: dict) -> 'list':
    """Rewrite ``:name:`` → ``<:name:id>`` for names in ``emoji_map`` (Discord's
    custom-emoji ref). Unknown ``:name:`` (standard emoji, non-emoji colons) pass
    through unchanged, so this only touches the app's own custom emoji."""
    from dataclasses import replace as _replace

    from .core import Msg

    def sub(text: str) -> str:
        return _EMOJI_SHORTCODE_RE.sub(
            lambda m: f'<:{m.group(1)}:{emoji_map[m.group(1)]}>'
            if m.group(1) in emoji_map else m.group(0),
            text,
        )

    return [
        _replace(m, content=sub(m.content)) if isinstance(m, Msg) else sub(m)
        for m in messages
    ]


@discord_cli.command("push")
@click.option('-c', '--channel', help=f'Discord channel id (overrides {DISCORD_CHANNEL_ENV} / session).')
@click.option('-g', '--guild', help=f'Discord guild id, for permalinks (overrides {DISCORD_GUILD_ENV} / session).')
@click.option('-j', '--jitter', type=float, default=0.0, help='Extra random 0..jitter seconds added to --pace.')
@click.option('-n', '--dry-run', is_flag=True, help='Show the plan; post nothing.')
@click.option('-N', '--thread-name', help='Name for the created thread (default: the doc slug).')
@click.option('-p', '--pace', type=float, default=0.0, help='Seconds to wait between posts.')
@click.argument('doc_path', required=False)
def discord_push(
    channel: str | None,
    guild: str | None,
    jitter: float,
    dry_run: bool,
    thread_name: str | None,
    pace: float,
    doc_path: str | None,
):
    """Post this session's doc to Discord as the bot: OP in the channel, replies in a thread.

    The doc's OP (before the first ``+++``) posts to the channel; a child
    thread is opened off it and the replies post into that thread. Re-pushing a
    session that already has a recorded OP **reconciles** the live thread to the
    doc (edit changed messages, post new replies, delete removed ones), spanning
    the parent-channel OP and the child-thread replies. The one unsupported
    transition is growing a *lone* OP (no thread) into a thread on re-push —
    re-init the session for that (see ``specs/discord-push.md``).
    """
    from .core import Msg, Thread
    from .md import parse_thread, resolve_messages

    state = _load_state(expected_platform='discord')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    parsed = parse_thread(text)
    # Discord attachments are structural: lift trailing `![alt](target)` images
    # out of content into `Msg.images` (local paths resolved against the doc's
    # dir), so routing sees them and the reconcile diffs clean content.
    messages = resolve_messages(
        parsed.thread.messages, parsed.frontmatter,
        lift_images=True, base_dir=Path(path).parent,
    )
    name = thread_name or state.discord_thread_name or Path(state.doc_path).stem

    # A per-message sender (name/avatar) or an attachment is webhook-only on
    # Discord — including on the OP: `op_sender` / an image posts the OP through
    # the webhook (parent channel) and the bot opens the thread off it (see
    # specs/done/discord-webhook-attachments.md §3). Either makes a message a `Msg`.
    needs_webhook = any(isinstance(m, Msg) for m in messages)

    repush = state.discord_op_id is not None
    # A re-push always reads the live thread to compute the diff, so it needs a
    # real token even under --dry-run (unlike a fresh dry-run, which posts and
    # reads nothing).
    require_creds = repush or not dry_run
    bot = _discord_client(state, channel, guild, require_token=require_creds)
    webhook_auto_created = False
    if needs_webhook:
        # Per-sender / attachment messages go through a webhook, into the
        # bot-opened thread.
        from .discord import DiscordHybridClient, DiscordWebhookClient

        webhook_url = os.environ.get(DISCORD_WEBHOOK_ENV)
        if not webhook_url:
            if require_creds:
                # Bootstrap an **app-owned** webhook from the bot token (reused
                # by name across pushes) — no hand-pasted URL, and it guarantees
                # app-emoji rendering (a user-created webhook strips them). Needs
                # `MANAGE_WEBHOOKS`; the explicit env still overrides.
                try:
                    webhook_url = bot.create_webhook(HYBRID_WEBHOOK_NAME)
                    webhook_auto_created = True
                except RuntimeError as e:
                    raise click.UsageError(
                        f'Doc needs a webhook (per-sender replies or image attachments); '
                        f'auto-creating one failed ({e}). Grant the bot `MANAGE_WEBHOOKS`, '
                        f'or set {DISCORD_WEBHOOK_ENV} to a webhook URL.'
                    ) from e
            else:
                webhook_url = 'dry-run'  # never used — a dry run posts nothing
        client = DiscordHybridClient(bot, DiscordWebhookClient(webhook_url))
    else:
        client = bot

    # Rewrite `:name:` → `<:name:id>` for the app's custom emoji, but only where
    # it round-trips: the **bot** always renders/echoes the ref, and an
    # **app-owned** webhook does too — but a user-supplied (env) webhook strips
    # it back to `:name:` on ingest, which would re-edit every push. So gate on
    # transport safety: a bot-only push, or a webhook we auto-created (app-owned).
    emoji_safe = not needs_webhook or webhook_auto_created
    if require_creds and emoji_safe:
        combined = "\n".join(m.content if isinstance(m, Msg) else m for m in messages)
        if _EMOJI_SHORTCODE_RE.search(combined):
            emoji_map = bot.app_emojis()
            if emoji_map:
                messages = _rewrite_app_emoji(messages, emoji_map)

    # Reconcile target: fresh push creates the thread; a re-push points `sync`
    # at where the OP/replies already live so its positional diff aligns.
    reconcile_thread_id: str | None = None
    only_ids: set[str] | None = None
    if repush:
        if state.discord_thread_id is not None:
            # OP + replies: reconcile against the child thread; `list_messages`
            # prepends the parent-channel OP so existing[0] is the OP.
            reconcile_thread_id = state.discord_thread_id
        else:
            # Lone OP, no thread. Reconcile the OP in place, scoped to just it
            # (the base channel may hold unrelated messages). Growing it into a
            # thread mid-life isn't supported by the shared reconcile.
            if len(messages) > 1:
                raise click.UsageError(
                    f'Session has a lone OP ({state.discord_op_id}) and the doc now has '
                    f'{len(messages)} messages; growing a lone OP into a thread on re-push '
                    'is not supported. Re-init the session to push a fresh thread.'
                )
            reconcile_thread_id = client.channel_id
            only_ids = {state.discord_op_id}

    result = client.sync(
        Thread(messages=messages),
        thread_id=reconcile_thread_id,
        dry_run=dry_run,
        pace=pace,
        jitter=jitter,
        thread_name=name,
        only_ids=only_ids,
    )

    if dry_run:
        err(result.format_preview())
        verb = 're-push' if repush else 'fresh'
        err(f'(dry run — {verb}, {len(messages)} message(s), thread name {name!r})')
        return

    state.discord_channel_id = client.channel_id
    state.discord_guild_id = client.guild_id
    state.discord_op_id = result.message_ids[0]
    # A reconcile never changes the thread id (a lone-OP reconcile passes the
    # base channel as `thread_id`, which is not a thread), so only a fresh push
    # sets it — from whether the doc actually had replies.
    if not repush:
        state.discord_thread_id = result.thread_id if len(messages) > 1 else None
    state.discord_thread_name = name
    state.save()

    op_id = state.discord_op_id
    verb = 'Reconciled' if repush else 'Posted'
    if state.discord_thread_id:
        err(f'{verb} OP {op_id} + {len(messages) - 1} repl(y/ies) in thread {state.discord_thread_id}.')
    else:
        err(f'{verb} OP {op_id} (no replies).')
    if client.guild_id:
        click.echo(f'https://discord.com/channels/{client.guild_id}/{client.channel_id}/{op_id}')


@discord_cli.command("thread")
@click.option('-c', '--channel', help=f'Discord channel id (overrides {DISCORD_CHANNEL_ENV} / session).')
@click.option('-g', '--guild', help=f'Discord guild id (overrides {DISCORD_GUILD_ENV} / session).')
@click.argument('thread_id', required=False)
def discord_thread(channel: str | None, guild: str | None, thread_id: str | None):
    """Dump a live Discord thread's messages (id + content per line).

    THREAD_ID defaults to this session's recorded thread, falling back to its
    OP when there are no replies. A verification / debugging aid.
    """
    state = _load_state(expected_platform='discord')
    tid = thread_id or state.discord_thread_id or state.discord_op_id
    if not tid:
        raise click.UsageError(
            'No thread id (session not pushed yet); pass one explicitly.'
        )
    client = _discord_client(state, channel, guild)
    for m in client.list_messages(tid):
        click.echo(f'{m.id}\t{m.content}')


# ============================================================================
# `thrds bsky …` subgroup — capture + Bluesky-specific lint, no live push.
# ============================================================================
#
# Bluesky's chief drafting pain is the 300-char post limit (per paragraph);
# beyond that, its render dialect is similar to Discord's (bare URLs
# auto-linkify via facets; masked-link syntax renders literal). Same phase-2c
# shape as `discord`: init + render + lint + open, no live push.


def _run_bsky_lint(doc_text: str, doc_path: str) -> int:
    """Shared lint runner for `bsky lint` and `bsky render`.

    Prints the report to stderr; returns the number of issues found.
    """
    from .lint import BskyLinter
    report = BskyLinter().lint(doc_text)
    if report.has_issues:
        err(report.format(path=doc_path))
    return len(report.issues)


@cli.group("bsky")
def bsky_cli():
    """Bluesky workflow: init, render (for paste), lint (post-length + link check).

    Same shape as `discord` — no `push`, since bsky's drafting workflow benefits
    most from the length + link lint alongside a gist-mirrored trajectory.
    The `BskyClient` in `thrds.bsky` (Python API) is unaffected; those wanting
    to script bsky posting directly can still import it.
    """
    pass


@bsky_cli.command("init")
@click.option('-G', '--no-gist', is_flag=True, help='Skip gist creation; local git repo only.')
@click.argument('doc_path')
def bsky_init(no_gist: bool, doc_path: str):
    """Initialize a `thrds bsky` session for DOC_PATH.

    Same on-disk shape as `slack init` / `discord init` / `capture init` —
    session dir under ``<git-root-or-cwd>/bsky/<slug>/``, optionally
    gist-mirrored. No atproto plumbing.
    """
    target, state, was_resume = _do_init(doc_path, no_gist, channel_prefix=None, platform='bsky')
    if was_resume:
        return
    hint = None if state.gist_id is None else f"Gist: https://gist.github.com/{state.gist_id}"
    _print_init_completion(target, state, extra_hint=hint)


@bsky_cli.command("render")
@click.option('-L', '--no-lint', is_flag=True, help='Skip the MD-compat lint pass (default: run it, warnings → stderr).')
@click.argument('doc_path', required=False)
def bsky_render(no_lint: bool, doc_path: str | None):
    """Print DOC_PATH to stdout for paste-into-Bluesky.

    Idiomatic: ``thrds bsky render | pbcopy`` (or set up the `tbc` alias
    in `.thrds-rc`). By default runs the bsky lint first and prints
    warnings to stderr; pass ``-L`` to skip.
    """
    state = _load_state(expected_platform='bsky')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    if not no_lint:
        _run_bsky_lint(text, path)
    click.echo(text, nl=False)


@bsky_cli.command("lint")
@click.argument('doc_path', required=False)
def bsky_lint(doc_path: str | None):
    """Run the Bluesky MD-compat lint on DOC_PATH; print warnings to stderr.

    Exit code is 0 whether or not issues were found (warnings, not errors —
    the doc is still postable, just not as intended). Rules:

    \b
    - paragraphs exceeding 300 chars (bsky's post limit).
    - masked links `[text](url)` render as literal text; use bare URLs
      (bsky auto-linkifies via facets).
    """
    state = _load_state(expected_platform='bsky')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    n = _run_bsky_lint(text, path)
    if n == 0:
        err(f"{path}: no issues")


@bsky_cli.command("open")
@click.option('-U', '--no-open', is_flag=True, help='Print the URL, do not launch browser.')
def bsky_open(no_open: bool):
    """Open this session's gist in the browser (or print with -U)."""
    state = _load_state(expected_platform='bsky')
    if state.gist_id is None:
        raise click.UsageError(
            'No gist recorded — session was init\'d with --no-gist.'
        )
    url = f'https://gist.github.com/{state.gist_id}'
    err(f'Opening gist {state.gist_id}: {url}')
    if not no_open:
        webbrowser.open(url)


# ---------------------------------------------------------------------------
# `thrds mastodon` — init + render + lint + open, same phase-1 shape as `bsky`.
#
# Mastodon's draft-time constraints mirror bsky's (no markdown parsing → masked
# links render literal, bare URLs auto-link; a per-paragraph length limit,
# default 500 chars). Unlike bsky, Mastodon has a real edit API, so a live
# `push` is coherent here later — but the immediately useful, account-free
# increment is the same render-for-paste + lint + gist-mirrored trajectory.
# The `MastodonClient` in `thrds.mastodon` (Python API) already implements the
# full `ThreadClient` (with a real `edit()`) for those scripting directly.


def _run_mastodon_lint(doc_text: str, doc_path: str) -> int:
    """Shared lint runner for `mastodon lint` and `mastodon render`.

    Prints the report to stderr; returns the number of issues found.
    """
    from .lint import MastodonLinter
    report = MastodonLinter().lint(doc_text)
    if report.has_issues:
        err(report.format(path=doc_path))
    return len(report.issues)


@cli.group("mastodon")
def mastodon_cli():
    """Mastodon workflow: init, render (for paste), lint (post-length + link check).

    Same phase-1 shape as `discord` / `bsky` — no `push` verb yet, though
    `thrds.mastodon.MastodonClient` (a full `ThreadClient` with a real edit
    API) is importable for scripting posts directly.
    """
    pass


@mastodon_cli.command("init")
@click.option('-G', '--no-gist', is_flag=True, help='Skip gist creation; local git repo only.')
@click.argument('doc_path')
def mastodon_init(no_gist: bool, doc_path: str):
    """Initialize a `thrds mastodon` session for DOC_PATH.

    Same on-disk shape as the other platform inits — session dir under
    ``<git-root-or-cwd>/mastodon/<slug>/``, optionally gist-mirrored. No live
    API plumbing (that lives in `MastodonClient` for scripting).
    """
    target, state, was_resume = _do_init(doc_path, no_gist, channel_prefix=None, platform='mastodon')
    if was_resume:
        return
    hint = None if state.gist_id is None else f"Gist: https://gist.github.com/{state.gist_id}"
    _print_init_completion(target, state, extra_hint=hint)


@mastodon_cli.command("render")
@click.option('-L', '--no-lint', is_flag=True, help='Skip the MD-compat lint pass (default: run it, warnings → stderr).')
@click.argument('doc_path', required=False)
def mastodon_render(no_lint: bool, doc_path: str | None):
    """Print DOC_PATH to stdout for paste-into-Mastodon.

    Idiomatic: ``thrds mastodon render | pbcopy``. By default runs the mastodon
    lint first and prints warnings to stderr; pass ``-L`` to skip.
    """
    state = _load_state(expected_platform='mastodon')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    if not no_lint:
        _run_mastodon_lint(text, path)
    click.echo(text, nl=False)


@mastodon_cli.command("lint")
@click.argument('doc_path', required=False)
def mastodon_lint(doc_path: str | None):
    """Run the Mastodon MD-compat lint on DOC_PATH; print warnings to stderr.

    Exit code is 0 whether or not issues were found (warnings, not errors).
    Rules:

    \b
    - paragraphs exceeding 500 chars (Mastodon's default post limit).
    - masked links `[text](url)` render as literal text; use bare URLs
      (Mastodon auto-links them).
    """
    state = _load_state(expected_platform='mastodon')
    path = _resolve_doc_path(state, doc_path)
    text = Path(path).read_text()
    n = _run_mastodon_lint(text, path)
    if n == 0:
        err(f"{path}: no issues")


@mastodon_cli.command("open")
@click.option('-U', '--no-open', is_flag=True, help='Print the URL, do not launch browser.')
def mastodon_open(no_open: bool):
    """Open this session's gist in the browser (or print with -U)."""
    state = _load_state(expected_platform='mastodon')
    if state.gist_id is None:
        raise click.UsageError(
            'No gist recorded — session was init\'d with --no-gist.'
        )
    url = f'https://gist.github.com/{state.gist_id}'
    err(f'Opening gist {state.gist_id}: {url}')
    if not no_open:
        webbrowser.open(url)


def main():
    cli()


def github_main():
    """Entry point for `ghpr` — `thrds github …` without the prefix.

    Same arrangement as :func:`slack_main`: one group object, reached by two
    names. Keeps `ghpr` (and the `ghprc`/`ghprd`/`ghprp` aliases built on it)
    working unchanged now that the package it used to ship from is merged in
    here — the command name is the tool's user-facing surface and outlives
    the distribution that carried it.
    """
    from .platforms.github.cli import cli as github_cli
    github_cli(prog_name='ghpr')


def slack_main():
    """Entry point for `slck` — `thrds slack …` without the prefix.

    Invokes the very same :data:`slack_cli` group object, so every verb,
    option and help string is shared; there is nothing to keep in sync. This
    exists instead of per-verb shell aliases because an alias list needs one
    entry per verb and silently goes stale as verbs are added, while a group
    entry point picks up new ones for free.
    """
    slack_cli(prog_name='slck')


if __name__ == '__main__':
    main()
