"""Tests for `DiscordHybridClient` — bot owns the thread, webhook owns replies.

The composite routes each `core.sync` op: listing/threading via the bot, a
per-sender reply via the webhook, an edit/delete back to whichever transport
authored the target. Both transports' HTTP is stubbed (`DiscordClient._curl`
and `DiscordWebhookClient._curl_raw`) onto shared recorders, so each test
asserts the exact bot-vs-webhook call split. See specs/done/discord-push.md.
"""
from __future__ import annotations

import pytest

from thrds import DiscordClient, DiscordHybridClient, DiscordWebhookClient, Image, Msg, Thread

WEBHOOK = "https://discord.com/api/webhooks/123/faketoken"
AV = "https://cdn.discordapp.com/embed/avatars/0.png"
BOT_ID = "700700700"  # this bot's own user id (`GET /users/@me`)


def _own(msg: dict) -> dict:
    """Stamp a canned message as authored by us unless it's already marked.

    Real Discord messages always carry `author`; these fixtures omit it, so a
    message with neither `author` nor `webhook_id` is one the bot posted (the
    common case in these single-identity threads) — stamp `author.id == BOT_ID`
    so `_authored_by_us` marks it editable. A `webhook_id` (webhook reply) or an
    explicit foreign `author` is left as-is."""
    if "author" not in msg and "webhook_id" not in msg:
        return {**msg, "author": {"id": BOT_ID}}
    return msg


class _BotRecorder:
    """Stub for `DiscordClient._curl`: records `(method, path, data)`.

    POSTs get ids `m1`, `m2`, …; a thread-create returns `thread-1`; a list GET
    returns ``thread_messages`` (raw dicts, newest-first — `_list_raw` reverses);
    a single-message GET returns ``op_message``; `GET /users/@me` returns this
    bot's id. Canned messages are stamped as bot-authored (`_own`) unless they
    already carry a `webhook_id` or an explicit `author`.
    """
    def __init__(self, thread_messages=None, op_message=None):
        self.calls: list[tuple[str, str, dict | None]] = []
        self._n = 0
        self._thread_messages = [_own(m) for m in (thread_messages or [])]
        self._op_message = _own(op_message) if op_message is not None else None

    def __call__(self, method, path, data=None):
        self.calls.append((method, path, data))
        if method == "GET":
            if path == "/users/@me":
                return {"id": BOT_ID}
            if "/messages/" in path:
                return self._op_message
            return self._thread_messages
        if method == "POST" and path.endswith("/threads"):
            return {"id": "thread-1"}
        if method == "POST" and path.endswith("/messages"):
            self._n += 1
            return {"id": f"m{self._n}"}
        return None


class _WebhookRecorder:
    """Stub for `DiscordWebhookClient._curl_raw`: records `(method, url, data)`;
    POSTs return ids `w1`, `w2`, …. A multipart call (``form`` set — an
    attachment upload) lands in ``form_calls`` as ``(method, url, form)``, kept
    apart from JSON ``calls`` so plain-request assertions stay exact."""
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.form_calls: list[tuple[str, str, list]] = []
        self._n = 0

    def __call__(self, method, url, data=None, *, form=None, headers=None, label=None):
        if form is not None:
            self.form_calls.append((method, url, form))
        else:
            self.calls.append((method, url, data))
        if method == "POST":
            self._n += 1
            return {"id": f"w{self._n}"}
        return None


def _hybrid(monkeypatch, bot_rec, hook_rec):
    monkeypatch.setattr(DiscordClient, "_curl", lambda self, m, p, data=None: bot_rec(m, p, data))
    # Pin the bot identity so classification doesn't emit a `GET /users/@me`
    # into the recorded call sequence (its resolution is covered separately).
    monkeypatch.setattr(DiscordClient, "bot_user_id", property(lambda self: BOT_ID))
    monkeypatch.setattr(
        DiscordWebhookClient, "_curl_raw",
        lambda self, method, url, data=None, *, form=None, headers=None, label=None: hook_rec(
            method, url, data, form=form, headers=headers, label=label,
        ),
    )
    bot = DiscordClient("bot-tok", "CHAN", "GUILD")
    webhook = DiscordWebhookClient(WEBHOOK)
    return DiscordHybridClient(bot, webhook)


def test_fresh_bot_op_thread_then_webhook_per_sender_replies(monkeypatch):
    bot_rec, hook_rec = _BotRecorder(), _WebhookRecorder()
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    result = hybrid.sync(Thread(messages=[
        "OP body",
        Msg("reply A", username="Alice", icon_url=AV),
        Msg("reply B", username="Bob", icon_url=AV),
    ]), thread_name="Digest")

    # Bot: OP → channel, open thread off it. No bot reply posts.
    assert bot_rec.calls == [
        ("POST", "/channels/CHAN/messages", {"content": "OP body"}),
        ("POST", "/channels/CHAN/messages/m1/threads", {"name": "Digest"}),
    ]
    # Webhook: two per-sender replies into the opened thread.
    assert hook_rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true&thread_id=thread-1",
         {"content": "reply A", "username": "Alice", "avatar_url": AV}),
        ("POST", f"{WEBHOOK}?wait=true&thread_id=thread-1",
         {"content": "reply B", "username": "Bob", "avatar_url": AV}),
    ]
    assert result.thread_id == "thread-1"
    assert result.message_ids == ["m1", "w1", "w2"]


def test_fresh_bare_reply_routes_to_bot(monkeypatch):
    bot_rec, hook_rec = _BotRecorder(), _WebhookRecorder()
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    result = hybrid.sync(Thread(messages=[
        "OP body",
        "bare reply",
        Msg("reply B", username="Bob", icon_url=AV),
    ]), thread_name="Digest")

    # OP + thread + the bare reply are all bot; only the sender reply is webhook.
    assert bot_rec.calls == [
        ("POST", "/channels/CHAN/messages", {"content": "OP body"}),
        ("POST", "/channels/CHAN/messages/m1/threads", {"name": "Digest"}),
        ("POST", "/channels/thread-1/messages", {"content": "bare reply"}),
    ]
    assert hook_rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true&thread_id=thread-1",
         {"content": "reply B", "username": "Bob", "avatar_url": AV}),
    ]
    assert result.message_ids == ["m1", "m2", "w1"]


def test_op_with_sender_routes_to_webhook_then_bot_opens_thread(monkeypatch):
    # Part 3: an OP carrying a sender is posted through the webhook (into the
    # PARENT channel — no thread_id), then the bot opens the thread off it.
    bot_rec, hook_rec = _BotRecorder(), _WebhookRecorder()
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    result = hybrid.sync(Thread(messages=[
        Msg("OP body", username="Digest", icon_url=AV),
        Msg("reply A", username="Alice", icon_url=AV),
    ]), thread_name="Digest")

    # Webhook: OP with no thread_id, then the reply into the opened thread.
    assert hook_rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         {"content": "OP body", "username": "Digest", "avatar_url": AV}),
        ("POST", f"{WEBHOOK}?wait=true&thread_id=thread-1",
         {"content": "reply A", "username": "Alice", "avatar_url": AV}),
    ]
    # Bot posts nothing — it only opens the thread off the webhook OP (id w1).
    assert bot_rec.calls == [
        ("POST", "/channels/CHAN/messages/w1/threads", {"name": "Digest"}),
    ]
    assert result.thread_id == "thread-1"
    assert result.message_ids == ["w1", "w2"]


def test_op_with_attachment_routes_to_webhook(monkeypatch, tmp_path):
    # An OP carrying a file (no sender) also goes through the webhook — the bot
    # `post` can't upload attachments — as a multipart request, then the bot
    # opens the thread off it.
    png = tmp_path / "plot.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    bot_rec, hook_rec = _BotRecorder(), _WebhookRecorder()
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    result = hybrid.sync(Thread(messages=[
        Msg("OP body", images=[Image(path=png)]),
        "bare reply",
    ]), thread_name="Digest")

    # OP is the one multipart call: payload_json (with the attachments manifest)
    # + one file part; no thread_id on the OP.
    import json
    assert hook_rec.form_calls == [
        ("POST", f"{WEBHOOK}?wait=true", [
            ("payload_json", json.dumps({
                "content": "OP body",
                "attachments": [{"id": 0, "filename": "plot.png"}],
            })),
            ("files[0]", f"@{png}"),
        ]),
    ]
    assert hook_rec.calls == []  # no plain-JSON webhook calls
    # Bot opens the thread off the webhook OP, then posts the bare reply into it.
    assert bot_rec.calls == [
        ("POST", "/channels/CHAN/messages/w1/threads", {"name": "Digest"}),
        ("POST", "/channels/thread-1/messages", {"content": "bare reply"}),
    ]
    assert result.message_ids == ["w1", "m1"]


def _repush_recorders(thread_messages):
    """Bot recorder seeded for a re-push: live thread listing + parent OP."""
    return _BotRecorder(
        thread_messages=thread_messages,
        op_message={"id": "thread-1", "content": "OP body", "type": 0},
    ), _WebhookRecorder()


def test_repush_edits_webhook_reply_via_webhook(monkeypatch):
    bot_rec, hook_rec = _repush_recorders([
        {"id": "w1", "content": "reply OLD", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    result = hybrid.sync(Thread(messages=[
        "OP body",
        Msg("reply NEW", username="Alice", icon_url=AV),
    ]), thread_id="thread-1")

    # Bot only reads (list + parent OP); the changed reply is webhook-authored,
    # so its edit goes through the webhook with ?thread_id=.
    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
    ]
    assert hook_rec.calls == [
        ("PATCH", f"{WEBHOOK}/messages/w1?thread_id=thread-1", {"content": "reply NEW"}),
    ]
    assert result.message_ids == ["thread-1", "w1"]


def test_repush_edits_op_via_bot_parent_channel(monkeypatch):
    bot_rec, hook_rec = _repush_recorders([
        {"id": "w1", "content": "reply A", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=[
        "OP CHANGED",
        Msg("reply A", username="Alice", icon_url=AV),
    ]), thread_id="thread-1")

    # The OP isn't webhook-authored → bot edit, addressed to the PARENT channel
    # (id == thread id). The reply is unchanged (SKIP), so no webhook write.
    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
        ("PATCH", "/channels/CHAN/messages/thread-1", {"content": "OP CHANGED"}),
    ]
    assert hook_rec.calls == []


def test_repush_edits_bot_authored_reply_via_bot(monkeypatch):
    # A reply with no webhook_id was bot-authored; its edit routes to the bot
    # (thread channel), even though the desired entry now names a sender —
    # sender is fixed at post time, so only the content changes.
    bot_rec, hook_rec = _repush_recorders([
        {"id": "r1", "content": "reply OLD", "type": 0},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=[
        "OP body",
        Msg("reply NEW", username="Alice", icon_url=AV),
    ]), thread_id="thread-1")

    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
        ("PATCH", "/channels/thread-1/messages/r1", {"content": "reply NEW"}),
    ]
    assert hook_rec.calls == []


def test_repush_posts_new_webhook_reply(monkeypatch):
    bot_rec, hook_rec = _repush_recorders([
        {"id": "w1", "content": "reply A", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=[
        "OP body",
        Msg("reply A", username="Alice", icon_url=AV),
        Msg("reply B", username="Bob", icon_url=AV),
    ]), thread_id="thread-1")

    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
    ]
    assert hook_rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true&thread_id=thread-1",
         {"content": "reply B", "username": "Bob", "avatar_url": AV}),
    ]


def test_repush_deletes_each_reply_via_its_author(monkeypatch):
    # Live: a webhook reply then a bot reply; desired drops both. Each delete
    # routes to the transport that authored it.
    bot_rec, hook_rec = _repush_recorders([
        {"id": "r2", "content": "bot reply", "type": 0},
        {"id": "w1", "content": "hook reply", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=["OP body"]), thread_id="thread-1")

    # Deletes run end-first: r2 (bot) then w1 (webhook).
    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
        ("DELETE", "/channels/thread-1/messages/r2", None),
    ]
    assert hook_rec.calls == [
        ("DELETE", f"{WEBHOOK}/messages/w1?thread_id=thread-1", None),
    ]


def test_repush_preserves_a_foreign_human_reply(monkeypatch):
    # A human reply (explicit foreign author, no webhook_id) sits between our
    # OP and our webhook reply. Desired keeps OP + reply; the human message is
    # non-editable, so `core.sync` preserves it — never edited, never deleted,
    # and it doesn't consume a desired slot.
    bot_rec, hook_rec = _repush_recorders([
        {"id": "h1", "content": "a human chimed in", "type": 0, "author": {"id": "999human"}},
        {"id": "w1", "content": "reply A", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=[
        "OP body",
        Msg("reply A", username="Alice", icon_url=AV),
    ]), thread_id="thread-1")

    # Bot only reads (list + parent OP); nothing touches h1, and the unchanged
    # webhook reply is a SKIP, so no writes on either transport.
    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
    ]
    assert hook_rec.calls == []


def _webhook_op_repush_recorders(thread_messages):
    """Re-push recorders where the OP itself is webhook-authored (Part 3):
    the prepended parent OP carries a `webhook_id`, so its edit must route to
    the webhook with no `?thread_id`."""
    return _BotRecorder(
        thread_messages=thread_messages,
        op_message={"id": "thread-1", "content": "OP body", "type": 0, "webhook_id": "wh"},
    ), _WebhookRecorder()


def test_repush_edits_webhook_op_via_webhook_without_thread_id(monkeypatch):
    # The OP is webhook-authored and lives in the parent channel; changing its
    # text edits it through the webhook, and the URL must NOT carry ?thread_id
    # (that would 404 — the OP isn't in the thread channel).
    bot_rec, hook_rec = _webhook_op_repush_recorders([
        {"id": "w2", "content": "reply A", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=[
        Msg("OP CHANGED", username="Digest", icon_url=AV),
        Msg("reply A", username="Alice", icon_url=AV),
    ]), thread_id="thread-1")

    # Bot only reads; the webhook OP edit has a bare /messages/thread-1 URL.
    assert bot_rec.calls == [
        ("GET", "/channels/thread-1/messages?limit=100", None),
        ("GET", "/channels/CHAN/messages/thread-1", None),
    ]
    assert hook_rec.calls == [
        ("PATCH", f"{WEBHOOK}/messages/thread-1", {"content": "OP CHANGED"}),
    ]


def test_repush_refreshes_webhook_op_attachment_on_edit(monkeypatch, tmp_path):
    # The daily gcs-style refresh: the OP text changes AND a new plot is
    # attached, so the edit re-uploads the file (multipart) to the webhook OP —
    # still with no ?thread_id.
    png = tmp_path / "plot2.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    bot_rec, hook_rec = _webhook_op_repush_recorders([
        {"id": "w2", "content": "reply A", "type": 0, "webhook_id": "wh"},
    ])
    hybrid = _hybrid(monkeypatch, bot_rec, hook_rec)

    hybrid.sync(Thread(messages=[
        Msg("OP CHANGED", username="Digest", icon_url=AV, images=[Image(path=png)]),
        Msg("reply A", username="Alice", icon_url=AV),
    ]), thread_id="thread-1")

    import json
    assert hook_rec.calls == []
    assert hook_rec.form_calls == [
        ("PATCH", f"{WEBHOOK}/messages/thread-1", [
            ("payload_json", json.dumps({
                "content": "OP CHANGED",
                "attachments": [{"id": 0, "filename": "plot2.png"}],
            })),
            ("files[0]", f"@{png}"),
        ]),
    ]
