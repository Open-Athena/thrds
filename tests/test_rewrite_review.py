"""`slck rewrite review`'s server: the plan, check / apply on selected actions, and its request guards."""
from __future__ import annotations

import json
import threading
import urllib.request
from urllib.error import HTTPError

import pytest

from thrds.rewrite import apply, find_history, plan, substitute
from thrds.rewrite_review import DIST_DIR, serve

from .test_rewrite import FakeChannel, ch  # noqa: F401  (fixture)


@pytest.fixture
def server(ch, tmp_path):  # noqa: F811
    plan_path = tmp_path / "plan.json"
    plan(find_history(ch, include_replies=True), substitute({":old:": ":new:"})).save(plan_path)
    receipts = tmp_path / "plan.receipts.jsonl"
    srv = serve(plan_path, 0, lambda p, ids, dry_run: apply(p, ch, dry_run=dry_run, only=ids, receipts=receipts, pace=0).outcomes)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", ch, receipts
    srv.shutdown()
    srv.server_close()


def request(url: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, dict | bytes]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            status = resp.status
            ctype = resp.headers.get("Content-Type", "")
    except HTTPError as e:
        raw, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "")
    return status, json.loads(raw) if ctype.startswith("application/json") else raw


def test_serves_the_page_and_the_plan(server):
    base, _, _ = server
    status, page = request(f"{base}/")
    assert (status, page) == (200, (DIST_DIR / "index.html").read_bytes())
    status, body = request(f"{base}/plan")
    assert status == 200
    assert body["path"] == "plan.json"
    assert [(a["ts"], a["kind"]) for a in body["plan"]["actions"]] == [("4.0", "edit"), ("3.0", "noop"), ("2.0", "edit"), ("2.1", "edit"), ("1.0", "edit")]
    assert body["plan"]["counts"] == {"edit": 4, "repost": 0, "post": 0, "delete": 0, "noop": 1, "skip": 0, "blocked": 0}
    assert request(f"{base}/../pyproject.toml")[0] == 404


def test_check_then_apply_selected(server):
    base, ch, receipts = server
    assert request(f"{base}/check", {"ids": ["2.0", "1.0"]}) == (200, {"outcomes": [
        {"ts": "2.0", "kind": "edit", "status": "pending"},
        {"ts": "1.0", "kind": "edit", "status": "pending"},
    ], "posted": {}})
    assert ch.writes == []
    assert not receipts.exists()
    assert request(f"{base}/apply", {"ids": ["1.0"]}) == (200, {"outcomes": [{"ts": "1.0", "kind": "edit", "status": "done"}], "posted": {}})
    assert ch.writes == [("chat.update", {"channel": "C1", "ts": "1.0", "text": ":new: one", "blocks": []})]
    assert [json.loads(line) for line in receipts.read_text().splitlines()] == [{"ts": "1.0", "kind": "edit", "status": "done"}]


def test_rejects_bad_requests(server):
    base, ch, _ = server
    assert request(f"{base}/apply", {"ids": ["3.0", "9.0"]}) == (400, {"error": "not writes in this plan: 3.0, 9.0"})
    assert request(f"{base}/apply", {"ids": "1.0"}) == (400, {"error": "bad request: ids must be a list of strings"})
    assert request(f"{base}/apply", {"ids": ["1.0"]}, {"Content-Type": "text/plain"}) == (415, {"error": "expected Content-Type: application/json"})
    assert request(f"{base}/apply", {"ids": ["1.0"]}, {"Origin": "https://evil.example"}) == (403, {"error": "cross-origin request from https://evil.example"})
    assert request(f"{base}/nope", {"ids": []}) == (404, {"error": "not found: /nope"})
    assert ch.writes == []
