"""Local session state for a thrds session — the write-through cache of thread ownership.

Written to ``thrds.yml`` at the session root, tracked and gist-mirrored via
the git repo so multi-machine sees the same authoritative slug → thread_ts map
without needing to scan Slack. (Capture sessions are the exception: they have
no thread_ts maps to sync, so their ``thrds.yml`` is a local-only, git-excluded
file and the gist carries just the doc.) The Slack ``metadata`` field on each
posted message carries the same info (session_id, slug, kind) as
belt-and-suspenders: if the local state is lost or corrupted,
``thrds slack recover`` scans Slack filtered by session_id and rebuilds this file.

Per-thread model (``specs/per-thread-model.md``)
------------------------------------------------
::

    private ephemeral channel (PEC)  ↔  gist  ↔  session  ↔  N threads
                                                  thread  ↔  one `NN-slug.md`

``threads`` maps each thread's slug to a :class:`ThreadEntry`: where its draft
lives in the staging channel, where it's destined (:class:`ThreadTarget`), and
its lifecycle state. **Destination is a property of the thread, not the
session** — that's what collapses the two use cases into one shape:

- batch: N threads, all targeting one channel with no ``thread_ts`` (the
  session-level ``prod_channel`` supplies it as a default, so no per-thread
  config is needed at all);
- reply: N threads, each targeting a different channel and/or an existing
  thread within it.

Legacy layout (pre-per-thread)
------------------------------
Sessions created before the per-thread model have a single ``doc_path`` holding
many ``===``-separated threads, with pointers split across ``staging_threads``
and ``prod_threads[channel][slug]``, and ``prod_channel`` as the *authority*
for prod pushes rather than a default. :attr:`SessionState.is_legacy` detects
these; ``thrds slack migrate`` converts one. The legacy fields are retained
(and still drive the pre-migration code paths) until every live session has
been migrated.

``platform`` identifies which subcommand group owns this session:

- ``"slack"``: the default; ``thrds slack …`` verbs operate on it.
- ``"discord"`` / ``"bsky"``: reserved for future subcommand groups.
- ``"capture"``: no platform target — gist-mirrored trajectory only, `thrds capture …`.

Old state files (pre-0.6) predate the field and default to ``"slack"`` on load.
"""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import MISSING, asdict, dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

import yaml


# Flat filenames (not `.thrds/state.yml`) — GitHub gists reject directories.
# YAML since the per-remote-pointers schema (`specs/remotes-model.md`): nicer
# to read and hand-edit, and the extension change doubles as the version
# boundary — old code can't half-read new state, and new code migrates the
# legacy JSON explicitly (`load` reads it, the next `save` replaces it).
STATE_PATH = Path('thrds.yml')
LEGACY_STATE_PATH = Path('thrds.json')
DEFAULT_GIST_REMOTE = 'g'  # matches ghpr's convention
CHANNEL_PREFIX_ENV = 'THRDS_CHANNEL_PREFIX'

VALID_PLATFORMS = ('slack', 'discord', 'bsky', 'mastodon', 'capture')
DEFAULT_PLATFORM = 'slack'

# A thread's lifecycle. `draft` → not ready; `ready` → armed for push (set by
# hand or by a 🟢 reaction); `posted` → landed at its target; `dropped` →
# abandoned without posting. Archiving the staging channel is gated on every
# thread being `posted` or `dropped`.
VALID_THREAD_STATES = ('draft', 'ready', 'posted', 'dropped')
DEFAULT_THREAD_STATE = 'draft'
TERMINAL_THREAD_STATES = ('posted', 'dropped')


# Staging chrome rendered as `context` blocks before that turned out to strip
# Slack's Edit affordance from every staged message.
RETIRED_CHROME_STYLE = 'context_block'


@dataclass
class StagingChrome:
    """What extra affordances to render on staged messages, and how.

    "Chrome" is anything visible in staging that must be absent from prod: a
    link back to the gist (so the versions being captured are auditable from
    Slack) and a pointer to the message a draft is replying to.

    It is stored here and rendered at push time — **never** written into doc
    content, so the body posted to prod is byte-identical to the body reviewed
    in staging. It renders as one trailing line in the message text, stripped
    on pull; see `thrds.chrome` for the shape, and for why it can't live in
    ``blocks`` (Slack makes any message carrying blocks uneditable, which would
    cost the staging channel the editing it exists for).
    """
    gist_link: bool = True
    target_link: bool = True
    posted_link: bool = True
    # Once a thread is `posted` or `dropped`, re-render its staged copy with
    # chrome in a `context` block. Slack strips the Edit affordance from any
    # message carrying blocks — a liability for a draft, and precisely the
    # value for one that's already gone out: the staged copy visibly locks.
    # `thrds slack reopen` is the way back.
    finalize_terminal: bool = True
    style: str = 'footer'

    def __post_init__(self) -> None:
        # `context_block` was the shipped default before blocks turned out to
        # make staged messages uneditable. Coerce rather than raise: it names a
        # version, not a choice, and refusing to load would strand any session
        # written by that version behind a hand-edit of `thrds.yml`.
        if self.style == RETIRED_CHROME_STYLE:
            self.style = 'footer'
        if self.style != 'footer':
            raise ValueError(
                f"Unsupported staging-chrome style {self.style!r}; only 'footer' "
                f"keeps staged messages editable in Slack"
            )

    @property
    def any_enabled(self) -> bool:
        return self.gist_link or self.target_link or self.posted_link


@dataclass
class ThreadTarget:
    """Where a thread is destined: a channel, and optionally a thread within it.

    ``thread_ts is None`` means "post as a new top-level message in
    ``channel``" — the batch case (six sibling messages into one channel).
    ``thread_ts`` set means "post as a reply into that existing thread" — the
    case of drafting a considered response to someone else's message.

    Destination is a property of the *thread*, not the session: that's what
    collapses both use cases into one shape. The session-level
    ``prod_channel`` is only a default for newly-added threads.
    """
    channel: str
    thread_ts: str | None = None

    def __post_init__(self) -> None:
        if not self.channel:
            raise ValueError("ThreadTarget.channel must be non-empty")


STAGING_REMOTE = 'staging'
PROD_REMOTE = 'prod'


def _require_ts_str(name: str, value: Any) -> None:
    if isinstance(value, (int, float)):
        raise ValueError(
            f"{name} parsed as a number ({value!r}) — Slack ts values must be "
            f"quoted strings in {STATE_PATH} (unquoted YAML turns them into "
            f"floats and can lose precision)"
        )


@dataclass
class RemotePointer:
    """One thread's footprint at one remote (`specs/remotes-model.md`).

    ``ts`` is our root message there; ``msg_ts`` every message id we've posted
    there — the reconcile whitelist for re-converging into shared threads.
    ``channel`` + ``thread_ts`` say where, and what we replied *into*
    (staging-role pointers omit them, inheriting the session's staging
    channel). ``url`` is the root's permalink — stored rather than derived
    because deriving one needs the workspace domain, which only Slack knows,
    and every path that sets ``ts`` already holds one; persisting it keeps
    later readers (chrome, ``status``) offline.
    """
    ts: str | None = None
    msg_ts: list[str] | None = None
    channel: str | None = None
    thread_ts: str | None = None
    url: str | None = None

    def __post_init__(self) -> None:
        _require_ts_str('ts', self.ts)
        _require_ts_str('thread_ts', self.thread_ts)
        for v in self.msg_ts or ():
            _require_ts_str('msg_ts', v)


@dataclass(init=False)
class ThreadEntry:
    """Per-thread state: its lifecycle, and its pointers at each remote.

    ``remotes`` maps remote name → :class:`RemotePointer`; ``upstream`` (which
    remote is canonical right now) is derived from ``state`` until a thread
    can name one of several prod-role remotes.

    The pre-pointers field names (``staging_ts``, ``target``, ``posted_ts``,
    ``posted_url``, ``posted_msg_ts``) survive as constructor kwargs and
    read/write properties over the pointer map — old `thrds.json` entries load
    through them, and call sites migrate to remote-parameterized access
    incrementally. They are no longer serialized.
    """
    state: str
    remotes: dict[str, RemotePointer]

    def __init__(
        self,
        state: str = DEFAULT_THREAD_STATE,
        remotes: dict[str, RemotePointer | dict] | None = None,
        *,
        staging_ts: str | None = None,
        target: ThreadTarget | dict | None = None,
        posted_ts: str | None = None,
        posted_url: str | None = None,
        posted_msg_ts: list[str] | None = None,
    ) -> None:
        if state not in VALID_THREAD_STATES:
            raise ValueError(
                f"Invalid thread state {state!r}; must be one of {VALID_THREAD_STATES}"
            )
        self.state = state
        self.remotes = {
            name: p if isinstance(p, RemotePointer) else RemotePointer(**p)
            for name, p in (remotes or {}).items()
        }
        if staging_ts is not None:
            self.staging_ts = staging_ts
        if isinstance(target, dict):
            target = ThreadTarget(**target)
        if target is not None:
            self.target = target
        if posted_ts is not None:
            self.posted_ts = posted_ts
        if posted_url is not None:
            self.posted_url = posted_url
        if posted_msg_ts is not None:
            self.posted_msg_ts = posted_msg_ts

    def pointer(self, remote: str) -> RemotePointer:
        """The pointer at ``remote``, created empty on first access."""
        if remote not in self.remotes:
            self.remotes[remote] = RemotePointer()
        return self.remotes[remote]

    @property
    def upstream(self) -> str:
        """Which remote is canonical for this thread right now."""
        return PROD_REMOTE if self.state == 'posted' else STAGING_REMOTE

    @property
    def is_terminal(self) -> bool:
        """True once this thread has been posted or explicitly dropped."""
        return self.state in TERMINAL_THREAD_STATES

    # --- pre-pointers accessors (see class docstring) -----------------------

    @property
    def staging_ts(self) -> str | None:
        p = self.remotes.get(STAGING_REMOTE)
        return p.ts if p is not None else None

    @staging_ts.setter
    def staging_ts(self, value: str | None) -> None:
        self.pointer(STAGING_REMOTE).ts = value

    @property
    def target(self) -> ThreadTarget | None:
        p = self.remotes.get(PROD_REMOTE)
        if p is None or p.channel is None:
            return None
        return ThreadTarget(channel=p.channel, thread_ts=p.thread_ts)

    @target.setter
    def target(self, value: ThreadTarget | None) -> None:
        if value is None:
            p = self.remotes.get(PROD_REMOTE)
            if p is not None:
                p.channel = None
                p.thread_ts = None
            return
        p = self.pointer(PROD_REMOTE)
        p.channel = value.channel
        p.thread_ts = value.thread_ts

    @property
    def posted_ts(self) -> str | None:
        p = self.remotes.get(PROD_REMOTE)
        return p.ts if p is not None else None

    @posted_ts.setter
    def posted_ts(self, value: str | None) -> None:
        self.pointer(PROD_REMOTE).ts = value

    @property
    def posted_url(self) -> str | None:
        p = self.remotes.get(PROD_REMOTE)
        return p.url if p is not None else None

    @posted_url.setter
    def posted_url(self, value: str | None) -> None:
        self.pointer(PROD_REMOTE).url = value

    @property
    def posted_msg_ts(self) -> list[str] | None:
        p = self.remotes.get(PROD_REMOTE)
        return p.msg_ts if p is not None else None

    @posted_msg_ts.setter
    def posted_msg_ts(self, value: list[str] | None) -> None:
        self.pointer(PROD_REMOTE).msg_ts = value


def _prune_none(value: Any) -> Any:
    """Drop ``None`` values recursively; keep empty containers and strings."""
    if isinstance(value, dict):
        return {k: _prune_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_prune_none(v) for v in value]
    return value


def resolve_channel_prefix(session_override: str | None) -> str:
    """Resolve the channel prefix for a private-channel name.

    Precedence: explicit ``session_override`` > ``THRDS_CHANNEL_PREFIX`` env
    var > empty string. Env-scoped is the common case (user-namespaced private
    channels like ``rw-``); the session override is for one-off deviations from
    the user default without needing to unset the env var.
    """
    if session_override is not None:
        return session_override
    return os.environ.get(CHANNEL_PREFIX_ENV, '')


@dataclass
class SessionState:
    """Session-wide state persisted between `thrds` invocations.

    ``session_id`` is generated once at init and stamped into every posted
    message's Slack metadata; it's the key that lets ``recover`` find our
    threads via Slack alone.

    ``doc_path`` is the .md filename (relative to the session root) that this
    session is drafting — resolved at init and pinned; changing which doc a
    session drafts is a new session.

    ``channel_prefix`` overrides the ``THRDS_CHANNEL_PREFIX`` env var at
    session scope — usually left ``None`` (env-scoped is the common case for
    user-namespaced private channels).

    ``platform`` is set implicitly by the ``init`` subcommand used
    (``thrds slack init`` → ``"slack"``, ``thrds capture init`` → ``"capture"``,
    etc.). All subsequent verbs for that session must match; the ``slack_cli`` /
    ``capture_cli`` groups guard on this to fail fast with a clear error rather
    than blowing up deep inside a mismatched code path.
    """
    session_id: str
    doc_path: str | None = None
    session_slug: str | None = None
    prod_channel: str | None = None
    gist_id: str | None = None
    gist_remote: str = DEFAULT_GIST_REMOTE
    channel_prefix: str | None = None
    platform: str = DEFAULT_PLATFORM
    staging_channel: str | None = None
    staging_preamble_ts: str | None = None
    staging_threads: dict[str, str] = field(default_factory=dict)                    # slug → thread_ts
    staging_archived: bool = False                                                   # True once the PC has been archived (idempotence marker)
    prod_threads: dict[str, dict[str, str]] = field(default_factory=dict)            # channel → (slug → thread_ts)
    prod_preamble_ts: dict[str, str] = field(default_factory=dict)                   # channel → preamble ts
    workspace_emoji: dict[str, str] = field(default_factory=dict)                    # custom emoji name → local filename (relative to session dir)
    channel_names: dict[str, str] = field(default_factory=dict)                      # channel id → name; a display-only cache, so a rename just goes stale
    threads: dict[str, ThreadEntry] = field(default_factory=dict)                    # slug → per-thread state (per-thread model; see `threads_legacy`)
    staging_chrome: StagingChrome = field(default_factory=StagingChrome)             # the default staging remote's chrome (session-level knob)
    remotes: dict[str, dict] = field(default_factory=dict)                           # remotes config: name → {role, channel, chrome}; see `thrds.remotes.resolve`
    # Discord session config (platform == 'discord'). All None-default, so the
    # slim serializer omits them from every non-Discord session's thrds.yml.
    # `channel_id`/`guild_id` say where to post; `op_id`/`thread_id` are filled
    # in by the first `thrds discord push` (the OP lives in the channel, its
    # replies in the child thread) so a re-push reconciles the same thread.
    discord_channel_id: str | None = None
    discord_guild_id: str | None = None
    discord_op_id: str | None = None
    discord_thread_id: str | None = None
    discord_thread_name: str | None = None

    def __post_init__(self) -> None:
        if self.platform not in VALID_PLATFORMS:
            raise ValueError(
                f"Invalid platform {self.platform!r}; must be one of {VALID_PLATFORMS}"
            )
        if isinstance(self.staging_chrome, dict):
            self.staging_chrome = StagingChrome(**self.staging_chrome)
        # `load` reconstructs via `cls(**json)`, so nested entries arrive as
        # plain dicts; coerce here so both load and direct construction yield
        # the same types.
        self.threads = {
            slug: entry if isinstance(entry, ThreadEntry) else ThreadEntry(**entry)
            for slug, entry in self.threads.items()
        }

    @classmethod
    def new(cls, **overrides: Any) -> 'SessionState':
        """Create a new SessionState with a fresh session_id (UUID4)."""
        return cls(session_id=str(uuid.uuid4()), **overrides)

    @classmethod
    def load(cls, root: Path | str = '.') -> 'SessionState':
        """Load from ``<root>/thrds.yml`` (or the legacy ``thrds.json``); raise if missing.

        A legacy file loads through :class:`ThreadEntry`'s pre-pointers
        kwargs; the next :meth:`save` writes ``thrds.yml`` and removes it.
        """
        path = Path(root) / STATE_PATH
        if path.exists():
            return cls(**yaml.safe_load(path.read_text()))
        legacy = Path(root) / LEGACY_STATE_PATH
        if legacy.exists():
            return cls(**json.loads(legacy.read_text()))
        raise FileNotFoundError(
            f"No thrds session state at {path}; run `thrds <platform> init` first."
        )

    _ALWAYS_SERIALIZED = ('session_id', 'doc_path', 'platform')

    def save(self, root: Path | str = '.') -> None:
        """Persist to ``<root>/thrds.yml``, creating the parent dir if needed.

        Fields still at their dataclass default are omitted — ``load``
        restores them, so the round trip is identical state and the YAML
        holds only what this session has actually set (a capture session's
        file is ~5 lines, not a page of empty Slack maps). Identity fields
        (``session_id``, ``doc_path``, ``platform``) are always written.
        Note ``channel_prefix: ''`` and ``channel_prefix: null`` mean
        different things: only the latter equals the default, so the
        empty-string form survives. Removes the legacy ``thrds.json`` —
        callers' commits record the swap (`_stage_paths`).
        """
        data = _prune_none(asdict(self))
        for f in fields(self):
            if f.name in self._ALWAYS_SERIALIZED or f.name not in data:
                continue
            if f.default is not MISSING:
                default = f.default
            elif f.default_factory is not MISSING:
                default = f.default_factory()
            else:
                continue
            if is_dataclass(default):
                default = asdict(default)
            if data[f.name] == _prune_none(default):
                del data[f.name]
        path = Path(root) / STATE_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(
            data, sort_keys=False, allow_unicode=True,
        ))
        legacy = Path(root) / LEGACY_STATE_PATH
        legacy.unlink(missing_ok=True)

    def get_thread_ts(self, channel: str, slug: str) -> str | None:
        """Look up the recorded thread_ts for ``(channel, slug)``; None if not present."""
        if channel == self.staging_channel:
            return self.staging_threads.get(slug)
        return self.prod_threads.get(channel, {}).get(slug)

    def set_thread_ts(self, channel: str, slug: str, thread_ts: str) -> None:
        """Record that ``slug`` was posted at ``thread_ts`` in ``channel``.

        Routes to ``staging_threads`` when ``channel == staging_channel``, else
        into ``prod_threads[channel]`` (creating the inner dict on first write).
        """
        if channel == self.staging_channel:
            self.staging_threads[slug] = thread_ts
        else:
            self.prod_threads.setdefault(channel, {})[slug] = thread_ts

    def threads_in(self, channel: str) -> dict[str, str]:
        """Return a snapshot dict of slug → thread_ts for ``channel`` (empty if none)."""
        if channel == self.staging_channel:
            return dict(self.staging_threads)
        return dict(self.prod_threads.get(channel, {}))

    # --- per-thread model (`threads`) ---------------------------------------

    @property
    def is_legacy(self) -> bool:
        """True for a session still on the one-doc-many-threads layout.

        The discriminator is ``doc_path``: a legacy session keeps every thread
        in that one file, and migration clears it when the content moves out to
        ``NN-slug.md`` files. Deliberately *not* keyed on whether
        ``staging_threads`` is populated — a freshly-inited session has a doc
        but no threads recorded yet, and is still very much single-doc.

        Verbs on the per-thread model check this and direct the user to
        ``thrds slack migrate`` rather than silently operating on a session
        whose threads they can't see.
        """
        return self.doc_path is not None

    def thread(self, slug: str) -> ThreadEntry:
        """The :class:`ThreadEntry` for ``slug``, creating an empty one if absent.

        Creating-on-access is right here because a thread's existence is
        determined by its file on disk; ``thrds.yml`` only accumulates what
        we've learned about it (where its draft landed, where it's going).
        """
        if slug not in self.threads:
            self.threads[slug] = ThreadEntry()
        return self.threads[slug]

    def target_for(self, slug: str) -> ThreadTarget | None:
        """Resolved destination for ``slug``: its own target, else the session default.

        Falls back to ``prod_channel`` as a bare channel target, which is what
        makes the batch case (N threads, all the same channel) require no
        per-thread configuration at all.
        """
        entry = self.threads.get(slug)
        if entry is not None and entry.target is not None:
            return entry.target
        if self.prod_channel is not None:
            return ThreadTarget(channel=self.prod_channel)
        return None

    def pending_threads(self) -> list[str]:
        """Slugs not yet in a terminal (``posted``/``dropped``) state, in slug order.

        Archiving the staging channel is gated on this being empty — other
        drafts being live is exactly why prod push must not auto-archive.
        """
        return sorted(slug for slug, e in self.threads.items() if not e.is_terminal)

    @property
    def doc_slug(self) -> str:
        """The session's slug: the local ID and the un-prefixed staging channel name.

        Prefers the explicit ``session_slug``; falls back to the ``doc_path``
        basename for legacy sessions, where the single doc *was* the session's
        identity. Migration pins ``session_slug`` before retiring ``doc_path``,
        so the staging channel name and session dir stay stable across it.
        """
        if self.session_slug is not None:
            return self.session_slug
        if self.doc_path is None:
            raise ValueError("neither session_slug nor doc_path is set on this session")
        return Path(self.doc_path).stem

    def staging_channel_name(self) -> str:
        """The Slack-side name to use when creating this session's staging PC.

        ``<prefix><doc_slug>``, where ``<prefix>`` comes from
        :func:`resolve_channel_prefix`. This is the name proposed to
        ``conversations.create``; the API may lowercase / replace invalid
        chars, so the returned channel object is the source of truth for the
        actual name Slack assigned.
        """
        return f"{resolve_channel_prefix(self.channel_prefix)}{self.doc_slug}"
