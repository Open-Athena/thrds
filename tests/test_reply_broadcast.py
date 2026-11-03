"""`SlackClient.post(broadcast=…)` → `reply_broadcast` (specs/done/slack-reply-broadcast.md).

A thread reply posted with ``broadcast=True`` also surfaces in the channel
(Slack's "Also send to channel"); the flag is Slack-specific, so every other
transport raises on ``broadcast=True``.
"""
from __future__ import annotations

import pytest

from thrds.discord import DiscordClient, DiscordHybridClient, DiscordWebhookClient
from thrds.mastodon import MastodonClient
from thrds.slack import SlackClient


class _FakeSlackClient(SlackClient):
    """SlackClient with `chat.postMessage` stubbed; records the exact wire data."""
    def __init__(self):
        super().__init__(token="xoxb-test", channel="C0")
        self.posted: list[dict] = []

    def _request(self, endpoint, data=None, method="POST"):
        assert endpoint == "chat.postMessage"
        self.posted.append(data)
        return {"ok": True, "ts": "1.222"}


def test_post_reply_broadcast_wire_payload():
    client = _FakeSlackClient()
    msg = client.post("hi", thread_id="1.111", broadcast=True)
    assert client.posted == [{
        "channel": "C0",
        "text": "hi",
        "unfurl_links": False,
        "unfurl_media": False,
        "thread_ts": "1.111",
        "reply_broadcast": True,
    }]
    assert (msg.id, msg.content) == ("1.222", "hi")


def test_post_reply_without_broadcast_omits_flag():
    """``broadcast=False`` (default) sends today's payload, byte for byte — no flag."""
    client = _FakeSlackClient()
    client.post("hi", thread_id="1.111")
    assert client.posted == [{
        "channel": "C0",
        "text": "hi",
        "unfurl_links": False,
        "unfurl_media": False,
        "thread_ts": "1.111",
    }]


def test_broadcast_without_thread_id_raises():
    client = _FakeSlackClient()
    with pytest.raises(ValueError) as exc:
        client.post("hi", broadcast=True)
    assert str(exc.value) == (
        "broadcast=True requires a thread_id: Slack's reply_broadcast "
        "('Also send to channel') only applies to a thread reply."
    )
    assert client.posted == []


def test_broadcast_false_without_thread_id_is_fine():
    """A top-level post with the default ``broadcast=False`` is unaffected."""
    client = _FakeSlackClient()
    client.post("hi")
    assert client.posted == [{
        "channel": "C0",
        "text": "hi",
        "unfurl_links": False,
        "unfurl_media": False,
    }]


_ANALOGUE = "{} has no `reply_broadcast` analogue (`broadcast=` is Slack-specific)."


@pytest.mark.parametrize("make_client, expected", [
    (lambda: MastodonClient.__new__(MastodonClient), _ANALOGUE.format("Mastodon")),
    (lambda: DiscordClient.__new__(DiscordClient), _ANALOGUE.format("Discord")),
    (lambda: DiscordWebhookClient.__new__(DiscordWebhookClient), _ANALOGUE.format("Discord")),
    (lambda: DiscordHybridClient.__new__(DiscordHybridClient), _ANALOGUE.format("Discord")),
])
def test_non_slack_transports_raise_on_broadcast(make_client, expected):
    """Every non-Slack transport rejects ``broadcast=True`` before touching the wire."""
    client = make_client()
    with pytest.raises(NotImplementedError) as exc:
        client.post("hi", thread_id="x", broadcast=True)
    assert str(exc.value) == expected


def test_bsky_raises_on_broadcast():
    """Bluesky too, behind the optional `atproto` extra (skipped if absent)."""
    pytest.importorskip("atproto")
    from thrds.bsky import BskyClient
    client = BskyClient.__new__(BskyClient)
    with pytest.raises(NotImplementedError) as exc:
        client.post("hi", thread_id="x", broadcast=True)
    assert str(exc.value) == _ANALOGUE.format("Bluesky")
