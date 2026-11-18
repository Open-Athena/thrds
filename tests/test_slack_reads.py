"""Python parity with the TS toolkit's reads and metadata writes.

`post` / `edit` take ``metadata=``; history and thread reads paginate and ask
for ``include_all_metadata``; `iter_channel_history(include_replies=True)`
descends into threads; `find_by_metadata` finds a bot's own tagged message.
"""
from __future__ import annotations

from thrds.slack import SlackClient


class _ScriptedSlack(SlackClient):
    """`_request` answers from per-(endpoint, ts, cursor) pages; every call is recorded."""
    def __init__(self, pages: dict[tuple[str, str | None, str | None], dict]):
        super().__init__(token="xoxb-test", channel="C1")
        self.pages = pages
        self.calls: list[tuple[str, dict]] = []

    def _request(self, endpoint, data=None, method="POST"):
        self.calls.append((endpoint, data))
        if endpoint in ("chat.postMessage", "chat.update"):
            return {"ok": True, "ts": data.get("ts", "9.000000")}
        return self.pages[(endpoint, data.get("ts"), data.get("cursor"))]


def _page(*tss: str, cursor: str | None = None, replies: dict[str, int] = {}, md: dict[str, dict] = {}) -> dict:
    msgs = []
    for ts in tss:
        m: dict = {"ts": ts, "text": f"m{ts}"}
        if ts in replies:
            m["reply_count"] = replies[ts]
        if ts in md:
            m["metadata"] = md[ts]
        msgs.append(m)
    return {"ok": True, "messages": msgs, "response_metadata": {"next_cursor": cursor or ""}}


H, R = "conversations.history", "conversations.replies"


def test_post_and_edit_send_metadata():
    client = _ScriptedSlack({})
    md = {"event_type": "watchy_event", "event_payload": {"id": 7, "date": "2026-11-18"}}
    client.post("hi", raw=True, metadata=md)
    client.edit("9.000000", "hi2", raw=True, metadata=md)
    assert client.calls == [
        ("chat.postMessage", {"channel": "C1", "text": "hi", "unfurl_links": False, "unfurl_media": False, "metadata": md}),
        ("chat.update", {"channel": "C1", "ts": "9.000000", "text": "hi2", "unfurl_links": False, "unfurl_media": False, "metadata": md}),
    ]


def test_history_paginates_with_metadata_and_stops_at_limit():
    client = _ScriptedSlack({
        (H, None, None): _page("5.0", "4.0", cursor="c2"),
        (H, None, "c2"): _page("3.0", "2.0", cursor="c3"),
        (H, None, "c3"): _page("1.0"),
    })
    assert [m["ts"] for m in client.list_channel_history("C1", limit=3)] == ["5.0", "4.0", "3.0"]
    # Third page never requested: the iterator stops once `limit` is reached.
    assert client.calls == [
        (H, {"channel": "C1", "limit": 3, "include_all_metadata": True}),
        (H, {"channel": "C1", "limit": 3, "include_all_metadata": True, "cursor": "c2"}),
    ]
    client.calls.clear()
    assert [m["ts"] for m in client.list_channel_history("C1", limit=None, oldest="0.5")] == ["5.0", "4.0", "3.0", "2.0", "1.0"]
    assert [c[1].get("cursor") for c in client.calls] == [None, "c2", "c3"]
    assert client.calls[0] == (H, {"channel": "C1", "oldest": "0.5", "limit": 200, "include_all_metadata": True})


def test_history_include_replies_descends_into_threads():
    client = _ScriptedSlack({
        (H, None, None): _page("3.0", "2.0", "1.0", replies={"2.0": 3}),
        (R, "2.0", None): _page("2.0", "2.1", cursor="r2"),
        (R, "2.0", "r2"): _page("2.2", "2.3"),
    })
    assert [m["ts"] for m in client.list_channel_history("C1", limit=None, include_replies=True)] == [
        "3.0", "2.0", "2.1", "2.2", "2.3", "1.0",
    ]


def test_thread_reads_paginate():
    client = _ScriptedSlack({
        (R, "1.0", None): _page("1.0", "1.1", cursor="r2"),
        (R, "1.0", "r2"): _page("1.2"),
    })
    client._bot_ids = ("UBOT", "BBOT")
    assert [m["ts"] for m in client.list_thread_raw("C1", "1.0")] == ["1.0", "1.1", "1.2"]
    assert [m.id for m in client.list_messages("1.0")] == ["1.0", "1.1", "1.2"]


def test_find_by_metadata_in_replies_and_threads():
    tag = lambda i: {"event_type": "watchy_event", "event_payload": {"id": i}}
    client = _ScriptedSlack({
        (H, None, None): _page("3.0", "2.0", replies={"2.0": 1}, md={"3.0": {"event_type": "other", "event_payload": {"id": 2}}}),
        (R, "2.0", None): _page("2.0", "2.1", md={"2.1": tag(2)}),
    })
    assert client.find_by_metadata("watchy_event", lambda p: p["id"] == 2) is None
    found = client.find_by_metadata("watchy_event", lambda p: p["id"] == 2, include_replies=True)
    assert found == {"ts": "2.1", "text": "m2.1", "metadata": tag(2)}
    assert client.find_by_metadata("watchy_event", thread_ts="2.0") == found
