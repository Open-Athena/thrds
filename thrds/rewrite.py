"""Bulk rewrite: find an app's Slack messages, re-render them, review the plan, apply it.

Three steps, the middle one pure (`specs/done/bulk-rewrite.md`):

1. **Find** (`find_history` / `find_thread` / `find_ids`): the messages in
   scope, as `Found` (wire text, blocks, sender, files, thread position).
   Ownership is the token's bot / user id, never the per-message
   ``username`` (custom senders change that).
2. **Plan** (`plan(found, render)`): the app's ``render(found) -> Desired |
   Skip`` re-derives each message; the plan gives each message one action:
   ``edit``, ``repost`` (the sender changes, which ``chat.update`` can't do),
   ``noop``, ``skip`` (the app's reason) or ``blocked`` (what Slack can't do).
   Each action records the message's content hash at planning time.
   `Plan.to_json` / `Plan.from_json` round-trip it for review.
3. **Apply** (`apply(plan, client)`): dry run unless ``dry_run=False``. Each
   action re-reads its message first and refuses it when the hash moved
   (``stale``); a message already matching the plan's new content is
   ``already``. Writes are paced, and an optional receipts file (JSONL) makes
   a re-run skip what's done.

The text is Slack wire mrkdwn throughout: no markdown conversion, since the
app renders the wire form itself.
"""
from __future__ import annotations

import hashlib
import json
import random
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import asdict, dataclass, field
from difflib import unified_diff
from enum import Enum
from pathlib import Path

from .slack import SLACK_MESSAGE_LIMIT, SlackApiError, SlackClient

PLAN_VERSION = 1

# `chat.update` / `chat.delete` are Slack tier 3 (~50/min), `chat.postMessage`
# ~1/s per channel: 1.2 s between writes stays under both.
DEFAULT_PACE = 1.2

# Subtypes an app's own posts carry; anything else (joins, file comments, …)
# isn't a message the app wrote.
_POST_SUBTYPES = (None, "bot_message", "thread_broadcast")


@dataclass(frozen=True)
class Sender:
    """A message's sender override: ``username`` and one icon (``icon_url`` beats ``icon_emoji``)."""
    username: str | None = None
    icon_url: str | None = None
    icon_emoji: str | None = None

    @property
    def is_override(self) -> bool:
        return self.username is not None or self.icon_url is not None or self.icon_emoji is not None

    def describe(self) -> str:
        if not self.is_override:
            return "the app"
        parts = []
        if self.username is not None:
            parts.append(f'"{self.username}"')
        if self.icon_emoji is not None:
            parts.append(self.icon_emoji)
        if self.icon_url is not None:
            parts.append(self.icon_url)
        return " ".join(parts)

    @classmethod
    def from_raw(cls, m: dict) -> Sender:
        """The override a read message shows: ``username``, and ``icons.emoji`` or an ``icons.image_*`` URL.

        Only a ``bot_message`` carries an override; an app's plain post has
        ``icons`` for its own avatar, which isn't one.
        """
        if m.get("subtype") != "bot_message":
            return cls()
        icons = m.get("icons") or {}
        emoji = icons.get("emoji")
        url = None
        if emoji is None:
            url = icons.get("image_original") or next(
                (v for k, v in sorted(icons.items()) if k.startswith("image_") and isinstance(v, str)),
                None,
            )
        return cls(username=m.get("username"), icon_url=url, icon_emoji=emoji)


@dataclass(frozen=True)
class Content:
    """What a message shows: wire ``text``, ``blocks`` (``None``: none), sender, attached file ids."""
    text: str
    blocks: list[dict] | None = None
    sender: Sender = field(default_factory=Sender)
    files: tuple[str, ...] = ()

    @property
    def hash(self) -> str:
        body = json.dumps(
            {"text": self.text, "blocks": self.blocks, "sender": asdict(self.sender), "files": list(self.files)},
            sort_keys=True,
            ensure_ascii=False,
        )
        return hashlib.sha256(body.encode()).hexdigest()[:16]

    def to_json(self) -> dict:
        return {"text": self.text, "blocks": self.blocks, "sender": asdict(self.sender), "files": list(self.files)}

    @classmethod
    def from_json(cls, d: dict) -> Content:
        return cls(
            text=d["text"],
            blocks=d.get("blocks"),
            sender=Sender(**d.get("sender", {})),
            files=tuple(d.get("files", ())),
        )


def _strip_block_ids(blocks: list[dict] | None) -> list[dict] | None:
    """``blocks`` without top-level ``block_id`` (Slack assigns one to each block it stores)."""
    if blocks is None:
        return None
    return [{k: v for k, v in b.items() if k != "block_id"} for b in blocks]


def _only_rich_text(blocks: list[dict] | None) -> bool:
    """No blocks, or only ``rich_text`` (Slack's own rendering of the text)."""
    return not blocks or all(b.get("type") == "rich_text" for b in blocks)


def same_content(live: Content, want: Content) -> bool:
    """``live`` (as read) already shows ``want``.

    Block ids are ignored (Slack assigns them). ``want.blocks is None`` (a
    text-only message) matches live blocks that are only ``rich_text``, which
    Slack derives from the text.
    """
    if live.text != want.text or live.sender != want.sender or live.files != want.files:
        return False
    if want.blocks is None:
        return _only_rich_text(live.blocks)
    return _strip_block_ids(live.blocks) == _strip_block_ids(want.blocks)


@dataclass(frozen=True)
class Found:
    """A message in scope, as read from Slack.

    ``thread_ts`` is the parent's ts for a reply and ``None`` for a top-level
    message. ``last`` says it's the newest in its container (the channel's top
    level, or its thread): only then can a repost keep its place. ``ours``:
    posted by this token's bot / user.
    """
    channel: str
    ts: str
    thread_ts: str | None
    content: Content
    ours: bool
    last: bool
    reply_count: int = 0
    subtype: str | None = None
    metadata: dict | None = None
    raw: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def text(self) -> str:
        return self.content.text

    @property
    def blocks(self) -> list[dict] | None:
        return self.content.blocks

    @property
    def sender(self) -> Sender:
        return self.content.sender

    @classmethod
    def from_raw(cls, m: dict, channel: str, bot_ids: tuple[str, str | None], last: bool) -> Found:
        user_id, bot_id = bot_ids
        parent = m.get("thread_ts")
        return cls(
            channel=channel,
            ts=m["ts"],
            thread_ts=parent if parent is not None and parent != m["ts"] else None,
            content=_content_of(m),
            ours=m.get("user") == user_id or (bot_id is not None and m.get("bot_id") == bot_id),
            last=last,
            reply_count=m.get("reply_count", 0),
            subtype=m.get("subtype"),
            metadata=m.get("metadata"),
            raw=m,
        )


def _content_of(m: dict) -> Content:
    return Content(
        text=m.get("text", ""),
        blocks=m.get("blocks"),
        sender=Sender.from_raw(m),
        files=tuple(f["id"] for f in m.get("files") or () if "id" in f),
    )


@dataclass(frozen=True)
class Desired:
    """What a message should show. ``blocks=None``: text only. ``sender=None``: keep its sender."""
    text: str
    blocks: list[dict] | None = None
    sender: Sender | None = None


@dataclass(frozen=True)
class Skip:
    """The app leaves this message alone, for ``reason``."""
    reason: str


Render = Callable[[Found], "Desired | Skip"]


class Kind(str, Enum):
    EDIT = "edit"
    REPOST = "repost"
    NOOP = "noop"
    SKIP = "skip"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class PlannedAction:
    kind: Kind
    channel: str
    ts: str
    thread_ts: str | None
    old: Content
    new: Content | None = None
    reason: str | None = None
    broadcast: bool = False
    metadata: dict | None = None

    @property
    def hash(self) -> str:
        """The message's content hash when planned; apply refuses it once this moves."""
        return self.old.hash

    @property
    def writes(self) -> bool:
        return self.kind in (Kind.EDIT, Kind.REPOST)

    def diff(self) -> str:
        """Unified diff of the wire text (empty when only blocks or the sender change)."""
        if self.new is None:
            return ""
        return "\n".join(unified_diff(
            self.old.text.split("\n"),
            self.new.text.split("\n"),
            fromfile=f"{self.ts} (now)",
            tofile=f"{self.ts} (planned)",
            lineterm="",
        ))

    def to_json(self) -> dict:
        d: dict = {
            "kind": self.kind.value,
            "channel": self.channel,
            "ts": self.ts,
            "thread_ts": self.thread_ts,
            "hash": self.hash,
            "old": self.old.to_json(),
            "new": None if self.new is None else self.new.to_json(),
            "reason": self.reason,
        }
        if self.broadcast:
            d["broadcast"] = True
        if self.metadata is not None:
            d["metadata"] = self.metadata
        return d

    @classmethod
    def from_json(cls, d: dict) -> PlannedAction:
        action = cls(
            kind=Kind(d["kind"]),
            channel=d["channel"],
            ts=d["ts"],
            thread_ts=d.get("thread_ts"),
            old=Content.from_json(d["old"]),
            new=None if d.get("new") is None else Content.from_json(d["new"]),
            reason=d.get("reason"),
            broadcast=d.get("broadcast", False),
            metadata=d.get("metadata"),
        )
        if "hash" in d and d["hash"] != action.hash:
            raise ValueError(f"plan action {action.ts}: recorded hash {d['hash']} doesn't match its old content ({action.hash})")
        return action

    def format(self, color: bool = True) -> str:
        RED, GREEN, DIM, RESET = ("\033[31m", "\033[32m", "\033[2m", "\033[0m") if color else ("", "", "", "")
        where = self.ts if self.thread_ts is None else f"{self.ts} (in {self.thread_ts})"
        header = f"{self.kind.value.upper()} {where}"
        if self.reason is not None:
            header += f": {self.reason}"
        if not self.writes:
            return header
        lines = [header]
        assert self.new is not None
        if self.new.sender != self.old.sender:
            lines.append(f"  sender: {self.old.sender.describe()} → {self.new.sender.describe()}")
        if self.new.text != self.old.text:
            lines += [f"  {RED}-{line}{RESET}" for line in self.old.text.split("\n")]
            lines += [f"  {GREEN}+{line}{RESET}" for line in self.new.text.split("\n")]
        if _strip_block_ids(self.new.blocks) != _strip_block_ids(self.old.blocks) and not (
            self.new.blocks is None and _only_rich_text(self.old.blocks)
        ):
            lines.append(f"  {DIM}blocks: {_blocks_summary(self.old.blocks)} → {_blocks_summary(self.new.blocks)}{RESET}")
        return "\n".join(lines)


def _blocks_summary(blocks: list[dict] | None) -> str:
    if not blocks:
        return "none"
    return ", ".join(b.get("type", "?") for b in blocks)


@dataclass
class Plan:
    actions: list[PlannedAction]

    def counts(self) -> dict[str, int]:
        out = {k.value: 0 for k in Kind}
        for a in self.actions:
            out[a.kind.value] += 1
        return out

    def summary(self) -> str:
        return ", ".join(f"{n} {k}" for k, n in self.counts().items() if n)

    def format_preview(self, color: bool = True, kinds: Sequence[Kind] | None = None) -> str:
        """The actions (``kinds``, default all but ``noop``), then the counts."""
        shown = [a for a in self.actions if (a.kind in kinds if kinds is not None else a.kind is not Kind.NOOP)]
        parts = [a.format(color=color) for a in shown]
        parts.append(f"Plan: {self.summary() or 'nothing found'}")
        return "\n".join(parts)

    def to_json(self) -> dict:
        return {"thrds_rewrite_plan": PLAN_VERSION, "actions": [a.to_json() for a in self.actions]}

    @classmethod
    def from_json(cls, d: dict) -> Plan:
        version = d.get("thrds_rewrite_plan")
        if version != PLAN_VERSION:
            raise ValueError(f"not a thrds rewrite plan (version {version!r}, expected {PLAN_VERSION})")
        return cls(actions=[PlannedAction.from_json(a) for a in d["actions"]])

    def review_json(self) -> dict:
        """`to_json` plus, per action, its text ``diff``: the form a review UI reads."""
        out = self.to_json()
        for a, d in zip(self.actions, out["actions"]):
            d["diff"] = a.diff()
        out["counts"] = self.counts()
        return out

    def save(self, path: Path | str) -> None:
        Path(path).write_text(json.dumps(self.to_json(), indent=2, ensure_ascii=False) + "\n")

    @classmethod
    def load(cls, path: Path | str) -> Plan:
        return cls.from_json(json.loads(Path(path).read_text()))


def plan(found: Iterable[Found], render: Render, *, reorder_ok: bool = False) -> Plan:
    """One action per found message; pure (no Slack calls).

    A sender change is a ``repost`` (delete + post; ``chat.update`` can't
    change ``username`` / ``icon_*``). It's ``blocked`` when the message has
    replies (they'd orphan), when it isn't the newest in its channel / thread
    (the repost would land at the end; ``reorder_ok`` allows it), and when it
    has files and the new sender is an override (Slack shows no files on
    those). ``render`` runs only on this app's own posts; others are
    ``blocked``.
    """
    actions = []
    for f in found:
        base = dict(
            channel=f.channel,
            ts=f.ts,
            thread_ts=f.thread_ts,
            old=f.content,
            broadcast=f.subtype == "thread_broadcast",
        )
        if not f.ours:
            actions.append(PlannedAction(Kind.BLOCKED, reason="another app's or a person's message", **base))
            continue
        if f.subtype not in _POST_SUBTYPES:
            actions.append(PlannedAction(Kind.BLOCKED, reason=f"a {f.subtype} message", **base))
            continue
        r = render(f)
        if isinstance(r, Skip):
            actions.append(PlannedAction(Kind.SKIP, reason=r.reason, **base))
            continue
        if not isinstance(r, Desired):
            raise TypeError(f"render({f.ts}) returned {type(r).__name__}, not Desired or Skip")
        new = Content(
            text=r.text,
            blocks=r.blocks,
            sender=f.sender if r.sender is None else r.sender,
            files=f.content.files,
        )
        if same_content(f.content, new):
            actions.append(PlannedAction(Kind.NOOP, new=new, **base))
            continue
        if len(new.text) > SLACK_MESSAGE_LIMIT:
            actions.append(PlannedAction(Kind.BLOCKED, new=new, reason=f"new text is {len(new.text)} chars, over {SLACK_MESSAGE_LIMIT}", **base))
            continue
        if new.sender == f.sender:
            actions.append(PlannedAction(Kind.EDIT, new=new, **base))
            continue
        where = "channel" if f.thread_ts is None else "thread"
        if f.reply_count > 0:
            reason = f"the sender changes, and a repost would orphan its {f.reply_count} replies"
        elif not f.last and not reorder_ok:
            reason = f"the sender changes, and a repost would move it to the end of its {where}"
        elif new.files and new.sender.is_override:
            reason = "the sender changes to an override, and Slack shows no files on those"
        else:
            reason = None
        if reason is None:
            # The repost carries the message's metadata (apps find their posts by it).
            actions.append(PlannedAction(Kind.REPOST, new=new, metadata=f.metadata, **base))
        else:
            actions.append(PlannedAction(Kind.BLOCKED, new=new, reason=reason, **base))
    return Plan(actions)


# --- find ---------------------------------------------------------------


def _newest_top_level(client: SlackClient, channel: str) -> str | None:
    result = client._request("conversations.history", {"channel": channel, "limit": 1}, method="GET")
    messages = result.get("messages", [])
    return messages[0]["ts"] if messages else None


def _keep(f: Found, include_foreign: bool) -> bool:
    return include_foreign or (f.ours and f.subtype in _POST_SUBTYPES)


def find_history(
    client: SlackClient,
    channel: str | None = None,
    *,
    oldest: str | None = None,
    latest: str | None = None,
    include_replies: bool = False,
    include_foreign: bool = False,
) -> list[Found]:
    """The app's messages in ``channel``'s history (newest first; ``oldest`` / ``latest`` bound it).

    With ``include_replies``, each thread's replies follow its parent (oldest
    first). Others' messages are left out unless ``include_foreign`` (then
    they plan as ``blocked``).
    """
    channel = channel or client.channel
    bot_ids = client.bot_ids
    params: dict = {"channel": channel}
    if oldest is not None:
        params["oldest"] = oldest
    if latest is not None:
        params["latest"] = latest
    newest: str | None = None
    out: list[Found] = []
    seen: set[str] = set()
    for i, m in enumerate(client._paginate("conversations.history", params)):
        if i == 0:
            newest = m["ts"] if latest is None else _newest_top_level(client, channel)
        if m["ts"] not in seen:
            seen.add(m["ts"])
            f = Found.from_raw(m, channel, bot_ids, last=m["ts"] == newest)
            if _keep(f, include_foreign):
                out.append(f)
        if include_replies and m.get("reply_count", 0) > 0:
            out += [
                f for f in _thread_replies(client, channel, m["ts"], bot_ids)
                if f.ts not in seen and _keep(f, include_foreign)
            ]
            seen.update(f.ts for f in out)
    return out


def _thread_replies(client: SlackClient, channel: str, thread_ts: str, bot_ids: tuple[str, str | None]) -> list[Found]:
    replies = [r for r in client.iter_thread_raw(channel, thread_ts) if r["ts"] != thread_ts]
    last = replies[-1]["ts"] if replies else None
    return [Found.from_raw(r, channel, bot_ids, last=r["ts"] == last) for r in replies]


def find_thread(
    client: SlackClient,
    thread_ts: str,
    channel: str | None = None,
    *,
    include_foreign: bool = False,
) -> list[Found]:
    """The app's messages in one thread: its parent, then its replies."""
    channel = channel or client.channel
    bot_ids = client.bot_ids
    raw = list(client.iter_thread_raw(channel, thread_ts))
    out = []
    if raw and raw[0]["ts"] == thread_ts:
        parent = Found.from_raw(raw[0], channel, bot_ids, last=_newest_top_level(client, channel) == thread_ts)
        if _keep(parent, include_foreign):
            out.append(parent)
    out += [f for f in _thread_replies(client, channel, thread_ts, bot_ids) if _keep(f, include_foreign)]
    return out


def read_message(client: SlackClient, channel: str, ts: str) -> dict | None:
    """One message by ts (a reply's ts reads the reply), or ``None`` when it's gone."""
    try:
        result = client._request(
            "conversations.replies",
            {"channel": channel, "ts": ts, "limit": 1, "include_all_metadata": True},
            method="GET",
        )
    except SlackApiError as e:
        if e.code in ("thread_not_found", "message_not_found"):
            return None
        raise
    messages = result.get("messages", [])
    if not messages or messages[0]["ts"] != ts:
        return None
    return messages[0]


def _is_last(client: SlackClient, channel: str, ts: str, thread_ts: str | None) -> bool:
    if thread_ts is None:
        return _newest_top_level(client, channel) == ts
    replies = [r for r in client.iter_thread_raw(channel, thread_ts) if r["ts"] != thread_ts]
    return bool(replies) and replies[-1]["ts"] == ts


def find_ids(client: SlackClient, tss: Sequence[str], channel: str | None = None) -> list[Found]:
    """Exactly these messages (top-level or replies), in the given order; others' messages included (they plan as ``blocked``)."""
    channel = channel or client.channel
    bot_ids = client.bot_ids
    out = []
    for ts in tss:
        m = read_message(client, channel, ts)
        if m is None:
            raise LookupError(f"no message {ts} in {channel}")
        parent = m.get("thread_ts")
        thread_ts = parent if parent is not None and parent != ts else None
        out.append(Found.from_raw(m, channel, bot_ids, last=_is_last(client, channel, ts, thread_ts)))
    return out


# --- apply --------------------------------------------------------------


class Status(str, Enum):
    DONE = "done"          # written now
    ALREADY = "already"    # the message already shows the new content
    RECEIPT = "receipt"    # done in an earlier run (receipts file)
    PENDING = "pending"    # dry run: would write
    STALE = "stale"        # changed since planning (or a repost would no longer keep its place)
    GONE = "gone"          # deleted since planning
    FAILED = "failed"      # Slack refused; see `error`
    UNDELETED = "undeleted"  # repost posted the new message but couldn't delete the old one


@dataclass(frozen=True)
class Outcome:
    ts: str
    kind: Kind
    status: Status
    new_ts: str | None = None
    error: str | None = None

    def to_json(self) -> dict:
        d: dict = {"ts": self.ts, "kind": self.kind.value, "status": self.status.value}
        if self.new_ts is not None:
            d["new_ts"] = self.new_ts
        if self.error is not None:
            d["error"] = self.error
        return d


@dataclass
class Report:
    outcomes: list[Outcome]

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for o in self.outcomes:
            out[o.status.value] = out.get(o.status.value, 0) + 1
        return out

    def summary(self) -> str:
        return ", ".join(f"{n} {k}" for k, n in self.counts().items()) or "nothing to apply"

    def format(self) -> str:
        lines = []
        for o in self.outcomes:
            line = f"{o.status.value:9} {o.kind.value:6} {o.ts}"
            if o.new_ts is not None:
                line += f" → {o.new_ts}"
            if o.error is not None:
                line += f": {o.error}"
            lines.append(line)
        lines.append(f"Applied: {self.summary()}")
        return "\n".join(lines)


def _read_receipts(path: Path | None) -> set[str]:
    if path is None or not path.exists():
        return set()
    done = set()
    for line in path.read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            if r["status"] in (Status.DONE.value, Status.ALREADY.value):
                done.add(r["ts"])
    return done


def _update_payload(a: PlannedAction) -> dict:
    assert a.new is not None
    return {"channel": a.channel, "ts": a.ts, "text": a.new.text, "blocks": a.new.blocks or []}


def _post_payload(a: PlannedAction) -> dict:
    assert a.new is not None
    data: dict = {"channel": a.channel, "text": a.new.text, "unfurl_links": False, "unfurl_media": False}
    if a.new.blocks:
        data["blocks"] = a.new.blocks
    if a.thread_ts is not None:
        data["thread_ts"] = a.thread_ts
        if a.broadcast:
            data["reply_broadcast"] = True
    s = a.new.sender
    if s.username is not None:
        data["username"] = s.username
    if s.icon_url is not None:
        data["icon_url"] = s.icon_url
    elif s.icon_emoji is not None:
        data["icon_emoji"] = s.icon_emoji
    if a.metadata is not None:
        data["metadata"] = a.metadata
    return data


def _apply_one(client: SlackClient, a: PlannedAction, dry_run: bool) -> Outcome:
    m = read_message(client, a.channel, a.ts)
    if m is None:
        return Outcome(a.ts, a.kind, Status.GONE)
    live = _content_of(m)
    assert a.new is not None
    if same_content(live, a.new):
        return Outcome(a.ts, a.kind, Status.ALREADY)
    if live.hash != a.hash:
        return Outcome(a.ts, a.kind, Status.STALE, error="changed since planning")
    if a.kind is Kind.REPOST:
        if m.get("reply_count", 0) > 0:
            return Outcome(a.ts, a.kind, Status.STALE, error=f"now has {m['reply_count']} replies")
        if not _is_last(client, a.channel, a.ts, a.thread_ts):
            return Outcome(a.ts, a.kind, Status.STALE, error="no longer the newest; a repost would move it")
        if a.new.sender.is_override and client.token.startswith("xoxp-"):
            return Outcome(a.ts, a.kind, Status.FAILED, error="a sender override needs a bot token (xoxb-…)")
    if dry_run:
        return Outcome(a.ts, a.kind, Status.PENDING)
    try:
        if a.kind is Kind.EDIT:
            client._request("chat.update", _update_payload(a))
            return Outcome(a.ts, a.kind, Status.DONE)
        posted = client._request("chat.postMessage", _post_payload(a))
        new_ts = posted["ts"]
        if a.new.files:
            client._request("chat.update", {
                "channel": a.channel, "ts": new_ts, "text": a.new.text, "file_ids": list(a.new.files),
            })
    except SlackApiError as e:
        return Outcome(a.ts, a.kind, Status.FAILED, error=e.code)
    try:
        client._request("chat.delete", {"channel": a.channel, "ts": a.ts})
    except SlackApiError as e:
        return Outcome(a.ts, a.kind, Status.UNDELETED, new_ts=new_ts, error=e.code)
    return Outcome(a.ts, a.kind, Status.DONE, new_ts=new_ts)


def apply(
    p: Plan,
    client: SlackClient,
    *,
    dry_run: bool = True,
    only: Iterable[str] | None = None,
    receipts: Path | str | None = None,
    pace: float = DEFAULT_PACE,
    jitter: float = 0.0,
    on_outcome: Callable[[Outcome], None] | None = None,
) -> Report:
    """Carry out ``p``'s ``edit`` / ``repost`` actions in order (``only``: just these ts).

    Dry run by default: each action is still checked against its message
    (``pending`` / ``stale`` / ``gone`` / ``already``), but nothing is written.
    A repost posts the new message before deleting the old one, so a failed
    delete leaves a duplicate (``undeleted``), never a loss. With
    ``receipts`` (a JSONL path), each outcome of a real run is appended, and
    a re-run skips messages already ``done`` / ``already``.
    """
    selected = None if only is None else set(only)
    receipts_path = None if receipts is None else Path(receipts)
    done = _read_receipts(receipts_path)
    outcomes = []
    wrote = False
    for a in p.actions:
        if not a.writes or (selected is not None and a.ts not in selected):
            continue
        if a.ts in done:
            o = Outcome(a.ts, a.kind, Status.RECEIPT)
        else:
            if wrote and pace > 0:
                time.sleep(pace + random.uniform(0, jitter))
            o = _apply_one(client, a, dry_run)
            wrote = o.status in (Status.DONE, Status.UNDELETED)
            if receipts_path is not None and not dry_run:
                with receipts_path.open("a") as fh:
                    fh.write(json.dumps(o.to_json()) + "\n")
        outcomes.append(o)
        if on_outcome is not None:
            on_outcome(o)
    return Report(outcomes)


# --- renders ------------------------------------------------------------


def substitute(mapping: dict[str, str]) -> Render:
    """A render that replaces each ``mapping`` key with its value, in the text and the blocks.

    Blocks that are only ``rich_text`` (Slack's rendering of the text) are
    dropped, so Slack re-derives them from the new text. Other blocks have
    their strings substituted, and an ``emoji`` element named ``x`` becomes
    ``y`` when ``:x:`` maps to ``:y:``. A message the mapping doesn't change
    plans as ``noop``.
    """
    emoji = {
        k[1:-1]: v[1:-1] for k, v in mapping.items()
        if len(k) > 2 and len(v) > 2 and k[0] == k[-1] == ":" and v[0] == v[-1] == ":"
    }

    def sub_text(s: str) -> str:
        for k, v in mapping.items():
            s = s.replace(k, v)
        return s

    def sub(x):
        if isinstance(x, str):
            return sub_text(x)
        if isinstance(x, list):
            return [sub(v) for v in x]
        if isinstance(x, dict):
            if x.get("type") == "emoji" and x.get("name") in emoji:
                return {**x, "name": emoji[x["name"]]}
            return {k: (v if k == "block_id" else sub(v)) for k, v in x.items()}
        return x

    def render(f: Found) -> Desired | Skip:
        blocks = None if _only_rich_text(f.blocks) else sub(f.blocks)
        return Desired(text=sub_text(f.text), blocks=blocks)

    return render
