from __future__ import annotations

import html
import json
import re
import time
import urllib.request
from collections.abc import Sequence
from urllib.error import HTTPError
from urllib.parse import urlencode

from .core import Image, Message, SyncOptions, SyncResult, Thread, sync

# Mastodon's default post limit is 500 characters, but instances can raise it
# (`GET /api/v1/instance` → `configuration.statuses.max_characters`). We take it
# as a constructor default rather than hard-coding, but 500 is the safe baseline.
POST_LIMIT = 500

# A minimal User-Agent. Some instances sit behind Cloudflare, which 403s the
# default `Python-urllib/x.y` agent (same gotcha we hit with Discord — see
# `specs/done/discord-app-emoji.md`), so every request carries one.
_USER_AGENT = "thrds (+https://github.com/runsascoded/thrds)"

# Strip HTML back to plain text for *foreign* statuses only (ours come from the
# authoritative `/source` endpoint). Block tags → newlines, then drop the rest.
_BLOCK_CLOSE_RE = re.compile(r"</(?:p|div)>", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(content: str) -> str:
    """Approximate the plain-text source of a rendered Mastodon status.

    Used only for statuses we did not author (which sync never edits, so an
    exact round-trip isn't needed). `</p>` / `</div>` become a blank line,
    `<br>` a single newline, remaining tags are dropped, entities unescaped.
    """
    text = _BLOCK_CLOSE_RE.sub("\n\n", content)
    text = _BR_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    return html.unescape(text).strip()


class MastodonClient:
    """Mastodon (ActivityPub) `ThreadClient` over the stdlib (no extra deps).

    Unlike `BskyClient`, Mastodon has a first-class edit API
    (`PUT /api/v1/statuses/:id`, since v3.5), so `edit()` really edits — no
    delete+repost fallback, and edits preserve the status id, its boosts,
    favourites, and replies. That editability is the whole reason thrds grows
    a Mastodon target (see `specs/mastodon-platform.md`).

    Threading is flat: every reply addresses the OP (`in_reply_to_id = OP`),
    matching `BskyClient`'s flat-thread choice. Mastodon renders the OP plus
    its direct replies as one thread. (A self-reply *chain* — each post
    replying to the previous — is a possible future refinement; it needs sync
    to thread the previous-posted id rather than a fixed root.)
    """

    def __init__(
        self,
        instance_url: str,
        access_token: str,
        *,
        visibility: str = "public",
        post_limit: int = POST_LIMIT,
    ):
        """Configure against one instance + account.

        ``instance_url`` is the account's home instance (e.g.
        ``https://mastodon.social``); ``access_token`` is a token with
        ``read:statuses write:statuses`` (Preferences → Development → New
        application, or the OAuth flow). ``visibility`` is the default post
        visibility (``public`` for syndication; also ``unlisted`` / ``private``
        / ``direct``).
        """
        self.base = instance_url.rstrip("/")
        if not self.base.startswith(("http://", "https://")):
            self.base = f"https://{self.base}"
        self.token = access_token
        self.visibility = visibility
        self.post_limit = post_limit
        self._account_id: str | None = None

    # --- HTTP ------------------------------------------------------------

    def _request(
        self,
        endpoint: str,
        data: dict | None = None,
        method: str = "GET",
    ) -> dict | list:
        """One Mastodon REST call. Returns the parsed JSON body.

        GET encodes ``data`` as a query string; other verbs send it as a form
        body (Mastodon accepts ``application/x-www-form-urlencoded``, which
        sidesteps JSON array-bracket quirks for ``media_ids[]`` etc.). Retries
        once on HTTP 429, honoring ``Retry-After``.
        """
        url = f"{self.base}/api/{endpoint.lstrip('/')}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": _USER_AGENT,
        }
        if method == "GET":
            if data:
                url = f"{url}?{urlencode(data)}"
            body = None
        else:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urlencode(data or {}).encode()
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        max_retries = 2
        for attempt in range(max_retries + 1):
            try:
                with urllib.request.urlopen(req) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except HTTPError as e:
                if e.code == 429 and attempt < max_retries:
                    time.sleep(int(e.headers.get("Retry-After", 1)))
                    continue
                raise RuntimeError(
                    f"Mastodon API error: {e.code} {e.read().decode(errors='replace')}"
                ) from e
        raise RuntimeError("unreachable")  # loop either returns or raises

    @property
    def account_id(self) -> str:
        """This token's account id (cached), used to tell our posts from others'."""
        if self._account_id is None:
            me = self._request("v1/accounts/verify_credentials")
            assert isinstance(me, dict)
            self._account_id = me["id"]
        return self._account_id

    # --- ThreadClient ----------------------------------------------------

    def list_messages(self, thread_id: str) -> list[Message]:
        """Return the OP + its thread, chronological. ``thread_id`` = OP status id.

        The OP and our own replies carry ``content`` from the authoritative
        ``/source`` endpoint (exact author text, so sync's positional diff is
        reliable); foreign statuses are HTML-stripped and marked
        ``editable=False`` so sync preserves them in place.
        """
        op = self._request(f"v1/statuses/{thread_id}")
        assert isinstance(op, dict)
        ctx = self._request(f"v1/statuses/{thread_id}/context")
        assert isinstance(ctx, dict)
        descendants = ctx.get("descendants", [])

        out: list[Message] = [self._to_message(op)]
        for status in sorted(descendants, key=lambda s: s["created_at"]):
            out.append(self._to_message(status))
        return out

    def _to_message(self, status: dict) -> Message:
        """Convert a raw status dict to a `Message`, ours-vs-foreign aware."""
        ours = status["account"]["id"] == self.account_id
        if ours:
            src = self._request(f"v1/statuses/{status['id']}/source")
            assert isinstance(src, dict)
            content = src["text"]
        else:
            content = _html_to_text(status["content"])
        return Message(id=status["id"], content=content, editable=ours)

    def post(
        self,
        content: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        images: Sequence[Image] = (),
    ) -> Message:
        """Post a status; if ``thread_id`` is set, reply to it (flat threading).

        Sender-override fields exist for `ThreadClient` parity but Mastodon has
        no per-message sender — a non-None value **raises** rather than being
        silently dropped (same contract as `BskyClient`).
        """
        if username is not None or icon_url is not None or icon_emoji is not None:
            raise NotImplementedError(
                "Mastodon has no per-message sender concept "
                "(username/icon_url/icon_emoji cannot be honored)."
            )
        if images:
            raise NotImplementedError(
                "Mastodon image attachments aren't wired in this client yet "
                "(`images=` is unsupported); see specs/mastodon-platform.md."
            )
        if len(content) > self.post_limit:
            raise ValueError(
                f"Post exceeds Mastodon's {self.post_limit} char limit ({len(content)} chars)"
            )
        data: dict = {"status": content, "visibility": self.visibility}
        if thread_id is not None:
            data["in_reply_to_id"] = thread_id
        resp = self._request("v1/statuses", data, method="POST")
        assert isinstance(resp, dict)
        return Message(id=resp["id"], content=content, editable=True)

    def edit(self, message_id: str, content: str, *, images: Sequence[Image] = ()) -> Message:
        """Edit a status in place via ``PUT /api/v1/statuses/:id`` (real edit).

        No `EditRateLimited` fallback: Mastodon edits keep the status id and its
        engagement, which is precisely the property Bluesky lacks.
        """
        if images:
            raise NotImplementedError(
                "Mastodon image attachments aren't wired in this client yet "
                "(`images=` is unsupported); see specs/mastodon-platform.md."
            )
        if len(content) > self.post_limit:
            raise ValueError(
                f"Edit exceeds Mastodon's {self.post_limit} char limit ({len(content)} chars)"
            )
        resp = self._request(f"v1/statuses/{message_id}", {"status": content}, method="PUT")
        assert isinstance(resp, dict)
        return Message(id=resp["id"], content=content, editable=True)

    def delete(self, message_id: str) -> None:
        """Delete a status by id."""
        self._request(f"v1/statuses/{message_id}", method="DELETE")

    def sync(
        self,
        thread: Thread,
        thread_id: str | None = None,
        dry_run: bool = False,
        pace: float = 0.5,
        jitter: float = 0.0,
    ) -> SyncResult:
        """Sync a thread to the desired state.

        Default pace 0.5s between ops (Mastodon instances rate-limit writes;
        the default is 300 requests / 5 min, but per-instance and lower for
        some, so we stay gentle — same posture as `BskyClient`).
        """
        return sync(
            client=self,
            desired=thread,
            thread_id=thread_id,
            options=SyncOptions(
                dry_run=dry_run,
                pace=pace,
                jitter=jitter,
            ),
        )
