from __future__ import annotations

import hashlib
import json
import random
import re
import time
import urllib.request
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode

from .chrome import (
    Chrome,
    ChromeEdit,
    drop_line as drop_chrome_line,
    has_chrome,
    locate as locate_chrome,
    normalize_glyphs,
    parse as parse_chrome,
    render as render_chrome,
    split as split_chrome,
)
from .core import Image, Message, Msg, OrphanedRepliesError, SyncOptions, SyncResult, Thread, sync
from .doc import Doc, DocMessage, DocSyncResult, DocThread, Frontmatter
from .imageblock import (
    ImageRef,
    bust_token,
    from_block as image_from_block,
    image_line,
    is_upload_ref,
    slack_file_block,
    split_trailing_images,
    to_block as image_to_block,
    upload_marker,
    upload_path,
    upload_sha,
)
from .linked import (
    LinkedSyncResult,
    LinkedThread,
    Section,
    build_detail_messages,
    build_summary_partition,
    render_summary_from_partition,
)
from .mrkdwn import (
    decode_entities as _decode_entities,
    find_custom_shortcodes,
    substitute_custom_emoji,
    to_markdown as _slack_to_md,
    to_slack as _md_to_slack,
)
from .refs import (
    PLACEHOLDER_URL,
    doc_has_refs,
    substitute_doc_refs,
    thread_has_refs,
    validate_refs,
)
from . import remotes
from .remotes import Remote
from .richtext import render as render_rich_text, rich_text_enabled
from .state import SessionState, ThreadEntry, ThreadTarget
from .tracking import STAGING
from .md import resolve_messages
from .threadfile import (
    SLUG_RE,
    dedupe_thread_filename,
    next_index,
    parse_thread_filename,
    slugify,
    thread_files,
)

THRDS_METADATA_EVENT_TYPE = 'thrds'

SLACK_MESSAGE_LIMIT = 4000
# A `section` block's text maxes out below the 4000 a plain `text` message
# allows, so a body in between finalizes as text rather than being split.
SLACK_SECTION_LIMIT = 3000


_UPLOAD_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif'}


def _image_sha(data: bytes) -> str:
    """16-hex-char content hash — the identity of an uploaded image."""
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass(frozen=True)
class AdoptedThread:
    """A thread discovered in the staging channel and taken into the session."""
    slug: str
    filename: str
    thread: DocThread


def _slack_icon_url(msg: dict) -> str | None:
    """Extract a canonical icon URL from a Slack message dict.

    `conversations.replies` returns an `icons` object with multiple sized
    URLs (`image_original`, `image_72`, `image_48`, etc.). Prefer the
    original for round-trip fidelity; fall back to any `image_*` key if
    the original is absent (some responses omit it).
    """
    icons = msg.get("icons") or {}
    if not icons:
        return None
    if "image_original" in icons:
        return icons["image_original"]
    for k, v in icons.items():
        if k.startswith("image_") and isinstance(v, str):
            return v
    return None


class ScanCapReached(RuntimeError):
    """Raised by ``scan_thrds_metadata`` when ``max_pages`` is exhausted
    before ``has_more`` clears.

    Carries the state needed to resume: ``next_cursor`` is the Slack
    pagination token that would have gone into the next request (opaque
    string, safe to copy-paste back via ``--cursor``), and
    ``oldest_ts_reached`` is the min ts seen so far (a decimal string
    like ``"1784587706.222199"``, usable as a ``latest`` bound for a
    time-anchored resume). Both are ``None`` if the cap fired before
    any page returned (e.g. ``max_pages=0`` would never trigger this;
    it's disabled). Distinct exception type so callers can catch without
    swallowing real failures.
    """
    def __init__(
        self,
        message: str,
        next_cursor: str | None = None,
        oldest_ts_reached: str | None = None,
        pages_scanned: int = 0,
    ):
        super().__init__(message)
        self.next_cursor = next_cursor
        self.oldest_ts_reached = oldest_ts_reached
        self.pages_scanned = pages_scanned


@dataclass
class RecoveredSession:
    """A thrds session discovered in a channel via metadata scan (``recover`` verb).

    ``thread_ts_by_slug`` is sorted by ``ts`` (channel post-order) so downstream
    consumers see a stable iteration order.
    """
    session_id: str
    doc_slug: str
    preamble_ts: str | None
    thread_ts_by_slug: dict[str, str]
    oldest_ts: str
    newest_ts: str

    @property
    def thread_count(self) -> int:
        return len(self.thread_ts_by_slug)


class SlackClient:
    def __init__(
        self,
        token: str,
        channel: str,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        raw: bool = False,
    ):
        """
        ``username`` / ``icon_url`` / ``icon_emoji`` are the thread-wide
        defaults; per-message overrides (via `Msg`) take precedence.
        Custom sender/icon requires the ``chat:write.customize`` scope.
        ``icon_url`` (a hosted image URL) wins over ``icon_emoji`` if both
        are set — Slack accepts one or the other on `chat.postMessage`.

        ``raw`` is the client-wide default for skipping the local-markdown →
        Slack-mrkdwn conversion on ``post`` / ``edit``. False (the default)
        preserves today's behavior — ``[text](url)`` becomes ``<url|text>``,
        ``**bold**`` becomes ``*bold*``, etc. True sends ``content`` as the
        wire ``text`` verbatim, which is what consumers already emitting
        Slack mrkdwn want (e.g. watchy's CFW renderer). Per-call override on
        ``post(..., raw=)`` / ``edit(..., raw=)`` takes precedence over this
        default; see `specs/done/raw-mrkdwn-passthrough.md`.
        """
        self.token = token
        self.channel = channel
        self.username = username
        self.icon_url = icon_url
        self.icon_emoji = icon_emoji
        self.raw = raw
        self._suppress_unfurls: bool = True
        self._metadata_by_content: dict[str, dict] | None = None
        self._chrome_by_content: dict[str, str] | None = None
        self._chrome_by_slug: dict[str, str] | None = None
        self._finalized_content: set[str] = set()
        self._finalized_slugs: set[str] = set()
        self._skip_op: bool = False
        self._bot_ids: tuple[str, str | None] | None = None
        self._user_name_cache: dict[str, str] = {}
        self._channels_by_name_cache: dict[str, str] | None = None
        # Lazy-upload de-dup (`specs/slack-lazy-image-upload.md`), reset per
        # `sync`: `sha → file_id`, so one image uploads once per push. The path
        # rides in the content marker itself, so no separate staging map.
        self._uploaded_file_ids: dict[str, str] = {}

    @property
    def bot_ids(self) -> tuple[str, str | None]:
        """Lazily resolve and cache the authenticated bot's (user_id, bot_id).

        Both are needed to tag messages as `editable`: Slack returns `user`
        on human messages (match via user_id) but `bot_id` with `user: null`
        on bot_message events, so our own posts would be marked non-editable
        if we only checked `user`.
        """
        if self._bot_ids is None:
            result = self._request("auth.test", method="POST")
            self._bot_ids = (result["user_id"], result.get("bot_id"))
        return self._bot_ids

    @property
    def bot_user_id(self) -> str:
        """Back-compat alias. Prefer `bot_ids` for bot/user_id both."""
        return self.bot_ids[0]

    def _request(
        self,
        endpoint: str,
        data: dict | None = None,
        method: str = "POST",
    ) -> dict:
        url = f"https://slack.com/api/{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.token}",
        }
        if method == "GET" and data:
            url = f"{url}?{urlencode(data)}"
            body = None
        else:
            headers["Content-Type"] = "application/json; charset=utf-8"
            body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        max_retries = 3
        for attempt in range(max_retries + 1):
            try:
                with urllib.request.urlopen(req) as resp:
                    result = json.loads(resp.read())
                break
            except HTTPError as e:
                if e.code == 429 and attempt < max_retries:
                    retry_after = int(e.headers.get("Retry-After", 1))
                    time.sleep(retry_after)
                    continue
                raise RuntimeError(f"Slack API error: {e.code} {e.read().decode()}") from e
        if not result.get("ok"):
            raise RuntimeError(f"Slack API error: {result.get('error', result)}")
        return result

    def _metadata_for(self, content: str) -> dict | None:
        """Look up metadata for a message by its content."""
        if self._metadata_by_content is None:
            return None
        return self._metadata_by_content.get(content)

    def list_channel_history(
        self,
        channel: str,
        limit: int = 20,
    ) -> list[dict]:
        """Fetch the last ``limit`` messages from ``channel`` as raw Slack dicts.

        Low-level accessor for CRUD/scripting (``thrds slack history``) —
        returns unwrapped dicts (``ts`` / ``user`` / ``bot_id`` / ``username``
        / ``text`` / …) rather than typed `Message`s. ``text`` is the wire
        mrkdwn as Slack returns it (no ``to_markdown`` roundtrip); this
        matches the "raw by default" ethos of the CRUD verbs. Takes
        ``channel`` explicitly (like `scan_thrds_metadata`) so it can be
        called without stomping ``self.channel``.
        """
        result = self._request("conversations.history", {
            "channel": channel,
            "limit": limit,
        }, method="GET")
        return result.get("messages", [])

    def list_thread_raw(
        self,
        channel: str,
        thread_ts: str,
    ) -> list[dict]:
        """Fetch a thread (``thread_ts`` OP + replies) as raw Slack dicts.

        Parallel to `list_channel_history` — returns unwrapped dicts (no
        typed `Message` wrapping, no ``to_markdown`` conversion on wire text)
        for CRUD/scripting via ``thrds slack thread``. The typed
        `list_messages` counterpart is what `sync()` consumes and
        converts back to local markdown.
        """
        result = self._request("conversations.replies", {
            "channel": channel,
            "ts": thread_ts,
        }, method="GET")
        return result.get("messages", [])

    @staticmethod
    def _message_markdown(m: dict) -> str:
        """A message's body as local markdown, with staging chrome removed.

        Three sources, in descending fidelity:

        1. A lone ``section`` block — one of our own *finalized* posts, whose
           chrome lives in a sibling ``context`` block and so never reaches
           here. Its text is wire mrkdwn.
        2. Slack's ``rich_text`` block — Slack's own parse of the message,
           which is structured rather than re-derived. See `thrds.richtext`.
        3. The flat ``text`` field, reverse-engineered with regexes. The
           original path, now the fallback for shapes we don't recognize.

        Chrome comes off differently per source because it's authored in Slack
        mrkdwn: in (3) it's parsed and stripped directly; in (2) the body has
        already been rendered to markdown, so the line is dropped by the
        *position* `chrome.locate` found in the raw text — which is always an
        extremity, and doesn't require a second grammar for rendered chrome.
        In (1) the section text gets `split_chrome` applied: a draft that
        carries image blocks folds its chrome line into the section (see
        `_lift_image_blocks`); for finalized posts (chrome in a sibling
        context block) the split is a no-op.

        `image` blocks are translated back to `![alt](url)` lines appended
        after the body (a `thrds_bust` param comes off as a `{bust}` suffix),
        so pulled content round-trips `specs/editable-image-blocks.md` syntax.
        """
        blocks = m.get("blocks") or []
        image_lines = [
            image_line(ref)
            for ref in (image_from_block(b) for b in blocks)
            if ref is not None
        ]
        sections = [
            b for b in blocks
            if b.get("type") == "section" and (b.get("text") or {}).get("text")
        ]
        body: str | None = None
        if len(sections) == 1:
            body = _slack_to_md(split_chrome(sections[0]["text"]["text"])[0])
        else:
            raw = m.get("text", "")
            if rich_text_enabled():
                rendered = render_rich_text(m.get("blocks"))
                if rendered is not None:
                    found = locate_chrome(raw)
                    body = (
                        drop_chrome_line(rendered, found[0])
                        if found is not None else rendered
                    )
            if body is None:
                body = _slack_to_md(split_chrome(raw)[0])
        if image_lines:
            return '\n\n'.join(([body] if body else []) + image_lines)
        return body

    def list_messages(self, thread_id: str) -> list[Message]:
        result = self._request("conversations.replies", {
            "channel": self.channel,
            "ts": thread_id,
        }, method="GET")
        user_id, bot_id = self.bot_ids
        messages = [
            Message(
                id=m["ts"],
                # Convert Slack mrkdwn back to our local markdown form so pulled
                # content is diff-clean against local docs. See `mrkdwn.py`.
                content=self._message_markdown(m),
                # Slack bot_messages come back with `user: null` and `bot_id`
                # set; human messages carry `user`. Match either so our own
                # bot's posts are correctly marked editable.
                editable=(
                    m.get("user") == user_id
                    or (bot_id is not None and m.get("bot_id") == bot_id)
                ),
                # Sender fields for `SenderChangePolicy` mismatch detection.
                # `username` is only set on user-token posts with an override
                # (bot posts show the app's name via bot_profile — ignored
                # here since sender-change cascade is a user-token feature).
                # Slack renders icon_emoji to a URL on read, so we never
                # get emoji back — `sender_icon_emoji` stays None. See
                # `_sender_mismatch` for the "unverifiable" fallback.
                sender_username=m.get("username"),
                sender_icon_url=_slack_icon_url(m),
            )
            for m in result.get("messages", [])
        ]
        # In sync_linked mode, skip the OP (thread parent) — it's managed separately
        if self._skip_op and messages:
            messages = messages[1:]
        return messages

    def get_reactions(self, message_id: str) -> list[dict]:
        """Return the list of reactions on ``message_id`` (empty if none).

        Called by `sync` under `SenderChangePolicy` when
        ``lose_reactions_ok=False`` — cascade aborts if any target has
        reactions. Uses ``reactions.get`` which requires ``reactions:read``
        scope.
        """
        result = self._request("reactions.get", {
            "channel": self.channel,
            "timestamp": message_id,
        }, method="GET")
        return result.get("message", {}).get("reactions", []) or []

    def post(
        self,
        content: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        images: Sequence[Image] = (),
        raw: bool | None = None,
        broadcast: bool = False,
    ) -> Message:
        """
        Sender fields resolve message override → client default → unset.
        ``icon_url`` beats ``icon_emoji`` when both resolve (Slack accepts
        one or the other on ``chat.postMessage``). Requires the
        ``chat:write.customize`` scope on the token for any override to
        take effect; without it Slack silently ignores the fields.

        ``images`` are `Image` attachments (URL-first — a local-path-only
        image raises); they fold into ``content`` as trailing ``![alt](url)``
        lines and then lift to Block Kit image blocks like any such line, so the
        doc and the programmatic surface converge on the same wire payload.

        ``raw`` follows the same override → default precedence: ``None``
        (the default) inherits ``self.raw``; ``True`` / ``False`` overrides.
        When resolved to ``True``, ``content`` is sent verbatim as wire
        ``text`` (no ``to_slack()`` md→mrkdwn conversion) — for consumers
        already emitting Slack mrkdwn. See `specs/done/raw-mrkdwn-passthrough.md`.

        ``broadcast`` sends ``reply_broadcast: true`` on ``chat.postMessage``
        (Slack's "Also send to channel"): the reply still lives in the thread
        but a copy surfaces in the channel. It requires ``thread_id`` — Slack
        ignores the flag on a top-level message, so ``broadcast=True`` without
        one is a caller bug and **raises** ``ValueError``.
        See `specs/done/slack-reply-broadcast.md`.
        """
        if broadcast and thread_id is None:
            raise ValueError(
                "broadcast=True requires a thread_id: Slack's reply_broadcast "
                "('Also send to channel') only applies to a thread reply."
            )
        content = self._fold_images_into_content(content, images)
        if len(content) > SLACK_MESSAGE_LIMIT:
            raise ValueError(
                f"Message exceeds Slack's {SLACK_MESSAGE_LIMIT} char limit ({len(content)} chars)"
            )
        resolved_raw = raw if raw is not None else self.raw
        # Raw consumers send wire mrkdwn verbatim — no image lifting either.
        body, image_refs = (content, []) if resolved_raw else split_trailing_images(content)
        wire = content if resolved_raw else _md_to_slack(body)
        data: dict = {
            "channel": self.channel,
            "text": wire,
            "unfurl_links": not self._suppress_unfurls,
            "unfurl_media": not self._suppress_unfurls,
        }
        self._attach_chrome(data, content, wire)
        resolved_username = username if username is not None else self.username
        if resolved_username is not None:
            data["username"] = resolved_username
        # Icon resolution treats icon_url + icon_emoji as a unit ("the icon"):
        # if the message sets EITHER, the client's icon is fully replaced —
        # otherwise the client's icon (either flavor) applies. This matches
        # the user's implicit intent ("I set icon_* on this msg, use that")
        # and diverges from the spec's field-by-field draft that would let
        # a client icon_url quietly override a msg icon_emoji. Within either
        # source (msg or client), icon_url beats icon_emoji if both are set.
        if icon_url is not None or icon_emoji is not None:
            if icon_url is not None:
                data["icon_url"] = icon_url
            else:
                data["icon_emoji"] = icon_emoji
        elif self.icon_url is not None or self.icon_emoji is not None:
            if self.icon_url is not None:
                data["icon_url"] = self.icon_url
            else:
                data["icon_emoji"] = self.icon_emoji
        overrides = [k for k in ("username", "icon_url", "icon_emoji") if k in data]
        if overrides and self.token.startswith("xoxp-"):
            # Slack honors sender customization only on bot tokens; on a user
            # token the fields are silently dropped, so a digest relying on a
            # custom name/avatar would quietly post as the human. Fail closed
            # (`specs/editable-image-blocks.md`, bot-token guard).
            raise ValueError(
                f"Sender override ({', '.join(overrides)}) requires a bot token "
                f"(xoxb-…): Slack ignores `chat.postMessage` sender customization "
                f"on user (xoxp-…) tokens. Use a bot token, or drop the override."
            )
        if image_refs:
            self._lift_image_blocks(data, image_refs)
        if thread_id is not None:
            data["thread_ts"] = thread_id
            if broadcast:
                data["reply_broadcast"] = True
        md = self._metadata_for(content)
        if md is not None:
            data["metadata"] = md
        result = self._request("chat.postMessage", data)
        # Return the ORIGINAL markdown as `content` — that's the local source
        # of truth, and callers (state.py, tests) compare against it directly.
        return Message(id=result["ts"], content=content)

    def edit(
        self,
        message_id: str,
        content: str,
        *,
        images: Sequence[Image] = (),
        raw: bool | None = None,
    ) -> Message:
        """Edit ``message_id``'s text to ``content``.

        ``images`` mirror `post()` — URL-first `Image`s folded into ``content``
        as trailing ``![alt](url)`` lines and lifted to image blocks.

        ``raw`` matches `post()`'s semantics: ``None`` inherits ``self.raw``,
        else the boolean overrides. When resolved to ``True``, ``content``
        is sent as wire ``text`` verbatim (no ``to_slack()`` conversion).
        See `specs/done/raw-mrkdwn-passthrough.md`.
        """
        content = self._fold_images_into_content(content, images)
        if len(content) > SLACK_MESSAGE_LIMIT:
            raise ValueError(
                f"Message exceeds Slack's {SLACK_MESSAGE_LIMIT} char limit ({len(content)} chars)"
            )
        resolved_raw = raw if raw is not None else self.raw
        body, image_refs = (content, []) if resolved_raw else split_trailing_images(content)
        wire = content if resolved_raw else _md_to_slack(body)
        data: dict = {
            "channel": self.channel,
            "ts": message_id,
            "text": wire,
            "unfurl_links": not self._suppress_unfurls,
            "unfurl_media": not self._suppress_unfurls,
        }
        self._attach_chrome(data, content, wire)
        if image_refs:
            self._lift_image_blocks(data, image_refs)
        elif not resolved_raw and "blocks" not in data:
            # Declarative blocks: `chat.update` leaves existing blocks in
            # place unless told otherwise, so an edit that drops the doc's
            # image lines must explicitly clear the live image blocks.
            data["blocks"] = []
        md = self._metadata_for(content)
        if md is not None:
            data["metadata"] = md
        self._request("chat.update", data)
        return Message(id=message_id, content=content)

    def _attach_chrome(self, data: dict, content: str, wire: str) -> None:
        """Render this content's staging chrome into the outgoing payload.

        Two shapes, chosen by whether the thread is finalized:

        * **draft** — chrome is a trailing line appended to ``wire``, after
          md→mrkdwn conversion so the converter never sees it, mirroring
          `split_chrome` running before the reverse. The message stays a plain
          text message, so it stays editable in Slack.
        * **finalized** — chrome becomes a ``context`` block under a ``section``
          body. Slack strips the Edit affordance from any message carrying
          blocks, which is a liability for a draft and exactly the point for a
          thread that has already gone out: the staged copy visibly locks, and
          `reopen` is the only way back.

        Every message in a staging sync is sent with an explicit ``blocks``,
        even an empty one: `chat.update` leaves existing blocks in place unless
        told otherwise, so a thread that got reopened would stay locked.

        A footer that wouldn't fit under Slack's message limit is dropped, and
        a body over the per-section limit stays a text message rather than
        being split mid-mrkdwn — a complete body beats the affordance.
        """
        if self._chrome_by_content is None:
            return
        data["blocks"] = []
        footer = self._chrome_by_content.get(content)
        if not footer:
            return
        if content in self._finalized_content and len(wire) <= SLACK_SECTION_LIMIT:
            data["blocks"] = [
                {"type": "section", "text": {"type": "mrkdwn", "text": wire}},
                {"type": "context", "elements": [{"type": "mrkdwn", "text": footer}]},
            ]
            return
        if len(wire) + len(footer) + 2 > SLACK_MESSAGE_LIMIT:
            return
        data["text"] = f"{wire}\n\n{footer}"

    def _fold_images_into_content(self, content: str, images: 'Sequence[Image]') -> str:
        """Append `Image`s to ``content`` as trailing image lines — Slack's
        canonical, idempotent form (image blocks that round-trip on read-back).

        A ``url`` image folds to ``![alt](url){bust?}``. A local-``path`` image
        (no url) is content-addressed but stays **renderable and readable**: it
        folds to ``![alt](<path>#thrds_sha=<sha>)`` — the URL is the real file
        path (so a viewer shows it; the ``#…`` fragment is client-only and
        stripped before fetch), and the sha makes a bytes change a content diff
        (re-upload iff changed). ``url`` wins when an image carries both."""
        if not images:
            return content
        lines = []
        for im in images:
            if im.url is not None:
                lines.append(image_line(ImageRef(alt=im.alt, url=im.url, bust=im.bust)))
                continue
            path = Path(im.path)
            if path.suffix.lower() not in _UPLOAD_SUFFIXES:
                raise ValueError(
                    f"Slack image upload supports {sorted(_UPLOAD_SUFFIXES)} only; "
                    f"got {path.name!r}"
                )
            sha = _image_sha(path.read_bytes())
            lines.append(image_line(ImageRef(alt=im.alt, url=upload_marker(str(im.path), sha))))
        # `\n\n` between body and each image line — matches `_message_markdown`'s
        # read-back reconstruction, so a converge is a no-op.
        extra = "\n\n".join(lines)
        return f"{content}\n\n{extra}" if content else extra

    def _upload_file(self, path: Path) -> str:
        """Upload ``path`` to Slack and return its ``file_id`` (three-step
        external-upload flow). The file is created workspace-side owned by the
        bot, not posted to any channel — an image block surfaces it by id."""
        data = path.read_bytes()
        up = self._request(
            "files.getUploadURLExternal",
            {"filename": path.name, "length": str(len(data))},
            method="GET",
        )
        req = urllib.request.Request(up["upload_url"], data=data, method="POST")
        with urllib.request.urlopen(req) as resp:
            resp.read()
        self._request(
            "files.completeUploadExternal",
            {"files": [{"id": up["file_id"]}]},
        )
        return up["file_id"]

    def _upload_cached(self, sha: str, path: str) -> str:
        """`file_id` for image ``sha`` at ``path``, uploading once per push."""
        if sha not in self._uploaded_file_ids:
            self._uploaded_file_ids[sha] = self._upload_file(Path(path))
        return self._uploaded_file_ids[sha]

    def _lift_image_blocks(self, data: dict, images: list[ImageRef]) -> None:
        """Render trailing `![alt](url)` doc lines as Block Kit `image` blocks.

        The message goes out as blocks (`section` body + `image`s) because an
        attached file can't be edited but an image block's URL can — see
        `specs/editable-image-blocks.md`. Placement interplay with staging
        chrome (`_attach_chrome` ran first):

        * no chrome → ``[section(text), *images]`` (the flat ``text`` stays as
          the notification fallback).
        * draft chrome → the footer is already folded into ``data["text"]``;
          the section carries that folded text so the chrome stays visible,
          and the flat-text fallback keeps `_live_chrome` reporting draft.
          (`_message_markdown` strips it back out of the section on pull.)
        * finalized chrome → images slot between the existing section and its
          `context` footer.
        """
        text = data["text"]
        if not text.strip():
            raise ValueError(
                "Message is only image lines; Slack needs body text alongside "
                "image blocks — add at least one line"
            )
        if len(text) > SLACK_SECTION_LIMIT:
            raise ValueError(
                f"Message body with image blocks exceeds Slack's "
                f"{SLACK_SECTION_LIMIT}-char section limit ({len(text)} chars); "
                f"shorten the body or drop the image lines"
            )
        token = bust_token()
        img_blocks = [
            slack_file_block(ref, self._upload_cached(upload_sha(ref), upload_path(ref)))
            if is_upload_ref(ref) else image_to_block(ref, token)
            for ref in images
        ]
        existing = data.get("blocks")
        if existing:
            head = [b for b in existing if b.get("type") != "context"]
            tail = [b for b in existing if b.get("type") == "context"]
            data["blocks"] = [*head, *img_blocks, *tail]
        else:
            data["blocks"] = [
                {"type": "section", "text": {"type": "mrkdwn", "text": text}},
                *img_blocks,
            ]

    def permalink(self, message_ts: str, channel: str | None = None) -> str:
        """Get a permalink URL for a Slack message."""
        result = self._request("chat.getPermalink", {
            "channel": channel if channel is not None else self.channel,
            "message_ts": message_ts,
        }, method="GET")
        return result["permalink"]

    def delete(self, message_id: str, orphans_ok: bool = False) -> None:
        if not orphans_ok:
            result = self._request("conversations.replies", {
                "channel": self.channel,
                "ts": message_id,
            }, method="GET")
            replies = result.get("messages", [])
            if len(replies) > 1:
                raise OrphanedRepliesError(message_id, len(replies) - 1)
        self._request("chat.delete", {
            "channel": self.channel,
            "ts": message_id,
        })

    def sync(
        self,
        thread: Thread,
        thread_ts: str | None = None,
        dry_run: bool = False,
        pace: float = 0.4,
        jitter: float = 0.0,
        suppress_unfurls: bool = True,
        metadata: dict[str, dict] | None = None,
        only_ts: set[str] | None = None,
    ) -> SyncResult:
        """Sync a thread to the desired state.

        Args:
            metadata: Optional dict mapping message content → Slack metadata.
                Each matching message gets the metadata dict passed on post/edit.

                Example::

                    metadata={
                        crash_text: {
                            "event_type": "new_crash",
                            "event_payload": {"ACCID": "123"},
                        },
                    }
            only_ts: Restrict the reconcile to these message ts; everything
                else in the thread — including our own token's messages — is
                preserved in place like a foreign message. See
                ``SyncOptions.only_ids``.
        """
        self._suppress_unfurls = suppress_unfurls
        self._metadata_by_content = metadata
        # Fresh per-push upload de-dup cache.
        self._uploaded_file_ids = {}
        # Slack carries images in content (image blocks that round-trip on
        # read-back), so fold any `Msg.images` into content up front: the
        # reconcile then diffs content that matches the read-back and stays
        # idempotent. Bare-str and image-free messages are untouched.
        if any(isinstance(m, Msg) and m.images for m in thread.messages):
            thread = replace(thread, messages=[
                replace(m, content=self._fold_images_into_content(m.content, m.images), images=())
                if isinstance(m, Msg) and m.images else m
                for m in thread.messages
            ])
        try:
            return sync(
                client=self,
                desired=thread,
                thread_id=thread_ts,
                options=SyncOptions(
                    dry_run=dry_run,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                    only_ids=only_ts,
                ),
            )
        finally:
            self._metadata_by_content = None

    @staticmethod
    def _bullet(section: Section, url: str) -> str:
        """Slack mrkdwn bullet: linked bold title."""
        return f"- <{url}|*{section.title}*> — {section.summary}"

    def _detail_url_placeholder(self) -> str:
        """Placeholder URL sized to bound real Slack permalink lengths.

        Real permalinks (workspace + channel + thread + cid params) typically
        run ~110-140 chars; 180 is a safe upper bound so phase-4 real-URL
        packing produces at most the phase-1 message count. Any residual
        mismatch is caught by the ``strict=True`` zip in phase 4.
        """
        return "x" * 180

    def sync_linked(
        self,
        linked: LinkedThread,
        thread_ts: str | None = None,
        dry_run: bool = False,
        pace: float = 0.4,
        jitter: float = 0.0,
        suppress_unfurls: bool = True,
    ) -> LinkedSyncResult:
        """Sync a linked summary thread.

        In Slack, the thread parent (OP) is the first message in
        conversations.replies. This method manages the OP separately
        (setting it to summary_prefix) and syncs bullets + details
        as thread replies starting at index 1.
        """
        placeholder = self._detail_url_placeholder()

        # Build summary bullets WITHOUT the prefix (prefix goes to OP)
        linked_replies = LinkedThread(
            summary_prefix="",
            sections=linked.sections,
            summary_suffix=linked.summary_suffix,
        )

        # Phase 1: Build detail + summary messages with placeholder links
        detail_msgs, section_starts = build_detail_messages(linked.sections, SLACK_MESSAGE_LIMIT)
        placeholder_urls = [placeholder] * len(linked.sections)
        summary_msgs, partition = build_summary_partition(linked_replies, placeholder_urls, SLACK_MESSAGE_LIMIT, bullet_fn=self._bullet)

        n_summary = len(summary_msgs)
        all_reply_msgs = summary_msgs + detail_msgs

        # Phase 2: Handle the OP separately, then sync replies
        if thread_ts is None:
            # New thread: post OP with summary_prefix
            if not dry_run:
                op_content = linked.summary_prefix or " "
                op = self.post(op_content)
                thread_ts = op.id
            else:
                thread_ts = "<new>"
        elif linked.summary_prefix and not dry_run:
            # Existing thread: edit OP with summary_prefix
            self.edit(thread_ts, linked.summary_prefix)

        # Sync reply messages (skip OP in list_messages)
        self._skip_op = True
        try:
            result = self.sync(
                Thread(messages=all_reply_msgs),
                thread_ts=thread_ts,
                dry_run=dry_run,
                pace=pace,
                jitter=jitter,
                suppress_unfurls=suppress_unfurls,
            )
        finally:
            self._skip_op = False

        if dry_run:
            return LinkedSyncResult(
                thread_id=thread_ts,
                summary_ids=result.message_ids[:n_summary],
                detail_ids=result.message_ids[n_summary:],
                section_detail_ids={},
            )

        tid = result.thread_id
        detail_ids = result.message_ids[n_summary:]
        summary_ids = result.message_ids[:n_summary]

        # Phase 3: Resolve real permalinks and build links
        section_detail_map: dict[str, str] = {}
        real_links: list[str] = []
        for i, section in enumerate(linked.sections):
            if i > 0 and pace > 0:
                time.sleep(pace + random.uniform(0, jitter))
            detail_idx = section_starts[i]
            detail_msg_id = detail_ids[detail_idx]
            section_detail_map[section.title] = detail_msg_id
            real_links.append(self.permalink(detail_msg_id))

        # Phase 4: Rebuild each phase-1 message with real URLs, preserving the
        # partition — this keeps the message count constant regardless of real
        # vs placeholder URL length, so the strict-zip below is an invariant
        # assertion (unreachable absent a bug in `build_summary_partition`),
        # not a common-case failure mode.
        final_summaries = render_summary_from_partition(linked_replies, real_links, partition, bullet_fn=self._bullet)
        if len(final_summaries) != len(summary_ids):
            raise RuntimeError(
                f"sync_linked phase-4 render yielded {len(final_summaries)} summary messages, "
                f"phase-1 posted {len(summary_ids)}; partition invariant violated."
            )
        for j, msg in enumerate(final_summaries):
            if len(msg) > SLACK_MESSAGE_LIMIT:
                raise RuntimeError(
                    f"sync_linked phase-4 message {j} rendered to {len(msg)} chars "
                    f"(limit {SLACK_MESSAGE_LIMIT}); real permalinks longer than "
                    "`_detail_url_placeholder` upper bound — bump the placeholder."
                )
        for i, (msg_id, content) in enumerate(zip(summary_ids, final_summaries, strict=True)):
            if i > 0 and pace > 0:
                time.sleep(pace + random.uniform(0, jitter))
            self.edit(msg_id, content)

        return LinkedSyncResult(
            thread_id=tid,
            summary_ids=summary_ids,
            detail_ids=detail_ids,
            section_detail_ids=section_detail_map,
        )

    # --- Cross-thread ref resolution (phase-2 placeholder / phase-3 real URL) ---
    def _prepare_doc_for_refs(self, doc: Doc, dry_run: bool) -> Doc:
        """Validate refs and return a Doc suitable for phase-2 posting.

        With refs and not dry-run: every ``[text](#slug)`` replaced with a
        180-char placeholder URL, so real permalinks (~110-140 chars) fit
        into the same message slot on the phase-3 rewrite. Every message
        is length-checked post-substitution — an over-limit failure here
        beats a mid-sync `chat.postMessage` "message too long".

        Dry-run passes the doc through unchanged (nothing gets posted, and
        the user reviewing the plan reads the raw `#slug` form more easily
        than 180 chars of `x`).
        """
        validate_refs(doc)
        if dry_run or not doc_has_refs(doc):
            return doc
        substituted = substitute_doc_refs(doc, lambda _slug: PLACEHOLDER_URL)
        # Length check on every message; identify offenders precisely.
        if substituted.preamble is not None and len(substituted.preamble) > SLACK_MESSAGE_LIMIT:
            raise ValueError(
                f"preamble is {len(substituted.preamble)} chars after ref-placeholder "
                f"substitution (limit {SLACK_MESSAGE_LIMIT}); shorten or split it."
            )
        for thread in substituted.threads:
            for i, m in enumerate(thread.messages):
                if len(m.content) > SLACK_MESSAGE_LIMIT:
                    raise ValueError(
                        f"thread {thread.slug!r} msg {i} is {len(m.content)} chars after "
                        f"ref-placeholder substitution (limit {SLACK_MESSAGE_LIMIT}); "
                        "shorten or split it."
                    )
        return substituted

    def _resolve_and_edit_refs(
        self,
        doc: Doc,
        channel: str,
        preamble_ts: str | None,
        thread_ts_by_slug: dict[str, str],
        state: SessionState,
        pace: float,
        jitter: float,
        suppress_unfurls: bool,
        frontmatter_by_slug: dict[str, Frontmatter] | None = None,
    ) -> None:
        """Phase-3: fetch permalinks + re-sync messages containing refs.

        The re-sync per thread (or preamble) delegates back to `core.sync`,
        which lists existing messages, diffs against the real-URL desired
        content, and edits only the messages whose content actually changed
        (the ref-containing ones). Threads/preamble without refs are skipped.

        Assumes `self.channel` is already set to ``channel`` by the caller.
        """
        if not doc_has_refs(doc):
            return
        # Build slug → real permalink via chat.getPermalink on each OP.
        permalinks = {slug: self.permalink(ts) for slug, ts in thread_ts_by_slug.items()}
        real_doc = substitute_doc_refs(doc, lambda slug: permalinks[slug])
        # Phase-3 rewrites OP content, which is how chrome is keyed — rebind
        # before the re-sync so a ref-carrying OP keeps its chrome.
        self._register_chrome(real_doc.threads)

        # Preamble: only re-sync if it had refs.
        if doc.preamble is not None and preamble_ts is not None:
            from .refs import CROSS_REF_RE
            if CROSS_REF_RE.search(doc.preamble):
                self._sync_preamble(
                    real_doc.preamble,
                    preamble_ts,
                    state,
                    dry_run=False,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                    delete_on_absent=False,  # phase-3 never deletes
                )

        for thread, real_thread in zip(doc.threads, real_doc.threads, strict=True):
            if not thread_has_refs(thread):
                continue
            self._sync_doc_thread(
                real_thread,
                thread_ts_by_slug[thread.slug],
                state,
                dry_run=False,
                pace=pace,
                jitter=jitter,
                suppress_unfurls=suppress_unfurls,
                frontmatter=(frontmatter_by_slug or {}).get(thread.slug),
            )

    # --- Doc-level sync (multi-thread) ---
    def create_private_channel(self, name: str) -> str:
        """Create a private channel with ``name`` and return its channel_id.

        The Slack API may lowercase / rewrite invalid chars in the name; the
        returned ID (not the name) is the durable handle to record in state.
        Requires the token to have ``groups:write``.
        """
        result = self._request("conversations.create", {
            "name": name,
            "is_private": True,
        })
        return result["channel"]["id"]

    def archive_channel(self, channel: str) -> None:
        """Archive ``channel`` (reversible via ``conversations.unarchive``).

        The primary use is GC of a session's staging PC after a successful
        prod push; Slack has no channel-delete for standard workspaces, so
        archive is the strongest cleanup available.
        """
        self._request("conversations.archive", {"channel": channel})

    def _delete_thread(self, thread_ts: str, pace: float, jitter: float) -> None:
        """Delete an entire thread — replies bottom-up, OP last.

        Foreign replies (non-editable) will fail chat.delete; we skip them via
        ``editable`` filter. That leaves them orphaned if any exist, but in a
        single-member staging PC that shouldn't happen in practice.
        """
        replies = self.list_messages(thread_ts)
        # replies[0] is the OP itself; skip and delete OP last.
        for msg in reversed(replies[1:]):
            if not msg.editable:
                continue
            self._request("chat.delete", {"channel": self.channel, "ts": msg.id})
            if pace > 0:
                time.sleep(pace + random.uniform(0, jitter))
        # OP:
        self._request("chat.delete", {"channel": self.channel, "ts": thread_ts})

    def _thrds_metadata(
        self,
        state: SessionState,
        thread_slug: str | None,
        kind: str,
    ) -> dict:
        """Build the Slack metadata payload for one thrds-owned message.

        Emitted on every post/edit so ``recover`` can rebuild state from
        ``conversations.history`` by filtering on ``event_type == 'thrds'``
        and ``event_payload.session_id == <id>``.
        """
        payload = {
            "session_id": state.session_id,
            "doc_slug": state.doc_slug,
            "kind": kind,
        }
        if thread_slug is not None:
            payload["thread_slug"] = thread_slug
        return {
            "event_type": THRDS_METADATA_EVENT_TYPE,
            "event_payload": payload,
        }

    def _sync_doc_thread(
        self,
        thread: DocThread,
        existing_ts: str | None,
        state: SessionState,
        dry_run: bool,
        pace: float,
        jitter: float,
        suppress_unfurls: bool,
        frontmatter: Frontmatter | None = None,
    ) -> tuple[str, SyncResult]:
        """Sync one owned thread (its OP + replies) via `sync()`.

        Filters ``thread.messages`` to ours-only (``author is None``) before
        translating to a `Thread` — foreign messages are preserved on Slack
        by `core.sync`'s editable filter, never re-posted. ``frontmatter``
        carries the per-thread sender profiles (`op_sender` / ``sender.*``), so
        a `+++ as <name>` reply resolves to a `Msg` with that name/avatar (a
        sender-free thread yields the same bare-string `Thread` as before).
        Returns ``(op_ts, sync_result)``.
        """
        ours = [m for m in thread.messages if m.author is None]
        if not ours:
            raise ValueError(
                f"Thread {thread.slug!r}: no ours messages to sync — every "
                "message has an author, which shouldn't be possible (OP must "
                "be ours). Data-model bug."
            )
        fm = frontmatter if frontmatter is not None else Frontmatter()
        core_thread = Thread(messages=resolve_messages(ours, fm))
        metadata: dict[str, dict] = {}
        for i, m in enumerate(ours):
            kind = "op" if i == 0 else "reply"
            metadata[m.content] = self._thrds_metadata(state, thread.slug, kind)
        result = self.sync(
            core_thread,
            thread_ts=existing_ts,
            dry_run=dry_run,
            pace=pace,
            jitter=jitter,
            suppress_unfurls=suppress_unfurls,
            metadata=metadata,
        )
        return result.thread_id, result

    def _sync_preamble(
        self,
        preamble: str | None,
        existing_ts: str | None,
        state: SessionState,
        dry_run: bool,
        pace: float,
        jitter: float,
        suppress_unfurls: bool,
        delete_on_absent: bool,
    ) -> str | None:
        """Sync the doc's preamble (a top-level message with no replies).

        - preamble absent + no existing_ts → nop, return None.
        - preamble absent + existing_ts + delete_on_absent → delete, return None.
          (Staging terraforms; prod leaves the existing preamble in place.)
        - preamble present + no existing_ts → post fresh, return new ts.
        - preamble present + existing_ts → edit in place, return existing_ts.
        """
        if preamble is None:
            if existing_ts is not None and delete_on_absent and not dry_run:
                self._request("chat.delete", {"channel": self.channel, "ts": existing_ts})
                return None
            return existing_ts  # preserved as-is (or None if never set)
        # Treat the preamble as a one-message "thread" (no replies).
        core_thread = Thread(messages=[preamble])
        metadata = {preamble: self._thrds_metadata(state, thread_slug=None, kind="preamble")}
        result = self.sync(
            core_thread,
            thread_ts=existing_ts,
            dry_run=dry_run,
            pace=pace,
            jitter=jitter,
            suppress_unfurls=suppress_unfurls,
            metadata=metadata,
        )
        return result.thread_id if not dry_run else (existing_ts or "<new>")

    def sync_doc_staging(
        self,
        doc: Doc,
        state: SessionState,
        dry_run: bool = False,
        pace: float = 0.4,
        jitter: float = 0.0,
        suppress_unfurls: bool = True,
    ) -> DocSyncResult:
        """Terraform-sync a `Doc` into its per-session staging PC.

        Creates the PC lazily on the first non-dry-run call (updates
        ``state.staging_channel`` and persists state immediately so a mid-run
        failure doesn't leak the channel handle). Terraform semantics:

        - Slugged threads present in state but absent from the doc are deleted.
        - Slugged threads in the doc are synced in place (`core.sync` reconciles
          OP + replies, preserving foreign messages via the editable filter).
        - Preamble is treated as a one-message thread; deletion on removal.

        Every thread must have a slug (state is slug-keyed). Bare ``===``
        threads raise ``ValueError``.
        """
        for t in doc.threads:
            if t.slug is None:
                raise ValueError(
                    "sync_doc_staging requires every thread to have a slug; "
                    "bare `===` threads aren't state-trackable."
                )

        # 0. Validate cross-refs + build phase-2 doc (placeholder-substituted
        #    if refs present + not dry-run; raw otherwise).
        phase2_doc = self._prepare_doc_for_refs(doc, dry_run)

        # 1. Ensure staging PC exists.
        if state.staging_channel is None and not dry_run:
            state.staging_channel = self.create_private_channel(state.staging_channel_name())
            state.save()  # persist eagerly — a mid-run failure shouldn't leak the channel handle
        channel = state.staging_channel if state.staging_channel is not None else "<new-pc>"

        prev_channel = self.channel
        self.channel = channel
        try:
            # 2. Preamble.
            preamble_ts = self._sync_preamble(
                phase2_doc.preamble,
                state.staging_preamble_ts,
                state,
                dry_run=dry_run,
                pace=pace,
                jitter=jitter,
                suppress_unfurls=suppress_unfurls,
                delete_on_absent=True,
            )
            if not dry_run:
                state.staging_preamble_ts = preamble_ts

            # 3. Delete stale slugs (in state, absent from doc).
            desired_slugs = {t.slug for t in phase2_doc.threads}
            stale_slugs = [s for s in list(state.staging_threads) if s not in desired_slugs]
            for slug in stale_slugs:
                thread_ts = state.staging_threads[slug]
                if not dry_run:
                    del state.staging_threads[slug]
                    self._delete_thread(thread_ts, pace=pace, jitter=jitter)

            # 4. Sync each desired thread.
            thread_ts_by_slug: dict[str, str] = {}
            thread_results: dict[str, SyncResult] = {}
            for thread in phase2_doc.threads:
                existing_ts = state.staging_threads.get(thread.slug)
                op_ts, sync_result = self._sync_doc_thread(
                    thread,
                    existing_ts,
                    state,
                    dry_run=dry_run,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                )
                if not dry_run:
                    state.staging_threads[thread.slug] = op_ts
                thread_ts_by_slug[thread.slug] = op_ts
                thread_results[thread.slug] = sync_result

            # 5. Phase-3 ref resolution: fetch permalinks, rewrite ref-containing
            #    messages in place. Skipped on dry-run (no ts's to link to).
            if not dry_run:
                self._resolve_and_edit_refs(
                    doc,
                    channel,
                    preamble_ts,
                    thread_ts_by_slug,
                    state,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                )
                state.save()

            return DocSyncResult(
                channel=channel,
                preamble_ts=preamble_ts,
                thread_ts_by_slug=thread_ts_by_slug,
                thread_results=thread_results,
                deleted_slugs=stale_slugs,
            )
        finally:
            self.channel = prev_channel

    @staticmethod
    def _chrome_line(
        state: SessionState,
        slug: str,
        filename: str,
        target_url: str | None = None,
        chrome: StagingChrome | None = None,
    ) -> str | None:
        """One staged thread's footer line, or None if there's nothing to say.

        Three affordances, all derived from state rather than content: where
        the draft is bound, the message it became once posted, and a deep link
        to its file in the gist. See `thrds.chrome` for the shape and why it
        lives in the text rather than in blocks. ``chrome`` is the remote's
        resolved config (defaults to the default staging remote's).
        """
        if chrome is None:
            chrome = remotes.resolve(state)[STAGING].chrome
        if chrome is None:
            return None
        entry = state.threads.get(slug)
        target = state.target_for(slug) if chrome.target_link else None
        posted = entry.posted_url if (
            chrome.posted_link and entry is not None
        ) else None
        return render_chrome(
            channel=target.channel if target is not None else None,
            thread_ts=target.thread_ts if target is not None else None,
            target_url=target_url,
            posted_url=posted,
            gist_id=state.gist_id if chrome.gist_link else None,
            filename=filename,
            channel_name=(
                state.channel_names.get(target.channel) if target is not None else None
            ),
        )

    def _live_chrome(self, op_ts: str) -> tuple[str | None, bool]:
        """``(chrome line, is_finalized)`` for the staged message at ``op_ts``.

        Both halves matter to the reconcile. The line can be identical while
        the *shape* changes — dropping a thread finalizes it without altering a
        word of its chrome — so comparing text alone would leave it unlocked
        forever.

        Entity-decoded, because Slack HTML-encodes ``&`` on storage: a
        permalink's ``&cid=`` comes back ``&amp;cid=``, and comparing that
        against freshly-rendered chrome would report drift on every push and
        re-edit every message forever. Glyphs are normalized for the same
        reason — see :data:`thrds.chrome.GLYPH_ALIASES`.
        """
        result = self._request("conversations.replies", {
            "channel": self.channel,
            "ts": op_ts,
            "limit": 1,
        }, method="GET")
        message = (result.get("messages") or [{}])[0]
        contexts = [
            b for b in (message.get("blocks") or []) if b.get("type") == "context"
        ]
        if contexts:
            line = normalize_glyphs(_decode_entities("".join(
                e.get("text", "") for e in contexts[0].get("elements", [])
                if e.get("type") == "mrkdwn"
            )))
            return (line or None), True
        text = normalize_glyphs(_decode_entities(message.get("text", "")))
        lines = text.rstrip("\n").split("\n")
        if len(lines) < 2:
            return None, False
        last = lines[-1].strip()
        return (last, False) if parse_chrome(last) is not None else (None, False)

    def _live_chrome_line(self, op_ts: str) -> str | None:
        """Just the chrome line — what `pull_chrome_edits` reads."""
        return self._live_chrome(op_ts)[0]

    def _reconcile_chrome(
        self,
        op_ts: str,
        content: str,
        pace: float,
        jitter: float,
    ) -> bool:
        """Bring the staged message at ``op_ts`` in line with its desired chrome.

        Body reconciliation can't cover this: `core.sync` compares *content*,
        and the footer isn't part of content — it's derived from `thrds.yml`.
        An OP whose text is unchanged is SKIPped, so a thread promoted since
        the last push would never gain its `posted` link. Chrome that only
        lands when the body happens to change is chrome you can't trust to
        reflect state, so a push converges it explicitly.

        Returns whether an edit was issued.
        """
        footer = (self._chrome_by_content or {}).get(content)
        if not footer:
            return False
        want = (footer, content in self._finalized_content)
        if self._live_chrome(op_ts) == want:
            return False
        if pace > 0:
            time.sleep(pace + random.uniform(0, jitter))
        self.edit(op_ts, content)
        return True

    def _target_urls(self, state: SessionState, slugs: list[str]) -> dict[str, str]:
        """slug → permalink of the message each reply-targeted thread answers.

        Only threads bound *into* a thread need one; the footer renders those
        as a linked arrow rather than a raw ts. Failures are swallowed: a
        stale target shouldn't fail a staging push, it should just render the
        plainer channel-only form.
        """
        urls: dict[str, str] = {}
        for slug in slugs:
            target = state.target_for(slug)
            if target is None or target.thread_ts is None:
                continue
            try:
                urls[slug] = self.permalink(target.thread_ts, channel=target.channel)
            except Exception:  # noqa: BLE001 — best-effort affordance
                continue
        return urls

    def _resolve_channel_names(self, state: SessionState, slugs: list[str]) -> None:
        """Cache ``channel id → name`` for each posted thread's target.

        Only posted threads need one: their condensed footer names the channel
        in link text, where a draft's ``<#C…>`` mention lets Slack do the
        naming. One `conversations.info` per channel — versus paginating
        `conversations.list` over the whole workspace for a display string —
        and it persists in `thrds.yml`, so a session pays at most once.

        Failures are swallowed like `_target_urls`': a name we can't resolve
        means the footer renders its longer form, not that the push fails.
        """
        for slug in slugs:
            entry = state.threads.get(slug)
            target = state.target_for(slug)
            if entry is None or entry.posted_url is None or target is None:
                continue
            if target.channel in state.channel_names:
                continue
            try:
                # GET, not JSON POST — same constraint as `list_channels_by_name`:
                # `conversations.info` answers a JSON POST with `invalid_arguments`.
                r = self._request(
                    'conversations.info', {'channel': target.channel}, method='GET',
                )
            except Exception:  # noqa: BLE001 — best-effort affordance
                continue
            if name := (r.get('channel') or {}).get('name'):
                state.channel_names[target.channel] = name

    def _chrome_for_threads(
        self,
        threads: list[DocThread],
        state: SessionState,
        filenames: dict[str, str],
        chrome: StagingChrome | None,
    ) -> dict[str, str]:
        """Map each thread's slug → its footer line (per the remote's chrome)."""
        if chrome is None or not chrome.any_enabled:
            return {}
        slugs = [t.slug for t in threads]
        target_urls = self._target_urls(state, slugs)
        self._resolve_channel_names(state, slugs)
        by_slug: dict[str, str] = {}
        for thread in threads:
            line = self._chrome_line(
                state,
                thread.slug,
                filenames.get(thread.slug, f'{thread.slug}.md'),
                target_urls.get(thread.slug),
                chrome=chrome,
            )
            if line:
                by_slug[thread.slug] = line
        return by_slug

    def _register_chrome(self, threads: list[DocThread]) -> None:
        """Bind these threads' OP *contents* to their slugs' chrome.

        `post`/`edit` see only content, so the footer has to be reachable by it —
        but one OP passes through up to three contents in a single push: the
        authored text, the placeholder-URL text used to size cross-refs, and
        the real-permalink text of phase 3. All three are the same thread, so
        all three register the same blocks. Without this an OP containing a
        cross-ref would lose its chrome the instant refs resolved, which is
        exactly the OP most worth annotating.

        Replies never register: only ``ours[0]`` is bound.
        """
        if not self._chrome_by_slug:
            return
        if self._chrome_by_content is None:
            self._chrome_by_content = {}
        for thread in threads:
            line = self._chrome_by_slug.get(thread.slug)
            if line is None:
                continue
            ours = [m for m in thread.messages if m.author is None]
            if ours and thread.slug in self._finalized_slugs:
                self._finalized_content.add(ours[0].content)
            if ours:
                self._chrome_by_content[ours[0].content] = line

    def sync_threads_staging(
        self,
        threads: list[DocThread],
        state: SessionState,
        dry_run: bool = False,
        pace: float = 0.4,
        jitter: float = 0.0,
        suppress_unfurls: bool = True,
        filenames: dict[str, str] | None = None,
        remote: Remote | None = None,
        frontmatter_by_slug: dict[str, Frontmatter] | None = None,
    ) -> DocSyncResult:
        """Terraform-sync a session's thread files into its staging PC.

        The per-thread-model counterpart to :meth:`sync_doc_staging`. Same
        terraform semantics — threads recorded in state but no longer on disk
        are deleted from Slack, threads on disk are reconciled in place — but
        driven by ``NN-slug.md`` files rather than one doc's ``===`` sections,
        and with no preamble special case (a preamble is just ``00-preamble``,
        an ordinary thread).

        Cross-references still resolve across the whole session: the threads
        are assembled into a transient `Doc` purely so the existing two-phase
        ref machinery (placeholder → real permalink) can operate over all of
        them at once, since a ``[text](#slug)`` link points from one file to
        another.
        """
        for t in threads:
            if t.slug is None:
                raise ValueError(
                    "sync_threads_staging requires every thread to have a slug; "
                    "a thread's slug is its filename."
                )

        if remote is None:
            remote = remotes.resolve(state)[STAGING]

        doc = Doc(threads=threads)
        phase2_doc = self._prepare_doc_for_refs(doc, dry_run)

        if remote.channel is None and not dry_run:
            # Only the default staging remote is provisionable (an extra
            # staging-role remote must declare its channel at config time).
            state.staging_channel = self.create_private_channel(state.staging_channel_name())
            state.save()  # persist eagerly — a mid-run failure shouldn't leak the channel handle
            remote = remotes.resolve(state)[remote.name]
        channel = remote.channel if remote.channel is not None else "<new-pc>"

        prev_channel = self.channel
        self.channel = channel
        # Chrome is staging-only by construction: it's attached here and
        # nowhere in `promote_thread`, so a prod post can't carry it.
        self._chrome_by_slug = self._chrome_for_threads(
            phase2_doc.threads, state, filenames or {}, remote.chrome,
        )
        # A terminal thread's staged copy finalizes: chrome moves into blocks,
        # which Slack renders more quietly and — the point — makes uneditable.
        # `reopen` is the way back.
        self._finalized_slugs = {
            slug for slug, e in state.threads.items()
            if e.is_terminal and remote.chrome is not None
            and remote.chrome.finalize_terminal
        }
        self._register_chrome(doc.threads)
        self._register_chrome(phase2_doc.threads)
        try:
            # Threads recorded in state but no longer on disk: terraform away.
            # Only those with a staging message to delete are considered — an
            # entry that never reached staging has nothing to clean up.
            desired = {t.slug for t in phase2_doc.threads}

            def root_at(e: ThreadEntry) -> str | None:
                p = e.remotes.get(remote.name)
                return p.ts if p is not None else None

            stale = [
                slug for slug, e in sorted(state.threads.items())
                if slug not in desired and root_at(e) is not None
            ]
            for slug in stale:
                if not dry_run:
                    self._delete_thread(root_at(state.threads[slug]), pace=pace, jitter=jitter)
                    del state.threads[slug]

            thread_ts_by_slug: dict[str, str] = {}
            thread_results: dict[str, SyncResult] = {}
            fm_by_slug = frontmatter_by_slug or {}
            for thread in phase2_doc.threads:
                entry = state.thread(thread.slug)
                op_ts, sync_result = self._sync_doc_thread(
                    thread,
                    root_at(entry),
                    state,
                    dry_run=dry_run,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                    frontmatter=fm_by_slug.get(thread.slug),
                )
                if not dry_run:
                    entry.pointer(remote.name).ts = op_ts
                    # The OP's body may have been SKIPped (unchanged) while its
                    # chrome drifted — e.g. the thread got promoted since the
                    # last push, so a `✓ posted` link is now due.
                    ours = [m for m in thread.messages if m.author is None]
                    if ours:
                        self._reconcile_chrome(op_ts, ours[0].content, pace, jitter)
                thread_ts_by_slug[thread.slug] = op_ts
                thread_results[thread.slug] = sync_result

            if not dry_run:
                self._resolve_and_edit_refs(
                    doc,
                    channel,
                    None,
                    thread_ts_by_slug,
                    state,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                    frontmatter_by_slug=fm_by_slug,
                )
                state.save()

            return DocSyncResult(
                channel=channel,
                preamble_ts=None,
                thread_ts_by_slug=thread_ts_by_slug,
                thread_results=thread_results,
                deleted_slugs=stale,
            )
        finally:
            self.channel = prev_channel
            self._chrome_by_content = None
            self._chrome_by_slug = None
            self._finalized_content = set()
            self._finalized_slugs = set()

    def promote_thread(
        self,
        slug: str,
        thread: DocThread,
        target: ThreadTarget,
        state: SessionState,
        dry_run: bool = False,
        pace: float = 0.4,
        jitter: float = 0.0,
        suppress_unfurls: bool = True,
        frontmatter: Frontmatter | None = None,
    ) -> SyncResult:
        """Post one thread to its own target. Never touches any other thread.

        The per-thread replacement for ``sync_doc_prod``'s whole-doc push (see
        ``specs/per-thread-model.md``). Two shapes, decided by the target:

        - ``target.thread_ts is None`` → the thread's messages become a new
          top-level message plus its replies.
        - ``target.thread_ts`` set → the messages go *into* that existing
          thread as replies, and the reconcile is scoped to the messages
          THIS SLUG previously posted there (``entry.posted_msg_ts``). Every
          other message is preserved in place — foreign users' via
          ``editable=False``, and, critically, our own token's messages from
          other slugs or manual posts via ``only_ts``. A first promote has an
          empty scope and is therefore strictly append-only. (Converging the
          whole thread here once edited/deleted three unrelated posts — see
          ``specs/promote-shared-thread-safety.md``.)

        Deliberately does **not** archive the staging channel: other threads in
        the session are still live drafts. Archiving is its own verb, gated on
        every thread reaching a terminal state.
        """
        ours = [m for m in thread.messages if m.author is None]
        if not ours:
            raise ValueError(
                f"Thread {slug!r}: no messages of ours to post."
            )
        # Fail closed. Chrome is stripped on pull, but "stripped on pull" is a
        # step that can fail open; publishing a secret-gist URL to a real
        # channel is the one failure worth an assertion at the boundary.
        leaked = [i for i, m in enumerate(ours) if has_chrome(m.content)]
        if leaked:
            raise ValueError(
                f"Thread {slug!r}: message(s) at index {leaked} still carry a staging "
                f"chrome footer; refusing to post. Re-pull the thread (or delete the "
                f"trailing footer line) before promoting."
            )

        entry = state.thread(slug)
        only_ts: set[str] | None
        if target.thread_ts is not None:
            # Shared thread: reconcile only what this slug posted before.
            # Legacy entries predate `posted_msg_ts`; their `posted_ts` is
            # trustworthy unless it recorded the thread root (an old bug),
            # which is someone else's message and must stay out of scope.
            if entry.posted_msg_ts is not None:
                only_ts = set(entry.posted_msg_ts)
            elif entry.posted_ts and entry.posted_ts != target.thread_ts:
                only_ts = {entry.posted_ts}
            else:
                only_ts = set()
        else:
            # Our own (new or previously-created) thread: every editable
            # message in it is this slug's; foreign replies are already
            # protected by `editable=False`.
            only_ts = None

        prev_channel = self.channel
        self.channel = target.channel
        try:
            fm = frontmatter if frontmatter is not None else Frontmatter()
            core_thread = Thread(messages=resolve_messages(ours, fm))
            metadata = {
                m.content: self._thrds_metadata(state, slug, "op" if i == 0 else "reply")
                for i, m in enumerate(ours)
            }
            result = self.sync(
                core_thread,
                thread_ts=target.thread_ts or entry.posted_ts,
                dry_run=dry_run,
                pace=pace,
                jitter=jitter,
                suppress_unfurls=suppress_unfurls,
                metadata=metadata,
                only_ts=only_ts,
            )
            if not dry_run:
                # Record OUR messages: `posted_ts` is the first of ours (the
                # thread root only when the thread is ours), and the full list
                # is the whitelist for the next re-promote.
                entry.posted_msg_ts = list(result.message_ids)
                first_ours = result.message_ids[0] if result.message_ids else result.thread_id
                entry.posted_ts = first_ours
                entry.posted_url = self.permalink(first_ours)
                entry.target = target
                entry.state = 'posted'
            return result
        finally:
            self.channel = prev_channel

    def sync_doc_prod(
        self,
        doc: Doc,
        state: SessionState,
        channel: str | None = None,
        keep_staging: bool = False,
        dry_run: bool = False,
        pace: float = 0.4,
        jitter: float = 0.0,
        suppress_unfurls: bool = True,
    ) -> DocSyncResult:
        """Additive sync of a `Doc` into its real target channel.

        Additive semantics (opposite of ``sync_doc_staging``): threads absent
        from the doc are LEFT in place on Slack (never terraform-deleted); the
        preamble on a channel is edited if the doc still has one but preserved
        otherwise. Owned threads present in state are reconciled by
        ``core.sync``; new threads in the doc get posted fresh and recorded in
        ``state.prod_threads[channel]``.

        ``channel`` overrides ``state.prod_channel`` for this call; the first
        successful (non-dry-run) call pins the resolved channel into
        ``state.prod_channel`` for subsequent runs.

        On success (non-dry-run), archives the session's staging PC unless
        ``keep_staging=True`` — the "prod push finalizes the session" GC step.
        The state records (``staging_channel`` + ``staging_threads``) are
        preserved as history; ``conversations.unarchive`` reopens the PC if
        needed.
        """
        for t in doc.threads:
            if t.slug is None:
                raise ValueError(
                    "sync_doc_prod requires every thread to have a slug; "
                    "bare `===` threads aren't state-trackable."
                )

        target = channel if channel is not None else state.prod_channel
        if target is None:
            raise ValueError(
                "No prod channel — pass channel= or set state.prod_channel first."
            )

        # 0. Validate cross-refs + build phase-2 doc.
        phase2_doc = self._prepare_doc_for_refs(doc, dry_run)

        prev_channel = self.channel
        self.channel = target
        try:
            # 1. Preamble (additive: preserved on absence).
            preamble_ts = self._sync_preamble(
                phase2_doc.preamble,
                state.prod_preamble_ts.get(target),
                state,
                dry_run=dry_run,
                pace=pace,
                jitter=jitter,
                suppress_unfurls=suppress_unfurls,
                delete_on_absent=False,
            )
            if not dry_run:
                if preamble_ts is not None:
                    state.prod_preamble_ts[target] = preamble_ts
                # If preamble_ts is None here (no doc preamble, no prior state), leave state clean.

            # 2. Threads: sync-in-place, add-if-new. No delete of state entries absent from doc.
            thread_ts_by_slug: dict[str, str] = {}
            thread_results: dict[str, SyncResult] = {}
            for thread in phase2_doc.threads:
                existing_ts = state.get_thread_ts(target, thread.slug)
                op_ts, sync_result = self._sync_doc_thread(
                    thread,
                    existing_ts,
                    state,
                    dry_run=dry_run,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                )
                if not dry_run:
                    state.set_thread_ts(target, thread.slug, op_ts)
                thread_ts_by_slug[thread.slug] = op_ts
                thread_results[thread.slug] = sync_result

            # 3. Phase-3 ref resolution.
            if not dry_run:
                self._resolve_and_edit_refs(
                    doc,
                    target,
                    preamble_ts,
                    thread_ts_by_slug,
                    state,
                    pace=pace,
                    jitter=jitter,
                    suppress_unfurls=suppress_unfurls,
                )
                state.prod_channel = target  # pin for future runs
                state.save()

            # 4. Auto-archive the staging PC unless the caller opted out.
            if not dry_run and not keep_staging and state.staging_channel is not None:
                self.archive_channel(state.staging_channel)

            return DocSyncResult(
                channel=target,
                preamble_ts=preamble_ts,
                thread_ts_by_slug=thread_ts_by_slug,
                thread_results=thread_results,
                deleted_slugs=[],
            )
        finally:
            self.channel = prev_channel

    # --- Doc-level pull ---
    def _resolve_user_name(self, user_id: str) -> str:
        """Look up ``user_id`` → username (Slack ``name`` field), cached per-client.

        Used to populate ``DocMessage.author`` on pull; the cache dedupes
        ``users.info`` calls when several messages share the same author.
        """
        if user_id in self._user_name_cache:
            return self._user_name_cache[user_id]
        result = self._request("users.info", {"user": user_id}, method="GET")
        name = result["user"]["name"]
        self._user_name_cache[user_id] = name
        return name

    def _raw_to_doc_message(self, raw: dict) -> DocMessage:
        """Convert a raw Slack message dict → `DocMessage`.

        ``author=None`` for messages we authored (matched via ``bot_ids``);
        else the username resolved from ``users.info``.

        Runs ``to_markdown`` on the raw Slack text so pulled content is in the
        same format the local doc uses — the roundtrip diff is a real content
        diff rather than a format-mismatch diff. Body comes from
        :meth:`_message_markdown`, which prefers Slack's own parse tree.
        """
        user_id, bot_id = self.bot_ids
        ours = raw.get("user") == user_id or (bot_id is not None and raw.get("bot_id") == bot_id)
        content = self._message_markdown(raw)
        if ours:
            return DocMessage(content=content, author=None)
        return DocMessage(content=content, author=self._resolve_user_name(raw["user"]))

    def _pull_thread_docmessages(self, thread_ts: str) -> list[DocMessage]:
        """Fetch a thread's OP + replies from ``self.channel``, translate to DocMessages."""
        result = self._request("conversations.replies", {
            "channel": self.channel,
            "ts": thread_ts,
        }, method="GET")
        return [self._raw_to_doc_message(m) for m in result.get("messages", [])]

    def _reverse_cross_refs(
        self,
        content: str,
        channel: str,
        thread_ts_by_slug: dict[str, str],
    ) -> str:
        """Rewrite `[text](permalink)` back to `[text](#slug)` for our own threads.

        The push path resolved `[text](#slug)` → `[text](<slack-permalink>)`;
        this reverses it so a `thrds slack pull --write` writes doc content the
        `push` codepath can consume again as source. Without this, `pull`
        would clobber every cross-ref with a permalink and a subsequent
        push would send the URL literally (bypassing ref resolution).

        Matches only permalinks in ``channel`` whose thread_ts is in our
        slug map — foreign links, links to other channels, and links to
        threads not tracked by this doc pass through unchanged.
        """
        if not thread_ts_by_slug:
            return content
        ts_to_slug = {ts: slug for slug, ts in thread_ts_by_slug.items()}
        # `(permalink)` where the URL matches our workspace + channel and
        # carries a `thread_ts=<ts>` we recognize.
        cid = re.escape(channel)
        # The `p<ts_no_dot>` fragment isn't reliable (Slack sometimes omits it
        # in shorter permalinks), but `thread_ts=<ts>` is always present on
        # thread-parent permalinks.
        pattern = re.compile(rf'\((https?://[^)]*/archives/{cid}/[^)]*thread_ts=([\d.]+)[^)]*)\)')

        def repl(m: re.Match) -> str:
            ts = m.group(2)
            slug = ts_to_slug.get(ts)
            return f'(#{slug})' if slug else m.group(0)

        return pattern.sub(repl, content)

    def _pull_doc(
        self,
        channel: str,
        preamble_ts: str | None,
        thread_ts_by_slug: dict[str, str],
        only: set[str] | None = None,
    ) -> Doc:
        """Fetch a doc's content from ``channel`` given the state pointers.

        Threads are returned in OP-ts numerical order (= channel post-order),
        which is stable regardless of how ``thread_ts_by_slug`` is iterated.

        Applies ``_reverse_cross_refs`` on each message's content so pulled
        text uses ``#slug`` refs (symmetric with local doc format).

        ``only`` restricts which threads are *fetched* without narrowing
        ``thread_ts_by_slug``, which stays whole: it's the map cross-refs
        resolve against, so filtering it would leave a link to an unfetched
        sibling as a raw permalink and report that as a change.
        """
        prev_channel = self.channel
        self.channel = channel
        try:
            preamble = None
            if preamble_ts is not None:
                msgs = self._pull_thread_docmessages(preamble_ts)
                if msgs:
                    # Preamble has no replies; the OP is the only message.
                    preamble = self._reverse_cross_refs(
                        msgs[0].content, channel, thread_ts_by_slug,
                    )

            sorted_slugs = sorted(thread_ts_by_slug, key=lambda s: float(thread_ts_by_slug[s]))
            threads = []
            for slug in sorted_slugs:
                if only is not None and slug not in only:
                    continue
                msgs = self._pull_thread_docmessages(thread_ts_by_slug[slug])
                threads.append(DocThread(
                    slug=slug,
                    messages=[
                        DocMessage(
                            content=self._reverse_cross_refs(m.content, channel, thread_ts_by_slug),
                            author=m.author,
                        )
                        for m in msgs
                    ],
                ))
            return Doc(preamble=preamble, threads=threads)
        finally:
            self.channel = prev_channel

    def scan_thrds_metadata(
        self,
        channel: str,
        oldest: float | None = None,
        latest: float | None = None,
        cursor: str | None = None,
        max_pages: int | None = None,
        on_page: 'callable | None' = None,
    ) -> dict[str, RecoveredSession]:
        """Scan ``channel``'s history for messages carrying thrds metadata.

        Backs the ``thrds slack recover`` verb: every ``chat.postMessage`` /
        ``chat.update`` this client makes stamps ``event_type='thrds'`` +
        ``event_payload={session_id, doc_slug, thread_slug, kind}`` on the
        message (see ``_thrds_metadata``). This method reverses that: it
        walks ``conversations.history`` (with ``include_all_metadata``) and
        groups matching messages by ``session_id`` into `RecoveredSession`s
        that carry enough info to rebuild `SessionState.{staging,prod}_*`.

        Only top-level messages contribute to the returned map because
        ``conversations.history`` returns thread parents only. `kind='op'`
        messages populate ``thread_ts_by_slug`` (slug → OP ts) and
        ``kind='preamble'`` messages set ``preamble_ts``. `kind='reply'`
        messages live under an OP and would only surface via
        ``conversations.replies`` — but they don't influence the map,
        so we don't fetch them.

        Metadata is only visible to the app that posted the message
        (Slack API contract), so ``recover`` only works with the same
        token/app that authored the original posts. Cross-token recovery
        would need a workspace-admin API and is out of scope.

        Raises `ValueError` on metadata-shape inconsistency (two messages
        with the same session_id disagreeing on ``doc_slug``) — treat that
        as corruption, don't silently pick a side.

        Args:
            oldest: unix timestamp lower bound; forwarded to Slack as
                ``oldest=<ts>``. Cheapest way to bound the scan when the
                user knows a rough post date.
            latest: unix timestamp upper bound; forwarded as ``latest=<ts>``.
                Symmetric with ``oldest`` — the pair defines a scan window.
                Time-anchored resume after a `ScanCapReached`: re-run with
                ``latest`` set to the exception's ``oldest_ts_reached``.
            cursor: Slack pagination token to start from. Set on the
                exception when ``max_pages`` fires; pass it back verbatim
                for an exact resume (no re-scan of covered pages).
            max_pages: safety cap on pages fetched. If reached before
                ``has_more`` clears, raise `ScanCapReached` carrying the
                next cursor + min ts reached — the caller decides whether
                to widen the cap, narrow the window, or resume. Metadata is
                not indexable (no `has_metadata:` search operator), so this
                is the only backstop against runaway scans on busy channels.
            on_page: called with ``(page_num, msg_count)`` after each page
                fetch — for progress-log hooks. `page_num` is 1-based.
        """
        # session_id -> mutable working dict; assembled into RecoveredSession at the end
        partial: dict[str, dict] = {}
        page_cursor: str | None = cursor
        page_num = 0
        # Track the min ts we've observed across all messages (not just
        # thrds-tagged ones) so `ScanCapReached` can report where we stopped.
        min_ts_seen: str | None = None
        while True:
            page_num += 1
            if max_pages is not None and page_num > max_pages:
                # Report the cursor we WOULD have used next, so a resume
                # re-issues the same next request.
                raise ScanCapReached(
                    f'scan_thrds_metadata: hit --max-pages={max_pages} on channel '
                    f'{channel}; scanned ~{max_pages * 200} messages without exhausting history. '
                    f'Reached back to ts={min_ts_seen}. '
                    'Options: widen with `--max-pages N`, narrow with `--oldest-days N`, '
                    'or resume via `--cursor <token>` (see stderr for the token).',
                    next_cursor=page_cursor,
                    oldest_ts_reached=min_ts_seen,
                    pages_scanned=page_num - 1,
                )
            params: dict = {
                'channel': channel,
                'limit': 200,
                'include_all_metadata': True,
            }
            # Slack requires ts bounds as *strings* with >=7 decimal places
            # — a JSON float, or a string with fewer decimals, silently
            # returns the wrong result set (empirically: `latest` as float
            # → 0 msgs; `.6f` → 0 msgs; `.7f` → correct). No idea whether
            # this is documented or a length-based string-comparison
            # peculiarity of their server; `.9f` sits comfortably above
            # the cutoff and matches nanosecond precision.
            if oldest is not None:
                params['oldest'] = f'{oldest:.9f}'
            if latest is not None:
                params['latest'] = f'{latest:.9f}'
            if page_cursor:
                params['cursor'] = page_cursor
            result = self._request('conversations.history', params)
            msgs = result.get('messages', [])
            if on_page is not None:
                on_page(page_num, len(msgs))
            # Track the min ts across ALL messages (thrds-tagged or not) —
            # that's the "how far back did we get" datum for a resume prompt.
            for msg in msgs:
                ts = msg.get('ts')
                if ts and (min_ts_seen is None or float(ts) < float(min_ts_seen)):
                    min_ts_seen = ts
            for msg in msgs:
                md = msg.get('metadata') or {}
                if md.get('event_type') != THRDS_METADATA_EVENT_TYPE:
                    continue
                payload = md.get('event_payload') or {}
                session_id = payload.get('session_id')
                doc_slug = payload.get('doc_slug')
                kind = payload.get('kind')
                if not (session_id and doc_slug and kind):
                    # Malformed thrds metadata — skip rather than crash the whole scan.
                    continue
                ts = msg['ts']
                sess = partial.setdefault(session_id, {
                    'doc_slug': doc_slug,
                    'preamble_ts': None,
                    'threads': {},
                    'oldest_ts': ts,
                    'newest_ts': ts,
                })
                if sess['doc_slug'] != doc_slug:
                    raise ValueError(
                        f'Inconsistent doc_slug for session {session_id}: '
                        f'{sess["doc_slug"]!r} vs {doc_slug!r} (ts={ts}). '
                        'Metadata trail is corrupt.'
                    )
                # ts is a decimal string like "1784587706.222199"; compare numerically.
                if float(ts) < float(sess['oldest_ts']):
                    sess['oldest_ts'] = ts
                if float(ts) > float(sess['newest_ts']):
                    sess['newest_ts'] = ts
                if kind == 'preamble':
                    sess['preamble_ts'] = ts
                elif kind == 'op':
                    thread_slug = payload.get('thread_slug')
                    if thread_slug:
                        sess['threads'][thread_slug] = ts
                # kind=='reply' or anything else: no map contribution.
            if not result.get('has_more'):
                break
            page_cursor = (result.get('response_metadata') or {}).get('next_cursor')
            if not page_cursor:
                break
        return {
            sid: RecoveredSession(
                session_id=sid,
                doc_slug=d['doc_slug'],
                preamble_ts=d['preamble_ts'],
                # Sort by ts numerically so consumers see channel post-order.
                thread_ts_by_slug=dict(sorted(
                    d['threads'].items(), key=lambda kv: float(kv[1]),
                )),
                oldest_ts=d['oldest_ts'],
                newest_ts=d['newest_ts'],
            )
            for sid, d in partial.items()
        }

    def list_channels_by_name(self) -> dict[str, str]:
        """Return ``{name: id}`` for all channels this token can see.

        Paginates ``conversations.list`` across public + private + mpim
        (single-member private channels + multi-party DMs) types. Includes
        archived channels — recovering from an archived staging PC is a
        real use case. Result cached per-client instance because channel
        lists change slowly and one CLI invocation is one client's lifetime.

        Requires ``channels:read`` (public) and ``groups:read`` (private)
        scopes on the token. `groups:read` is granted implicitly with
        `groups:write` — but ``channels:read`` needs to be added
        explicitly if the token doesn't have it (Slack raises
        ``missing_scope`` otherwise).
        """
        if self._channels_by_name_cache is not None:
            return self._channels_by_name_cache
        result: dict[str, str] = {}
        cursor: str | None = None
        while True:
            params: dict = {
                # Slack silently ignores `types` when the request is a JSON
                # POST — must be GET/urlencoded (only public_channel comes
                # back otherwise). Empirically: JSON POST → 51 channels,
                # GET/urlencoded → 108. `_request` handles both; force GET.
                'types': 'public_channel,private_channel,mpim',
                'limit': 1000,
                # For form-encoding, booleans must be JSON-style strings.
                'exclude_archived': 'false',
            }
            if cursor:
                params['cursor'] = cursor
            r = self._request('conversations.list', params, method='GET')
            for c in r.get('channels', []):
                name = c.get('name')
                cid = c.get('id')
                if name and cid:
                    result[name] = cid
            cursor = (r.get('response_metadata') or {}).get('next_cursor')
            if not cursor:
                break
        self._channels_by_name_cache = result
        return result

    def fetch_workspace_emoji(self) -> dict[str, str]:
        """Fetch this workspace's custom emoji map (name → URL).

        Slack's ``emoji.list`` returns ``{name: value}`` where ``value`` is
        one of: a URL (custom PNG/GIF), ``alias:other-name``, or ``-1``
        (deleted). Follow aliases to their canonical URL; drop deleted and
        broken-alias entries. Names Slack allows: ``[a-z0-9_+-]``.
        """
        result = self._request('emoji.list', {}, method='GET')
        raw = result.get('emoji', {})
        resolved: dict[str, str] = {}
        for name, val in raw.items():
            target = val
            seen = {name}
            while isinstance(target, str) and target.startswith('alias:'):
                alias = target[len('alias:'):]
                if alias in seen:
                    target = None  # cycle; drop
                    break
                seen.add(alias)
                target = raw.get(alias)
            if isinstance(target, str) and target.startswith('http'):
                resolved[name] = target
        return resolved

    def _download_url(self, url: str, dest: Path) -> None:
        """Fetch ``url`` and write bytes to ``dest``. No auth needed for
        emoji.slack-edge.com URLs."""
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            dest.write_bytes(resp.read())

    def _resolve_custom_emoji(
        self,
        doc: Doc,
        state: SessionState,
        session_dir: Path,
        download: bool = True,
    ) -> Doc:
        """Substitute custom `:name:` refs → `![:name:](emoji-<name>.<ext>)`.

        For each unique custom shortcode found in the doc, ensure a local
        emoji file exists in ``session_dir`` — download from Slack if not
        cached. Missing names (not in workspace or fetch failed) pass
        through as literal ``:name:``. Mutates ``state.workspace_emoji``;
        caller saves.

        ``download=False`` computes the same substitution (the filename is
        deterministic given the workspace URL) but writes nothing to
        ``session_dir`` — for read-only observations (`fetch`, `diff`, the
        push/promote gates), which must render the same text `pull` would
        write while touching no files.

        `emoji.list` is fetched at most once per call, and only when an
        unknown shortcode is seen. State cache holds across sessions. If
        the token lacks the ``emoji:read`` scope, prints a one-time hint
        via ``self._emoji_scope_warned`` and no-ops.
        """
        all_names: set[str] = set()
        if doc.preamble:
            all_names |= find_custom_shortcodes(doc.preamble)
        for thread in doc.threads:
            for m in thread.messages:
                all_names |= find_custom_shortcodes(m.content)

        unknown = all_names - set(state.workspace_emoji)
        if unknown:
            workspace_urls: dict[str, str] = {}
            try:
                workspace_urls = self.fetch_workspace_emoji()
            except RuntimeError as e:
                # Missing scope is the common failure — surface it once with a
                # clear fix. Other errors also degrade to "leave shortcodes
                # literal" but we still warn.
                msg = str(e)
                if not getattr(self, '_emoji_scope_warned', False):
                    if 'missing_scope' in msg:
                        print(
                            f"warning: `emoji.list` denied ({msg.strip()}). "
                            f"Custom emoji ({sorted(unknown)}) will pass through as `:name:` text — "
                            f"add `emoji:read` to `THRDS_SLACK_TOKEN` to inline them as images.",
                            file=__import__('sys').stderr,
                        )
                    else:
                        print(f"warning: `emoji.list` failed: {msg}", file=__import__('sys').stderr)
                    self._emoji_scope_warned = True
            for name in unknown:
                url = workspace_urls.get(name)
                if not url:
                    continue  # not in workspace or fetch failed; leave literal
                # Ext from URL, stripped of any query string.
                ext = url.rsplit('.', 1)[-1].split('?', 1)[0].lower()
                if not ext or not ext.isalnum() or len(ext) > 5:
                    ext = 'png'  # sane fallback
                filename = f'emoji-{name}.{ext}'
                dest = session_dir / filename
                if download and not dest.exists():
                    try:
                        self._download_url(url, dest)
                    except Exception as e:
                        print(
                            f"warning: emoji download failed for :{name}: ({e})",
                            file=__import__('sys').stderr,
                        )
                        continue  # leave literal
                state.workspace_emoji[name] = filename

        # Substitute across all message content using state cache.
        def sub(text: str) -> str:
            return substitute_custom_emoji(text, state.workspace_emoji)

        return Doc(
            preamble=sub(doc.preamble) if doc.preamble else doc.preamble,
            threads=[
                DocThread(
                    slug=t.slug,
                    messages=[
                        DocMessage(content=sub(m.content), author=m.author, sender=m.sender)
                        for m in t.messages
                    ],
                )
                for t in doc.threads
            ],
        )

    def pull_thread_states(
        self,
        remote: Remote,
        state: SessionState,
        session_dir: Path | None = None,
        slugs: Iterable[str] | None = None,
        download_emoji: bool = True,
    ) -> list[DocThread]:
        """Fetch each thread's current state at one remote, in slug order.

        The remote-parameterized reader (`specs/remotes-model.md`): which
        threads to read, and from which channel, comes from each thread's
        pointer at ``remote.name`` — so a second staging-role remote reads its
        own pointers rather than being a declared fiction. What "read" means
        is the role's behavior:

        - **staging role**: observe the whole channel — every thread with a
          root there, foreign replies included. We own the channel, and a
          Slack-side edit (or deletion) must land as a version of that one
          thread's file.
        - **prod role**: read only threads whose *upstream* is this remote
          (a reopened thread is being revised in staging — its frozen prod
          copy is deliberately not pulled over the revision), and only *our
          own* messages there (``msg_ts``, falling back to the root ``ts``
          for entries predating the whitelist): the target is shared, and
          foreign replies are not ours to sync.

        ``slugs`` limits the fetch, for callers scoped to one thread.
        """
        only = None if slugs is None else set(slugs)
        if remote.role == STAGING:
            if remote.channel is None:
                raise ValueError(
                    f"No channel for remote {remote.name!r} — the session "
                    f"hasn't pushed a staging Doc yet."
                )
            roots = {
                slug: p.ts
                for slug, e in sorted(state.threads.items())
                if (p := e.remotes.get(remote.name)) is not None and p.ts is not None
            }
            doc = self._pull_doc(remote.channel, None, roots, only=only)
        else:
            out: list[DocThread] = []
            for slug, entry in sorted(state.threads.items()):
                if entry.upstream != remote.name:
                    continue
                if only is not None and slug not in only:
                    continue
                p = entry.remotes.get(remote.name)
                if p is None:
                    continue
                channel = p.channel or remote.channel
                own = set(p.msg_ts or ([p.ts] if p.ts else []))
                root = p.thread_ts or p.ts
                if not own or root is None or channel is None:
                    continue
                prev_channel, self.channel = self.channel, channel
                try:
                    msgs = [m for m in self.list_messages(root) if m.id in own]
                finally:
                    self.channel = prev_channel
                if not msgs:
                    continue
                out.append(DocThread(
                    slug=slug,
                    messages=[DocMessage(content=m.content) for m in msgs],
                ))
            doc = Doc(threads=out)
        if session_dir is not None:
            doc = self._resolve_custom_emoji(doc, state, session_dir, download=download_emoji)
        return doc.threads

    def _resolve_chrome_channel(self, chrome: Chrome) -> str | None:
        """The channel id a parsed chrome line names, resolving ``#name`` if needed."""
        if chrome.channel is not None:
            return chrome.channel
        if chrome.channel_name is None:
            return None
        by_name = {n.lower(): cid for n, cid in self.list_channels_by_name().items()}
        return by_name.get(chrome.channel_name.lower())

    def pull_chrome_edits(
        self,
        state: SessionState,
        filenames: dict[str, str] | None = None,
    ) -> dict[str, ChromeEdit]:
        """Read each staged OP's chrome line and apply what it declares.

        The affordance chrome exists for, and the reason it can't live in
        blocks: editing "→ #some-channel" in Slack is how you point a draft
        somewhere else, and pasting a message permalink after the arrow aims
        it *into* that thread.

        Retargets and renames are both applied — see :class:`ChromeEdit` for
        why renaming is safe. Terminal threads are skipped: a `posted` thread's
        target is a record of where it went, not an instruction.
        """
        chrome_cfg = remotes.resolve(state)[STAGING].chrome
        if state.staging_channel is None or chrome_cfg is None or not chrome_cfg.any_enabled:
            return {}
        prev_channel, self.channel = self.channel, state.staging_channel
        edits: dict[str, ChromeEdit] = {}
        try:
            for slug, entry in sorted(state.threads.items()):
                if entry.staging_ts is None or entry.is_terminal:
                    continue
                line = self._live_chrome_line(entry.staging_ts)
                chrome = parse_chrome(line) if line else None
                if chrome is None:
                    continue
                was, now = entry.target, None
                channel = (
                    self._resolve_chrome_channel(chrome)
                    if chrome_cfg.target_link else None
                )
                if channel is not None:
                    candidate = ThreadTarget(channel=channel, thread_ts=chrome.thread_ts)
                    if candidate != was:
                        entry.target = candidate
                        now = candidate
                renamed = None
                if chrome.filename is not None and filenames is not None:
                    on_disk = filenames.get(slug)
                    if on_disk is not None and chrome.filename != on_disk:
                        renamed = chrome.filename
                if now is not None or renamed is not None:
                    edits[slug] = ChromeEdit(
                        slug=slug, target_was=was, target_now=now, renamed_to=renamed,
                    )
        finally:
            self.channel = prev_channel
        return edits

    def adopt_new_staging_threads(
        self,
        state: SessionState,
        session_dir: Path,
    ) -> list[AdoptedThread]:
        """Adopt top-level messages written straight into the staging channel.

        Starting a thread shouldn't require leaving Slack: post a draft in the
        staging channel, give it a chrome line naming where it's going, and the
        next pull turns it into a thread with its own file and state entry.

        A message qualifies only if it's ours, top-level, not already a known
        thread, and carries a chrome line — that last condition is what
        separates "a new draft" from "a note to self in the scratchpad".

        Oldest first, so several new drafts get indices in the order they were
        written. ``state`` gains an entry for each; the caller writes the files.
        """
        if state.staging_channel is None:
            return []
        known = {e.staging_ts for e in state.threads.values() if e.staging_ts is not None}
        user_id, bot_id = self.bot_ids
        files = thread_files(session_dir)
        taken = {f.name for f in files}
        index = next_index(files)
        adopted: list[AdoptedThread] = []
        prev_channel, self.channel = self.channel, state.staging_channel
        try:
            history = self.list_channel_history(state.staging_channel, limit=200)
            for raw in sorted(history, key=lambda m: m.get("ts", "")):
                ts = raw.get("ts")
                if ts is None or ts in known or raw.get("subtype"):
                    continue
                ours = raw.get("user") == user_id or (
                    bot_id is not None and raw.get("bot_id") == bot_id
                )
                if not ours:
                    continue
                text = _decode_entities(raw.get("text", ""))
                body, chrome = split_chrome(text)
                if chrome is None:
                    continue
                name = self._name_for_adopted(chrome, body, index, taken)
                parsed = parse_thread_filename(name)
                assert parsed is not None  # _name_for_adopted only emits valid names
                slug = parsed[1]
                if slug in state.threads:
                    continue
                taken.add(name)
                index = max(index, parsed[0] + 1)
                channel = self._resolve_chrome_channel(chrome)
                state.threads[slug] = ThreadEntry(
                    staging_ts=ts,
                    target=(
                        ThreadTarget(channel=channel, thread_ts=chrome.thread_ts)
                        if channel is not None else None
                    ),
                )
                adopted.append(AdoptedThread(
                    slug=slug,
                    filename=name,
                    thread=DocThread(
                        messages=self._pull_thread_docmessages(ts), slug=slug,
                    ),
                ))
        finally:
            self.channel = prev_channel
        return adopted

    @staticmethod
    def _name_for_adopted(
        chrome: Chrome,
        body: str,
        index: int,
        taken: set[str],
    ) -> str:
        """The ``NN-slug.md`` name for a thread adopted out of the staging channel.

        An explicit filename in the chrome line wins — that's the author saying
        what to call it and where to sort it. Otherwise the slug comes from the
        message's first line and the index is the next free one, so adopting
        never renumbers an existing thread.
        """
        if chrome.filename is not None:
            parsed = parse_thread_filename(chrome.filename)
            if parsed is not None:
                return dedupe_thread_filename(parsed[0], parsed[1], taken)
            # `cuda-graph.md` — a name without a number. The author cared what
            # it's called, not where it sorts, so take the next free index.
            stem = chrome.filename[:-3] if chrome.filename.endswith('.md') else ''
            if SLUG_RE.fullmatch(stem):
                return dedupe_thread_filename(index, stem, taken)
        return dedupe_thread_filename(index, slugify(body) or 'untitled', taken)

    def pull_doc_staging(
        self,
        state: SessionState,
        session_dir: Path | None = None,
    ) -> Doc:
        """Fetch the current state of the session's staging PC as a `Doc`.

        Uses the state's slug → ts pointers as the roots and ``conversations.replies``
        for each; foreign messages (colleague replies) come back with their
        ``author`` populated from ``users.info``. If ``session_dir`` is
        given, custom Slack emoji are downloaded there and referenced
        inline in the returned Doc (see ``_resolve_custom_emoji``).
        """
        if state.staging_channel is None:
            raise ValueError(
                "No staging channel — the session hasn't pushed a staging Doc yet."
            )
        doc = self._pull_doc(
            state.staging_channel,
            state.staging_preamble_ts,
            state.staging_threads,
        )
        if session_dir is not None:
            doc = self._resolve_custom_emoji(doc, state, session_dir)
        return doc

    def pull_doc_prod(
        self,
        state: SessionState,
        channel: str | None = None,
        session_dir: Path | None = None,
    ) -> Doc:
        """Fetch the current state of the doc on a real prod channel.

        ``channel`` overrides ``state.prod_channel`` if given; falls back to
        the pinned prod channel otherwise. Raises if neither is set. If
        ``session_dir`` is given, custom Slack emoji are downloaded there
        and referenced inline.
        """
        target = channel if channel is not None else state.prod_channel
        if target is None:
            raise ValueError(
                "No prod channel — pass channel= or set state.prod_channel first."
            )
        doc = self._pull_doc(
            target,
            state.prod_preamble_ts.get(target),
            state.prod_threads.get(target, {}),
        )
        if session_dir is not None:
            doc = self._resolve_custom_emoji(doc, state, session_dir)
        return doc
