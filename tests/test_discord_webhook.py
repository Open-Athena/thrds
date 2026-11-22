"""Tests for `DiscordWebhookClient` — the per-message-sender transport.

A webhook sets `username`/`avatar_url` per message (the bot API can't) but can't
open a thread or read messages, so this client is write-only (post/edit/delete)
and pairs with a `DiscordClient` for threading + reconcile. See
specs/done/discord-push.md.

The stub records each `_curl_raw` call as `(method, url, data, label)` so tests
assert exact request shapes; POSTs return a canned id. The fake `webhook_url`
below stands in for the real secret one.
"""
from __future__ import annotations

import pytest

from thrds import NO_MENTIONS, DiscordWebhookClient, Image, Message

WEBHOOK = "https://discord.com/api/webhooks/123/faketoken"
AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png"


class _RawRecorder:
    """Stub for `DiscordWebhookClient._curl_raw`: records calls, returns ids.

    A JSON call lands in ``calls`` as ``(method, url, data, label)``; a
    multipart call (``form`` set) lands in ``form_calls`` as
    ``(method, url, form, label)`` — kept apart so JSON-path assertions stay
    exact. A POST returns a canned ``{"id": …}``; PATCH/DELETE return None.
    """
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None, str | None]] = []
        self.form_calls: list[tuple[str, str, list, str | None]] = []
        self._n = 0

    def __call__(self, method, url, data=None, *, form=None, headers=None, label=None):
        if form is not None:
            self.form_calls.append((method, url, form, label))
        else:
            self.calls.append((method, url, data, label))
        if method == "POST":
            self._n += 1
            return {"id": f"w{self._n}"}
        return None


@pytest.fixture
def rec(monkeypatch):
    r = _RawRecorder()
    monkeypatch.setattr(
        DiscordWebhookClient, "_curl_raw",
        lambda self, method, url, data=None, *, form=None, headers=None, label=None: r(
            method, url, data, form=form, headers=headers, label=label,
        ),
    )
    return r


def test_post_sets_wait_and_per_message_sender(rec):
    client = DiscordWebhookClient(WEBHOOK)
    msg = client.post("hello", username="Alice", icon_url=AVATAR)
    assert msg == Message(id="w1", content="hello")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         {"content": "hello", "username": "Alice", "avatar_url": AVATAR},
         "POST webhook message"),
    ]


def test_post_into_thread_appends_thread_id(rec):
    client = DiscordWebhookClient(WEBHOOK, thread_id="t9")
    client.post("in thread", username="Bob")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true&thread_id=t9",
         {"content": "in thread", "username": "Bob"},
         "POST webhook message"),
    ]


def test_post_per_call_thread_id_overrides_client_default(rec):
    client = DiscordWebhookClient(WEBHOOK, thread_id="t9")
    client.post("elsewhere", thread_id="t42")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true&thread_id=t42",
         {"content": "elsewhere"},
         "POST webhook message"),
    ]


def test_post_uses_client_default_sender(rec):
    client = DiscordWebhookClient(WEBHOOK, username="Digest", avatar_url=AVATAR)
    client.post("body")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         {"content": "body", "username": "Digest", "avatar_url": AVATAR},
         "POST webhook message"),
    ]


def test_post_message_username_overrides_client_default(rec):
    client = DiscordWebhookClient(WEBHOOK, username="Digest", avatar_url=AVATAR)
    client.post("body", username="Alice")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         {"content": "body", "username": "Alice", "avatar_url": AVATAR},
         "POST webhook message"),
    ]


def test_post_suppress_embeds_sets_flags(rec):
    client = DiscordWebhookClient(WEBHOOK, suppress_embeds=True)
    client.post("body")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         {"content": "body", "flags": 4},
         "POST webhook message"),
    ]


def test_post_icon_emoji_raises(rec):
    client = DiscordWebhookClient(WEBHOOK)
    with pytest.raises(NotImplementedError, match="no emoji avatar"):
        client.post("body", icon_emoji=":tada:")
    assert rec.calls == []


def test_post_over_length_raises(rec):
    client = DiscordWebhookClient(WEBHOOK)
    with pytest.raises(ValueError, match="2000 char limit"):
        client.post("x" * 2001)
    assert rec.calls == []


def test_edit_patches_message_in_thread(rec):
    client = DiscordWebhookClient(WEBHOOK, thread_id="t9")
    msg = client.edit("w1", "edited")
    assert msg == Message(id="w1", content="edited")
    assert rec.calls == [
        ("PATCH", f"{WEBHOOK}/messages/w1?thread_id=t9",
         {"content": "edited"},
         "PATCH webhook message w1"),
    ]


def test_edit_without_thread_has_no_query(rec):
    client = DiscordWebhookClient(WEBHOOK)
    client.edit("w1", "edited")
    assert rec.calls == [
        ("PATCH", f"{WEBHOOK}/messages/w1",
         {"content": "edited"},
         "PATCH webhook message w1"),
    ]


def test_delete_targets_message_in_thread(rec):
    client = DiscordWebhookClient(WEBHOOK, thread_id="t9")
    client.delete("w1")
    assert rec.calls == [
        ("DELETE", f"{WEBHOOK}/messages/w1?thread_id=t9", None,
         "DELETE webhook message w1"),
    ]


def test_list_messages_raises(rec):
    client = DiscordWebhookClient(WEBHOOK)
    with pytest.raises(NotImplementedError, match="can't read messages"):
        client.list_messages("t9")
    assert rec.calls == []


def test_error_labels_never_carry_the_secret_url(rec):
    """Every request labels itself with method + message id, never the webhook
    URL — its token is a secret and error strings surface labels verbatim."""
    client = DiscordWebhookClient(WEBHOOK, thread_id="t9")
    client.post("a", username="Alice")
    client.edit("w1", "b")
    client.delete("w1")
    labels = [label for _, _, _, label in rec.calls]
    assert labels == [
        "POST webhook message",
        "PATCH webhook message w1",
        "DELETE webhook message w1",
    ]
    assert all(WEBHOOK not in label for label in labels)


# --- file attachments (specs/discord-webhook-attachments.md §1) ---


def test_post_with_path_image_uploads_multipart(rec, tmp_path):
    png = tmp_path / "diff.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    client = DiscordWebhookClient(WEBHOOK)
    msg = client.post("here", images=[Image(path=png)])
    assert msg == Message(id="w1", content="here")
    # Multipart: payload_json (content + attachments manifest) + one file part.
    assert rec.form_calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         [("payload_json", '{"content": "here", "attachments": [{"id": 0, "filename": "diff.png"}]}'),
          ("files[0]", f"@{png}")],
         "POST webhook message"),
    ]
    # No JSON-path call was made.
    assert rec.calls == []


def test_post_with_url_image_fetches_then_uploads(rec, tmp_path, monkeypatch):
    # A `url` image is fetched (GET) to a temp file, then uploaded as multipart —
    # the attachment is named after the URL's basename.
    import thrds.discord as dm

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"\x89PNGdata"

    monkeypatch.setattr(dm, "urlopen", lambda url: _Resp())
    client = DiscordWebhookClient(WEBHOOK)
    client.post("here", images=[Image(url="https://host/path/chart.png")])
    assert len(rec.form_calls) == 1
    method, url, form, label = rec.form_calls[0]
    assert (method, url, label) == ("POST", f"{WEBHOOK}?wait=true", "POST webhook message")
    assert form[0] == ("payload_json", '{"content": "here", "attachments": [{"id": 0, "filename": "chart.png"}]}')
    part_name, at_path = form[1]
    assert part_name == "files[0]" and at_path.endswith("/chart.png")


def test_post_without_images_stays_json(rec):
    client = DiscordWebhookClient(WEBHOOK)
    client.post("plain", images=[])
    assert rec.form_calls == []
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true", {"content": "plain"}, "POST webhook message"),
    ]


def test_post_too_many_images_raises(rec, tmp_path):
    images = []
    for i in range(11):
        p = tmp_path / f"f{i}.png"
        p.write_bytes(b"x")
        images.append(Image(path=p))
    client = DiscordWebhookClient(WEBHOOK)
    with pytest.raises(ValueError, match="at most 10 files per message; got 11"):
        client.post("too many", images=images)
    assert rec.calls == [] and rec.form_calls == []


def test_post_oversized_image_raises(rec, tmp_path):
    big = tmp_path / "big.png"
    with big.open("wb") as f:
        f.truncate(8 * 1024 * 1024 + 1)  # sparse: one past the 8 MiB cap
    client = DiscordWebhookClient(WEBHOOK)
    with pytest.raises(ValueError, match="exceeds Discord's default 8388608-byte"):
        client.post("huge", images=[Image(path=big)])


def test_edit_with_images_replaces_attachments(rec, tmp_path):
    png = tmp_path / "new.png"
    png.write_bytes(b"\x89PNG")
    client = DiscordWebhookClient(WEBHOOK, thread_id="t9")
    client.edit("w1", "updated", images=[Image(path=png)])
    assert rec.form_calls == [
        ("PATCH", f"{WEBHOOK}/messages/w1?thread_id=t9",
         [("payload_json", '{"content": "updated", "attachments": [{"id": 0, "filename": "new.png"}]}'),
          ("files[0]", f"@{png}")],
         "PATCH webhook message w1"),
    ]


def test_edit_text_only_keeps_attachments(rec):
    client = DiscordWebhookClient(WEBHOOK)
    client.edit("w1", "just text")
    # No `attachments` key → Discord leaves the existing image in place.
    assert rec.calls == [
        ("PATCH", f"{WEBHOOK}/messages/w1", {"content": "just text"}, "PATCH webhook message w1"),
    ]


def test_edit_drop_attachments_sends_empty_list(rec):
    client = DiscordWebhookClient(WEBHOOK)
    client.edit("w1", "text now", keep_attachments=False)
    assert rec.calls == [
        ("PATCH", f"{WEBHOOK}/messages/w1",
         {"content": "text now", "attachments": []}, "PATCH webhook message w1"),
    ]


# --- allowed_mentions (specs/discord-webhook-attachments.md §2) ---


def test_allowed_mentions_on_post_and_edit(rec):
    client = DiscordWebhookClient(WEBHOOK, allowed_mentions=NO_MENTIONS)
    client.post("ping @here")
    client.edit("w1", "still @here")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true",
         {"content": "ping @here", "allowed_mentions": {"parse": []}}, "POST webhook message"),
        ("PATCH", f"{WEBHOOK}/messages/w1",
         {"content": "still @here", "allowed_mentions": {"parse": []}}, "PATCH webhook message w1"),
    ]


def test_allowed_mentions_absent_by_default(rec):
    client = DiscordWebhookClient(WEBHOOK)
    client.post("hi @here")
    assert rec.calls == [
        ("POST", f"{WEBHOOK}?wait=true", {"content": "hi @here"}, "POST webhook message"),
    ]
