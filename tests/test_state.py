"""Tests for the session state persistence layer (thrds.yml)."""
from __future__ import annotations

import json

import yaml
import re
import uuid
from pathlib import Path

import pytest

from thrds.state import (
    CHANNEL_PREFIX_ENV,
    DEFAULT_GIST_REMOTE,
    DEFAULT_PLATFORM,
    STATE_PATH,
    VALID_PLATFORMS,
    SessionState,
    resolve_channel_prefix,
)


def test_new_generates_uuid4():
    """SessionState.new() stamps a fresh UUID4 into session_id."""
    s = SessionState.new()
    parsed = uuid.UUID(s.session_id)
    assert parsed.version == 4


def test_new_accepts_overrides():
    """SessionState.new(prod_channel='C1') applies overrides on top of the fresh UUID."""
    s = SessionState.new(prod_channel='C1', gist_id='abc', channel_prefix='rw-', doc_path='trainium-update.md')
    assert s.prod_channel == 'C1'
    assert s.gist_id == 'abc'
    assert s.channel_prefix == 'rw-'
    assert s.doc_path == 'trainium-update.md'
    uuid.UUID(s.session_id)


def test_load_missing_raises_clearly(tmp_path):
    """Load errors with an actionable message if state.json is absent."""
    with pytest.raises(FileNotFoundError, match=re.escape(f"{tmp_path / STATE_PATH}")):
        SessionState.load(tmp_path)


def test_save_writes_flat_file(tmp_path):
    """Save writes to a flat filename (no directory) — gists reject dirs."""
    s = SessionState(session_id='fixed-uuid')
    s.save(tmp_path)
    assert (tmp_path / STATE_PATH).exists()
    # Flat: STATE_PATH.parent is '.' (current dir), i.e. no subdirectory.
    assert STATE_PATH.parent == Path('.')


def test_save_load_round_trip_empty(tmp_path):
    """save + load is identity on a fresh session with no threads recorded yet."""
    original = SessionState(
        session_id='fixed-uuid',
        doc_path='trainium-update.md',
        prod_channel='C0PROD',
        gist_id='gist-abc',
        gist_remote='g',
        channel_prefix='rw-',
    )
    original.save(tmp_path)
    loaded = SessionState.load(tmp_path)
    assert loaded == original


def test_save_load_round_trip_with_threads(tmp_path):
    """save + load is identity on a session with staging + prod thread state."""
    original = SessionState(
        session_id='fixed-uuid',
        doc_path='trainium-update.md',
        prod_channel='C0PROD',
        gist_id='gist-abc',
        staging_channel='C0STAGE',
        staging_threads={'mfu': '1785.001', 'profiling': '1785.002'},
        prod_threads={'C0PROD': {'mfu': '1786.001'}},
    )
    original.save(tmp_path)
    loaded = SessionState.load(tmp_path)
    assert loaded == original


def test_save_format_is_yaml_with_nones_pruned(tmp_path):
    """State file is human-readable YAML: no `null` noise (load restores
    defaults), first key first, single trailing newline."""
    s = SessionState(session_id='fixed-uuid', prod_channel='C0PROD')
    s.save(tmp_path)
    text = (tmp_path / STATE_PATH).read_text()
    assert yaml.safe_load(text)['session_id'] == 'fixed-uuid'
    assert text.split('\n')[0] == 'session_id: fixed-uuid'
    assert [l for l in text.split('\n') if 'null' in l] == []
    assert text.endswith('\n') and not text.endswith('\n\n')


def test_default_gist_remote_matches_ghpr():
    """DEFAULT_GIST_REMOTE is 'g' to align with ghpr's convention."""
    assert DEFAULT_GIST_REMOTE == 'g'
    assert SessionState(session_id='x').gist_remote == 'g'


def test_get_set_thread_ts_staging_routing():
    """SessionState routes staging_channel to staging_threads."""
    s = SessionState(session_id='x', staging_channel='C0STAGE')
    s.set_thread_ts('C0STAGE', 'mfu', '1785.001')
    assert s.staging_threads == {'mfu': '1785.001'}
    assert s.prod_threads == {}
    assert s.get_thread_ts('C0STAGE', 'mfu') == '1785.001'
    assert s.get_thread_ts('C0STAGE', 'missing') is None


def test_get_set_thread_ts_prod_routing():
    """SessionState routes non-staging channels to prod_threads[channel]."""
    s = SessionState(session_id='x', staging_channel='C0STAGE')
    s.set_thread_ts('C0PROD', 'mfu', '1786.001')
    s.set_thread_ts('C0PROD', 'profiling', '1786.002')
    s.set_thread_ts('C0OTHER', 'mfu', '1787.001')
    assert s.prod_threads == {
        'C0PROD': {'mfu': '1786.001', 'profiling': '1786.002'},
        'C0OTHER': {'mfu': '1787.001'},
    }
    assert s.get_thread_ts('C0PROD', 'mfu') == '1786.001'
    assert s.get_thread_ts('C0OTHER', 'mfu') == '1787.001'
    assert s.get_thread_ts('C0PROD', 'C0OTHER-only-slug') is None


def test_threads_in_returns_snapshot():
    """threads_in returns a copy; mutating it doesn't affect state."""
    s = SessionState(session_id='x', staging_channel='C0STAGE', staging_threads={'mfu': '1785.001'})
    snap = s.threads_in('C0STAGE')
    assert snap == {'mfu': '1785.001'}
    snap['other'] = '9999.999'
    assert s.staging_threads == {'mfu': '1785.001'}


def test_threads_in_empty_for_unknown_channel():
    """Channel with no recorded threads → empty dict (not None, not KeyError)."""
    s = SessionState(session_id='x')
    assert s.threads_in('C0UNKNOWN') == {}


def test_resolve_channel_prefix_override_wins(monkeypatch):
    """Explicit session override beats the env var."""
    monkeypatch.setenv(CHANNEL_PREFIX_ENV, 'env-')
    assert resolve_channel_prefix('override-') == 'override-'


def test_resolve_channel_prefix_falls_back_to_env(monkeypatch):
    """No session override → env var wins."""
    monkeypatch.setenv(CHANNEL_PREFIX_ENV, 'rw-')
    assert resolve_channel_prefix(None) == 'rw-'


def test_resolve_channel_prefix_defaults_to_empty(monkeypatch):
    """No override and no env → empty string (no prefix)."""
    monkeypatch.delenv(CHANNEL_PREFIX_ENV, raising=False)
    assert resolve_channel_prefix(None) == ''


def test_doc_slug_from_doc_path():
    """SessionState.doc_slug strips the .md extension from doc_path."""
    s = SessionState(session_id='x', doc_path='trainium-update.md')
    assert s.doc_slug == 'trainium-update'


def test_doc_slug_raises_when_unset():
    """doc_slug is an error if neither slug source is set (uninitialized session)."""
    s = SessionState(session_id='x')
    with pytest.raises(ValueError) as e:
        _ = s.doc_slug
    assert str(e.value) == 'neither session_slug nor doc_path is set on this session'


def test_doc_slug_prefers_session_slug_over_doc_path():
    """Migration pins `session_slug` then retires `doc_path`; the staging channel
    name must not shift underneath a session when that happens."""
    s = SessionState(session_id='x', doc_path='old-name.md', session_slug='pinned')
    assert s.doc_slug == 'pinned'


def test_doc_slug_falls_back_to_doc_path_for_legacy_sessions():
    s = SessionState(session_id='x', doc_path='cw-quickwins.md')
    assert s.doc_slug == 'cw-quickwins'


def test_staging_channel_name_prefix_env(monkeypatch):
    """staging_channel_name = <env-prefix><doc_slug> when no session override."""
    monkeypatch.setenv(CHANNEL_PREFIX_ENV, 'rw-')
    s = SessionState(session_id='x', doc_path='trainium-update.md')
    assert s.staging_channel_name() == 'rw-trainium-update'


def test_staging_channel_name_override(monkeypatch):
    """staging_channel_name uses session override even if env is set."""
    monkeypatch.setenv(CHANNEL_PREFIX_ENV, 'env-')
    s = SessionState(session_id='x', doc_path='trainium-update.md', channel_prefix='override-')
    assert s.staging_channel_name() == 'override-trainium-update'


def test_staging_channel_name_no_prefix(monkeypatch):
    """staging_channel_name is bare doc_slug when neither env nor override is set."""
    monkeypatch.delenv(CHANNEL_PREFIX_ENV, raising=False)
    s = SessionState(session_id='x', doc_path='trainium-update.md')
    assert s.staging_channel_name() == 'trainium-update'


def test_platform_defaults_to_slack():
    """Default platform is `slack` (matches pre-0.6 behavior)."""
    assert DEFAULT_PLATFORM == 'slack'
    assert SessionState(session_id='x').platform == 'slack'


def test_valid_platforms_enumerated():
    """VALID_PLATFORMS is the canonical set (kept in sync with subcommand groups)."""
    assert VALID_PLATFORMS == ('slack', 'discord', 'bsky', 'mastodon', 'capture')


def test_platform_roundtrips_through_save_load(tmp_path):
    """Non-default platform (e.g. capture) survives save/load."""
    original = SessionState(session_id='x', doc_path='foo.md', platform='capture')
    original.save(tmp_path)
    loaded = SessionState.load(tmp_path)
    assert loaded.platform == 'capture'
    assert loaded == original


def test_load_backfills_platform_on_legacy_state(tmp_path):
    """State files predating the `platform` field load with platform=slack."""
    # Simulate a pre-0.6 state file (no `platform` key).
    (tmp_path / STATE_PATH).write_text(json.dumps({
        'session_id': 'legacy-uuid',
        'doc_path': 'legacy.md',
        'staging_channel': 'C0STAGE',
    }) + '\n')
    loaded = SessionState.load(tmp_path)
    assert loaded.platform == 'slack'
    assert loaded.session_id == 'legacy-uuid'


def test_invalid_platform_raises():
    """Unknown platform value raises immediately (catches typos on init)."""
    with pytest.raises(ValueError, match="Invalid platform 'twitter'"):
        SessionState(session_id='x', platform='twitter')
