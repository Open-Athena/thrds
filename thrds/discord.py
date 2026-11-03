from __future__ import annotations

import base64
import json
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Sequence
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from .core import EditRateLimited, Image, Message, SyncOptions, SyncResult, Thread, sync
from .linked import (
    LinkedSyncResult,
    LinkedThread,
    build_detail_messages,
    build_summary_partition,
    render_summary_from_partition,
)

DISCORD_API = "https://discord.com/api/v10"
MESSAGE_LIMIT = 2000
MAX_FILES = 10
MAX_FILE_BYTES = 8 * 1024 * 1024  # Discord's default (non-boosted) per-file upload cap

# A ready-made `allowed_mentions` that suppresses every ping — the safe default
# for a bot-authored report whose text interpolates paths / names that may read
# as `@here` / `@everyone` / `@role`. Pass to a client's `allowed_mentions=`.
NO_MENTIONS = {"parse": []}


@contextmanager
def _image_paths(images: Sequence[Image]):
    """Resolve unified `Image`s to local file paths for a multipart upload.

    A ``path`` image is used in place; a ``url`` image is fetched (`GET`) into a
    temp dir, named after the URL's basename so Discord shows a meaningful
    filename. Yields the ordered list of paths and cleans up any fetched temps
    afterward — so the caller's `_curl_raw` (which may retry) sees stable files
    for the whole request. `path` wins when an `Image` carries both (no fetch)."""
    tmpdir: str | None = None
    paths: list[Path] = []
    try:
        for im in images:
            if im.path is not None:
                paths.append(Path(im.path))
                continue
            if tmpdir is None:
                tmpdir = tempfile.mkdtemp(prefix="thrds-img-")
            name = os.path.basename(urlsplit(im.url).path) or "image"
            dest = Path(tmpdir) / name
            with urlopen(im.url) as resp:
                dest.write_bytes(resp.read())
            paths.append(dest)
        yield paths
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)


def _files_form(body: dict, files: Sequence[Path | str]) -> list[tuple[str, str]]:
    """Multipart form parts for a message with attachments.

    Adds `attachments: [{"id", "filename"}]` to ``body`` (in order, so Discord
    keeps the filenames and ordering), then returns the `-F` parts: one
    `payload_json` carrying the JSON body, plus one `files[i]=@<path>` per file.
    Enforces Discord's count/size limits with a clear `ValueError` (past the
    server's own limit it would otherwise surface a terse `40005`)."""
    paths = [Path(f) for f in files]
    if len(paths) > MAX_FILES:
        raise ValueError(f"Discord allows at most {MAX_FILES} files per message; got {len(paths)}")
    for p in paths:
        size = p.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ValueError(
                f"{p.name} is {size} bytes; exceeds Discord's default {MAX_FILE_BYTES}-byte "
                f"(8 MiB) per-file upload limit"
            )
    body["attachments"] = [{"id": i, "filename": p.name} for i, p in enumerate(paths)]
    return [("payload_json", json.dumps(body))] + [
        (f"files[{i}]", f"@{p}") for i, p in enumerate(paths)
    ]


class _DiscordHTTP:
    """Shared curl-based HTTP core for the two Discord transports.

    `DiscordClient` (bot token) and `DiscordWebhookClient` (webhook execution)
    are two identity models over one transport — same retry/backoff, 429 +
    `EditRateLimited` handling, and status parsing. Subclasses build the URL and
    auth headers; this holds the request loop.

    Error strings carry a caller-supplied ``label`` rather than the raw URL, so
    a webhook client (whose URL embeds a secret token) never leaks it.
    """

    _MAX_ATTEMPTS = 4
    _BACKOFF_BASE = 1.0
    _BACKOFF_CAP = 15.0
    _BODY_SNIPPET = 500

    def _backoff(self, attempt: int) -> float:
        return min(self._BACKOFF_BASE * (2 ** attempt) + random.uniform(0, 1.0), self._BACKOFF_CAP)

    def _curl_raw(
        self,
        method: str,
        url: str,
        data: dict | None = None,
        *,
        form: list[tuple[str, str]] | None = None,
        headers: dict[str, str] | None = None,
        label: str | None = None,
    ) -> dict | list | None:
        if data is not None and form is not None:
            raise ValueError("_curl_raw: pass `data` (JSON) or `form` (multipart), not both")
        label = label or f"{method} {url}"
        last_err = ""
        for attempt in range(self._MAX_ATTEMPTS):
            cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method]
            for key, value in (headers or {}).items():
                cmd += ["-H", f"{key}: {value}"]
            if data is not None:
                cmd += ["-d", json.dumps(data)]
            elif form is not None:
                # Each part `-F name=value`; curl sets the multipart boundary +
                # Content-Type (so the caller omits its JSON content-type header).
                for name, value in form:
                    cmd += ["-F", f"{name}={value}"]
            cmd.append(url)
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)

            if result.returncode != 0:
                last_err = f"curl exit {result.returncode}: {result.stderr.strip()[:self._BODY_SNIPPET]}"
                if attempt + 1 < self._MAX_ATTEMPTS:
                    time.sleep(self._backoff(attempt))
                    continue
                raise RuntimeError(f"Discord {label}: {last_err}")

            body, _, status_str = result.stdout.rpartition("\n")
            try:
                status = int(status_str.strip())
            except ValueError:
                last_err = f"unparseable status line from curl: {result.stdout[:self._BODY_SNIPPET]!r}"
                if attempt + 1 < self._MAX_ATTEMPTS:
                    time.sleep(self._backoff(attempt))
                    continue
                raise RuntimeError(f"Discord {label}: {last_err}")

            body = body.strip()

            if status == 204:
                return None

            if 500 <= status < 600:
                last_err = f"HTTP {status}: {body[:self._BODY_SNIPPET]}"
                if attempt + 1 < self._MAX_ATTEMPTS:
                    time.sleep(self._backoff(attempt))
                    continue
                raise RuntimeError(f"Discord {label}: {last_err}")

            try:
                resp = json.loads(body) if body else None
            except json.JSONDecodeError:
                last_err = f"HTTP {status}, non-JSON body: {body[:self._BODY_SNIPPET]}"
                if attempt + 1 < self._MAX_ATTEMPTS:
                    time.sleep(self._backoff(attempt))
                    continue
                raise RuntimeError(f"Discord {label}: {last_err}")

            # Structured Discord error dict — handle before generic 4xx so
            # `EditRateLimited` (code 30046, HTTP 429) is preserved and other
            # 4xx errors surface Discord's message.
            if isinstance(resp, dict) and "code" in resp and "message" in resp:
                if resp["code"] == 30046:
                    raise EditRateLimited(resp["message"])
                if status == 429:
                    retry_after = resp.get("retry_after")
                    delay = float(retry_after) if isinstance(retry_after, (int, float)) else self._backoff(attempt)
                    last_err = f"HTTP 429: {body[:self._BODY_SNIPPET]}"
                    if attempt + 1 < self._MAX_ATTEMPTS:
                        time.sleep(min(delay, self._BACKOFF_CAP))
                        continue
                    raise RuntimeError(f"Discord {label}: rate-limited after {attempt+1} attempts: {last_err}")
                raise RuntimeError(f"Discord API error: {resp['message']} (code {resp['code']})")

            if status == 429:
                last_err = f"HTTP 429: {body[:self._BODY_SNIPPET]}"
                if attempt + 1 < self._MAX_ATTEMPTS:
                    time.sleep(self._backoff(attempt))
                    continue
                raise RuntimeError(f"Discord {label}: rate-limited after {attempt+1} attempts: {last_err}")

            if 200 <= status < 300 and resp is None:
                last_err = f"HTTP {status}, empty body (expected entity)"
                if attempt + 1 < self._MAX_ATTEMPTS:
                    time.sleep(self._backoff(attempt))
                    continue
                raise RuntimeError(f"Discord {label}: {last_err}")

            if 400 <= status < 500:
                raise RuntimeError(f"Discord {label}: HTTP {status}: {body[:self._BODY_SNIPPET]}")

            return resp

        raise RuntimeError(f"Discord {label}: retries exhausted: {last_err}")


class DiscordClient(_DiscordHTTP):
    def __init__(
        self,
        token: str,
        channel_id: str,
        guild_id: str | None = None,
        *,
        allowed_mentions: dict | None = None,
    ):
        self.token = token if token.startswith("Bot ") else f"Bot {token}"
        self.channel_id = channel_id
        self.guild_id = guild_id
        self.allowed_mentions = allowed_mentions
        self._active_thread_id: str | None = None
        self._suppress_embeds: bool = False
        self._bot_user_id: str | None = None
        self._application_id: str | None = None

    @property
    def bot_user_id(self) -> str:
        """This bot's own user id (`GET /users/@me`), lazily resolved and cached.

        Used to tell our messages (editable) apart from foreign ones (humans,
        other apps) when listing a thread — the Discord counterpart to
        `SlackClient.bot_ids`. Resolved once per client and memoized.
        """
        if self._bot_user_id is None:
            me = self._curl("GET", "/users/@me")
            self._bot_user_id = str(me["id"])
        return self._bot_user_id

    @property
    def application_id(self) -> str:
        """This bot's application id (`GET /applications/@me`), lazy + cached.

        Distinct from `bot_user_id` — it addresses the *app* (which owns
        application emoji and app-created webhooks), not the bot user.
        """
        if self._application_id is None:
            app = self._curl("GET", "/applications/@me")
            self._application_id = str(app["id"])
        return self._application_id

    def _authored_by_us(self, raw: dict) -> bool:
        """Whether a raw message dict is ours to edit/delete (vs. preserved).

        Ours = posted by this bot. Foreign — a human, another app/bot, or a
        webhook post (a webhook message can't be edited via the bot token) —
        returns False, so `core.sync` preserves it in place rather than
        reconciling it, exactly as `SlackClient` does with `editable=False`.
        `DiscordHybridClient` widens "ours" to include its own webhook's
        replies (which it routes to the webhook transport)."""
        if raw.get("webhook_id") is not None:
            return False
        author = raw.get("author") or {}
        return str(author.get("id")) == self.bot_user_id

    def _curl(
        self,
        method: str,
        path: str,
        data: dict | None = None,
    ) -> dict | list | None:
        return self._curl_raw(
            method,
            f"{DISCORD_API}{path}",
            data,
            headers={"Authorization": self.token, "Content-Type": "application/json"},
            label=f"{method} {path}",
        )

    @property
    def _channel(self) -> str:
        return self._active_thread_id or self.channel_id

    def _channel_for(self, message_id: str) -> str:
        """Channel id to address ``message_id`` for edit/delete.

        A thrds thread's OP lives in the **parent** channel but shares the
        thread's id (``create_thread`` returns a channel whose id equals the
        starter message's id). So during a thread reconcile — ``_active_thread_id``
        set to the thread — the one message whose id equals that thread id is
        the OP, and must be addressed via the parent channel:
        ``PATCH /channels/{thread}/messages/{op}`` is a ``10008 Unknown Message``.
        Every other message is a real thread reply, addressed via the thread.
        """
        if self._active_thread_id is not None and message_id == self._active_thread_id:
            return self.channel_id
        return self._channel

    def _list_raw(self, thread_id: str) -> list[dict]:
        """Chronological type-0 message dicts for a thread, OP prepended.

        Discord returns messages newest-first (reversed here). A thread created
        off a message shares that message's id, and the OP itself lives in the
        PARENT channel — `GET /channels/{thread}/messages` returns only the
        replies (plus an empty type-21 starter placeholder, dropped by the
        type-0 filter), never the OP. Prepend it so `sync`'s positional diff
        aligns (existing[0] is the OP); its id is the thread id. Listing the
        base channel itself (thread_id == channel_id, e.g. a lone-OP reconcile
        scoped by `only_ids`) has no such separate OP, so the prepend only fires
        for an actual child thread.

        Returns raw dicts (not `Message`s) so a caller can read fields the
        positional diff doesn't need — e.g. `webhook_id`, which
        `DiscordHybridClient` uses to route an edit/delete to the transport that
        authored the message.
        """
        resp = self._curl("GET", f"/channels/{thread_id}/messages?limit=100")
        messages = [m for m in reversed(resp or []) if m.get("type", 0) == 0]
        if thread_id != self.channel_id:
            op = self._curl("GET", f"/channels/{self.channel_id}/messages/{thread_id}")
            if isinstance(op, dict) and op.get("type", 0) == 0:
                messages.insert(0, op)
        return messages

    def list_messages(self, thread_id: str) -> list[Message]:
        return [
            Message(id=m["id"], content=m.get("content", ""), editable=self._authored_by_us(m))
            for m in self._list_raw(thread_id)
        ]

    def post(
        self,
        content: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        images: Sequence[Image] = (),
        broadcast: bool = False,
    ) -> Message:
        """Post a message as the bot.

        The per-message sender kwargs (``username``/``icon_url``/``icon_emoji``)
        exist for `ThreadClient` protocol parity, but Discord's **bot** API
        cannot set a per-message sender — so any non-None value **raises**
        rather than being silently dropped. Per-message identity on Discord
        requires the webhook transport (a webhook-backed client; see
        ``specs/discord-push.md``); route such threads there.

        ``images`` likewise route through the webhook transport — this bot
        `post` doesn't build the multipart attachment upload — so non-empty
        ``images`` **raises**. The `DiscordHybridClient` sends any attachment-
        bearing message via its webhook.

        ``broadcast`` is Slack's `reply_broadcast`; Discord has no analogue, so
        ``broadcast=True`` **raises**.
        """
        if broadcast:
            raise NotImplementedError(
                "Discord has no `reply_broadcast` analogue (`broadcast=` is "
                "Slack-specific)."
            )
        if username is not None or icon_url is not None or icon_emoji is not None:
            raise NotImplementedError(
                "Discord's bot API cannot set a per-message sender "
                "(username/icon_url/icon_emoji); post via a webhook-backed "
                "client for per-message identity. See specs/discord-push.md."
            )
        if images:
            raise NotImplementedError(
                "This bot `post` doesn't upload attachments; send `images=` via the "
                "webhook transport (`DiscordWebhookClient` / `DiscordHybridClient`)."
            )
        if len(content) > MESSAGE_LIMIT:
            raise ValueError(f"Message exceeds Discord's {MESSAGE_LIMIT} char limit ({len(content)} chars)")
        channel = thread_id or self._channel
        data: dict = {"content": content}
        if self._suppress_embeds:
            data["flags"] = 4
        if self.allowed_mentions is not None:
            data["allowed_mentions"] = self.allowed_mentions
        resp = self._curl("POST", f"/channels/{channel}/messages", data)
        return Message(id=resp["id"], content=content)

    def create_thread(self, message_id: str, name: str) -> str:
        """Create a thread from a message, return the thread channel ID."""
        resp = self._curl("POST", f"/channels/{self.channel_id}/messages/{message_id}/threads", {
            "name": name,
        })
        return resp["id"]

    def open_thread(self, op_id: str, name: str | None) -> str:
        """Open a child thread off message ``op_id``; return its channel id.

        The `_reply_target` seam in `core.sync` calls this so a fresh push posts
        the OP to the channel and its replies into a real Discord thread — a
        message id is not a channel, so replies can't address the OP directly
        the way Slack's ``thread_ts`` does. Discord requires a thread name
        (1–100 chars); the caller must supply one.
        """
        if not name:
            raise ValueError(
                "Discord requires a thread name to open a thread; pass "
                "`thread_name` (e.g. `--thread-name`, or `SyncOptions.thread_name`)."
            )
        return self.create_thread(op_id, name)

    def create_webhook(self, name: str, *, avatar: str | None = None) -> str:
        """Ensure an **app-owned** webhook named ``name`` on this channel; return
        its URL. Reuses an existing one by name (`GET /channels/{id}/webhooks`),
        else creates it (`POST`, needs `MANAGE_WEBHOOKS`).

        The point of app-ownership: only the bot or a webhook whose
        ``application_id`` is this app's can post **application emoji**
        (`<:name:id>`); a user-created webhook silently strips them to bare
        `:name:` (see `specs/discord-app-emoji.md`). So bootstrapping the hybrid
        pair through here — rather than a hand-pasted "Integrations → Webhooks"
        URL — guarantees the emoji actually render. ``avatar`` is a data URI
        (`data:image/png;base64,…`) if given.
        """
        existing = self._curl("GET", f"/channels/{self.channel_id}/webhooks") or []
        for wh in existing:
            if wh.get("name") == name and str(wh.get("application_id") or "") == self.application_id:
                return f"https://discord.com/api/webhooks/{wh['id']}/{wh['token']}"
        body: dict = {"name": name}
        if avatar is not None:
            body["avatar"] = avatar
        wh = self._curl("POST", f"/channels/{self.channel_id}/webhooks", body)
        return f"https://discord.com/api/webhooks/{wh['id']}/{wh['token']}"

    def app_emojis(self) -> dict[str, str]:
        """This app's application emoji as ``{name: id}`` (`GET
        /applications/{app}/emojis`). Use the ids to build `<:name:id>` refs the
        bot or an app-owned webhook can post. Names are `[A-Za-z0-9_]{2,32}`."""
        resp = self._curl("GET", f"/applications/{self.application_id}/emojis")
        items = resp.get("items", resp) if isinstance(resp, dict) else resp
        return {e["name"]: str(e["id"]) for e in (items or [])}

    def upload_app_emoji(self, name: str, png: Path | str) -> str:
        """Upload ``png`` as application emoji ``name``; return its id (`POST
        /applications/{app}/emojis`). ``name`` must match `[A-Za-z0-9_]{2,32}`
        (no ``-`` — map e.g. Slack's ``arrow_deg-30`` to ``arrow_degm30``)."""
        if not re.fullmatch(r"[A-Za-z0-9_]{2,32}", name):
            raise ValueError(
                f"Discord emoji name must be [A-Za-z0-9_]{{2,32}} (no '-'); got {name!r}"
            )
        data = Path(png).read_bytes()
        image = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        resp = self._curl("POST", f"/applications/{self.application_id}/emojis", {
            "name": name, "image": image,
        })
        return str(resp["id"])

    def edit(self, message_id: str, content: str, *, images: Sequence[Image] = ()) -> Message:
        if len(content) > MESSAGE_LIMIT:
            raise ValueError(f"Message exceeds Discord's {MESSAGE_LIMIT} char limit ({len(content)} chars)")
        if images:
            raise NotImplementedError(
                "This bot `edit` doesn't upload attachments; edit `images=` via the "
                "webhook transport (`DiscordWebhookClient` / `DiscordHybridClient`)."
            )
        data: dict = {"content": content}
        if self._suppress_embeds:
            data["flags"] = 4
        self._curl("PATCH", f"/channels/{self._channel_for(message_id)}/messages/{message_id}", data)
        return Message(id=message_id, content=content)

    def delete(self, message_id: str) -> None:
        self._curl("DELETE", f"/channels/{self._channel_for(message_id)}/messages/{message_id}")

    def sync(
        self,
        thread: Thread,
        thread_id: str | None = None,
        dry_run: bool = False,
        pace: float = 0.0,
        jitter: float = 0.0,
        suppress_embeds: bool = False,
        thread_name: str | None = None,
        only_ids: set[str] | None = None,
    ) -> SyncResult:
        self._active_thread_id = thread_id
        self._suppress_embeds = suppress_embeds
        try:
            return sync(
                client=self,
                desired=thread,
                thread_id=thread_id,
                options=SyncOptions(
                    dry_run=dry_run,
                    pace=pace,
                    jitter=jitter,
                    suppress_embeds=suppress_embeds,
                    thread_name=thread_name,
                    only_ids=only_ids,
                ),
            )
        finally:
            self._active_thread_id = None
            self._suppress_embeds = False

    def _detail_url(self, message_id: str, thread_id: str) -> str:
        """Build a Discord message URL."""
        return f"https://discord.com/channels/{self.guild_id}/{thread_id}/{message_id}"

    def _detail_url_placeholder(self) -> str:
        """Placeholder URL with max possible length for space reservation."""
        # Discord snowflake IDs are up to 20 digits
        fake_id = "0" * 20
        return f"https://discord.com/channels/{self.guild_id}/{fake_id}/{fake_id}"

    def sync_linked(
        self,
        linked: LinkedThread,
        thread_id: str | None = None,
        dry_run: bool = False,
        pace: float = 0.0,
        jitter: float = 0.0,
        suppress_embeds: bool = False,
    ) -> LinkedSyncResult:
        """Sync a linked summary thread."""
        if not self.guild_id:
            raise ValueError("`guild_id` required for `sync_linked` (needed for message links)")

        placeholder = self._detail_url_placeholder()

        # Phase 1: Build detail + summary messages with placeholder links
        detail_msgs, section_starts = build_detail_messages(linked.sections, MESSAGE_LIMIT)
        placeholder_urls = [placeholder] * len(linked.sections)
        summary_msgs, partition = build_summary_partition(linked, placeholder_urls, MESSAGE_LIMIT)

        n_summary = len(summary_msgs)
        all_msgs = summary_msgs + detail_msgs

        # Phase 2: Sync all messages
        result = self.sync(
            Thread(messages=all_msgs),
            thread_id=thread_id,
            dry_run=dry_run,
            pace=pace,
            jitter=jitter,
            suppress_embeds=suppress_embeds,
        )

        if dry_run:
            return LinkedSyncResult(
                thread_id=result.thread_id,
                summary_ids=result.message_ids[:n_summary],
                detail_ids=result.message_ids[n_summary:],
                section_detail_ids={},
            )

        tid = result.thread_id
        detail_ids = result.message_ids[n_summary:]
        summary_ids = result.message_ids[:n_summary]

        # Phase 3: Build section → detail ID map and real links
        section_detail_map: dict[str, str] = {}
        real_links: list[str] = []
        for i, section in enumerate(linked.sections):
            detail_idx = section_starts[i]
            detail_msg_id = detail_ids[detail_idx]
            section_detail_map[section.title] = detail_msg_id
            real_links.append(self._detail_url(detail_msg_id, tid))

        # Phase 4: Rebuild summaries with real links and edit
        # Set _active_thread_id so edits target the thread, not the parent channel
        self._active_thread_id = tid
        self._suppress_embeds = suppress_embeds
        try:
            # Rebuild each phase-1 message with real URLs, preserving the
            # partition (see `SlackClient.sync_linked` for rationale).
            final_summaries = render_summary_from_partition(linked, real_links, partition)
            if len(final_summaries) != len(summary_ids):
                raise RuntimeError(
                    f"sync_linked phase-4 render yielded {len(final_summaries)} summary messages, "
                    f"phase-1 posted {len(summary_ids)}; partition invariant violated."
                )
            for j, msg in enumerate(final_summaries):
                if len(msg) > MESSAGE_LIMIT:
                    raise RuntimeError(
                        f"sync_linked phase-4 message {j} rendered to {len(msg)} chars "
                        f"(limit {MESSAGE_LIMIT}); real message URLs longer than "
                        "the placeholder upper bound."
                    )
            for i, (msg_id, content) in enumerate(zip(summary_ids, final_summaries, strict=True)):
                if i > 0 and pace > 0:
                    time.sleep(pace + random.uniform(0, jitter))
                self.edit(msg_id, content)
        finally:
            self._active_thread_id = None
            self._suppress_embeds = False

        return LinkedSyncResult(
            thread_id=tid,
            summary_ids=summary_ids,
            detail_ids=detail_ids,
            section_detail_ids=section_detail_map,
        )


class DiscordWebhookClient(_DiscordHTTP):
    """Per-message-sender Discord transport via webhook execution.

    A webhook sets ``username`` + ``avatar_url`` **per message** — the bot API
    can't, so `DiscordClient.post` raises on sender overrides and points here.
    But a webhook can't open a thread and can't list/read messages, so this
    client is deliberately write-only (``post`` / ``edit`` / ``delete``) and
    pairs with a `DiscordClient` that owns thread creation, listing, and
    reconcile: the bot opens the thread and owns the OP; this client fans
    per-sender replies into it via ``?thread_id=``. See specs/discord-push.md.

    The protocol's ``icon_url`` maps to the webhook's ``avatar_url`` (both a
    hosted image URL); ``icon_emoji`` has no webhook equivalent and raises.
    Per-message values override the client-wide ``username`` / ``avatar_url``
    defaults (mirroring `SlackClient.post`).

    ``webhook_url`` embeds the webhook's secret token, so it is never logged —
    error labels carry only the method and message id, never the URL.
    """

    _HEADERS = {"Content-Type": "application/json"}

    def __init__(
        self,
        webhook_url: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        avatar_url: str | None = None,
        suppress_embeds: bool = False,
        allowed_mentions: dict | None = None,
    ):
        self.webhook_url = webhook_url
        self.thread_id = thread_id
        self.username = username
        self.avatar_url = avatar_url
        self.suppress_embeds = suppress_embeds
        self.allowed_mentions = allowed_mentions

    def _message_url(self, message_id: str) -> str:
        url = f"{self.webhook_url}/messages/{message_id}"
        if self.thread_id is not None:
            url += f"?thread_id={self.thread_id}"
        return url

    def list_messages(self, thread_id: str) -> list[Message]:
        raise NotImplementedError(
            "A webhook can't read messages. Use a `DiscordClient` (bot token) to "
            "list/reconcile the thread, and this client only to post/edit/delete "
            "per-sender replies. See specs/discord-push.md."
        )

    def post(
        self,
        content: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        images: Sequence[Image] = (),
        broadcast: bool = False,
    ) -> Message:
        """Post a webhook message, optionally with image attachments.

        ``images`` (unified `Image`s — a ``path`` uploaded directly, a ``url``
        fetched then uploaded) go as multipart alongside the text; they render
        inline like any user attachment, and `suppress_embeds` (which only hides
        link previews) leaves them visible. Empty ``images`` sends the
        byte-identical JSON request as before.

        ``broadcast`` is Slack's `reply_broadcast`; Discord has no analogue, so
        ``broadcast=True`` **raises**."""
        if broadcast:
            raise NotImplementedError(
                "Discord has no `reply_broadcast` analogue (`broadcast=` is "
                "Slack-specific)."
            )
        if icon_emoji is not None:
            raise NotImplementedError(
                "Discord webhooks have no emoji avatar; pass a hosted image URL as "
                "`icon_url` (mapped to the webhook's `avatar_url`)."
            )
        if len(content) > MESSAGE_LIMIT:
            raise ValueError(f"Message exceeds Discord's {MESSAGE_LIMIT} char limit ({len(content)} chars)")
        tid = thread_id if thread_id is not None else self.thread_id
        url = f"{self.webhook_url}?wait=true"
        if tid is not None:
            url += f"&thread_id={tid}"
        data: dict = {"content": content}
        resolved_username = username if username is not None else self.username
        if resolved_username is not None:
            data["username"] = resolved_username
        resolved_avatar = icon_url if icon_url is not None else self.avatar_url
        if resolved_avatar is not None:
            data["avatar_url"] = resolved_avatar
        if self.suppress_embeds:
            data["flags"] = 4
        if self.allowed_mentions is not None:
            data["allowed_mentions"] = self.allowed_mentions
        if images:
            with _image_paths(images) as paths:
                resp = self._curl_raw("POST", url, form=_files_form(data, paths), label="POST webhook message")
        else:
            resp = self._curl_raw("POST", url, data, headers=self._HEADERS, label="POST webhook message")
        return Message(id=resp["id"], content=content)

    def edit(
        self,
        message_id: str,
        content: str,
        *,
        images: Sequence[Image] = (),
        keep_attachments: bool = True,
    ) -> Message:
        """Edit a webhook message's text, and optionally its attachments.

        With no ``images``: ``keep_attachments`` (the default) leaves existing
        attachments in place — a text-only edit must not strip an earlier image
        — while ``False`` sends ``attachments: []`` to drop them. Passing
        ``images`` replaces the attachment set with the new uploads."""
        if len(content) > MESSAGE_LIMIT:
            raise ValueError(f"Message exceeds Discord's {MESSAGE_LIMIT} char limit ({len(content)} chars)")
        data: dict = {"content": content}
        if self.suppress_embeds:
            data["flags"] = 4
        if self.allowed_mentions is not None:
            data["allowed_mentions"] = self.allowed_mentions
        if images:
            with _image_paths(images) as paths:
                self._curl_raw(
                    "PATCH", self._message_url(message_id), form=_files_form(data, paths),
                    label=f"PATCH webhook message {message_id}",
                )
        else:
            if not keep_attachments:
                data["attachments"] = []
            self._curl_raw(
                "PATCH", self._message_url(message_id), data,
                headers=self._HEADERS, label=f"PATCH webhook message {message_id}",
            )
        return Message(id=message_id, content=content)

    def delete(self, message_id: str) -> None:
        self._curl_raw(
            "DELETE", self._message_url(message_id),
            headers=self._HEADERS, label=f"DELETE webhook message {message_id}",
        )


class DiscordHybridClient:
    """Threaded per-sender digest: a bot owns the thread, a webhook the replies.

    The composite that pairs the two transports so a single `sync` can post
    per-contributor replies (name + avatar) into a thread the bot opens and
    reconciles. It is itself a `ThreadClient`, routing each `core.sync` call:

    - ``list_messages`` / ``open_thread`` → **bot** (a webhook can't read or
      open a thread). Listing records which live ids are webhook-authored (via
      ``webhook_id``), so a re-push routes edits/deletes correctly.
    - ``post`` → **webhook** when the desired message carries a per-sender
      override **or an attachment**, else **bot**. This holds for the OP too:
      a plain OP is the bot's single identity, but an OP with a sender or a
      file is posted through the webhook (into the parent channel, no
      ``thread_id``) and the bot then opens the thread off it — a bot can
      ``create_thread`` off *any* channel message, webhook-authored included
      (probe-confirmed, `specs/done/discord-webhook-attachments.md` §3).
    - ``edit`` / ``delete`` → the transport that **authored** the target (a
      webhook message can only be edited via the webhook; each transport
      deletes its own). A webhook-authored OP lives in the **parent channel**,
      not the thread, so its edit must route to the webhook with no
      ``?thread_id`` — tracked as ``_webhook_op_id`` and handled specially.

    A message that was bot-authored on a prior push can't be *re-attributed* to
    a sender on re-push — sender is fixed at post time on every Discord
    transport (see the README capability matrix). Its content still edits, as
    the bot.
    """

    def __init__(self, bot: DiscordClient, webhook: DiscordWebhookClient):
        self.bot = bot
        self.webhook = webhook
        self._webhook_ids: set[str] = set()
        # A webhook-authored OP (sender/attachment on the OP): it lives in the
        # parent channel, so its edit must drop the thread override. None until
        # a sender/file OP is posted or a listing finds one at the thread head.
        self._webhook_op_id: str | None = None

    @property
    def channel_id(self) -> str:
        return self.bot.channel_id

    @property
    def guild_id(self) -> str | None:
        return self.bot.guild_id

    def _is_ours(self, raw: dict) -> bool:
        """Ours to reconcile: a webhook reply (routed to the webhook on edit/
        delete) or a bot-authored message. Foreign (human/other-app) → False,
        so `core.sync` preserves it in place."""
        return raw.get("webhook_id") is not None or self.bot._authored_by_us(raw)

    def list_messages(self, thread_id: str) -> list[Message]:
        raw = self.bot._list_raw(thread_id)
        self._webhook_ids = {m["id"] for m in raw if m.get("webhook_id")}
        # When listing a real thread, `_list_raw` prepends the parent-channel
        # OP at raw[0]; a webhook_id there means the OP is webhook-authored and
        # its edits must skip `?thread_id`. (For a lone OP reconciled in the
        # base channel, `thread_id == channel_id` and no OP is prepended, so
        # don't infer one — the webhook has no thread override there anyway.)
        self._webhook_op_id = (
            raw[0]["id"]
            if thread_id != self.bot.channel_id and raw and raw[0].get("webhook_id")
            else None
        )
        return [
            Message(id=m["id"], content=m.get("content", ""), editable=self._is_ours(m))
            for m in raw
        ]

    def open_thread(self, op_id: str, name: str | None) -> str:
        tid = self.bot.open_thread(op_id, name)
        self.webhook.thread_id = tid
        self.bot._active_thread_id = tid
        return tid

    def post(
        self,
        content: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        images: Sequence[Image] = (),
        broadcast: bool = False,
    ) -> Message:
        if broadcast:
            raise NotImplementedError(
                "Discord has no `reply_broadcast` analogue (`broadcast=` is "
                "Slack-specific)."
            )
        via_webhook = username is not None or icon_url is not None or icon_emoji is not None or bool(images)
        if thread_id is None:
            # OP. A plain OP is the bot's single identity; one carrying a sender
            # or an attachment goes through the webhook, into the PARENT channel
            # (no thread_id). `open_thread` then creates the thread off it — the
            # bot can thread off a webhook-authored message all the same.
            if not via_webhook:
                return self.bot.post(content)
            prev = self.webhook.thread_id
            self.webhook.thread_id = None
            try:
                msg = self.webhook.post(
                    content, thread_id=None,
                    username=username, icon_url=icon_url, icon_emoji=icon_emoji, images=images,
                )
            finally:
                self.webhook.thread_id = prev
            self._webhook_ids.add(msg.id)
            self._webhook_op_id = msg.id
            return msg
        if via_webhook:
            msg = self.webhook.post(
                content, thread_id=thread_id,
                username=username, icon_url=icon_url, icon_emoji=icon_emoji, images=images,
            )
            self._webhook_ids.add(msg.id)
            return msg
        return self.bot.post(content, thread_id=thread_id)

    def edit(self, message_id: str, content: str, *, images: Sequence[Image] = ()) -> Message:
        if message_id == self._webhook_op_id:
            # The webhook-authored OP lives in the parent channel — its edit must
            # not carry `?thread_id`. Clear the webhook's thread override around
            # this one call (the sync wrapper set it to the child thread).
            prev = self.webhook.thread_id
            self.webhook.thread_id = None
            try:
                return self.webhook.edit(message_id, content, images=images)
            finally:
                self.webhook.thread_id = prev
        if message_id in self._webhook_ids:
            return self.webhook.edit(message_id, content, images=images)
        return self.bot.edit(message_id, content, images=images)

    def delete(self, message_id: str) -> None:
        if message_id in self._webhook_ids:
            self.webhook.delete(message_id)
            self._webhook_ids.discard(message_id)
        else:
            self.bot.delete(message_id)

    def sync(
        self,
        thread: Thread,
        thread_id: str | None = None,
        dry_run: bool = False,
        pace: float = 0.0,
        jitter: float = 0.0,
        suppress_embeds: bool = False,
        thread_name: str | None = None,
        only_ids: set[str] | None = None,
    ) -> SyncResult:
        prev_webhook_thread = self.webhook.thread_id
        prev_webhook_suppress = self.webhook.suppress_embeds
        if thread_id is not None:
            self.webhook.thread_id = thread_id
        self.bot._active_thread_id = thread_id
        self.bot._suppress_embeds = suppress_embeds
        self.webhook.suppress_embeds = suppress_embeds
        try:
            return sync(
                client=self,
                desired=thread,
                thread_id=thread_id,
                options=SyncOptions(
                    dry_run=dry_run,
                    pace=pace,
                    jitter=jitter,
                    suppress_embeds=suppress_embeds,
                    thread_name=thread_name,
                    only_ids=only_ids,
                ),
            )
        finally:
            self.bot._active_thread_id = None
            self.bot._suppress_embeds = False
            self.webhook.thread_id = prev_webhook_thread
            self.webhook.suppress_embeds = prev_webhook_suppress
