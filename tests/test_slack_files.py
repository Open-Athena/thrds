"""Uploaded files attached to messages (TS parity: `upload`, `files`, `deleteFile`).

From disky's experiments (TS branch `specs/done/slack-file-replace.md`): only
an attached file offers Download on Slack's phone apps, and ``chat.update``
``file_ids`` swaps it in place.
"""
from __future__ import annotations

import pytest

from thrds.slack import FilesNotAttachedError, SlackApiError, SlackClient


class _Files(SlackClient):
    """Answers the file endpoints; ``unprocessed`` = how many ``files.info``
    reads report no ``mimetype`` yet."""
    def __init__(self, unprocessed: int = 0, delete_error: str | None = None, fail_update: bool = False):
        super().__init__(token="xoxb-t", channel="C1")
        self._bot_ids = ("U1", "B1")
        self.calls: list[tuple[str, dict | None, str]] = []
        self.unprocessed = unprocessed
        self.delete_error = delete_error
        self.fail_update = fail_update

    def _request(self, endpoint, data=None, method="POST"):
        self.calls.append((endpoint, data, method))
        if endpoint == "files.getUploadURLExternal":
            return {"ok": True, "upload_url": "https://files.slack.test/up/1", "file_id": "F1"}
        if endpoint == "files.info":
            if self.unprocessed > 0:
                self.unprocessed -= 1
                return {"ok": True, "file": {"id": data["file"], "mimetype": ""}}
            return {"ok": True, "file": {"id": data["file"], "mimetype": "image/png"}}
        if endpoint == "files.delete" and self.delete_error:
            raise SlackApiError(endpoint, self.delete_error)
        if endpoint == "chat.update" and self.fail_update:
            raise SlackApiError(endpoint, "http_503")
        if endpoint == "chat.postMessage":
            return {"ok": True, "ts": "5.0"}
        return {"ok": True, "ts": (data or {}).get("ts")}


@pytest.fixture
def uploads(monkeypatch):
    sent: list[tuple[str, bytes]] = []

    def _urlopen(req, *a, **k):
        sent.append((req.full_url, req.data))

        class _R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b"OK"
        return _R()

    monkeypatch.setattr("thrds.slack.urllib.request.urlopen", _urlopen)
    return sent


@pytest.fixture
def clock(monkeypatch):
    t = [0.0]
    sleeps: list[float] = []

    def _sleep(s):
        sleeps.append(s)
        t[0] += s

    monkeypatch.setattr("thrds.slack.time.monotonic", lambda: t[0])
    monkeypatch.setattr("thrds.slack.time.sleep", _sleep)
    return sleeps


def test_upload_unshared_and_processed_by_default(uploads):
    c = _Files()
    assert c.upload("fleet.png", b"PNG!", alt_text="fleet") == "F1"
    assert c.calls == [
        ("files.getUploadURLExternal", {"filename": "fleet.png", "length": "4", "alt_txt": "fleet"}, "GET"),
        ("files.completeUploadExternal", {"files": [{"id": "F1"}]}, "POST"),
        ("files.info", {"file": "F1"}, "GET"),
    ]
    assert uploads == [("https://files.slack.test/up/1", b"PNG!")]


def test_upload_shared_into_a_thread_str_as_utf8(uploads):
    c = _Files()
    c.upload("notes.txt", "héllo", channel="C9", initial_comment="notes", thread_ts="1.0", title="Notes", processed=False)
    assert c.calls == [
        ("files.getUploadURLExternal", {"filename": "notes.txt", "length": "6"}, "GET"),
        ("files.completeUploadExternal", {
            "files": [{"id": "F1", "title": "Notes"}],
            "channel_id": "C9", "initial_comment": "notes", "thread_ts": "1.0",
        }, "POST"),
    ]
    assert uploads == [("https://files.slack.test/up/1", "héllo".encode())]


def test_upload_processed_polls_until_mimetype(uploads, clock):
    c = _Files(unprocessed=2)
    assert c.upload("a.png", b"A") == "F1"
    assert [e for e, _, _ in c.calls] == [
        "files.getUploadURLExternal", "files.completeUploadExternal", "files.info", "files.info", "files.info",
    ]
    assert clock == [1.0, 1.0]


def test_upload_processed_times_out(uploads, clock):
    c = _Files(unprocessed=99)
    with pytest.raises(SlackApiError) as e:
        c.upload("a.png", b"A", processed=2.5)
    assert (e.value.endpoint, e.value.code, str(e.value)) == (
        "files.info", "timeout", "Slack file F1 not processed after 2.5s",
    )
    assert clock == [1.0, 1.0]


def test_edit_files_only_when_given_and_empty_detaches():
    c = _Files()
    c.edit("1.0", "card", raw=True, files=["F1"])
    c.edit("1.0", "card", raw=True)
    c.edit("1.0", "card", raw=True, files=[])
    assert [d.get("file_ids") for _, d, _ in c.calls] == [["F1"], None, []]
    assert c.calls[0][1] == {
        "channel": "C1", "ts": "1.0", "text": "card",
        "unfurl_links": False, "unfurl_media": False, "file_ids": ["F1"],
    }


def test_delete_file_tolerates_already_gone():
    _Files(delete_error="file_not_found").delete_file("F1")
    _Files(delete_error="file_deleted").delete_file("F1")
    c = _Files()
    c.delete_file("F1")
    assert c.calls == [("files.delete", {"file": "F1"}, "POST")]
    with pytest.raises(SlackApiError) as e:
        _Files(delete_error="cant_delete_file").delete_file("F1")
    assert (e.value.code, str(e.value)) == ("cant_delete_file", "Slack API error: cant_delete_file")


def test_post_with_files_posts_then_attaches_by_edit():
    c = _Files()
    assert c.post("card", raw=True, files=["F1"]).id == "5.0"
    assert c.calls == [
        ("chat.postMessage", {"channel": "C1", "text": "card", "unfurl_links": False, "unfurl_media": False}, "POST"),
        ("chat.update", {
            "channel": "C1", "ts": "5.0", "text": "card",
            "unfurl_links": False, "unfurl_media": False, "file_ids": ["F1"],
        }, "POST"),
    ]


def test_post_with_files_whose_attach_fails_names_the_posted_ts():
    c = _Files(fail_update=True)
    with pytest.raises(FilesNotAttachedError) as e:
        c.post("card", raw=True, files=["F1"])
    assert (e.value.ts, str(e.value), e.value.__cause__.code) == (
        "5.0", "posted 5.0, but attaching its files failed", "http_503",
    )
