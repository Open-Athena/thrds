"""Tests for the per-thread state model (`ThreadEntry` / `ThreadTarget` / `SessionState.threads`).

Companion to `test_state.py`, which covers the session-level fields. See
`specs/done/per-thread-model.md`: destination is a property of the *thread*, not the
session, which is what collapses the batch case (N threads, one channel) and
the reply case (N threads, N targets) into one shape.
"""
from __future__ import annotations

import json

import yaml

import pytest

from thrds import SessionState, ThreadEntry, ThreadTarget
from thrds.state import STATE_PATH


# --- ThreadTarget ---


def test_thread_target_channel_only_means_top_level_post():
    t = ThreadTarget(channel='#marin-alerts')
    assert (t.channel, t.thread_ts) == ('#marin-alerts', None)


def test_thread_target_with_thread_ts_means_reply():
    t = ThreadTarget(channel='#marin-alerts', thread_ts='1786980761.357209')
    assert (t.channel, t.thread_ts) == ('#marin-alerts', '1786980761.357209')


def test_thread_target_rejects_empty_channel():
    with pytest.raises(ValueError) as e:
        ThreadTarget(channel='')
    assert str(e.value) == 'ThreadTarget.channel must be non-empty'


# --- ThreadEntry ---


def test_thread_entry_defaults():
    e = ThreadEntry()
    assert (e.staging_ts, e.target, e.state, e.posted_ts) == (None, None, 'draft', None)


def test_thread_entry_rejects_unknown_state():
    with pytest.raises(ValueError) as e:
        ThreadEntry(state='mostly-ready')
    assert str(e.value) == (
        "Invalid thread state 'mostly-ready'; "
        "must be one of ('draft', 'ready', 'posted', 'dropped')"
    )


def test_thread_entry_coerces_target_dict_to_dataclass():
    """`SessionState.load` reconstructs via `cls(**json)`, so nested entries
    arrive as plain dicts; they must come back as dataclasses."""
    e = ThreadEntry(target={'channel': '#foo', 'thread_ts': '1.2'})
    assert e.target == ThreadTarget(channel='#foo', thread_ts='1.2')


@pytest.mark.parametrize('state,terminal', [
    ('draft', False),
    ('ready', False),
    ('posted', True),
    ('dropped', True),
])
def test_thread_entry_is_terminal(state, terminal):
    assert ThreadEntry(state=state).is_terminal is terminal


# --- SessionState.threads round-trip ---


def test_threads_round_trip_through_save_and_load(tmp_path):
    state = SessionState.new(
        doc_path='draft.md',
        threads={
            'cw-quickwins': ThreadEntry(
                staging_ts='1786840558.331079',
                target=ThreadTarget(channel='#marin-alerts', thread_ts='1786980761.357209'),
                state='draft',
            ),
            'cw-mpu': ThreadEntry(
                staging_ts='1786983442.254669',
                target=ThreadTarget(channel='#marin-alerts'),
                state='ready',
            ),
        },
    )
    state.save(tmp_path)
    loaded = SessionState.load(tmp_path)
    assert loaded.threads == state.threads


def test_threads_serialize_as_per_remote_pointers(tmp_path):
    """The pointers schema (`specs/remotes-model.md`): legacy field names are
    constructor sugar; what persists is the remote → pointer map, Nones
    pruned. A quoted ts stays a string through the YAML round trip."""
    state = SessionState.new(
        threads={'a': ThreadEntry(staging_ts='1.1', target=ThreadTarget(channel='#c'))},
    )
    state.save(tmp_path)
    written = yaml.safe_load((tmp_path / STATE_PATH).read_text())
    assert written['threads'] == {
        'a': {
            'state': 'draft',
            'remotes': {
                'staging': {'ts': '1.1'},
                'prod': {'channel': '#c'},
            },
        },
    }


def test_threads_defaults_to_empty(tmp_path):
    SessionState.new(doc_path='d.md').save(tmp_path)
    assert SessionState.load(tmp_path).threads == {}


# --- is_legacy ---


def test_is_legacy_true_while_doc_path_is_set():
    state = SessionState.new(doc_path='draft.md', staging_threads={'a': '1.1'})
    assert state.is_legacy is True


def test_is_legacy_true_for_freshly_inited_session_with_no_threads_yet():
    """A session that has a doc but hasn't pushed is still single-doc — keying
    on `staging_threads` would misclassify it as per-thread."""
    assert SessionState.new(doc_path='draft.md').is_legacy is True


def test_is_legacy_false_once_doc_path_cleared():
    state = SessionState.new(session_slug='s', threads={'a': ThreadEntry()})
    assert state.is_legacy is False


def test_is_legacy_false_for_per_thread_session_with_no_threads_recorded():
    assert SessionState.new(session_slug='s').is_legacy is False


# --- thread() accessor ---


def test_thread_creates_entry_on_first_access():
    state = SessionState.new()
    entry = state.thread('new-slug')
    assert entry == ThreadEntry()
    assert list(state.threads) == ['new-slug']


def test_thread_returns_same_entry_on_repeat_access():
    state = SessionState.new()
    state.thread('a').staging_ts = '1.1'
    assert state.thread('a').staging_ts == '1.1'


# --- target_for ---


def test_target_for_prefers_per_thread_target():
    state = SessionState.new(
        prod_channel='#session-default',
        threads={'a': ThreadEntry(target=ThreadTarget(channel='#per-thread'))},
    )
    assert state.target_for('a') == ThreadTarget(channel='#per-thread')


def test_target_for_falls_back_to_session_prod_channel():
    """The batch case: N threads all destined for one channel need no
    per-thread configuration at all."""
    state = SessionState.new(prod_channel='#oa-amazon-trainium', threads={'a': ThreadEntry()})
    assert state.target_for('a') == ThreadTarget(channel='#oa-amazon-trainium')


def test_target_for_unknown_slug_uses_session_default():
    state = SessionState.new(prod_channel='#c')
    assert state.target_for('never-seen') == ThreadTarget(channel='#c')


def test_target_for_returns_none_when_nothing_set():
    state = SessionState.new(threads={'a': ThreadEntry()})
    assert state.target_for('a') is None


# --- pending_threads ---


def test_pending_threads_excludes_terminal_states():
    state = SessionState.new(threads={
        'a': ThreadEntry(state='draft'),
        'b': ThreadEntry(state='ready'),
        'c': ThreadEntry(state='posted'),
        'd': ThreadEntry(state='dropped'),
    })
    assert state.pending_threads() == ['a', 'b']


def test_pending_threads_empty_when_all_terminal():
    """Archiving the staging channel is gated on this being empty."""
    state = SessionState.new(threads={
        'a': ThreadEntry(state='posted'),
        'b': ThreadEntry(state='dropped'),
    })
    assert state.pending_threads() == []


def test_pending_threads_sorted_by_slug():
    state = SessionState.new(threads={
        'zebra': ThreadEntry(),
        'alpha': ThreadEntry(),
        'mango': ThreadEntry(),
    })
    assert state.pending_threads() == ['alpha', 'mango', 'zebra']
