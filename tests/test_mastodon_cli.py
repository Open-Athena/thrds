"""Tests for the `thrds mastodon …` subgroup.

Mirrors `test_discord_cli.py`: the paste verbs (init/render/lint/open) plus the
live `push`. Push tests route the real client's `_request` into the in-memory
`FakeMastodon` emulator (from `test_mastodon.py`), so `sync` runs for real with
no network. The headline vs `bsky` is that a re-push **edits in place** (PUT),
because Mastodon has a real edit API.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import CliRunner

from thrds import SessionState
from thrds.cli import (
    MASTODON_INSTANCE_ENV,
    MASTODON_TOKEN_ENV,
    SLACK_TOKEN_ENV,
    cli,
)
from thrds.mastodon import MastodonClient

from tests.test_mastodon import FakeMastodon


@pytest.fixture
def in_tmp(tmp_path, monkeypatch):
    """CWD → tmp_path so state read/write is scoped to the test."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('GIT_AUTHOR_NAME', 'Test')
    monkeypatch.setenv('GIT_AUTHOR_EMAIL', 'test@example.com')
    monkeypatch.setenv('GIT_COMMITTER_NAME', 'Test')
    monkeypatch.setenv('GIT_COMMITTER_EMAIL', 'test@example.com')
    monkeypatch.setenv(SLACK_TOKEN_ENV, 'xoxp-fake')
    return tmp_path


def _init_mastodon(in_tmp: Path, monkeypatch, doc_name: str = 'draft.md',
                   doc_text: str = "=== a\n\nHello.\n") -> Path:
    """Write the doc, run `thrds mastodon init --no-gist <doc>`, chdir to session dir."""
    (in_tmp / doc_name).write_text(doc_text)
    result = CliRunner().invoke(cli, ['mastodon', 'init', '--no-gist', doc_name])
    assert result.exit_code == 0, (result.output, result.exception)
    slug = Path(doc_name).stem
    session_dir = in_tmp / 'mastodon' / slug
    monkeypatch.chdir(session_dir)
    return session_dir


def _install_api(monkeypatch, backing: FakeMastodon) -> None:
    """Route every real `MastodonClient._request` into ``backing``'s emulator."""
    monkeypatch.setattr(
        MastodonClient, '_request',
        lambda self, endpoint, data=None, method="GET": backing._request(endpoint, data, method),
    )


def _set_env(monkeypatch, instance='https://masto.test', token='mt-tok'):
    for env, val in ((MASTODON_INSTANCE_ENV, instance), (MASTODON_TOKEN_ENV, token)):
        if val is None:
            monkeypatch.delenv(env, raising=False)
        else:
            monkeypatch.setenv(env, val)


def _writes(backing: FakeMastodon) -> list:
    """The POST/PUT/DELETE calls only (drops the GET reads), for exact assertions."""
    return [(m, e, d) for (m, e, d) in backing.calls if m != 'GET']


# --- init (regression: `mastodon` was missing from SESSION_DIRS) ---

def test_mastodon_init_writes_platform_and_session_dir(in_tmp, monkeypatch):
    (in_tmp / 'draft.md').write_text("=== a\n\nHello.\n")
    result = CliRunner().invoke(cli, ['mastodon', 'init', '--no-gist', 'draft.md'])
    assert result.exit_code == 0, (result.output, result.exception)
    session_dir = in_tmp / 'mastodon' / 'draft'
    assert session_dir.is_dir()
    assert SessionState.load(session_dir).platform == 'mastodon'


# --- push: fresh ---

def test_mastodon_push_fresh_posts_op_and_flat_replies(in_tmp, monkeypatch):
    session = _init_mastodon(in_tmp, monkeypatch, doc_text="OP body\n\n+++\n\nreply one\n")
    _set_env(monkeypatch)
    backing = FakeMastodon(account_id="ME")
    _install_api(monkeypatch, backing)

    result = CliRunner().invoke(cli, ['mastodon', 'push'])
    assert result.exit_code == 0, (result.output, result.exception)
    # OP is a new status; the reply addresses the OP (flat threading).
    assert _writes(backing) == [
        ('POST', 'v1/statuses', {'status': 'OP body', 'visibility': 'public'}),
        ('POST', 'v1/statuses', {'status': 'reply one', 'visibility': 'public', 'in_reply_to_id': 'n1'}),
    ]
    # Permalink to the OP on stdout (the status's canonical `url`).
    assert result.stdout == 'https://masto.test/@me/n1\n'
    # State records where it landed, for a future reconcile.
    state = SessionState.load(session)
    assert (state.mastodon_op_id, state.mastodon_instance) == ('n1', 'https://masto.test')


def test_mastodon_push_lone_op_no_replies(in_tmp, monkeypatch):
    session = _init_mastodon(in_tmp, monkeypatch, doc_text="just the OP\n")
    _set_env(monkeypatch)
    backing = FakeMastodon(account_id="ME")
    _install_api(monkeypatch, backing)

    result = CliRunner().invoke(cli, ['mastodon', 'push'])
    assert result.exit_code == 0, (result.output, result.exception)
    assert _writes(backing) == [
        ('POST', 'v1/statuses', {'status': 'just the OP', 'visibility': 'public'}),
    ]
    assert SessionState.load(session).mastodon_op_id == 'n1'


# --- push: dry run ---

def test_mastodon_push_dry_run_posts_nothing_and_needs_no_token(in_tmp, monkeypatch):
    session = _init_mastodon(in_tmp, monkeypatch, doc_text="OP body\n\n+++\n\nreply one\n")
    _set_env(monkeypatch, token=None)  # no credentials — a dry run makes no calls
    backing = FakeMastodon(account_id="ME")
    _install_api(monkeypatch, backing)

    result = CliRunner().invoke(cli, ['mastodon', 'push', '-n'])
    assert result.exit_code == 0, (result.output, result.exception)
    assert backing.calls == []
    assert result.stdout == ""
    assert result.stderr.rstrip().split('\n')[-1] == (
        '(dry run — fresh, 2 message(s), instance https://masto.test)'
    )
    # Nothing recorded; a later real push is still a fresh one.
    assert SessionState.load(session).mastodon_op_id is None


# --- push: re-push reconciles in place (the edit-API differentiator) ---

def test_mastodon_repush_edits_changed_reply_in_place(in_tmp, monkeypatch):
    session = _init_mastodon(in_tmp, monkeypatch, doc_text="OP body\n\n+++\n\nreply one\n")
    _set_env(monkeypatch)
    backing = FakeMastodon(account_id="ME")
    _install_api(monkeypatch, backing)

    r1 = CliRunner().invoke(cli, ['mastodon', 'push'])
    assert r1.exit_code == 0, (r1.output, r1.exception)
    op_id = SessionState.load(session).mastodon_op_id
    assert op_id == 'n1'

    # Change the reply, re-push: the OP skips, the reply edits in place (PUT),
    # nothing is deleted or reposted, and the OP id is unchanged.
    (session / 'draft.md').write_text("OP body\n\n+++\n\nreply TWO\n")
    backing.calls.clear()
    r2 = CliRunner().invoke(cli, ['mastodon', 'push'])
    assert r2.exit_code == 0, (r2.output, r2.exception)
    assert _writes(backing) == [
        ('PUT', 'v1/statuses/n2', {'status': 'reply TWO'}),
    ]
    assert backing.store['n2']['text'] == 'reply TWO'
    assert SessionState.load(session).mastodon_op_id == 'n1'


# --- push: config guards ---

def test_mastodon_push_errors_without_instance(in_tmp, monkeypatch):
    _init_mastodon(in_tmp, monkeypatch, doc_text="OP body\n")
    _set_env(monkeypatch, instance=None)
    result = CliRunner().invoke(cli, ['mastodon', 'push'])
    assert result.exit_code == 2
    assert result.stderr.rstrip().split('\n')[-1] == (
        'Error: No Mastodon instance; pass --instance, set THRDS_MASTODON_INSTANCE, '
        'or record one in the session (a prior push does).'
    )


def test_mastodon_push_errors_without_token(in_tmp, monkeypatch):
    _init_mastodon(in_tmp, monkeypatch, doc_text="OP body\n")
    _set_env(monkeypatch, token=None)  # instance set, but no token and not a dry run
    result = CliRunner().invoke(cli, ['mastodon', 'push'])
    assert result.exit_code == 2
    assert result.stderr.rstrip().split('\n')[-1] == (
        'Error: Set THRDS_MASTODON_TOKEN to a Mastodon access token to push '
        '(scopes `read:statuses write:statuses`).'
    )
