from __future__ import annotations

import random
import time
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .protocol import ThreadClient


class EditRateLimited(Exception):
    """Raised when an edit is rate-limited (e.g. Discord code 30046)."""


class SenderChangeForbidden(Exception):
    """Raised when `sync` detects a sender mismatch it can't reconcile.

    Fires when:
    - `SyncOptions.sender_change` is None (default; strict) and any `Msg`
      whose content matches an existing message has a different resolved
      sender than the live message.
    - A `SenderChangePolicy` is set but a hard rule fails: target is the
      OP (`thread_ts` change breaks state / permalinks), or a foreign
      message sits between the change target and thread-end (cascade
      would reorder past a msg we can't delete).
    - A policy gate fails: `len(cascade) > policy.max_reposts`, or any
      cascade member has reactions and `policy.lose_reactions_ok=False`.

    Message on the exception names which rule fired + which msgs.
    """


class OrphanedRepliesError(Exception):
    """Raised when attempting to delete a message that has thread replies."""

    def __init__(self, message_id: str, reply_count: int):
        self.message_id = message_id
        self.reply_count = reply_count
        super().__init__(
            f"Refusing to delete message {message_id}: "
            f"it has {reply_count} thread replies that would be orphaned. "
            f"Pass orphans_ok=True to delete anyway."
        )


class ActionType(Enum):
    SKIP = "skip"
    EDIT = "edit"
    POST = "post"
    DELETE = "delete"


@dataclass
class Action:
    type: ActionType
    index: int
    message_id: str | None = None
    content: str | None = None
    prior_content: str | None = None

    def format(self, color: bool = True) -> str:
        """Render a human-readable preview line for this action.

        EDIT and DELETE show the prior content (``-``); POST and EDIT
        show the new content (``+``); SKIP just notes the index.
        Multi-line content gets the prefix on every line.
        """
        RED, GREEN, RESET = ("\033[31m", "\033[32m", "\033[0m") if color else ("", "", "")
        header = f"{self.type.value.upper()} [{self.index}]"

        def prefix_lines(s: str, char: str, col: str) -> str:
            return "\n".join(f"  {col}{char}{line}{RESET}" for line in s.split("\n"))

        if self.type is ActionType.POST:
            return f"{header}\n{prefix_lines(self.content or '', '+', GREEN)}"
        if self.type is ActionType.EDIT:
            prior = prefix_lines(self.prior_content or "", "-", RED)
            new = prefix_lines(self.content or "", "+", GREEN)
            return f"{header}\n{prior}\n{new}"
        if self.type is ActionType.DELETE:
            return f"{header}\n{prefix_lines(self.prior_content or '', '-', RED)}"
        if self.type is ActionType.SKIP:
            return f"{header} (unchanged)"
        raise ValueError(f"Unknown action type: {self.type}")


@dataclass
class Image:
    """One image attachment on a desired message — the unified surface across
    platforms whose native mechanisms differ (see `specs/unified-image-attachments.md`).

    A **hosted URL** is the cross-platform currency: with ``url`` set, Slack
    references it in a Block Kit image block and Discord `GET`s it and uploads
    the bytes as a webhook attachment. With only ``path`` (local bytes), Discord
    uploads directly but Slack **raises** — it has no native path without first
    hosting the bytes (URL-first; the lazy-upload bridge is a deferred item in
    the spec). ``bust`` cache-busts a stable ``url`` on edit for Slack (Discord
    always refreshes by re-uploading, so it ignores it).

    Both forms reach here identically: a doc's trailing ``![alt](target){bust?}``
    line (lifted at resolve time) or a programmatic ``Msg(images=[Image(...)])``.
    """
    url: str | None = None
    path: Path | str | None = None
    alt: str = ""
    bust: bool = False

    def __post_init__(self):
        if self.url is None and self.path is None:
            raise ValueError("Image needs a `url` or a `path`")
        if self.bust and self.url is None:
            raise ValueError("Image `bust` cache-busts a `url`; it needs one")


@dataclass
class Msg:
    """A desired message with an optional per-message sender override.

    Wraps a `str` content plus optional ``username``/``icon_url``/``icon_emoji``
    overrides that apply on POST (Slack `chat.postMessage` accepts them
    with the ``chat:write.customize`` scope). Fields left ``None`` fall
    back to the client-level defaults.

    Sender is a **post-time attribute** — Slack's ``chat.update``
    silently ignores ``username``/``icon_url``/``icon_emoji`` in an
    update payload, so an EDIT never changes the live sender. That's
    the desired behavior: a content tweak on an existing message
    shouldn't churn its avatar or name.

    Discord's bot API cannot override per-message sender at all;
    `DiscordClient` warns once and ignores. Bluesky has no sender
    concept; ignored silently.

    ``images`` are `Image` attachments carried through POST and — when an edit
    fires — EDIT, so a re-push whose text changed also refreshes the picture.
    Each platform resolves them natively (Slack image block, Discord upload);
    see `Image`. Empty ``images`` (the default) is a no-op everywhere.
    """
    content: str
    username: str | None = None
    icon_url: str | None = None
    icon_emoji: str | None = None
    images: Sequence[Image] = ()


def _content(entry: str | Msg) -> str:
    """Extract the content string from a `str | Msg` desired-thread entry."""
    return entry.content if isinstance(entry, Msg) else entry


def _post_kwargs(entry: str | Msg) -> dict:
    """Extract the per-message sender override kwargs (empty for bare `str`).

    Always includes all three keys (with `None` for unset) so downstream
    `post()` implementations can uniformly resolve ``msg_override or
    client_default`` without missing-key gymnastics.
    """
    if isinstance(entry, Msg):
        return {
            'username': entry.username,
            'icon_url': entry.icon_url,
            'icon_emoji': entry.icon_emoji,
            'images': entry.images,
        }
    return {}


def _images(entry: str | Msg) -> 'Sequence[Image]':
    """The attachments an EDIT should re-upload (empty for a bare `str`)."""
    return entry.images if isinstance(entry, Msg) else ()


def _reply_target(client: 'ThreadClient', op_id: str, thread_name: str | None) -> str:
    """The id that replies to a just-posted OP should be posted under.

    Slack and Bluesky thread by addressing the OP's own id (its ``thread_ts`` /
    reply root), so the default is ``op_id`` — identical to the behavior before
    this seam existed. Discord's replies live in a *separate child thread
    channel* opened off the OP; ``DiscordClient`` implements the optional
    ``open_thread(op_id, name) -> str`` capability to create it and return its
    id. A client without ``open_thread`` gets the OP-id default, so no existing
    platform's behavior changes.
    """
    opener = getattr(client, 'open_thread', None)
    if opener is None:
        return op_id
    return opener(op_id, thread_name)


def _resolve_sender(
    msg: Msg,
    client_username: str | None,
    client_icon_url: str | None,
    client_icon_emoji: str | None,
) -> tuple[str | None, str | None, str | None]:
    """Resolve (username, icon_url, icon_emoji) as they'd appear on POST.

    Mirrors `SlackClient.post()`'s resolution — msg-level username is a
    simple override; icon is treated as a unit (msg icon fully replaces
    client icon; within either source, url beats emoji if both set).
    Returns a normalized triple where at most one of icon_url/icon_emoji
    is non-None. Used by `sync` to compare desired vs live sender.
    """
    username = msg.username if msg.username is not None else client_username
    if msg.icon_url is not None or msg.icon_emoji is not None:
        icon_url = msg.icon_url
        icon_emoji = None if msg.icon_url is not None else msg.icon_emoji
    elif client_icon_url is not None or client_icon_emoji is not None:
        icon_url = client_icon_url
        icon_emoji = None if client_icon_url is not None else client_icon_emoji
    else:
        icon_url = None
        icon_emoji = None
    return username, icon_url, icon_emoji


def _enforce_sender_change_policy(
    target_index: int,
    editable_existing: 'list[Message]',
    all_existing: 'list[Message]',
    policy: 'SenderChangePolicy | None',
    client,
) -> None:
    """Raise `SenderChangeForbidden` if any rule blocks a sender-change cascade
    starting at ``target_index`` (index into the editable-only ``existing`` list).

    Hard rules (not gated):
    - ``target_index == 0`` → target is OP → forbidden (thread_ts change breaks state).
    - Any foreign message sits AFTER the target's live ts → forbidden (order hazard).

    Policy gates (require an opted-in policy):
    - ``policy is None`` → any sender mismatch is forbidden.
    - Cascade length (= number of ours-msgs from target to end) > ``policy.max_reposts``.
    - Any cascade member has reactions and not ``policy.lose_reactions_ok``.
    """
    target = editable_existing[target_index]
    if target_index == 0:
        raise SenderChangeForbidden(
            f"sender change on OP (index 0, msg {target.id}) is always forbidden: "
            "delete+repost of the OP changes thread_ts, invalidating state.json / "
            "cross-refs / permalinks. Create a new thread instead."
        )
    if policy is None:
        raise SenderChangeForbidden(
            f"sender mismatch on msg {target.id} (index {target_index}); "
            "no `SyncOptions.sender_change` policy set — pass a `SenderChangePolicy` "
            "to opt in to delete+repost."
        )
    # Foreign-after-target check: walk `all_existing` (which includes foreign
    # msgs); any foreign msg with a later ts than the target is a hard-abort.
    target_id = target.id
    saw_target = False
    for m in all_existing:
        if m.id == target_id:
            saw_target = True
            continue
        if saw_target and not m.editable:
            raise SenderChangeForbidden(
                f"sender change on msg {target_id} would require reordering past "
                f"foreign msg {m.id} (index would move to end of thread). "
                "Foreign msgs can't be deleted, so order can't be preserved. "
                "Hard-forbidden."
            )
    # Cascade: from target to end of editable_existing.
    cascade = editable_existing[target_index:]
    if len(cascade) > policy.max_reposts:
        raise SenderChangeForbidden(
            f"sender-change cascade at index {target_index} would touch "
            f"{len(cascade)} msgs, exceeding policy.max_reposts={policy.max_reposts}. "
            "Raise the cap or narrow the change."
        )
    if not policy.lose_reactions_ok:
        # Pre-flight: reactions.get on each cascade member. Skip silently if
        # the client doesn't expose `get_reactions` (non-Slack clients).
        get_reactions = getattr(client, 'get_reactions', None)
        if get_reactions is not None:
            with_reactions = [m.id for m in cascade if get_reactions(m.id)]
            if with_reactions:
                raise SenderChangeForbidden(
                    f"sender-change cascade would delete msgs with reactions: "
                    f"{with_reactions}. Pass `lose_reactions_ok=True` on the policy "
                    "to proceed anyway."
                )


def _sender_mismatch(desired: Msg, live: Message, client) -> bool:
    """Return True iff desired's resolved sender differs from live's stored sender.

    Consults ``client.username`` / ``client.icon_url`` / ``client.icon_emoji``
    for the resolution fallback (all optional; missing attrs treated as None).

    Returns False (no cascade) in two "can't verify" cases:
    - All live sender fields are None — the client's `list_messages`
      didn't populate them (Discord/Bluesky).
    - Desired resolves to `icon_emoji` (with no `icon_url`) — Slack's
      `conversations.replies` doesn't preserve emoji-vs-URL on read
      (emojis are rendered to URLs server-side), so we can't verify.
      Users with icon_emoji overrides don't get auto-cascade; document
      as a v1 limitation.
    """
    if live.sender_username is None and live.sender_icon_url is None and live.sender_icon_emoji is None:
        return False
    d_user, d_url, d_emoji = _resolve_sender(
        desired,
        getattr(client, 'username', None),
        getattr(client, 'icon_url', None),
        getattr(client, 'icon_emoji', None),
    )
    if d_user != live.sender_username:
        return True
    # Icon check: compare url form only. If desired resolved to icon_emoji
    # (d_url is None but d_emoji is set), skip icon check — unverifiable.
    if d_url is None and d_emoji is not None:
        return False
    return d_url != live.sender_icon_url


@dataclass
class Thread:
    """Desired state of a thread.

    ``messages`` accepts bare ``str`` entries (use client defaults for
    every posted message) or `Msg` wrappers (per-message sender overrides).
    Mixing both in one thread is fine and common — e.g. an OP with a
    date-suffixed name plus replies with the plain name.
    """
    messages: list[str | Msg]


@dataclass
class Message:
    """An existing message in a thread.

    ``editable=False`` marks messages the sync client cannot edit or delete
    (typically because they were authored by another user/bot). Such
    messages are preserved in place — never included in the `sync()`
    reconcile, never counted against the desired message slots.

    Sender fields default to ``None`` = "unknown / not populated by this
    client". `SlackClient.list_messages` populates them from the returned
    message dict; Discord + Bluesky leave them `None`. When populated,
    ``sync`` compares against the desired `Msg`'s resolved sender at the
    SKIP path to drive `SenderChangePolicy` (see the aggressive-mode
    section in ``specs/per-message-sender.md``).
    """
    id: str
    content: str
    editable: bool = True
    sender_username: str | None = None
    sender_icon_url: str | None = None
    sender_icon_emoji: str | None = None


@dataclass
class SyncResult:
    """Result of syncing a thread."""
    thread_id: str
    message_ids: list[str]
    actions: list[Action] = field(default_factory=list)

    def format_preview(self, color: bool = True, prefix: str = "") -> str:
        """Render a colored multi-line preview of all actions.

        ``prefix`` is prepended to each line (e.g. a per-thread identifier).
        """
        lines: list[str] = []
        for action in self.actions:
            for line in action.format(color=color).split("\n"):
                lines.append(prefix + line)
        return "\n".join(lines)


@dataclass
class SenderChangePolicy:
    """Opt-in policy for delete+repost of existing replies whose live
    sender differs from the desired `Msg`. Attach to `SyncOptions.sender_change`
    to enable; default `None` means strict (any sender mismatch raises).

    Never gated (hard rules): OP sender change is always forbidden
    (`thread_ts` invariant); a cascade cannot cross a foreign reply
    (ordering hazard). See ``specs/per-message-sender.md``.
    """
    max_reposts: int = 3
    lose_reactions_ok: bool = False


@dataclass
class SyncOptions:
    suppress_embeds: bool = False
    suppress_unfurls: bool = True
    dry_run: bool = False
    thread_name: str | None = None
    pace: float = 0.0
    jitter: float = 0.0
    sender_change: SenderChangePolicy | None = None
    # When set, only messages whose id is in this set are reconciled; all
    # others are preserved in place exactly like foreign (non-editable) ones.
    # This is how `promote` scopes a sync to the messages *it* posted in a
    # shared thread — same-author messages from other slugs or manual posts
    # are ours to Slack but not ours to converge (see
    # specs/done/promote-shared-thread-safety.md). None = no restriction.
    only_ids: set[str] | None = None


def sync(
    client: ThreadClient,
    desired: Thread,
    thread_id: str | None = None,
    options: SyncOptions | None = None,
) -> SyncResult:
    """Sync a thread to the desired state using minimal API calls."""
    opts = options or SyncOptions()
    actions: list[Action] = []
    message_ids: list[str] = []
    mutated = False

    def _pace():
        nonlocal mutated
        if mutated and opts.pace > 0:
            delay = opts.pace + random.uniform(0, opts.jitter)
            time.sleep(delay)
        mutated = True

    # Get existing messages (if thread exists). Foreign (non-editable)
    # messages — e.g. a human interjecting in a bot-managed thread — are
    # filtered out of the reconcile. They stay in place: never edited,
    # never deleted, and not counted against the desired message slots.
    if thread_id is not None:
        all_existing = client.list_messages(thread_id)
    else:
        all_existing = []
    if opts.only_ids is not None:
        # Demote out-of-scope messages to foreign for EVERY downstream check
        # (reconcile list, sender-cascade crossing guard), not just this filter.
        all_existing = [
            m if m.id in opts.only_ids else replace(m, editable=False)
            for m in all_existing
        ]
    existing = [m for m in all_existing if m.editable]

    M = len(desired.messages)
    N = len(existing)
    # Normalize desired entries once at the top: content-strings power the
    # positional diff (existing[i].content == desired_contents[i]), while
    # per-message sender kwargs get carried through to POST unchanged. An
    # EDIT uses content only — sender is a post-time attribute (see `Msg`).
    desired_contents = [_content(e) for e in desired.messages]

    # Phase 1: Delete extras from the end (backwards, OP last)
    if M < N:
        for i in range(N - 1, M - 1, -1):
            msg = existing[i]
            action = Action(
                type=ActionType.DELETE,
                index=i,
                message_id=msg.id,
                prior_content=msg.content,
            )
            actions.append(action)
            if not opts.dry_run:
                _pace()
                client.delete(msg.id)

    # Phase 2: Edit overlapping messages
    overlap = min(M, N)
    repost_from: int | None = None
    sender_repost_from: int | None = None
    for i in range(overlap):
        if existing[i].content == desired_contents[i]:
            # Content match → SKIP normally. But if the desired entry is a
            # `Msg` with a resolved sender that differs from the live
            # message's stored sender, that's a sender-change candidate;
            # policy check + cascade planning happens once we hit the FIRST
            # such index, then we break out and run the cascade below.
            desired_entry = desired.messages[i]
            if isinstance(desired_entry, Msg) and _sender_mismatch(
                desired_entry, existing[i], client,
            ):
                _enforce_sender_change_policy(
                    i, existing, all_existing, opts.sender_change, client,
                )
                sender_repost_from = i
                break
            actions.append(Action(
                type=ActionType.SKIP,
                index=i,
                message_id=existing[i].id,
                content=desired_contents[i],
            ))
            message_ids.append(existing[i].id)
        else:
            action = Action(
                type=ActionType.EDIT,
                index=i,
                message_id=existing[i].id,
                content=desired_contents[i],
                prior_content=existing[i].content,
            )
            actions.append(action)
            if opts.dry_run:
                message_ids.append(existing[i].id)
            else:
                try:
                    _pace()
                    result_msg = client.edit(
                        existing[i].id, desired_contents[i],
                        images=_images(desired.messages[i]),
                    )
                except EditRateLimited:
                    # Fall back to delete+repost for this and all remaining messages
                    repost_from = i
                    break
                message_ids.append(result_msg.id)

    # Phase 2b: Delete+repost fallback (on edit rate limit)
    if repost_from is not None:
        # Delete remaining existing messages from end to repost_from
        for j in range(overlap - 1, repost_from - 1, -1):
            msg = existing[j]
            actions.append(Action(
                type=ActionType.DELETE,
                index=j,
                message_id=msg.id,
                prior_content=msg.content,
            ))
            _pace()
            client.delete(msg.id)
        # Post replacements (and any new messages beyond overlap) — sender
        # kwargs from the desired-entry go with the POST.
        for j in range(repost_from, M):
            action = Action(type=ActionType.POST, index=j, content=desired_contents[j])
            actions.append(action)
            _pace()
            result_msg = client.post(
                desired_contents[j],
                thread_id=thread_id,
                **_post_kwargs(desired.messages[j]),
            )
            message_ids.append(result_msg.id)
        return SyncResult(
            thread_id=thread_id or "",
            message_ids=message_ids,
            actions=actions,
        )

    # Phase 2c: Sender-change cascade — one contiguous DELETE+REPOST run
    # from the first sender-mismatch SKIP to end of thread. Policy already
    # passed the pre-flight checks in Phase 2; here we execute.
    if sender_repost_from is not None:
        cascade = existing[sender_repost_from:]
        # Preserve message_ids for indices before the cascade start (already
        # appended as SKIPs above); wipe the cascade slot forward.
        # Delete end-to-start (matches Phase 1's delete-backwards discipline).
        for j in range(len(cascade) - 1, -1, -1):
            msg = cascade[j]
            actions.append(Action(
                type=ActionType.DELETE,
                index=sender_repost_from + j,
                message_id=msg.id,
                prior_content=msg.content,
            ))
            if not opts.dry_run:
                _pace()
                client.delete(msg.id)
        # Repost start-to-end. thread_id is guaranteed non-None here — the
        # cascade only fires when target_index >= 1, which requires an OP
        # to already exist (i.e. `thread_id` was passed in).
        for j in range(sender_repost_from, M):
            actions.append(Action(
                type=ActionType.POST,
                index=j,
                content=desired_contents[j],
            ))
            if opts.dry_run:
                message_ids.append("<new>")
            else:
                _pace()
                result_msg = client.post(
                    desired_contents[j],
                    thread_id=thread_id,
                    **_post_kwargs(desired.messages[j]),
                )
                message_ids.append(result_msg.id)
        return SyncResult(
            thread_id=thread_id or "",
            message_ids=message_ids,
            actions=actions,
        )

    # Phase 3: Post new messages at the end
    if M > N:
        # If no thread exists yet, first message creates it
        start = N
        if thread_id is None and N == 0 and M > 0:
            action = Action(
                type=ActionType.POST,
                index=0,
                content=desired_contents[0],
            )
            actions.append(action)
            if opts.dry_run:
                message_ids.append("<new>")
                thread_id = "<new>"
            else:
                _pace()
                result_msg = client.post(
                    desired_contents[0],
                    **_post_kwargs(desired.messages[0]),
                )
                message_ids.append(result_msg.id)
                # Replies go under the OP id (Slack/Bsky) or a child thread
                # opened off it (Discord) — see `_reply_target`. Only open a
                # thread when replies will actually follow; a lone OP needs
                # none (and Discord would otherwise create an empty thread).
                thread_id = (
                    _reply_target(client, result_msg.id, opts.thread_name)
                    if M > 1
                    else result_msg.id
                )
            start = 1

        for i in range(start, M):
            action = Action(
                type=ActionType.POST,
                index=i,
                content=desired_contents[i],
            )
            actions.append(action)
            if opts.dry_run:
                message_ids.append("<new>")
            else:
                _pace()
                result_msg = client.post(
                    desired_contents[i],
                    thread_id=thread_id,
                    **_post_kwargs(desired.messages[i]),
                )
                message_ids.append(result_msg.id)

    return SyncResult(
        thread_id=thread_id or "",
        message_ids=message_ids,
        actions=actions,
    )
