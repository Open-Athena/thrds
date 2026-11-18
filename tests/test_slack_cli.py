"""Tests for `thrds slack …` CRUD subgroup (``specs/done/slack-crud-cli.md``).

Six verbs (`history`, `thread`, `rm`, `post`, `edit`, `permalink`) wrap
`SlackClient` methods one-to-one; tests assert:

- the CLI calls the right client method with the right args,
- the rendered output shape (table vs `--json`),
- channel resolution (`#name` / `C…` id / bare name) reaches the client,
- the raw-by-default flag polarity (`-m/--markdown` opts INTO conversion).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest
from click.testing import CliRunner

from thrds.cli import SLACK_TOKEN_ENV, cli
from thrds.core import OrphanedRepliesError


@dataclass
class CrudSpy:
    """SlackClient stand-in for CRUD-verb tests.

    Records every method the CLI calls plus the args; scripts return values
    per-test. Only the surface `slack_cli` actually touches is stubbed —
    doc-sync methods raise if reached.
    """
    token: str = ""
    channel: str = ""
    raw: bool = False
    # Scripted returns.
    history_returns: list[dict] = field(default_factory=list)
    thread_returns: list[dict] = field(default_factory=list)
    channels_by_name: dict[str, str] = field(default_factory=dict)
    permalink_returns: str = "https://example.slack.com/archives/CX/pXXX"
    post_returns_id: str = "1.999999"
    # Delete: script per-ts behavior. Key = ts. Value = None (ok) or Exception (raise).
    delete_by_ts: dict[str, object] = field(default_factory=dict)
    # Call log.
    history_calls: list[dict] = field(default_factory=list)
    thread_calls: list[dict] = field(default_factory=list)
    post_calls: list[dict] = field(default_factory=list)
    edit_calls: list[dict] = field(default_factory=list)
    delete_calls: list[dict] = field(default_factory=list)
    permalink_calls: list[str] = field(default_factory=list)

    def __init__(self, *, token: str, channel: str):
        self.token = token
        self.channel = channel
        self.raw = False
        self.history_returns = []
        self.thread_returns = []
        self.channels_by_name = {}
        self.permalink_returns = "https://example.slack.com/archives/CX/pXXX"
        self.post_returns_id = "1.999999"
        self.delete_by_ts = {}
        self.history_calls = []
        self.thread_calls = []
        self.post_calls = []
        self.edit_calls = []
        self.delete_calls = []
        self.permalink_calls = []

    # --- surface the CLI uses ---
    def list_channels_by_name(self) -> dict[str, str]:
        return dict(self.channels_by_name)

    def list_channel_history(self, channel: str, limit: int | None = 20, *, include_replies: bool = False) -> list[dict]:
        self.history_calls.append({"channel": channel, "limit": limit, "include_replies": include_replies})
        return list(self.history_returns)

    def list_thread_raw(self, channel: str, thread_ts: str) -> list[dict]:
        self.thread_calls.append({"channel": channel, "thread_ts": thread_ts})
        return list(self.thread_returns)

    def post(self, content, thread_id=None, *, username=None, icon_url=None, icon_emoji=None, images=(), raw=None):
        self.post_calls.append({
            "content": content, "thread_id": thread_id,
            "username": username, "icon_url": icon_url, "icon_emoji": icon_emoji,
            "raw": raw, "channel": self.channel,
        })
        from thrds import Message
        return Message(id=self.post_returns_id, content=content)

    def edit(self, message_id, content, *, images=(), raw=None):
        self.edit_calls.append({
            "message_id": message_id, "content": content, "raw": raw,
            "channel": self.channel,
        })
        from thrds import Message
        return Message(id=message_id, content=content)

    def delete(self, message_id, orphans_ok: bool = False) -> None:
        self.delete_calls.append({
            "message_id": message_id, "orphans_ok": orphans_ok,
            "channel": self.channel,
        })
        outcome = self.delete_by_ts.get(message_id)
        if isinstance(outcome, Exception):
            raise outcome

    def permalink(self, message_ts: str) -> str:
        self.permalink_calls.append(message_ts)
        return self.permalink_returns


@pytest.fixture
def spy(monkeypatch):
    """A single spy instance reused across every `_make_slack_client` call.

    The CLI reconstructs a `SlackClient` per verb invocation, but for
    unit tests we want state (scripted returns, call log) to persist
    across multiple `_run(...)` calls within one test. The factory
    returns the same spy each time; it just updates `channel` per call
    to match what a real client construction would set. This diverges
    from `test_cli.py`'s per-invocation spy (fine there — those tests
    are one-invocation each).
    """
    the_spy = CrudSpy(token="xoxp-fake", channel="")

    def factory(*, token, channel):
        the_spy.token = token
        the_spy.channel = channel
        return the_spy

    monkeypatch.setattr("thrds.cli.SlackClient", factory)
    monkeypatch.setenv(SLACK_TOKEN_ENV, "xoxp-fake")
    return the_spy


def _run(*args) -> object:
    """Invoke `thrds slack …` with `catch_exceptions=False` so bugs surface.

    Click 8.2+ separates the streams into `result.stdout` and `result.stderr`;
    `result.output` still mixes both (kept for back-compat). Tests that need
    to prove a line went to stderr (not stdout) — e.g. `rm`'s per-ts failure
    reporting — assert against `result.stdout` explicitly.
    """
    return CliRunner().invoke(cli, ["slack", *args], catch_exceptions=False)


# --- history ---

def test_history_default_limit_and_table_output(spy):
    """`thrds slack history CH` → limit=20, table rows aligned by widest sender."""
    spy.history_returns = [
        {"ts": "1.000000", "user": "U0AB1CD", "text": "hi"},
        {"ts": "1.000001", "username": "GCS usage — 2026", "text": "line1\nline2"},
    ]
    result = _run("history", "C_TEST")
    assert result.exit_code == 0, (result.output, result.stderr)
    assert spy.history_calls[-1] == {"channel": "C_TEST", "limit": 20, "include_replies": False}
    # Column width padded to longest sender ("GCS usage — 2026" = 16 chars).
    assert result.output.rstrip().split("\n") == [
        "1.000000  U0AB1CD           hi",
        "1.000001  GCS usage — 2026  line1",
    ]


def test_history_respects_limit_flag(spy):
    _run("history", "-n", "5", "C_TEST")
    _run("history", "-n", "0", "-r", "C_TEST")
    assert spy.history_calls[-2:] == [
        {"channel": "C_TEST", "limit": 5, "include_replies": False},
        {"channel": "C_TEST", "limit": None, "include_replies": True},
    ]


def test_history_json_emits_raw_dicts(spy):
    """`-j/--json` bypasses table rendering; stdout is `json.loads`-able."""
    spy.history_returns = [{"ts": "1.0", "user": "U1", "text": "a"}]
    result = _run("history", "-j", "C_TEST")
    assert result.exit_code == 0, (result.output, result.stderr)
    assert json.loads(result.output) == [{"ts": "1.0", "user": "U1", "text": "a"}]


def test_history_first_line_of_multiline_text(spy):
    """Multiline `text` → first non-empty line in the table row."""
    spy.history_returns = [{"ts": "1.0", "user": "U", "text": "\n\nfirst real line\nsecond"}]
    result = _run("history", "C_TEST")
    assert result.output.rstrip() == "1.0  U  first real line"


def test_history_long_line_truncated_with_ellipsis(spy):
    """Line > 100 chars → truncated at 99 + `…`."""
    long = "x" * 150
    spy.history_returns = [{"ts": "1.0", "user": "U", "text": long}]
    result = _run("history", "C_TEST")
    line = result.output.rstrip().split("  ")[-1]
    assert len(line) == 100
    assert line.endswith("…")


def test_history_empty_channel_prints_nothing(spy):
    """No messages → empty stdout, exit 0."""
    spy.history_returns = []
    result = _run("history", "C_TEST")
    assert result.exit_code == 0
    assert result.output == ""


# --- thread ---

def test_thread_calls_list_thread_raw_with_ts(spy):
    _run("thread", "C_TEST", "1.000000")
    assert spy.thread_calls[-1] == {"channel": "C_TEST", "thread_ts": "1.000000"}


def test_thread_json_shape(spy):
    spy.thread_returns = [
        {"ts": "1.000000", "user": "UOP", "text": "op text"},
        {"ts": "1.000001", "user": "UR1", "text": "reply"},
    ]
    result = _run("thread", "-j", "C_TEST", "1.000000")
    assert json.loads(result.output) == spy.thread_returns


def test_thread_table_output(spy):
    spy.thread_returns = [
        {"ts": "1.000000", "user": "UOP", "text": "op"},
        {"ts": "1.000001", "user": "UR1", "text": "reply"},
    ]
    result = _run("thread", "C_TEST", "1.000000")
    assert result.output.rstrip().split("\n") == [
        "1.000000  UOP  op",
        "1.000001  UR1  reply",
    ]


# --- rm ---

def test_rm_single_ts_ok(spy):
    _run("rm", "C_TEST", "1.000001")
    assert spy.delete_calls == [{"message_id": "1.000001", "orphans_ok": False, "channel": "C_TEST"}]


def test_rm_multiple_ts_all_ok(spy):
    result = _run("rm", "C_TEST", "1.000001", "1.000002", "1.000003")
    assert result.exit_code == 0
    assert [c["message_id"] for c in spy.delete_calls] == ["1.000001", "1.000002", "1.000003"]
    assert result.output.rstrip().split("\n") == [
        "1.000001: ok",
        "1.000002: ok",
        "1.000003: ok",
    ]


def test_rm_force_passes_orphans_ok(spy):
    _run("rm", "-f", "C_TEST", "1.000001")
    assert spy.delete_calls[-1]["orphans_ok"] is True


def test_rm_orphaned_replies_error_surfaces_without_force(spy):
    """Without `--force`, an `OrphanedRepliesError` prints the fix and exits 1."""
    spy.delete_by_ts["1.000001"] = OrphanedRepliesError("1.000001", 3)
    result = _run("rm", "C_TEST", "1.000001")
    assert result.exit_code == 1
    stderr = result.stderr.rstrip()
    # One-line error mentioning both ts and --force.
    assert stderr.startswith("1.000001: ")
    assert "--force" in stderr


def test_rm_continues_after_per_ts_failure(spy):
    """One ts failing doesn't abort the rest; overall exit is 1."""
    spy.delete_by_ts["b"] = RuntimeError("Slack API error: message_not_found")
    result = _run("rm", "C_TEST", "a", "b", "c")
    assert result.exit_code == 1
    # All three attempted.
    assert [c["message_id"] for c in spy.delete_calls] == ["a", "b", "c"]
    # Stdout carries only the successes; stderr carries only the failure.
    assert result.stdout.rstrip().split("\n") == ["a: ok", "c: ok"]
    assert result.stderr.rstrip() == "b: Slack API error: message_not_found"


# --- post ---

def test_post_default_is_raw_and_prints_ts(spy):
    """No `-m` → `raw=True` (verbatim wire text); stdout is the new ts."""
    spy.post_returns_id = "1.777"
    result = _run("post", "C_TEST", "<https://ex.com|link> *bold*")
    assert result.exit_code == 0
    assert result.output.rstrip() == "1.777"
    assert spy.post_calls[-1] == {
        "content": "<https://ex.com|link> *bold*",
        "thread_id": None,
        "username": None,
        "icon_url": None,
        "icon_emoji": None,
        "raw": True,
        "channel": "C_TEST",
    }


def test_post_markdown_flag_forces_conversion(spy):
    """`-m/--markdown` → `raw=False`, so `SlackClient.post` runs `to_slack`."""
    _run("post", "-m", "C_TEST", "**bold**")
    assert spy.post_calls[-1]["raw"] is False


def test_post_thread_ts_reply(spy):
    _run("post", "-t", "9.999", "C_TEST", "hi")
    assert spy.post_calls[-1]["thread_id"] == "9.999"


def test_post_sender_flags_forwarded(spy):
    _run("post", "-u", "GCS usage", "-i", "https://cdn.example/a.png", "-e", ":robot:", "C_TEST", "hi")
    call = spy.post_calls[-1]
    assert call["username"] == "GCS usage"
    assert call["icon_url"] == "https://cdn.example/a.png"
    assert call["icon_emoji"] == ":robot:"


# --- edit ---

def test_edit_default_is_raw(spy):
    _run("edit", "C_TEST", "1.000001", "new text")
    assert spy.edit_calls[-1] == {
        "message_id": "1.000001", "content": "new text", "raw": True, "channel": "C_TEST",
    }


def test_edit_markdown_flag_forces_conversion(spy):
    _run("edit", "-m", "C_TEST", "1.000001", "**bold**")
    assert spy.edit_calls[-1]["raw"] is False


# --- permalink ---

def test_permalink_prints_url(spy):
    spy.permalink_returns = "https://example.slack.com/archives/CX/p123"
    result = _run("permalink", "C_TEST", "1.000001")
    assert result.exit_code == 0
    assert result.output.rstrip() == "https://example.slack.com/archives/CX/p123"
    assert spy.permalink_calls == ["1.000001"]


# --- channel resolution reaches every verb ---

def test_channel_name_resolved_to_id_for_history(spy):
    """`#foo` → `C_FOO` via `list_channels_by_name`; history call uses the id."""
    spy.channels_by_name = {"foo": "C_FOO"}
    _run("history", "#foo")
    assert spy.history_calls[-1]["channel"] == "C_FOO"


def test_channel_name_resolved_for_post(spy):
    spy.channels_by_name = {"digest": "C_DIG"}
    _run("post", "digest", "hi")
    assert spy.post_calls[-1]["channel"] == "C_DIG"


def test_channel_id_passthrough(spy):
    """`C…` id (uppercase-starting) bypasses the name lookup entirely.

    `channels_by_name` is left empty — if the CLI tried to look up
    `C_DIRECT` it would fail with "channel not found".
    """
    _run("history", "C_DIRECT")
    assert spy.history_calls[-1]["channel"] == "C_DIRECT"
