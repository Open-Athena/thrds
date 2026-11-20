"""Lazy image upload on Slack (`Image(path=…)`), `specs/slack-lazy-image-upload.md`.

A local-`path` image hashes its bytes, uploads via the three-step external flow,
and lands as a `slack_file` image block whose `alt_text` carries the sha — so
the content marker `![alt](slackfile:<sha>)` round-trips and a converge
re-uploads iff the bytes change. `_request` (Slack API) and the raw upload PUT
are stubbed; each test asserts exact call shapes.
"""
from __future__ import annotations

import hashlib

import pytest

from thrds.core import Image, Msg, Thread
from thrds.imageblock import from_block, image_line
from thrds.slack import SlackClient

PNG = b"\x89PNG\r\n\x1a\nfake-bytes"
SHA = hashlib.sha256(PNG).hexdigest()[:16]


class _FakeSlack(SlackClient):
    """Records `_request` calls, canned responses; captures raw upload PUTs and
    the file ids handed to `completeUploadExternal`."""
    def __init__(self, history=None):
        super().__init__(token="xoxb-t", channel="C_TARGET")
        self._bot_ids = ("U1", "B1")  # pre-seed so no auth.test call in the trace
        self.calls: list[tuple[str, dict | None, str]] = []
        self.uploaded_bytes: list[bytes] = []
        self._history = history or []
        self._n = 0

    def _request(self, endpoint, data=None, method="POST"):
        self.calls.append((endpoint, data, method))
        if endpoint == "files.getUploadURLExternal":
            self._n += 1
            return {"ok": True, "upload_url": f"https://files.slack.test/up/{self._n}",
                    "file_id": f"F{self._n}"}
        if endpoint == "files.completeUploadExternal":
            return {"ok": True}
        if endpoint == "files.info":
            return {"ok": True, "file": {"id": data["file"], "mimetype": "image/png", "thumb_64": "https://t/64"}}
        if endpoint == "chat.postMessage":
            self._n += 1
            return {"ts": f"{self._n}.000", "channel": "C_TARGET"}
        if endpoint == "chat.update":
            return {"ts": data.get("ts"), "channel": "C_TARGET"}
        if endpoint == "conversations.replies":
            return {"ok": True, "messages": self._history}
        raise NotImplementedError(endpoint)


@pytest.fixture
def fake(monkeypatch):
    f = _FakeSlack()

    def _put(req, *a, **k):
        f.uploaded_bytes.append(req.data)

        class _R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b""
        return _R()

    monkeypatch.setattr("thrds.slack.urllib.request.urlopen", _put)
    return f


def _last_post(fake) -> dict:
    endpoint, data, _ = next(c for c in reversed(fake.calls) if c[0] == "chat.postMessage")
    assert endpoint == "chat.postMessage"
    return data


def test_path_image_uploads_and_builds_slack_file_block(fake, tmp_path):
    png = tmp_path / "plot.png"
    png.write_bytes(PNG)
    fake.post("August usage", images=[Image(path=png, alt="usage")])

    # Three-step upload, then a wait for Slack to process the file (a
    # `slack_file` block on an unprocessed file is `invalid_blocks`), then the post.
    endpoints = [c[0] for c in fake.calls]
    assert endpoints == [
        "files.getUploadURLExternal",
        "files.completeUploadExternal",
        "files.info",
        "chat.postMessage",
    ]
    assert fake.calls[0][1] == {"filename": "plot.png", "length": str(len(PNG))}
    assert fake.calls[1][1] == {"files": [{"id": "F1"}]}
    assert fake.uploaded_bytes == [PNG]
    # The message carries a slack_file block whose alt_text holds the renderable
    # marker (real path + sha fragment).
    data = _last_post(fake)
    assert data["blocks"][-1] == {
        "type": "image", "slack_file": {"id": "F1"},
        "alt_text": f"usage⁣{png}#thrds_sha={SHA}",
    }
    # And the block round-trips back to the human-readable content marker.
    assert image_line(from_block(data["blocks"][-1])) == f"![usage]({png}#thrds_sha={SHA})"


def test_non_image_suffix_raises(fake, tmp_path):
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(PNG)
    with pytest.raises(ValueError, match="supports"):
        fake.post("x", images=[Image(path=pdf)])
    assert fake.calls == []  # nothing uploaded


def test_same_image_uploads_once_per_push(fake, tmp_path):
    png = tmp_path / "p.png"
    png.write_bytes(PNG)
    im = Image(path=png, alt="p")
    fake.sync(Thread(messages=[
        Msg("OP", images=[im]),
        Msg("reply also has it", images=[im]),
    ]))
    # Two messages, same bytes → exactly one upload (deduped by sha).
    assert [c[0] for c in fake.calls].count("files.getUploadURLExternal") == 1


def test_repush_unchanged_image_is_skip_no_reupload(fake, tmp_path):
    png = tmp_path / "p.png"
    png.write_bytes(PNG)
    # Live thread already holds our OP whose block reconstructs the same marker.
    live_block = {"type": "image", "slack_file": {"id": "F0"},
                  "alt_text": f"cap⁣{png}#thrds_sha={SHA}"}
    fake._history = [{
        "ts": "100.000", "bot_id": "B1",
        "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": "caption"}},
            live_block,
        ],
        "text": "caption",
    }]
    monkeyres = fake.sync(
        Thread(messages=[Msg("caption", images=[Image(path=png, alt="cap")])]),
        thread_ts="100.000",
    )
    # No upload, no post/update — the desired marker matches the live read-back.
    assert [c[0] for c in fake.calls] == ["conversations.replies"]
    assert monkeyres.actions[0].type.name == "SKIP"
