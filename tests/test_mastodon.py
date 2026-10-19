"""Tests for `MastodonClient`.

Exercises the real client code (request shaping, ours-vs-foreign reads, and the
first-class edit) against a stateful in-memory emulator of the Mastodon REST
API — no network. The headline vs `BskyClient` is that `edit()` really edits
(preserves the status id, never raises `EditRateLimited`), so `sync` uses EDIT
in place rather than delete+repost.
"""
from __future__ import annotations

import pytest

from thrds import ActionType, Thread, sync
from thrds.core import Image
from thrds.mastodon import MastodonClient, _html_to_text


class FakeMastodon(MastodonClient):
    """`MastodonClient` with `_request` swapped for an in-memory API emulator.

    Statuses live in ``self.store`` (id → raw dict with a ``text`` source
    field). Flat threading: a reply's ``in_reply_to_id`` is its OP, and
    ``/context`` returns every status that points at the requested id.
    """

    def __init__(self, account_id: str = "ME", visibility: str = "public"):
        super().__init__("https://masto.test", "tok", visibility=visibility)
        self._account_id = account_id
        self.store: dict[str, dict] = {}
        self.calls: list[tuple[str, str, dict | None]] = []
        self._seq = 0

    def _mk(self, id_: str, text: str, account: str, in_reply_to: str | None) -> dict:
        self._seq += 1
        return {
            "id": id_,
            "account": {"id": account},
            "created_at": f"2026-01-01T00:00:{self._seq:02d}Z",
            "content": f"<p>{text}</p>",
            "text": text,
            "in_reply_to_id": in_reply_to,
        }

    def seed(self, id_: str, text: str, account: str = "ME", in_reply_to: str | None = None) -> None:
        self.store[id_] = self._mk(id_, text, account, in_reply_to)

    def _request(self, endpoint, data=None, method="GET"):
        self.calls.append((method, endpoint, data))
        parts = endpoint.strip("/").split("/")  # e.g. ["v1","statuses","5","source"]
        if method == "GET":
            if parts[:2] == ["v1", "accounts"] and parts[2] == "verify_credentials":
                return {"id": self._account_id}
            if parts[:2] == ["v1", "statuses"] and len(parts) == 3:
                return self.store[parts[2]]
            if parts[:2] == ["v1", "statuses"] and parts[3:] == ["context"]:
                pid = parts[2]
                return {"descendants": [s for s in self.store.values() if s["in_reply_to_id"] == pid]}
            if parts[:2] == ["v1", "statuses"] and parts[3:] == ["source"]:
                return {"text": self.store[parts[2]]["text"]}
            raise AssertionError(f"unhandled GET {endpoint}")
        if method == "POST" and parts == ["v1", "statuses"]:
            assert data is not None
            new_id = f"n{self._seq + 1}"
            rec = self._mk(new_id, data["status"], self._account_id, data.get("in_reply_to_id"))
            self.store[new_id] = rec
            return rec
        if method == "PUT" and parts[:2] == ["v1", "statuses"] and len(parts) == 3:
            assert data is not None
            rec = self.store[parts[2]]
            rec["text"] = data["status"]
            rec["content"] = f"<p>{data['status']}</p>"
            return rec
        if method == "DELETE" and parts[:2] == ["v1", "statuses"] and len(parts) == 3:
            self.store.pop(parts[2], None)
            return {}
        raise AssertionError(f"unhandled {method} {endpoint}")


# --- request shaping -------------------------------------------------------


def test_post_shapes_request_and_returns_message():
    c = FakeMastodon()
    msg = c.post("hello")
    assert (msg.id, msg.content, msg.editable) == ("n1", "hello", True)
    assert c.calls[-1] == ("POST", "v1/statuses", {"status": "hello", "visibility": "public"})


def test_post_reply_sets_in_reply_to_id():
    c = FakeMastodon()
    c.post("reply", thread_id="42")
    assert c.calls[-1] == (
        "POST",
        "v1/statuses",
        {"status": "reply", "visibility": "public", "in_reply_to_id": "42"},
    )


def test_post_honors_visibility():
    c = FakeMastodon(visibility="unlisted")
    c.post("quiet")
    assert c.calls[-1][2] == {"status": "quiet", "visibility": "unlisted"}


def test_post_over_limit_raises():
    c = FakeMastodon()
    with pytest.raises(ValueError, match="500 char limit"):
        c.post("x" * 501)


def test_post_at_limit_ok():
    c = FakeMastodon()
    assert c.post("x" * 500).content == "x" * 500


# --- the differentiator: edit is a real, in-place edit ---------------------


def test_edit_is_real_and_preserves_id():
    c = FakeMastodon()
    c.seed("55", "old")
    msg = c.edit("55", "new")
    assert (msg.id, msg.content, msg.editable) == ("55", "new", True)
    assert c.calls[-1] == ("PUT", "v1/statuses/55", {"status": "new"})


def test_edit_over_limit_raises():
    c = FakeMastodon()
    with pytest.raises(ValueError, match="500 char limit"):
        c.edit("1", "x" * 501)


def test_delete():
    c = FakeMastodon()
    c.seed("9", "bye")
    c.delete("9")
    assert c.calls[-1] == ("DELETE", "v1/statuses/9", None)
    assert "9" not in c.store


# --- list_messages: ours (source text, editable) vs foreign (HTML, frozen) --


def test_list_messages_ours_vs_foreign():
    c = FakeMastodon(account_id="ME")
    c.seed("op", "Root post", account="ME")
    c.seed("r1", "My reply", account="ME", in_reply_to="op")
    c.seed("r2", "stranger reply", account="OTHER", in_reply_to="op")
    # r2's rendered HTML differs from its source text to prove the HTML path.
    c.store["r2"]["content"] = "<p>stranger <a href='x'>reply</a></p>"

    msgs = c.list_messages("op")
    assert [(m.id, m.content, m.editable) for m in msgs] == [
        ("op", "Root post", True),
        ("r1", "My reply", True),
        ("r2", "stranger reply", False),
    ]


# --- sync end-to-end: edit in place, no delete+repost fallback -------------


def test_sync_edits_in_place_no_repost():
    """A changed reply becomes one EDIT (id preserved) — not delete+repost."""
    c = FakeMastodon()
    c.seed("1", "Root", in_reply_to=None)
    c.seed("2", "Reply", in_reply_to="1")

    result = sync(c, Thread(messages=["Root", "New reply"]), thread_id="1")
    assert [a.type for a in result.actions] == [ActionType.SKIP, ActionType.EDIT]
    assert result.message_ids == ["1", "2"]
    assert c.store["2"]["text"] == "New reply"
    # A PUT happened; no status was ever deleted.
    assert any(m == "PUT" for m, _, _ in c.calls)
    assert not any(m == "DELETE" for m, _, _ in c.calls)


def test_sync_creates_flat_thread():
    """New thread → OP post, then a reply addressing the OP (flat threading)."""
    c = FakeMastodon()
    result = sync(c, Thread(messages=["A", "B"]))
    assert [a.type for a in result.actions] == [ActionType.POST, ActionType.POST]
    op_id, reply_id = result.message_ids
    assert c.store[reply_id]["in_reply_to_id"] == op_id


# --- protocol-parity guards ------------------------------------------------


@pytest.mark.parametrize("kwargs", [
    {"username": "Custom"},
    {"icon_url": "https://cdn.example/x.png"},
    {"icon_emoji": ":wave:"},
])
def test_post_raises_on_sender_override(kwargs):
    c = FakeMastodon()
    with pytest.raises(NotImplementedError, match="per-message sender"):
        c.post("hi", **kwargs)


def test_post_raises_on_images():
    c = FakeMastodon()
    with pytest.raises(NotImplementedError, match="image attachments"):
        c.post("hi", images=[Image(url="https://cdn.example/x.png")])


def test_edit_raises_on_images():
    c = FakeMastodon()
    with pytest.raises(NotImplementedError, match="image attachments"):
        c.edit("1", "hi", images=[Image(url="https://cdn.example/x.png")])


# --- html→text helper ------------------------------------------------------


def test_html_to_text_paragraphs_and_breaks():
    html = "<p>First line.</p><p>Second<br>third</p>"
    assert _html_to_text(html) == "First line.\n\nSecond\nthird"


def test_html_to_text_unescapes_entities_and_strips_tags():
    html = "<p>a &amp; b <a href=\"x\">link</a> &lt;ok&gt;</p>"
    assert _html_to_text(html) == "a & b link <ok>"
