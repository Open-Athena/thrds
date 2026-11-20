"""Uploaded files attached to messages (TS parity: `upload`, `files`, `deleteFile`).

From disky's experiments (TS branch `specs/done/slack-file-replace.md`): only
an attached file offers Download on Slack's phone apps, and ``chat.update``
``file_ids`` swaps it in place.
"""
from __future__ import annotations

import pytest

from urllib.error import HTTPError, URLError

from thrds.slack import (
    FileNotProcessedError,
    FileSpec,
    FileSwapError,
    FilesSwap,
    FilesNotAttachedError,
    SlackApiError,
    SlackClient,
    hash53_bytes,
    is_processed,
)


class _Files(SlackClient):
    """Answers the file endpoints; ``unprocessed`` = how many ``files.info``
    reads report no ``mimetype`` yet. ``update_error`` fails ``chat.update``;
    ``live_files`` are the files ``conversations.replies`` shows on ``1.0``."""
    def __init__(
        self,
        unprocessed: int = 0,
        delete_error: str | None = None,
        fail_update: bool = False,
        update_error: Exception | None = None,
        live_files: list[str] = [],
        live_hashes: list[str] | None = None,
        fail_upload: str | None = None,
    ):
        super().__init__(token="xoxb-t", channel="C1")
        self._bot_ids = ("U1", "B1")
        self.calls: list[tuple[str, dict | None, str]] = []
        self.unprocessed = unprocessed
        self.delete_error = delete_error
        self.fail_update = fail_update
        self.update_error = update_error
        self.live_files = live_files
        self.live_hashes = live_hashes
        self.fail_upload = fail_upload
        self.n = 0

    def _request(self, endpoint, data=None, method="POST"):
        self.calls.append((endpoint, data, method))
        if endpoint == "files.getUploadURLExternal":
            if data["filename"] == self.fail_upload:
                raise SlackApiError(endpoint, "invalid_name")
            self.n += 1
            return {"ok": True, "upload_url": f"https://files.slack.test/up/{self.n}", "file_id": f"F{self.n}"}
        if endpoint == "files.info":
            if self.unprocessed > 0:
                self.unprocessed -= 1
                return {"ok": True, "file": {"id": data["file"], "mimetype": ""}}
            return {"ok": True, "file": {"id": data["file"], "mimetype": "image/png", "thumb_64": "https://t/64"}}
        if endpoint == "files.delete" and self.delete_error:
            raise SlackApiError(endpoint, self.delete_error)
        if endpoint == "chat.update" and self.fail_update:
            raise SlackApiError(endpoint, "http_503")
        if endpoint == "chat.update" and self.update_error is not None:
            raise self.update_error
        if endpoint == "conversations.replies":
            m: dict = {"ts": "1.0", "files": [{"id": f} for f in self.live_files]}
            if self.live_hashes is not None:
                m["metadata"] = {"event_type": "thrds", "event_payload": {"thrds_files": self.live_hashes}}
            return {"ok": True, "messages": [m]}
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
    assert clock == [0.5, 0.5]


def test_upload_processed_times_out_and_deletes_the_unshared_file(uploads, clock):
    c = _Files(unprocessed=99)
    with pytest.raises(FileNotProcessedError) as e:
        c.upload("a.png", b"A", processed=2.5)
    assert (e.value.file_id, e.value.waited, e.value.deleted, str(e.value)) == (
        "F1", 2.5, True, "Slack hadn't processed file F1 after 2.5 s (deleted it)",
    )
    assert clock == [0.5, 0.5, 0.5, 0.5, 0.5]
    assert c.calls[-1] == ("files.delete", {"file": "F1"}, "POST")


def test_upload_poll_count_bounds_a_frozen_clock(uploads, monkeypatch):
    monkeypatch.setattr("thrds.slack.time.sleep", lambda s: None)
    c = _Files(unprocessed=99)
    with pytest.raises(FileNotProcessedError):
        c.upload("a.png", b"A", processed=2.0)
    assert [e for e, _, _ in c.calls].count("files.info") == 5


def test_is_processed_needs_thumbnails_for_images():
    assert [
        is_processed({"mimetype": ""}),
        is_processed({"mimetype": "image/png"}),
        is_processed({"mimetype": "image/png", "thumb_64": "u"}),
        is_processed({"mimetype": "image/png", "thumb_tiny": "x"}),
        is_processed({"mimetype": "text/plain"}),
    ] == [False, False, True, False, True]


def test_upload_post_retries_5xx_429_and_timeouts_but_not_4xx(monkeypatch, clock):
    outcomes = [
        HTTPError("u", 504, "Gateway Timeout", None, None),
        HTTPError("u", 429, "Too Many", {"Retry-After": "3"}, None),
        URLError(TimeoutError("timed out")),
        None,
    ]

    def _urlopen(req, *a, **k):
        o = outcomes.pop(0)
        if o is not None:
            raise o

        class _R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b"OK"
        return _R()

    monkeypatch.setattr("thrds.slack.urllib.request.urlopen", _urlopen)
    assert _Files().upload("a.png", b"A", processed=False) == "F1"
    assert clock == [1.0, 3.0, 4.0]
    outcomes[:] = [HTTPError("u", 413, "Too Large", None, None)]
    with pytest.raises(SlackApiError) as e:
        _Files().upload("a.png", b"A", processed=False)
    assert (e.value.code, e.value.definite) == ("http_413", True)


def test_definite():
    assert [SlackApiError("x", c).definite for c in ("msg_too_long", "http_400", "http_503", "timeout", "transport_error")] == [
        True, True, False, False, False,
    ]


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


def _stamp(*datas: bytes) -> dict:
    return {"event_type": "thrds", "event_payload": {"thrds_files": [hash53_bytes(d) for d in datas]}}


def test_hash53_bytes_matches_the_ts_toolkit():
    # Reference values from TS `hash53Bytes` (src/hash.ts), so `thrds_files` dedupes across both.
    assert [hash53_bytes(s.encode()) for s in ("", "a", "png-2", "héllo")] == [
        "0bdcb81aee8d83", "1c2ba782c97901", "1b6bc876e8bb86", "07ff2cfafac5c0",
    ]
    assert hash53_bytes(bytes((i * 37) % 256 for i in range(1000))) == "0a479fabee104f"


def test_replace_file_swaps_and_deletes_the_previous_only_after_the_edit(uploads):
    c = _Files(live_files=["F0"])
    swap = c.replace_file("1.0", "fleet.png", b"PNG", "card", raw=True)
    assert (swap, swap.file_id) == (FilesSwap(file_ids=["F1"], uploaded=["F1"], deleted=["F0"]), "F1")
    assert [(e, d) for e, d, _ in c.calls] == [
        ("conversations.replies", {"channel": "C1", "ts": "1.0", "limit": 1, "include_all_metadata": True}),
        ("files.getUploadURLExternal", {"filename": "fleet.png", "length": "3"}),
        ("files.completeUploadExternal", {"files": [{"id": "F1"}]}),
        ("files.info", {"file": "F1"}),
        ("chat.update", {
            "channel": "C1", "ts": "1.0", "text": "card",
            "unfurl_links": False, "unfurl_media": False,
            "metadata": _stamp(b"PNG"), "file_ids": ["F1"],
        }),
        ("files.delete", {"file": "F0"}),
    ]


def test_replace_files_reuses_by_hash_keeps_order_and_deletes_dropped(uploads):
    c = _Files(live_files=["Fa", "Fb", "Fc"], live_hashes=[hash53_bytes(x) for x in (b"a", b"b", b"c")])
    swap = c.replace_files("1.0", [("c.png", b"c"), FileSpec("a.png", b"a"), ("b2.png", b"b2")], "card", raw=True)
    assert swap == FilesSwap(file_ids=["Fc", "Fa", "F1"], uploaded=["F1"], deleted=["Fb"])
    update = next(d for e, d, _ in c.calls if e == "chat.update")
    assert (update["file_ids"], update["metadata"]) == (["Fc", "Fa", "F1"], _stamp(b"c", b"a", b"b2"))


def test_replace_files_without_hashes_uploads_everything_and_merges_metadata(uploads):
    c = _Files(live_files=["Fa"])
    swap = c.replace_files(
        "1.0", [("a.png", b"a")], "card", raw=True,
        metadata={"event_type": "fleet", "event_payload": {"run": 7}},
    )
    update = next(d for e, d, _ in c.calls if e == "chat.update")
    assert (swap, update["metadata"]) == (
        FilesSwap(file_ids=["F1"], uploaded=["F1"], deleted=["Fa"]),
        {"event_type": "fleet", "event_payload": {"run": 7, "thrds_files": [hash53_bytes(b"a")]}},
    )


def test_replace_files_upload_failing_partway_deletes_this_runs_uploads(uploads):
    c = _Files(live_files=["F0"], fail_upload="c.png")
    with pytest.raises(SlackApiError) as e:
        c.replace_files("1.0", [("a.png", b"a"), ("b.png", b"b"), ("c.png", b"c")], "card", raw=True)
    assert e.value.code == "invalid_name"
    assert [d for ep, d, _ in c.calls if ep in ("files.delete", "chat.update")] == [{"file": "F1"}, {"file": "F2"}]


@pytest.mark.parametrize("error, deleted, message", [
    (SlackApiError("chat.update", "msg_too_long"), True, "attaching file F1 failed (deleted the upload)"),
    (SlackApiError("chat.update", "http_503"), False, "attaching file F1 failed (kept the upload: the write may have landed)"),
])
def test_replace_file_failed_edit(uploads, error, deleted, message):
    c = _Files(update_error=error)
    with pytest.raises(FileSwapError) as e:
        c.replace_file("1.0", "fleet.png", b"PNG", "card", raw=True, previous=[("F0", None)])
    assert (e.value.file_ids, e.value.file_id, e.value.deleted, str(e.value), e.value.__cause__) == (
        ["F1"], "F1", deleted, message, error,
    )
    # The previous file is never touched; the new one is deleted only when Slack refused the edit.
    assert [d for ep, d, _ in c.calls if ep == "files.delete"] == ([{"file": "F1"}] if deleted else [])


def test_replace_files_failed_edit_without_uploads_reraises(uploads):
    error = SlackApiError("chat.update", "msg_too_long")
    c = _Files(update_error=error, live_files=["Fa"], live_hashes=[hash53_bytes(b"a")])
    with pytest.raises(SlackApiError) as e:
        c.replace_files("1.0", [("a.png", b"a")], "card v2", raw=True)
    assert e.value is error
    assert [ep for ep, _, _ in c.calls] == ["conversations.replies", "chat.update"]


def test_replace_file_reports_undeletable_previous_files(uploads):
    c = _Files(delete_error="cant_delete_file")
    swap = c.replace_file("1.0", "fleet.png", b"PNG", "card", raw=True, previous=[("F0", None)])
    assert (swap.file_ids, swap.deleted, [(i, e.code) for i, e in swap.undeleted]) == (["F1"], [], [("F0", "cant_delete_file")])
