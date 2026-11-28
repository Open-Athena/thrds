"""Bulk rewrite: find → plan → apply over an app's existing Slack messages (`specs/done/bulk-rewrite.md`)."""
from __future__ import annotations

import json

import pytest

from thrds.rewrite import (
    Content,
    Desired,
    Found,
    Kind,
    Plan,
    PlannedAction,
    Sender,
    Skip,
    Status,
    apply,
    find_history,
    find_ids,
    find_thread,
    plan,
    same_content,
    sendable,
    substitute,
)
from thrds.slack import SlackApiError, SlackClient, fallback_text

US, BOT = "UBOT", "BBOT"


def slack_stored(v):
    """``v`` as Slack stores what an app sent: ``&`` as ``&amp;``, and mrkdwn text objects with ``verbatim: false``."""
    if isinstance(v, str):
        return v.replace("&", "&amp;")
    if isinstance(v, list):
        return [slack_stored(x) for x in v]
    if isinstance(v, dict):
        out = {k: slack_stored(x) for k, x in v.items()}
        if v.get("type") == "mrkdwn":
            out.setdefault("verbatim", False)
        return out
    return v


class FakeChannel(SlackClient):
    """One channel's messages in memory; reads page, writes are recorded in ``writes``."""

    def __init__(self, token: str = "xoxb-test"):
        super().__init__(token=token, channel="C1")
        self._bot_ids = (US, BOT)
        self.msgs: dict[str, dict] = {}
        self.writes: list[tuple[str, dict]] = []
        self.next_ts = 100

    def add(self, ts: str, text: str, *, thread_ts: str | None = None, ours: bool = True, **extra) -> dict:
        m: dict = {"ts": ts, "text": text, **extra}
        if ours:
            m["bot_id"] = BOT
        else:
            m["user"] = "UHUMAN"
        if thread_ts is not None:
            m["thread_ts"] = thread_ts
            parent = self.msgs[thread_ts]
            parent["thread_ts"] = thread_ts
            parent["reply_count"] = parent.get("reply_count", 0) + 1
        self.msgs[ts] = m
        return m

    def _top(self) -> list[dict]:
        return sorted(
            (m for m in self.msgs.values() if m.get("thread_ts") in (None, m["ts"])),
            key=lambda m: float(m["ts"]),
            reverse=True,
        )

    def _thread(self, ts: str) -> list[dict]:
        return sorted(
            (m for m in self.msgs.values() if m["ts"] == ts or m.get("thread_ts") == ts),
            key=lambda m: float(m["ts"]),
        )

    @staticmethod
    def _page(items: list[dict], data: dict) -> dict:
        start = int(data.get("cursor") or 0)
        limit = data.get("limit", 200)
        end = start + limit
        cursor = str(end) if end < len(items) else ""
        return {"ok": True, "messages": [dict(m) for m in items[start:end]], "response_metadata": {"next_cursor": cursor}}

    def _request(self, endpoint, data=None, method="POST"):
        data = dict(data or {})
        if endpoint == "conversations.history":
            items = [
                m for m in self._top()
                if ("oldest" not in data or float(m["ts"]) > float(data["oldest"]))
                and ("latest" not in data or float(m["ts"]) < float(data["latest"]))
            ]
            return self._page(items, data)
        if endpoint == "conversations.replies":
            m = self.msgs.get(data["ts"])
            if m is None:
                raise SlackApiError(endpoint, "thread_not_found")
            if m.get("thread_ts") not in (None, m["ts"]):
                return {"ok": True, "messages": [dict(m)], "response_metadata": {"next_cursor": ""}}
            return self._page(self._thread(m["ts"]), data)
        self.writes.append((endpoint, data))
        if endpoint == "chat.update":
            m = self.msgs[data["ts"]]
            m["text"] = slack_stored(data["text"])
            if "blocks" in data:
                if data["blocks"]:
                    m["blocks"] = [{"block_id": f"b{i}", **slack_stored(b)} for i, b in enumerate(data["blocks"])]
                else:
                    m.pop("blocks", None)
            if "file_ids" in data:
                m["files"] = [{"id": i} for i in data["file_ids"]]
            return {"ok": True, "ts": data["ts"]}
        if endpoint == "chat.postMessage":
            ts = f"{self.next_ts}.0"
            self.next_ts += 1
            extra = {k: data[k] for k in ("blocks", "metadata") if k in data}
            if "username" in data or "icon_emoji" in data or "icon_url" in data:
                extra["subtype"] = "bot_message"
                if "username" in data:
                    extra["username"] = data["username"]
                if "icon_emoji" in data:
                    extra["icons"] = {"emoji": data["icon_emoji"]}
                if "icon_url" in data:
                    extra["icons"] = {"image_48": data["icon_url"]}
            self.add(ts, data["text"], thread_ts=data.get("thread_ts"), **extra)
            return {"ok": True, "ts": ts}
        if endpoint == "chat.delete":
            m = self.msgs.pop(data["ts"], None)
            if m is None:
                raise SlackApiError(endpoint, "message_not_found")
            parent = m.get("thread_ts")
            if parent not in (None, m["ts"]):
                self.msgs[parent]["reply_count"] -= 1
            return {"ok": True}
        raise AssertionError(f"unexpected {endpoint}")


SECTION = {"type": "section", "text": {"type": "mrkdwn", "text": ":old: build"}}
RICH = {"type": "rich_text", "block_id": "r1", "elements": [{"type": "rich_text_section", "elements": [{"type": "emoji", "name": "old"}]}]}
DIGEST = Sender(username="Digest", icon_emoji=":bar_chart:")


@pytest.fixture
def ch() -> FakeChannel:
    c = FakeChannel()
    c.add("1.0", ":old: one")
    c.add("2.0", ":old: two", blocks=[RICH])
    c.add("2.1", ":old: reply", thread_ts="2.0")
    c.add("2.2", "a person's reply :old:", thread_ts="2.0", ours=False)
    c.add("3.0", "nothing to change")
    c.add("4.0", "fallback :old:", blocks=[{"block_id": "s0", **SECTION}])
    c.add("5.0", "a person :old:", ours=False)
    return c


def found_view(fs: list[Found]) -> list[tuple]:
    return [(f.ts, f.thread_ts, f.ours, f.last, f.reply_count) for f in fs]


def test_find_history_own_messages_with_thread_positions(ch):
    assert found_view(find_history(ch)) == [
        ("4.0", None, True, False, 0),
        ("3.0", None, True, False, 0),
        ("2.0", None, True, False, 2),
        ("1.0", None, True, False, 0),
    ]
    assert found_view(find_history(ch, include_replies=True, include_foreign=True)) == [
        ("5.0", None, False, True, 0),
        ("4.0", None, True, False, 0),
        ("3.0", None, True, False, 0),
        ("2.0", None, True, False, 2),
        ("2.1", "2.0", True, False, 0),
        ("2.2", "2.0", False, True, 0),
        ("1.0", None, True, False, 0),
    ]
    # Bounded by `latest`: the newest in range isn't the channel's newest.
    assert found_view(find_history(ch, latest="4.5")) == [
        ("4.0", None, True, False, 0),
        ("3.0", None, True, False, 0),
        ("2.0", None, True, False, 2),
        ("1.0", None, True, False, 0),
    ]


def test_find_thread_and_ids(ch):
    assert found_view(find_thread(ch, "2.0")) == [("2.0", None, True, False, 2), ("2.1", "2.0", True, False, 0)]
    assert found_view(find_ids(ch, ["2.2", "5.0", "2.1"])) == [
        ("2.2", "2.0", False, True, 0),
        ("5.0", None, False, True, 0),
        ("2.1", "2.0", True, False, 0),
    ]
    with pytest.raises(LookupError, match="no message 9.0 in C1"):
        find_ids(ch, ["9.0"])


def kinds(p: Plan) -> list[tuple[str, str, str | None]]:
    return [(a.ts, a.kind.value, a.reason) for a in p.actions]


def test_substitute_plans_edits_noops_and_blocks_others(ch):
    p = plan(find_history(ch, include_replies=True, include_foreign=True), substitute({":old:": ":new:"}))
    assert kinds(p) == [
        ("5.0", "blocked", "another app's or a person's message"),
        ("4.0", "edit", None),
        ("3.0", "noop", None),
        ("2.0", "edit", None),
        ("2.1", "edit", None),
        ("2.2", "blocked", "another app's or a person's message"),
        ("1.0", "edit", None),
    ]
    by_ts = {a.ts: a for a in p.actions}
    # Section blocks are substituted (block ids kept); rich_text-only blocks drop, so Slack re-derives them.
    assert by_ts["4.0"].new == Content(
        text="fallback :new:",
        blocks=[{"block_id": "s0", "type": "section", "text": {"type": "mrkdwn", "text": ":new: build"}}],
    )
    assert by_ts["2.0"].new == Content(text=":new: two", blocks=None)
    assert p.counts() == {"edit": 4, "repost": 0, "post": 0, "delete": 0, "noop": 1, "skip": 0, "blocked": 2}


# r2's November digest OP (2026-11-23), trimmed: Slack stored the text one line with `&amp;`, the section with
# `&amp;` and `verbatim: false`, and the image with the fields it measured. The digest renders the same message
# with `&`, newlines, and none of Slack's fields.
R2_LINK = "<https://openathena.slack.com/archives/C0C9J6CE8BD/p1792161450872609?thread_ts=1792161450.872609&cid=C0C9J6CE8BD|← October>"
R2_IMAGE = "https://78c8fa4d.oa-r2-usage-icons.pages.dev/plot-44e86ce2c3df3d0ceff5b79f6bc8b9e0.png?v=1795394377"
R2_WANT_TEXT = f"*−1.1 TB* <https://r2.oa.dev/|dashboard>\n_as of 11/22 23:22Z_\n\n_Weekly summaries_\n{R2_LINK}"
R2_WANT_BLOCKS = [
    {"type": "section", "text": {"type": "mrkdwn", "text": R2_WANT_TEXT}},
    {"type": "image", "image_url": R2_IMAGE, "alt_text": "Open Athena R2 — November 2026"},
]
R2_LIVE = {
    "text": R2_WANT_TEXT.replace("\n", " ").replace("&", "&amp;"),
    "blocks": [
        {"type": "section", "block_id": "/rQqq", "text": {"type": "mrkdwn", "text": R2_WANT_TEXT.replace("&", "&amp;"), "verbatim": False}},
        {
            "type": "image", "block_id": "wiYSm", "image_url": R2_IMAGE, "alt_text": "Open Athena R2 — November 2026",
            "image_width": 1350, "image_height": 1251, "image_bytes": 88415, "fallback": "1350x1251px image", "is_animated": True,
        },
    ],
}


def test_compares_content_as_slack_stores_it():
    ch = FakeChannel()
    ch.add("1.0", **R2_LIVE)
    p = plan(find_ids(ch, ["1.0"]), lambda f: Desired(R2_WANT_TEXT, R2_WANT_BLOCKS))
    assert kinds(p) == [("1.0", "noop", None)]
    # A different image URL (another deploy's host) is a real change.
    moved = [R2_WANT_BLOCKS[0], {**R2_WANT_BLOCKS[1], "image_url": R2_IMAGE.replace("78c8fa4d", "c5fbca09")}]
    p = plan(find_ids(ch, ["1.0"]), lambda f: Desired(R2_WANT_TEXT, moved))
    assert kinds(p) == [("1.0", "edit", None)]
    # Applied, Slack stores it escaped again; a re-run sees it's already there.
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, pace=0).outcomes] == [("1.0", "done")]
    assert ch.msgs["1.0"]["text"] == R2_WANT_TEXT.replace("&", "&amp;")
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, pace=0).outcomes] == [("1.0", "already")]


# Two paragraphs of 30 lines × 70 chars: 4,260 chars, over the 4,000 on `text`; each paragraph fits a section.
LONG_ROWS = [f"{i:02d} " + "p" * 67 for i in range(60)]
LONG = "\n".join(LONG_ROWS[:30]) + "\n\n" + "\n".join(LONG_ROWS[30:])
LONG_SECTIONS = [
    {"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(LONG_ROWS[:30])}},
    {"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(LONG_ROWS[30:])}},
]
LONG_IMAGE = {"type": "image", "image_url": "https://example.com/plot.png", "alt_text": "plot"}
# Sendable, but over 50 sections.
LONG_MANY = "\n\n".join("q" * 2999 for _ in range(51))
# Over 4,000, with a line over the 3,000-char section limit.
LONG_LINE = "x" * 3001 + "\n" + "y" * 1500


def test_sendable():
    assert sendable("short", None) == ("short", None)
    assert sendable(LONG, [*LONG_SECTIONS, LONG_IMAGE]) == (fallback_text(LONG), [*LONG_SECTIONS, LONG_IMAGE])
    assert sendable(LONG, None) == (fallback_text(LONG), LONG_SECTIONS)
    with pytest.raises(ValueError, match=r"^Message body has a line over Slack's 3000-char section limit \(3001 chars\)$"):
        sendable(LONG_LINE, None)
    with pytest.raises(ValueError, match=r"^new text is 153049 chars, 51 sections over Slack's 50 blocks$"):
        sendable(LONG_MANY, None)


def test_long_text_plans_as_post_and_edit_send_it():
    ch = FakeChannel()
    for ts in ("1.0", "2.0", "3.0", "4.0", "5.0"):
        ch.add(ts, "short")
    # Written by `SlackClient.edit`: sections and the capped fallback.
    ch.edit("1.0", f"{LONG}\n\n![plot]({LONG_IMAGE['image_url']})")
    ch.edit("2.0", LONG)
    ch.writes.clear()
    want = {
        "1.0": Desired(LONG, [*LONG_SECTIONS, LONG_IMAGE]),
        "2.0": Desired(LONG),
        "3.0": Desired(LONG),
        "4.0": Desired(LONG_LINE),
        "5.0": Desired(LONG_MANY),
    }
    p = plan(find_ids(ch, list(want)), lambda f: want[f.ts])
    assert kinds(p) == [
        ("1.0", "noop", None),
        ("2.0", "noop", None),
        ("3.0", "edit", None),
        ("4.0", "blocked", "Message body has a line over Slack's 3000-char section limit (3001 chars)"),
        ("5.0", "blocked", "new text is 153049 chars, 51 sections over Slack's 50 blocks"),
    ]
    by_ts = {a.ts: a for a in p.actions}
    assert by_ts["3.0"].new == Content(fallback_text(LONG), blocks=LONG_SECTIONS)
    assert by_ts["4.0"].new == Content(LONG_LINE)
    report = apply(p, ch, dry_run=False, pace=0)
    assert [(o.ts, o.status.value) for o in report.outcomes] == [("3.0", "done")]
    assert ch.writes == [("chat.update", {"channel": "C1", "ts": "3.0", "text": fallback_text(LONG), "blocks": LONG_SECTIONS})]
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, pace=0).outcomes] == [("3.0", "already")]


# `same_content` cases; also TS parity fixtures (`scripts/rewrite_ts_fixtures.py`).
SAME_CASES = [
    (Content(R2_LIVE["text"], blocks=R2_LIVE["blocks"]), Content(R2_WANT_TEXT, blocks=R2_WANT_BLOCKS), True),
    (Content("a &amp; b &lt;x&gt;"), Content("a & b <x>"), True),
    # An entity the app sends means its character; live `&amp;lt;` shows a literal "&lt;".
    (Content("a &lt; b"), Content("a < b"), True),
    (Content("a &amp;lt; b"), Content("a &lt; b"), False),
    # Without blocks the text is what renders: whitespace counts.
    (Content("a b"), Content("a\nb"), False),
    (Content("a &amp; b", blocks=[RICH]), Content("a & b"), True),
    # With blocks the text is the fallback: whitespace runs don't count, words do.
    (Content("fb  one", blocks=[SECTION]), Content("fb\n\none", blocks=[SECTION]), True),
    (Content("fb one", blocks=[SECTION]), Content("fb two", blocks=[SECTION]), False),
    (Content("fb", blocks=[{"type": "header", "text": {"type": "plain_text", "text": "h", "emoji": True}}]),
     Content("fb", blocks=[{"type": "header", "text": {"type": "plain_text", "text": "h"}}]), True),
    (Content("fb", blocks=[{"type": "header", "text": {"type": "plain_text", "text": "h", "emoji": False}}]),
     Content("fb", blocks=[{"type": "header", "text": {"type": "plain_text", "text": "h"}}]), False),
    (Content("fb", blocks=[{"type": "section", "text": {"type": "mrkdwn", "text": "x", "verbatim": True}}]),
     Content("fb", blocks=[{"type": "section", "text": {"type": "mrkdwn", "text": "x"}}]), False),
    # Image fields count on an image block, not elsewhere.
    (Content("fb", blocks=[{"type": "section", "fallback": "x"}]), Content("fb", blocks=[{"type": "section"}]), False),
    (Content("a", sender=DIGEST), Content("a"), False),
]


@pytest.mark.parametrize("live, want, same", SAME_CASES)
def test_same_content(live, want, same):
    assert same_content(live, want) is same


def test_substitute_renames_emoji_elements_in_non_rich_text_blocks():
    f = Found("C1", "1.0", None, Content(":old:", blocks=[
        {"type": "context", "elements": [{"type": "emoji", "name": "old"}, {"type": "mrkdwn", "text": ":old:"}]},
    ]), ours=True, last=True)
    assert substitute({":old:": ":new:"})(f) == Desired(":new:", blocks=[
        {"type": "context", "elements": [{"type": "emoji", "name": "new"}, {"type": "mrkdwn", "text": ":new:"}]},
    ])


def test_sender_changes_repost_only_where_slack_allows(ch):
    ch.add("6.0", "newest", files=[{"id": "F1"}])
    ch.add("6.1", "last reply", thread_ts="2.0")

    def render(f: Found) -> Desired | Skip:
        if f.ts == "3.0":
            return Skip("not a digest")
        return Desired(f.text, blocks=f.blocks, sender=DIGEST)

    p = plan(find_history(ch, include_replies=True), render)
    assert kinds(p) == [
        ("6.0", "blocked", "the sender changes to an override, and Slack shows no files on those"),
        ("4.0", "blocked", "the sender changes, and a repost would move it to the end of its channel"),
        ("3.0", "skip", "not a digest"),
        ("2.0", "blocked", "the sender changes, and a repost would orphan its 3 replies"),
        ("2.1", "blocked", "the sender changes, and a repost would move it to the end of its thread"),
        ("6.1", "repost", None),
        ("1.0", "blocked", "the sender changes, and a repost would move it to the end of its channel"),
    ]
    reorder = plan(find_history(ch), render, reorder_ok=True)
    assert [(a.ts, a.kind.value) for a in reorder.actions] == [
        ("6.0", "blocked"), ("4.0", "repost"), ("3.0", "skip"), ("2.0", "blocked"), ("1.0", "repost"),
    ]


def test_plan_json_round_trips_and_checks_hashes(ch):
    p = plan(find_history(ch, include_replies=True, include_foreign=True), substitute({":old:": ":new:"}))
    d = json.loads(json.dumps(p.to_json()))
    assert Plan.from_json(d) == p
    assert d["actions"][1] == {
        "kind": "edit",
        "channel": "C1",
        "ts": "4.0",
        "thread_ts": None,
        "hash": p.actions[1].hash,
        "old": {
            "text": "fallback :old:",
            "blocks": [{"block_id": "s0", **SECTION}],
            "sender": {"username": None, "icon_url": None, "icon_emoji": None},
            "files": [],
        },
        "new": {
            "text": "fallback :new:",
            "blocks": [{"block_id": "s0", "type": "section", "text": {"type": "mrkdwn", "text": ":new: build"}}],
            "sender": {"username": None, "icon_url": None, "icon_emoji": None},
            "files": [],
        },
        "reason": None,
    }
    d["actions"][1]["old"]["text"] = "edited by hand"
    with pytest.raises(ValueError, match=r"plan action 4\.0: recorded hash \w+ doesn't match its old content"):
        Plan.from_json(d)
    with pytest.raises(ValueError, match="not a thrds rewrite plan"):
        Plan.from_json({"actions": []})


def test_format_preview(ch):
    p = plan(find_thread(ch, "2.0", include_foreign=True), substitute({":old:": ":new:"}))
    assert p.format_preview(color=False).split("\n") == [
        "EDIT 2.0",
        "  -:old: two",
        "  +:new: two",
        "EDIT 2.1 (in 2.0)",
        "  -:old: reply",
        "  +:new: reply",
        "BLOCKED 2.2 (in 2.0): another app's or a person's message",
        "Plan: 2 edit, 1 blocked",
    ]


def test_apply_dry_run_then_real_then_rerun(ch, tmp_path):
    p = plan(find_history(ch, include_replies=True), substitute({":old:": ":new:"}))
    dry = apply(p, ch, pace=0)
    assert ch.writes == []
    assert [(o.ts, o.status.value) for o in dry.outcomes] == [("4.0", "pending"), ("2.0", "pending"), ("2.1", "pending"), ("1.0", "pending")]

    receipts = tmp_path / "receipts.jsonl"
    report = apply(p, ch, dry_run=False, receipts=receipts, pace=0, only=["4.0", "2.0"])
    assert report.format().split("\n") == ["done      edit   4.0", "done      edit   2.0", "Applied: 2 done"]
    assert ch.writes == [
        ("chat.update", {"channel": "C1", "ts": "4.0", "text": "fallback :new:", "blocks": [
            {"block_id": "s0", "type": "section", "text": {"type": "mrkdwn", "text": ":new: build"}},
        ]}),
        ("chat.update", {"channel": "C1", "ts": "2.0", "text": ":new: two", "blocks": []}),
    ]
    assert ch.msgs["2.0"] == {"ts": "2.0", "text": ":new: two", "bot_id": BOT, "thread_ts": "2.0", "reply_count": 2}

    # A re-run skips the receipts, and finds the rest still to do.
    ch.writes.clear()
    again = apply(p, ch, dry_run=False, receipts=receipts, pace=0)
    assert [(o.ts, o.status.value) for o in again.outcomes] == [("4.0", "receipt"), ("2.0", "receipt"), ("2.1", "done"), ("1.0", "done")]
    assert [json.loads(line) for line in receipts.read_text().splitlines()] == [
        {"ts": "4.0", "kind": "edit", "status": "done"},
        {"ts": "2.0", "kind": "edit", "status": "done"},
        {"ts": "2.1", "kind": "edit", "status": "done"},
        {"ts": "1.0", "kind": "edit", "status": "done"},
    ]
    # Without receipts, a re-run sees the new content already there.
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, pace=0).outcomes] == [
        ("4.0", "already"), ("2.0", "already"), ("2.1", "already"), ("1.0", "already"),
    ]


def test_apply_refuses_stale_and_gone(ch):
    p = plan(find_history(ch), substitute({":old:": ":new:"}))
    ch.msgs["4.0"]["text"] = "someone edited this"
    del ch.msgs["1.0"]
    report = apply(p, ch, dry_run=False, pace=0)
    assert report.format().split("\n") == [
        "stale     edit   4.0: changed since planning",
        "done      edit   2.0",
        "gone      edit   1.0",
        "Applied: 1 stale, 1 done, 1 gone",
    ]
    assert [w[1]["ts"] for w in ch.writes] == ["2.0"]


def test_repost_posts_then_deletes_keeping_metadata_and_files():
    ch = FakeChannel()
    ch.add("1.0", "status", metadata={"event_type": "fleet", "event_payload": {"id": 1}})
    ch.add("1.1", "panels", thread_ts="1.0", files=[{"id": "F1"}])
    ch.add("1.2", "latest", thread_ts="1.0", subtype="bot_message", username="Old")

    def render(f: Found) -> Desired:
        if f.ts == "1.0":
            return Desired("status", sender=DIGEST)
        if f.ts == "1.2":
            return Desired("latest", sender=Sender())
        return Desired(f.text)

    p = plan(find_thread(ch, "1.0"), render)
    assert kinds(p) == [
        ("1.0", "blocked", "the sender changes, and a repost would orphan its 2 replies"),
        ("1.1", "noop", None),
        ("1.2", "repost", None),
    ]
    report = apply(p, ch, dry_run=False, pace=0)
    assert [o.to_json() for o in report.outcomes] == [{"ts": "1.2", "kind": "repost", "status": "done", "new_ts": "100.0"}]
    assert ch.writes == [
        ("chat.postMessage", {"channel": "C1", "text": "latest", "unfurl_links": False, "unfurl_media": False, "thread_ts": "1.0"}),
        ("chat.delete", {"channel": "C1", "ts": "1.2"}),
    ]
    assert sorted(ch.msgs) == ["1.0", "1.1", "100.0"]

    # A top-level repost carries the metadata; files re-attach on a plain sender.
    ch2 = FakeChannel()
    ch2.add("1.0", "card", subtype="bot_message", username="Fleet", metadata={"event_type": "fleet", "event_payload": {}}, files=[{"id": "F1"}])
    p2 = plan(find_history(ch2), lambda f: Desired("card", sender=Sender()))
    apply(p2, ch2, dry_run=False, pace=0)
    assert ch2.writes == [
        ("chat.postMessage", {"channel": "C1", "text": "card", "unfurl_links": False, "unfurl_media": False, "metadata": {"event_type": "fleet", "event_payload": {}}}),
        ("chat.update", {"channel": "C1", "ts": "100.0", "text": "card", "file_ids": ["F1"]}),
        ("chat.delete", {"channel": "C1", "ts": "1.0"}),
    ]


def test_repost_turns_stale_when_no_longer_newest():
    ch = FakeChannel()
    ch.add("1.0", "card")
    p = plan(find_history(ch), lambda f: Desired("card", sender=DIGEST))
    assert kinds(p) == [("1.0", "repost", None)]
    ch.add("2.0", "someone posted after")
    report = apply(p, ch, dry_run=False, pace=0)
    assert [o.to_json() for o in report.outcomes] == [
        {"ts": "1.0", "kind": "repost", "status": "stale", "error": "no longer the newest; a repost would move it"},
    ]
    assert ch.writes == []


def test_repost_with_override_on_a_user_token_fails():
    ch = FakeChannel(token="xoxp-test")
    ch.add("1.0", "card")
    p = plan(find_history(ch), lambda f: Desired("card", sender=DIGEST))
    assert [o.to_json() for o in apply(p, ch, dry_run=False, pace=0).outcomes] == [
        {"ts": "1.0", "kind": "repost", "status": "failed", "error": "a sender override needs a bot token (xoxb-…)"},
    ]


def test_render_must_return_desired_or_skip(ch):
    with pytest.raises(TypeError, match=r"render\(4\.0\) returned str, not Desired, Skip or Delete"):
        plan(find_history(ch), lambda f: "oops")


def test_planned_action_from_json_without_hash():
    a = PlannedAction(Kind.EDIT, "C1", "1.0", None, Content("a"), Content("b"))
    d = a.to_json()
    del d["hash"]
    assert PlannedAction.from_json(d) == a
    assert Status("already") is Status.ALREADY


# --- CLI: `thrds slack rewrite {plan,show,apply}` ---

from click.testing import CliRunner  # noqa: E402

from thrds.cli import SLACK_TOKEN_ENV, cli  # noqa: E402


@pytest.fixture
def cli_ch(ch, monkeypatch) -> FakeChannel:
    def factory(*, token, channel):
        ch.channel = channel
        return ch

    monkeypatch.setattr("thrds.cli.SlackClient", factory)
    monkeypatch.setenv(SLACK_TOKEN_ENV, "xoxb-fake")
    return ch


def run(*args: str):
    return CliRunner().invoke(cli, ["slack", "rewrite", *args], catch_exceptions=False)


def test_cli_plan_show_apply(cli_ch, tmp_path):
    out = tmp_path / "plan.json"
    r = run("plan", "-c", "C1", "-t", "2.0", "-f", "-s", ":old:=:new:", "-o", str(out))
    assert r.exit_code == 0
    assert r.stdout == ""
    assert r.stderr.split("\n") == [
        "EDIT 2.0",
        "  -:old: two",
        "  +:new: two",
        "EDIT 2.1 (in 2.0)",
        "  -:old: reply",
        "  +:new: reply",
        "BLOCKED 2.2 (in 2.0): another app's or a person's message",
        "Plan: 2 edit, 1 blocked",
        f"Wrote {out}",
        "",
    ]
    assert Plan.load(out) == plan(find_thread(cli_ch, "2.0", include_foreign=True), substitute({":old:": ":new:"}))

    r = run("show", "-k", "blocked", str(out))
    assert r.stdout.split("\n") == ["BLOCKED 2.2 (in 2.0): another app's or a person's message", "Plan: 2 edit, 1 blocked", ""]
    review = json.loads(run("show", "-j", str(out)).stdout)
    assert [a["diff"].split("\n") for a in review["actions"]] == [
        ["--- 2.0 (now)", "+++ 2.0 (planned)", "@@ -1 +1 @@", "-:old: two", "+:new: two"],
        ["--- 2.1 (now)", "+++ 2.1 (planned)", "@@ -1 +1 @@", "-:old: reply", "+:new: reply"],
        [""],
    ]
    assert review["counts"] == {"edit": 2, "repost": 0, "post": 0, "delete": 0, "noop": 0, "skip": 0, "blocked": 1}

    r = run("apply", str(out))
    assert r.exit_code == 0
    assert r.stderr.split("\n") == ["pending   edit   2.0", "pending   edit   2.1", "Dry run: 2 pending", "Pass -y to write.", ""]
    assert cli_ch.writes == []
    assert not (tmp_path / "plan.receipts.jsonl").exists()

    r = run("apply", "-y", "-p", "0", str(out))
    assert r.stderr.split("\n") == ["done      edit   2.0", "done      edit   2.1", "Applied: 2 done", ""]
    assert [w[1]["ts"] for w in cli_ch.writes] == ["2.0", "2.1"]
    assert [json.loads(line)["ts"] for line in (tmp_path / "plan.receipts.jsonl").read_text().splitlines()] == ["2.0", "2.1"]


def test_cli_plan_render_from_file(cli_ch, tmp_path):
    mod = tmp_path / "myrender.py"
    mod.write_text(
        "from thrds.rewrite import Desired, Skip\n"
        "def render(f):\n"
        "    return Desired(f.text.upper()) if f.ts == '1.0' else Skip('not mine')\n"
    )
    r = run("plan", "-c", "C1", "-r", f"{mod}:render")
    assert r.exit_code == 0
    assert [(a["ts"], a["kind"], a["reason"]) for a in json.loads(r.stdout)["actions"]] == [
        ("4.0", "skip", "not mine"),
        ("3.0", "skip", "not mine"),
        ("2.0", "skip", "not mine"),
        ("1.0", "edit", None),
    ]


def test_cli_plan_argument_errors(cli_ch):
    assert run("plan", "-c", "C1").stderr.split("\n")[-2] == "Error: pass exactly one of -r/--render or -s/--sub"
    assert run("plan", "-c", "C1", "-s", "a=b", "-i", "1.0", "-t", "2.0").stderr.split("\n")[-2] == "Error: -i/--id takes no -t / -a / -b / -w"
    assert run("plan", "-c", "C1", "-s", "nope").stderr.split("\n")[-2] == "Error: Invalid value for -s/--sub: expected OLD=NEW, got 'nope'"
