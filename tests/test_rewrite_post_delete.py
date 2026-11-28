"""Rewrite plans' `post` and `delete` actions (`specs/rewrite-post-delete.md`): a thread switched to another set of replies."""
from __future__ import annotations

import json

import pytest

from thrds.rewrite import (
    Content,
    Delete,
    Desired,
    Found,
    Kind,
    Plan,
    PlannedAction,
    Post,
    Skip,
    apply,
    apply_order,
    find_thread,
    plan,
)
from thrds.slack import SlackApiError
from tests.test_rewrite import BOT, DIGEST, FakeChannel


class Refusing(FakeChannel):
    """Refuses to post any message whose text is in ``refuse``."""

    def __init__(self, refuse: set[str] = frozenset(), **kw):
        super().__init__(**kw)
        self.refuse = refuse

    def _request(self, endpoint, data=None, method="POST"):
        if endpoint == "chat.postMessage" and data["text"] in self.refuse:
            self.writes.append((endpoint, dict(data)))
            raise SlackApiError(endpoint, "msg_too_long")
        return super()._request(endpoint, data, method)


def thread(c: FakeChannel) -> FakeChannel:
    """An OP with three daily replies (ours) and a person's reply."""
    c.add("1.0", "November")
    for day in (1, 2, 3):
        c.add(f"1.{day}", f"Nov {day}", thread_ts="1.0")
    c.add("1.4", "nice", thread_ts="1.0", ours=False)
    return c


@pytest.fixture
def ch() -> Refusing:
    return thread(Refusing())


def switch(f: Found) -> Desired | Skip | Delete:
    if f.ts == "1.0":
        return Skip("the OP")
    return Delete("replaced by the weekly replies")


WEEKS = [
    Post("C1", "1.0", Desired("Week 1: Nov 1–2"), key="wk-1"),
    Post("C1", "1.0", Desired("Week 2: Nov 3", sender=DIGEST), key="wk-2"),
]


def kinds(p: Plan) -> list[tuple[str, str, str | None]]:
    return [(a.ts, a.kind.value, a.reason) for a in p.actions]


def test_plan_deletes_and_posts(ch):
    p = plan(find_thread(ch, "1.0", include_foreign=True), switch, posts=WEEKS, delete_after_posts=True, atomic=True)
    assert kinds(p) == [
        ("1.0", "skip", "the OP"),
        ("1.1", "delete", "replaced by the weekly replies"),
        ("1.2", "delete", "replaced by the weekly replies"),
        ("1.3", "delete", "replaced by the weekly replies"),
        ("1.4", "blocked", "another app's or a person's message"),
        ("wk-1", "post", None),
        ("wk-2", "post", None),
    ]
    assert p.summary() == "2 post, 3 delete, 1 skip, 1 blocked"
    d = p.to_json()
    assert (d["thrds_rewrite_plan"], d["delete_after_posts"], d["atomic"]) == (1, True, True)
    assert d["actions"][1] == {
        "kind": "delete", "channel": "C1", "ts": "1.1", "thread_ts": "1.0", "hash": Content("Nov 1").hash,
        "old": {"text": "Nov 1", "blocks": None, "sender": {"username": None, "icon_url": None, "icon_emoji": None}, "files": []},
        "new": None, "reason": "replaced by the weekly replies",
    }
    want = Content("Week 2: Nov 3", sender=DIGEST)
    assert d["actions"][6] == {
        "kind": "post", "channel": "C1", "ts": "wk-2", "thread_ts": "1.0", "hash": want.hash,
        "old": None, "new": want.to_json(), "reason": None,
    }
    assert Plan.from_json(json.loads(json.dumps(d))) == p
    # Every delete runs after the rest, posts included.
    assert [a.ts for a in apply_order(p.actions)] == ["1.0", "1.4", "wk-1", "wk-2", "1.1", "1.2", "1.3"]


def test_post_keys():
    same = Desired("same")
    p = plan([], switch, posts=[Post("C1", None, same), Post("C1", "1.0", same), Post("C1", None, Desired("other"), broadcast=True)])
    h = Content("same").hash
    assert [(a.ts, a.thread_ts, a.broadcast) for a in p.actions] == [
        (f"post-{h}", None, False), (f"post-{h}-2", "1.0", False), (f"post-{Content('other').hash}", None, False),
    ]
    # Re-planning the same content gives the same keys.
    assert [a.ts for a in plan([], switch, posts=[Post("C1", None, same), Post("C1", "1.0", same)]).actions] == [f"post-{h}", f"post-{h}-2"]
    with pytest.raises(ValueError, match=r"^post key '1\.5' looks like a message ts$"):
        plan([], switch, posts=[Post("C1", None, same, key="1.5")])
    with pytest.raises(ValueError, match=r"^post key 'a' is already an id in the plan$"):
        plan([], switch, posts=[Post("C1", None, same, key="a"), Post("C1", None, same, key="a")])


def test_a_delete_with_replies_is_blocked(ch):
    p = plan(find_thread(ch, "1.0"), lambda f: Delete(), posts=[])
    assert kinds(p) == [
        ("1.0", "blocked", "a delete would orphan its 4 replies"),
        ("1.1", "delete", None), ("1.2", "delete", None), ("1.3", "delete", None),
    ]


def test_a_post_over_slacks_limits_is_blocked():
    p = plan([], switch, posts=[Post("C1", None, Desired("x" * 3001 + "\n" + "y" * 1000), key="long")])
    assert kinds(p) == [("long", "blocked", "Message body has a line over Slack's 3000-char section limit (3001 chars)")]
    assert p.actions[0].old is None and not p.actions[0].writes


@pytest.mark.parametrize("change, error", [
    (lambda d: d["actions"][0].update(hash="0" * 16), "plan action wk-1: recorded hash 0000000000000000 doesn't match its new content ("),
    (lambda d: d["actions"].append(dict(d["actions"][0])), "plan actions share ids: wk-1"),
    (lambda d: d["actions"][0].update(old=d["actions"][0]["new"]), "plan action wk-1: a post with old content"),
    (lambda d: d["actions"][0].update(new=None), "plan action wk-1: neither old nor new content"),
])
def test_plan_json_checks_posts(change, error):
    d = plan([], switch, posts=WEEKS[:1]).to_json()
    change(d)
    with pytest.raises(ValueError) as e:
        Plan.from_json(d)
    assert str(e.value)[:len(error)] == error


def test_format_preview(ch):
    p = plan(find_thread(ch, "1.0"), switch, posts=WEEKS)
    assert p.format_preview(color=False).split("\n") == [
        "SKIP 1.0: the OP",
        "DELETE 1.1 (in 1.0): replaced by the weekly replies",
        "  -Nov 1",
        "DELETE 1.2 (in 1.0): replaced by the weekly replies",
        "  -Nov 2",
        "DELETE 1.3 (in 1.0): replaced by the weekly replies",
        "  -Nov 3",
        "POST wk-1 (in 1.0)",
        "  +Week 1: Nov 1–2",
        "POST wk-2 (in 1.0)",
        '  sender: "Digest" :bar_chart:',
        "  +Week 2: Nov 3",
        "Plan: 2 post, 3 delete, 1 skip",
    ]


def receipts_of(path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_apply_posts_before_deletes_then_rerun(ch, tmp_path):
    p = plan(find_thread(ch, "1.0"), switch, posts=WEEKS)
    dry = apply(p, ch, pace=0)
    assert [(o.ts, o.status.value) for o in dry.outcomes] == [
        ("wk-1", "pending"), ("wk-2", "pending"), ("1.1", "pending"), ("1.2", "pending"), ("1.3", "pending"),
    ]
    assert ch.writes == []
    with pytest.raises(ValueError, match=r"^a real run with posts needs receipts \(a re-run would post again\)$"):
        apply(p, ch, dry_run=False, pace=0)
    assert ch.writes == []

    receipts = tmp_path / "r.jsonl"
    report = apply(p, ch, dry_run=False, receipts=receipts, pace=0)
    assert report.format().split("\n") == [
        "done      post   wk-1 → 100.0",
        "done      post   wk-2 → 101.0",
        "done      delete 1.1",
        "done      delete 1.2",
        "done      delete 1.3",
        "Applied: 5 done",
    ]
    assert report.posted == {"wk-1": "100.0", "wk-2": "101.0"}
    assert ch.writes == [
        ("chat.postMessage", {"channel": "C1", "text": "Week 1: Nov 1–2", "unfurl_links": False, "unfurl_media": False, "thread_ts": "1.0"}),
        ("chat.postMessage", {
            "channel": "C1", "text": "Week 2: Nov 3", "unfurl_links": False, "unfurl_media": False, "thread_ts": "1.0",
            "username": "Digest", "icon_emoji": ":bar_chart:",
        }),
        ("chat.delete", {"channel": "C1", "ts": "1.1"}),
        ("chat.delete", {"channel": "C1", "ts": "1.2"}),
        ("chat.delete", {"channel": "C1", "ts": "1.3"}),
    ]
    assert [(m["ts"], m["text"]) for m in ch._thread("1.0")] == [
        ("1.0", "November"), ("1.4", "nice"), ("100.0", "Week 1: Nov 1–2"), ("101.0", "Week 2: Nov 3"),
    ]
    assert receipts_of(receipts) == [
        {"ts": "wk-1", "kind": "post", "status": "done", "new_ts": "100.0"},
        {"ts": "wk-2", "kind": "post", "status": "done", "new_ts": "101.0"},
        {"ts": "1.1", "kind": "delete", "status": "done"},
        {"ts": "1.2", "kind": "delete", "status": "done"},
        {"ts": "1.3", "kind": "delete", "status": "done"},
    ]

    # A re-run posts nothing twice, and still reports what was posted.
    ch.writes.clear()
    again = apply(p, ch, dry_run=False, receipts=receipts, pace=0)
    assert [(o.ts, o.status.value, o.new_ts) for o in again.outcomes] == [
        ("wk-1", "receipt", "100.0"), ("wk-2", "receipt", "101.0"), ("1.1", "receipt", None), ("1.2", "receipt", None), ("1.3", "receipt", None),
    ]
    assert again.posted == {"wk-1": "100.0", "wk-2": "101.0"}
    assert ch.writes == []
    # Without receipts, each delete finds its message gone.
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, pace=0, only=["1.1", "1.2", "1.3"]).outcomes] == [
        ("1.1", "gone"), ("1.2", "gone"), ("1.3", "gone"),
    ]


def test_a_failed_post_holds_the_deletes(tmp_path):
    ch = thread(Refusing({"Week 2: Nov 3"}))
    receipts = tmp_path / "r.jsonl"
    report = apply(plan(find_thread(ch, "1.0"), switch, posts=WEEKS), ch, dry_run=False, receipts=receipts, pace=0)
    assert report.format().split("\n") == [
        "done      post   wk-1 → 100.0",
        "failed    post   wk-2: msg_too_long",
        "pending   delete 1.1: held: post wk-2 not done",
        "pending   delete 1.2: held: post wk-2 not done",
        "pending   delete 1.3: held: post wk-2 not done",
        "Applied: 1 done, 1 failed, 3 pending",
    ]
    assert [w[0] for w in ch.writes] == ["chat.postMessage", "chat.postMessage"]
    assert receipts_of(receipts) == [
        {"ts": "wk-1", "kind": "post", "status": "done", "new_ts": "100.0"},
        {"ts": "wk-2", "kind": "post", "status": "failed", "error": "msg_too_long"},
    ]


def test_delete_after_posts_waits_across_runs(ch, tmp_path):
    p = plan(find_thread(ch, "1.0"), switch, posts=WEEKS, delete_after_posts=True)
    receipts = tmp_path / "r.jsonl"
    # A batch of deletes before the posts' batch: held.
    first = apply(p, ch, dry_run=False, receipts=receipts, pace=0, only=["1.1", "1.2"])
    assert [(o.ts, o.status.value, o.error) for o in first.outcomes] == [
        ("1.1", "pending", "held: post wk-1, wk-2 not done"), ("1.2", "pending", "held: post wk-1, wk-2 not done"),
    ]
    # A dry run checks the deletes against their messages regardless.
    assert [o.status.value for o in apply(p, ch, receipts=receipts, pace=0, only=["1.1", "1.2"]).outcomes] == ["pending", "pending"]
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, receipts=receipts, pace=0, only=["wk-1"]).outcomes] == [("wk-1", "done")]
    assert [o.error for o in apply(p, ch, dry_run=False, receipts=receipts, pace=0, only=["1.1"]).outcomes] == ["held: post wk-2 not done"]
    assert [(o.ts, o.status.value) for o in apply(p, ch, dry_run=False, receipts=receipts, pace=0, only=["wk-2", "1.1", "1.2", "1.3"]).outcomes] == [
        ("wk-2", "done"), ("1.1", "done"), ("1.2", "done"), ("1.3", "done"),
    ]
    assert [w[0] for w in ch.writes] == ["chat.postMessage", "chat.postMessage", "chat.delete", "chat.delete", "chat.delete"]


def test_delete_refuses_a_changed_message(ch):
    p = plan(find_thread(ch, "1.0"), switch)
    ch.msgs["1.1"]["text"] = "Nov 1, edited"
    ch.msgs["1.3"]["reply_count"] = 1
    del ch.msgs["1.2"]
    report = apply(p, ch, dry_run=False, pace=0)
    assert [(o.ts, o.status.value, o.error) for o in report.outcomes] == [
        ("1.1", "stale", "changed since planning"),
        ("1.2", "gone", None),
        ("1.3", "stale", "now has 1 replies"),
    ]
    assert ch.writes == []


def test_post_checks_its_thread_and_token(tmp_path):
    ch = thread(Refusing(token="xoxp-user"))
    p = plan([], switch, posts=[*WEEKS, Post("C1", "9.0", Desired("into nothing"), key="lost")])
    assert [(o.ts, o.status.value, o.error) for o in apply(p, ch, dry_run=False, receipts=tmp_path / "r.jsonl", pace=0).outcomes] == [
        ("wk-1", "done", None),
        ("wk-2", "failed", "a sender override needs a bot token (xoxb-…)"),
        ("lost", "gone", "its thread 9.0 is gone"),
    ]
    assert ch.msgs["100.0"] == {"ts": "100.0", "text": "Week 1: Nov 1–2", "bot_id": BOT, "thread_ts": "1.0"}


def test_planned_action_kinds():
    post = PlannedAction(Kind.POST, "C1", "k", None, None, Content("x"))
    assert (post.writes, post.is_new, post.hash, post.diff().split("\n")) == (True, True, Content("x").hash, ["--- k (now)", "+++ k (planned)", "@@ -0,0 +1 @@", "+x"])
    delete = PlannedAction(Kind.DELETE, "C1", "1.0", None, Content("y"))
    assert (delete.writes, delete.is_new, delete.diff().split("\n")) == (True, False, ["--- 1.0 (now)", "+++ 1.0 (planned)", "@@ -1 +0,0 @@", "-y"])
