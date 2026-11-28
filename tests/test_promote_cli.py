"""Tests for the per-thread prod verbs: `promote`, `drop`, `status`, and the archive gate.

The spec's central requirement (`specs/done/per-thread-model.md`): prod push is
per-thread and never whole-doc, resolves its destination from the thread's own
metadata, confirms before firing, and never auto-archives the staging channel.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pytest
from click.testing import CliRunner

from thrds import SessionState, ThreadEntry, ThreadTarget
from thrds.cli import SLACK_TOKEN_ENV, cli
from thrds.core import Action, ActionType, SyncResult


@dataclass
class PromoteSpy:
    """SlackClient stand-in recording promote/archive/DM calls.

    One spy serves as both the user-token client and the bot-token client the
    notification path constructs; `post_calls` records the channel it was
    constructed with, which is what distinguishes a DM (channel = a `U…` id)
    from anything else.
    """
    token: str = ''
    channel: str = ''
    channels_by_name: dict[str, str] = field(default_factory=dict)
    promote_calls: list[dict] = field(default_factory=list)
    archive_calls: list[str] = field(default_factory=list)
    post_calls: list[dict] = field(default_factory=list)
    posted_ts: str = '9.900000'
    user_id: str = 'U0ME'
    permalink_returns: str = 'https://ex.slack.com/archives/C0D/p9900000'
    permalink_raises: Exception | None = None
    plan_actions: list[Action] | None = None

    def __init__(self, *, token, channel):
        self.token = token
        self.channel = channel
        self.channels_by_name = {}
        self.promote_calls = []
        self.archive_calls = []
        self.post_calls = []
        self.posted_ts = '9.900000'
        self.user_id = 'U0ME'
        self.permalink_returns = 'https://ex.slack.com/archives/C0D/p9900000'
        self.permalink_raises = None
        self.plan_actions = None

    @property
    def bot_ids(self):
        return (self.user_id, None)

    def permalink(self, message_ts: str) -> str:
        if self.permalink_raises is not None:
            raise self.permalink_raises
        return self.permalink_returns

    def post(self, content: str, thread_id=None, **kw):
        self.post_calls.append({'channel': self.channel, 'content': content, 'token': self.token})
        return None

    def list_channels_by_name(self) -> dict[str, str]:
        return dict(self.channels_by_name)

    def promote_thread(self, slug, thread, target, state, dry_run=False, **kw):
        self.promote_calls.append({
            'slug': slug,
            'channel': target.channel,
            'thread_ts': target.thread_ts,
            'messages': [m.content for m in thread.messages],
            'dry_run': dry_run,
        })
        actions = self.plan_actions if self.plan_actions is not None else [
            Action(type=ActionType.POST, index=i, content=m.content)
            for i, m in enumerate(thread.messages)
        ]
        if dry_run:
            return SyncResult(thread_id=target.thread_ts or self.posted_ts, message_ids=[], actions=actions)
        entry = state.thread(slug)
        entry.posted_ts = self.posted_ts
        entry.posted_msg_ts = [self.posted_ts]
        entry.target = target
        entry.state = 'posted'
        return SyncResult(thread_id=self.posted_ts, message_ids=[self.posted_ts], actions=actions)

    @property
    def real_calls(self):
        return [c for c in self.promote_calls if not c['dry_run']]

    def archive_channel(self, channel: str) -> None:
        self.archive_calls.append(channel)


@pytest.fixture
def spy(monkeypatch):
    the_spy = PromoteSpy(token='xoxp-fake', channel='')

    def factory(*, token, channel):
        the_spy.token = token
        the_spy.channel = channel
        return the_spy

    monkeypatch.setattr('thrds.cli.SlackClient', factory)
    monkeypatch.setenv(SLACK_TOKEN_ENV, 'xoxp-fake')
    return the_spy


@pytest.fixture
def session(tmp_path, monkeypatch):
    """A migrated (per-thread) session with two thread files."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / '01-alpha.md').write_text('Alpha OP.\n\n+++\n\nAlpha reply.\n')
    (tmp_path / '02-beta.md').write_text('Beta OP.\n')
    state = SessionState.new(
        session_slug='s',
        staging_channel='C0STAGE',
        threads={'alpha': ThreadEntry(staging_ts='1.1'), 'beta': ThreadEntry(staging_ts='2.2')},
    )
    state.save(tmp_path)
    return tmp_path


def _run(*args):
    return CliRunner().invoke(cli, ['slack', *args], catch_exceptions=False)


# --- promote: target resolution ---


def test_promote_uses_per_thread_target(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').target = ThreadTarget(channel='C0ALPHA')
    state.save(session)
    result = _run('promote', 'alpha', '-y')
    assert result.exit_code == 0, result.output
    assert [c['channel'] for c in spy.real_calls] == ['C0ALPHA']


def test_promote_falls_back_to_session_prod_channel(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0DEFAULT'
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert [c['channel'] for c in spy.real_calls] == ['C0DEFAULT']


def test_promote_channel_flag_overrides(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').target = ThreadTarget(channel='C0RECORDED')
    state.save(session)
    _run('promote', 'alpha', '-c', 'C0OVERRIDE', '-y')
    assert [c['channel'] for c in spy.real_calls] == ['C0OVERRIDE']


def test_promote_resolves_channel_name_to_id(session, spy):
    spy.channels_by_name['marin-alerts'] = 'C0RESOLVED'
    _run('promote', 'alpha', '-c', '#marin-alerts', '-y')
    assert [c['channel'] for c in spy.real_calls] == ['C0RESOLVED']


def test_promote_carries_recorded_thread_ts_for_reply(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').target = ThreadTarget(channel='C0A', thread_ts='1786980761.357209')
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert [c['thread_ts'] for c in spy.real_calls] == ['1786980761.357209']


def test_promote_thread_ts_flag_overrides_recorded(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').target = ThreadTarget(channel='C0A', thread_ts='old.1')
    state.save(session)
    _run('promote', 'alpha', '-t', 'new.2', '-y')
    assert [c['thread_ts'] for c in spy.real_calls] == ['new.2']


def test_promote_errors_with_no_target(session, spy):
    result = CliRunner().invoke(cli, ['slack', 'promote', 'alpha', '-y'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == (
        "Error: No target for thread 'alpha' — pass --channel, or set the session's "
        "prod_channel, before promoting."
    )


def test_promote_thread_ts_without_channel_errors(session, spy):
    result = CliRunner().invoke(cli, ['slack', 'promote', 'alpha', '-t', '1.1', '-y'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == (
        "Error: No target channel for 'alpha' — pass --channel alongside --thread-ts."
    )


def test_promote_unknown_slug_lists_available(session, spy):
    result = CliRunner().invoke(cli, ['slack', 'promote', 'nope', '-y'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == (
        "Error: No thread 'nope' in this session; available: alpha, beta"
    )


# --- promote: posts only the named thread ---


def test_promote_posts_only_the_named_thread(session, spy):
    """The whole point: one thread, not the doc."""
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert [c['slug'] for c in spy.real_calls] == ['alpha']


def test_promote_sends_that_threads_messages(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert [c['messages'] for c in spy.real_calls] == [['Alpha OP.', 'Alpha reply.']]


def test_promote_never_archives_staging(session, spy):
    """Other drafts are still live — prod push must not tear down the scratchpad."""
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert spy.archive_calls == []


def test_promote_marks_thread_posted(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    _run('promote', 'alpha', '-y')
    after = SessionState.load(session)
    assert (after.threads['alpha'].state, after.threads['alpha'].posted_ts) == ('posted', '9.900000')


def test_promote_leaves_sibling_thread_untouched(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert SessionState.load(session).threads['beta'].state == 'draft'


# --- promote: preview + confirmation ---


def test_promote_dry_run_posts_nothing(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    result = _run('promote', 'alpha', '-n')
    assert result.exit_code == 0
    assert spy.real_calls == []
    assert [c['dry_run'] for c in spy.promote_calls] == [True]


def test_promote_dry_run_renders_destination_and_body(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    result = _run('promote', 'alpha', '-n')
    assert result.stderr.rstrip().split('\n') == [
        'promote alpha → new thread in C0D',
        '  ---',
        '  POST [0]',
        '    +Alpha OP.',
        '  POST [1]',
        '    +Alpha reply.',
        '  ---',
        '(dry run — nothing posted)',
    ]


def test_promote_dry_run_labels_reply_destination(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').target = ThreadTarget(channel='C0A', thread_ts='1786980761.357209')
    state.save(session)
    result = _run('promote', 'alpha', '-n')
    assert result.stderr.split('\n')[0] == (
        'promote alpha → reply into C0A @ 1786980761.357209'
    )


def test_promote_declined_at_prompt_posts_nothing(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    result = CliRunner().invoke(cli, ['slack', 'promote', 'alpha'], input='n\n')
    assert result.exit_code == 1
    assert spy.real_calls == []


def test_promote_confirmed_at_prompt_posts(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    result = CliRunner().invoke(cli, ['slack', 'promote', 'alpha'], input='y\n')
    assert result.exit_code == 0
    assert [c['slug'] for c in spy.real_calls] == ['alpha']


def test_promote_computes_plan_before_posting(session, spy):
    """The real post must be preceded by a dry-run plan of the SAME promote —
    the plan is what the confirmation approves (see
    specs/done/promote-shared-thread-safety.md)."""
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    _run('promote', 'alpha', '-y')
    assert [c['dry_run'] for c in spy.promote_calls] == [True, False]


def test_promote_plan_with_deletes_warns_loudly(session, spy):
    spy.plan_actions = [
        Action(type=ActionType.EDIT, index=0, message_id='2.0', content='new', prior_content='old'),
        Action(type=ActionType.DELETE, index=1, message_id='3.0', prior_content='gone'),
    ]
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    result = _run('promote', 'alpha', '-n')
    assert result.stderr.rstrip().split('\n') == [
        'promote alpha → new thread in C0D',
        '  ---',
        '  EDIT [0]',
        '    -old',
        '    +new',
        '  DELETE [1]',
        '    -gone',
        '  ---',
        "  ⚠ plan touches 2 existing message(s) (EDIT, DELETE) — all must be this thread's own prior posts",
        '(dry run — nothing posted)',
    ]


def test_promote_warns_when_already_posted(session, spy):
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.thread('alpha').state = 'posted'
    state.thread('alpha').posted_ts = '5.5'
    state.save(session)
    result = _run('promote', 'alpha', '-n')
    assert result.stderr.split('\n')[1] == (
        '  note: already posted (ts 5.5) — this will sync it in place'
    )


# --- prod-post notification ---


@pytest.fixture
def promotable(session):
    """`session` with a resolvable target so promote reaches the notify step."""
    state = SessionState.load(session)
    state.prod_channel = 'C0D'
    state.save(session)
    return session


def test_promote_dms_user_when_bot_token_set(promotable, spy, monkeypatch):
    """The DM goes to the user's own `U…` id, using the *bot* token — a post
    made with the user's own token never notifies them."""
    monkeypatch.setenv('THRDS_SLACK_BOT_TOKEN', 'xoxb-bot')
    _run('promote', 'alpha', '-y')
    assert spy.post_calls == [{
        'channel': 'U0ME',
        'content': 'Posted *alpha* to <#C0D>: https://ex.slack.com/archives/C0D/p9900000',
        'token': 'xoxb-bot',
    }]


def test_promote_reports_dm_sent(promotable, spy, monkeypatch):
    monkeypatch.setenv('THRDS_SLACK_BOT_TOKEN', 'xoxb-bot')
    result = _run('promote', 'alpha', '-y')
    assert result.stderr.rstrip().split('\n')[-1] == '  DM sent to U0ME'


def test_promote_without_bot_token_sends_no_dm(promotable, spy, monkeypatch):
    monkeypatch.delenv('THRDS_SLACK_BOT_TOKEN', raising=False)
    _run('promote', 'alpha', '-y')
    assert spy.post_calls == []


def test_promote_without_bot_token_explains_the_silence(promotable, spy, monkeypatch):
    monkeypatch.delenv('THRDS_SLACK_BOT_TOKEN', raising=False)
    result = _run('promote', 'alpha', '-y')
    assert result.stderr.rstrip().split('\n')[-1] == (
        "  (no THRDS_SLACK_BOT_TOKEN — no DM sent; posts made with your own "
        "token don't notify you)"
    )


def test_promote_succeeds_even_if_dm_fails(promotable, spy, monkeypatch):
    """A notification failure must not make a successful post look failed."""
    monkeypatch.setenv('THRDS_SLACK_BOT_TOKEN', 'xoxb-bot')
    spy.permalink_raises = RuntimeError('missing_scope')
    result = _run('promote', 'alpha', '-y')
    assert result.exit_code == 0
    assert SessionState.load(promotable).threads['alpha'].state == 'posted'


def test_promote_warns_when_dm_fails(promotable, spy, monkeypatch):
    monkeypatch.setenv('THRDS_SLACK_BOT_TOKEN', 'xoxb-bot')
    spy.permalink_raises = RuntimeError('missing_scope')
    result = _run('promote', 'alpha', '-y')
    assert result.stderr.rstrip().split('\n')[-1] == (
        '  warning: promote succeeded but DM failed: missing_scope'
    )


def test_dry_run_sends_no_dm(promotable, spy, monkeypatch):
    monkeypatch.setenv('THRDS_SLACK_BOT_TOKEN', 'xoxb-bot')
    _run('promote', 'alpha', '-n')
    assert spy.post_calls == []


# --- drop ---


def test_drop_marks_thread_dropped(session, spy):
    _run('drop', 'beta')
    assert SessionState.load(session).threads['beta'].state == 'dropped'


def test_drop_refuses_posted_thread(session, spy):
    state = SessionState.load(session)
    state.thread('beta').state = 'posted'
    state.thread('beta').posted_ts = '7.7'
    state.save(session)
    result = CliRunner().invoke(cli, ['slack', 'drop', 'beta'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == (
        "Error: Thread 'beta' was already posted (ts 7.7); refusing to mark it dropped."
    )


# --- status ---


def test_status_lists_threads_with_state_and_destination(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').target = ThreadTarget(channel='C0A', thread_ts='1.5')
    state.thread('beta').state = 'ready'
    state.prod_channel = 'C0DEFAULT'
    state.save(session)
    result = _run('status')
    assert result.stdout.rstrip('\n').split('\n') == [
        '01-alpha.md\tdraft\tC0A @ 1.5\t',
        '02-beta.md\tready\tC0DEFAULT\t',
    ]


def test_status_marks_threads_with_no_target(session, spy):
    result = _run('status')
    assert result.stdout.rstrip('\n').split('\n') == [
        '01-alpha.md\tdraft\t(no target)\t',
        '02-beta.md\tdraft\t(no target)\t',
    ]


def test_status_shows_the_posted_permalink(session, spy):
    """Four columns always, so `cut -f4` stays honest across mixed states."""
    state = SessionState.load(session)
    entry = state.thread('alpha')
    entry.target = ThreadTarget(channel='C0A')
    entry.state = 'posted'
    entry.posted_ts = '9.9'
    entry.posted_url = 'https://ex.slack.com/archives/C0A/p99'
    state.save(session)
    result = _run('status')
    assert result.stdout.rstrip('\n').split('\n') == [
        '01-alpha.md\tposted\tC0A\thttps://ex.slack.com/archives/C0A/p99',
        '02-beta.md\tdraft\t(no target)\t',
    ]


# --- archive gate ---


def test_archive_refuses_with_pending_threads(session, spy):
    result = CliRunner().invoke(cli, ['slack', 'archive'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == (
        'Error: 2 thread(s) still pending: alpha, beta. '
        'Promote or drop them first, or pass -f to archive anyway.'
    )
    assert spy.archive_calls == []


def test_archive_allowed_once_all_terminal(session, spy):
    state = SessionState.load(session)
    state.thread('alpha').state = 'posted'
    state.thread('beta').state = 'dropped'
    state.save(session)
    result = _run('archive')
    assert result.exit_code == 0
    assert spy.archive_calls == ['C0STAGE']


def test_archive_force_overrides_gate(session, spy):
    result = _run('archive', '-f')
    assert result.exit_code == 0
    assert spy.archive_calls == ['C0STAGE']


# --- legacy guard ---


def test_per_thread_verbs_reject_legacy_session(tmp_path, monkeypatch, spy):
    monkeypatch.chdir(tmp_path)
    SessionState.new(doc_path='d.md', staging_threads={'a': '1.1'}).save(tmp_path)
    result = CliRunner().invoke(cli, ['slack', 'promote', 'a', '-y'])
    assert result.exit_code == 2
    assert result.stderr.splitlines()[-1] == (
        'Error: This session is still on the legacy single-doc layout; '
        'run `thrds slack migrate` first.'
    )
