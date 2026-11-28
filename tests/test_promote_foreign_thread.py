"""Regression tests for the 2026-08-19 promote incident.

See ``specs/done/promote-shared-thread-safety.md``: promoting into an existing
(someone else's) thread must be append-only on first promote — it may not
edit or delete *any* message already in the thread, including ones posted
with our own token (earlier-promoted slugs, manual posts). Converging those
is how a one-message promote vandalized two prior posts and deleted a third
(losing its approval reactions) in a real ops thread.
"""
from __future__ import annotations

from thrds import DocMessage, DocThread, SessionState, ThreadEntry, ThreadTarget
from thrds.core import ActionType, Message
from thrds.slack import SlackClient

THREAD_ROOT = '1.000000'


class SharedThreadSlack(SlackClient):
    """Transport-stubbed client: the target thread holds a foreign OP plus
    three of-our-token messages belonging to other slugs / manual posts."""

    def __init__(self):
        super().__init__(token='xoxp-fake', channel='C0PROD')
        self.existing = [
            Message(id=THREAD_ROOT, content='foreign OP', editable=False),
            Message(id='2.000000', content='our cw-summary post', editable=True),
            Message(id='3.000000', content='our cw-mpu post', editable=True),
            Message(id='4.000000', content='our cuda-graph confirmation', editable=True),
        ]
        self.posted: list[tuple[str, str | None]] = []
        self.edits: list[tuple[str, str]] = []
        self.deletes: list[str] = []

    def list_messages(self, thread_id):
        return list(self.existing)

    def post(self, content, thread_id=None, **kw):
        self.posted.append((content, thread_id))
        return Message(id=f'9.{len(self.posted):06d}', content=content)

    def edit(self, message_id, content, **kw):
        self.edits.append((message_id, content))
        return Message(id=message_id, content=content)

    def delete(self, message_id, **kw):
        self.deletes.append(message_id)

    def permalink(self, message_ts, channel=None):
        return f'https://ex.slack.com/p{message_ts}'


def _promote(client, entry: ThreadEntry, dry_run: bool = False):
    state = SessionState.new(session_slug='s', staging_channel='C0STAGE', threads={'grug': entry})
    thread = DocThread(slug='grug', messages=[DocMessage(content='Done — grug deleted.')])
    target = ThreadTarget(channel='C0PROD', thread_ts=THREAD_ROOT)
    result = client.promote_thread('grug', thread, target, state, dry_run=dry_run)
    return result, state.thread('grug')


def test_first_promote_into_shared_thread_appends_only():
    client = SharedThreadSlack()
    result, entry = _promote(client, ThreadEntry(staging_ts='5.5'))
    assert client.deletes == []
    assert client.edits == []
    assert client.posted == [('Done — grug deleted.', THREAD_ROOT)]
    assert [a.type for a in result.actions] == [ActionType.POST]


def test_first_promote_records_own_message_ts_not_thread_root():
    client = SharedThreadSlack()
    _, entry = _promote(client, ThreadEntry(staging_ts='5.5'))
    assert entry.posted_ts == '9.000001'
    assert entry.posted_msg_ts == ['9.000001']
    assert entry.posted_url == 'https://ex.slack.com/p9.000001'


def test_repromote_edits_only_this_slugs_message():
    client = SharedThreadSlack()
    client.existing.append(Message(id='9.000001', content='Done — grug deleted (v1).', editable=True))
    entry = ThreadEntry(staging_ts='5.5', posted_ts='9.000001', posted_msg_ts=['9.000001'], state='posted')
    result, entry = _promote(client, entry)
    assert client.deletes == []
    assert client.posted == []
    assert client.edits == [('9.000001', 'Done — grug deleted.')]


def test_legacy_posted_ts_equal_to_thread_root_is_not_reconciled():
    """Bug 3 wrote `posted_ts = thread root`; a re-promote must not treat the
    foreign root as this slug's message (it appends instead)."""
    client = SharedThreadSlack()
    entry = ThreadEntry(staging_ts='5.5', posted_ts=THREAD_ROOT, state='posted')
    _promote(client, entry)
    assert client.deletes == []
    assert client.edits == []
    assert client.posted == [('Done — grug deleted.', THREAD_ROOT)]


def test_dry_run_reports_append_plan_without_side_effects():
    client = SharedThreadSlack()
    result, entry = _promote(client, ThreadEntry(staging_ts='5.5'), dry_run=True)
    assert client.posted == [] and client.edits == [] and client.deletes == []
    assert [a.type for a in result.actions] == [ActionType.POST]
    assert entry.posted_msg_ts is None
