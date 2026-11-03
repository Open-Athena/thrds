"""Tests for `thrds/mirror.py` — git + gist subprocess wrappers.

Uses real git in tmp dirs (git is a hard dep for this feature; no reason
to fake it). Mocks the `gh` invocation via subprocess patching since we
can't create a real gist during tests.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from thrds import mirror
from thrds.mirror import (
    MirrorError,
    add_remote,
    commit,
    commit_and_push,
    create_gist,
    find_git_root,
    has_remote,
    init_repo,
    is_git_repo,
    push,
    resolve_session_dir,
    SESSION_DIRS,
)


@pytest.fixture
def session_dir(tmp_path):
    """A tmp dir with `git init` already run — ready for commit tests."""
    d = tmp_path / 'session'
    d.mkdir()
    init_repo(d)
    # Every commit needs an author configured on the fresh repo.
    subprocess.run(['git', 'config', 'user.email', 'test@example.com'], cwd=d, check=True)
    subprocess.run(['git', 'config', 'user.name', 'Test'], cwd=d, check=True)
    return d


# --- helpers ---

def test_is_git_repo(tmp_path):
    assert is_git_repo(tmp_path) is False
    subprocess.run(['git', 'init', '-q'], cwd=tmp_path, check=True)
    assert is_git_repo(tmp_path) is True


def test_find_git_root_walks_up(tmp_path):
    subprocess.run(['git', 'init', '-q'], cwd=tmp_path, check=True)
    nested = tmp_path / 'a' / 'b'
    nested.mkdir(parents=True)
    assert find_git_root(nested) == tmp_path


def test_find_git_root_returns_none_outside_repo(tmp_path):
    # tmp_path is not a git repo and (in test envs) shouldn't be inside one.
    assert find_git_root(tmp_path) is None


def test_resolve_session_dir_uses_git_root(tmp_path):
    subprocess.run(['git', 'init', '-q'], cwd=tmp_path, check=True)
    nested = tmp_path / 'sub'
    nested.mkdir()
    assert resolve_session_dir(nested, 'trainium', 'slack') == tmp_path / 'slck' / 'trainium'


def test_resolve_session_dir_falls_back_to_cwd_outside_repo(tmp_path):
    assert resolve_session_dir(tmp_path, 'trainium', 'slack') == tmp_path / 'slck' / 'trainium'


def test_session_dir_is_named_for_the_platform(tmp_path):
    """One repo holds `gh/` PR clones beside `slck/` sessions without either
    hiding the other, so each platform gets its own top-level dir."""
    assert [
        resolve_session_dir(tmp_path, 'trainium', p) for p in SESSION_DIRS
    ] == [
        tmp_path / 'slck' / 'trainium',
        tmp_path / 'dscrd' / 'trainium',
        tmp_path / 'bsky' / 'trainium',
        tmp_path / 'mastodon' / 'trainium',
        tmp_path / 'capture' / 'trainium',
    ]


def test_resolve_session_dir_rejects_an_unknown_platform(tmp_path):
    with pytest.raises(ValueError) as e:
        resolve_session_dir(tmp_path, 'trainium', 'myspace')
    assert str(e.value) == (
        "No session dir configured for platform 'myspace' "
        "(known: bsky, capture, discord, mastodon, slack)"
    )


# --- init_repo ---

def test_init_repo_creates_git_dir(tmp_path):
    d = tmp_path / 'x'
    d.mkdir()
    init_repo(d)
    assert (d / '.git').is_dir()


def test_init_repo_is_idempotent(tmp_path):
    d = tmp_path / 'x'
    d.mkdir()
    init_repo(d)
    init_repo(d)  # no raise
    assert (d / '.git').is_dir()


def test_init_repo_uses_main_branch(session_dir):
    """Fresh init defaults to `main` (git 2.28+); pinned so `push HEAD:main` works everywhere."""
    (session_dir / 'x.txt').write_text('x')
    commit(session_dir, ['x.txt'], 'first')
    branch = subprocess.run(
        ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
        cwd=session_dir, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert branch == 'main'


# --- commit ---

def test_commit_stages_and_returns_sha(session_dir):
    (session_dir / 'foo.md').write_text('body')
    sha = commit(session_dir, ['foo.md'], 'add foo')
    assert sha is not None and len(sha) == 40


def test_commit_returns_none_when_nothing_staged(session_dir):
    """Idempotent: no changes → no commit, no error."""
    (session_dir / 'foo.md').write_text('body')
    commit(session_dir, ['foo.md'], 'first')
    sha = commit(session_dir, ['foo.md'], 'again')
    assert sha is None


def test_commit_message_lands_in_git_log(session_dir):
    (session_dir / 'foo.md').write_text('body')
    commit(session_dir, ['foo.md'], 'commit message here')
    log = subprocess.run(
        ['git', 'log', '--format=%s', '-n', '1'],
        cwd=session_dir, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert log == 'commit message here'


# --- remote handling ---

def test_add_and_check_remote(session_dir):
    assert has_remote(session_dir, 'g') is False
    add_remote(session_dir, 'g', 'https://gist.github.com/abc.git')
    assert has_remote(session_dir, 'g') is True


def test_add_remote_updates_existing(session_dir):
    add_remote(session_dir, 'g', 'https://gist.github.com/abc.git')
    add_remote(session_dir, 'g', 'https://gist.github.com/xyz.git')
    url = subprocess.run(
        ['git', 'remote', 'get-url', 'g'],
        cwd=session_dir, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert url == 'https://gist.github.com/xyz.git'


def test_push_noop_when_no_remote(session_dir):
    """No `g` remote → push() returns silently, no error."""
    push(session_dir, remote='g')  # no raise


# --- THRDS_NO_PUSH guard ---

@pytest.fixture
def wired_remote(session_dir, tmp_path):
    """`session_dir` with a real bare repo wired as `g`, and one commit staged.

    A local bare repo (rather than a mock) so a push either genuinely lands or
    genuinely doesn't — the guard's whole job is preventing a real write.
    """
    bare = tmp_path / 'remote.git'
    subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', str(bare)], check=True)
    add_remote(session_dir, 'g', str(bare))
    (session_dir / 'f.txt').write_text('v1\n')
    commit(session_dir, ['f.txt'], 'first')
    return session_dir, bare


def _remote_head(bare: Path) -> str | None:
    """The bare repo's `main` SHA, or None if the ref doesn't exist yet."""
    r = subprocess.run(
        ['git', 'rev-parse', 'main'], cwd=bare, capture_output=True, text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else None


@pytest.mark.parametrize('value,disabled', [
    ('1', True),
    ('yes', True),
    ('0', True),      # any non-empty value counts — presence is the signal
    ('', False),
])
def test_push_disabled_reads_env(monkeypatch, value, disabled):
    monkeypatch.setenv(mirror.NO_PUSH_ENV, value)
    assert mirror.push_disabled() is disabled


def test_push_disabled_false_when_env_unset(monkeypatch):
    monkeypatch.delenv(mirror.NO_PUSH_ENV, raising=False)
    assert mirror.push_disabled() is False


def test_push_reaches_remote_when_guard_unset(wired_remote, monkeypatch):
    """Control: without the guard, the push genuinely lands."""
    session_dir, bare = wired_remote
    monkeypatch.delenv(mirror.NO_PUSH_ENV, raising=False)
    push(session_dir, remote='g')
    local = subprocess.run(
        ['git', 'rev-parse', 'HEAD'], cwd=session_dir, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert _remote_head(bare) == local


def test_push_skipped_when_guard_set(wired_remote, monkeypatch):
    session_dir, bare = wired_remote
    monkeypatch.setenv(mirror.NO_PUSH_ENV, '1')
    push(session_dir, remote='g')
    assert _remote_head(bare) is None


def test_push_skip_is_announced_on_stderr(wired_remote, monkeypatch, capsys):
    """Silently skipping would be its own trap — the skip must be visible."""
    session_dir, _ = wired_remote
    monkeypatch.setenv(mirror.NO_PUSH_ENV, '1')
    push(session_dir, remote='g')
    assert capsys.readouterr().err == 'THRDS_NO_PUSH set — skipping push to g\n'


def test_commit_and_push_still_commits_locally_with_guard(wired_remote, monkeypatch):
    """The guard blocks the network, not the local history."""
    session_dir, bare = wired_remote
    monkeypatch.setenv(mirror.NO_PUSH_ENV, '1')
    (session_dir / 'f.txt').write_text('v2\n')
    sha = commit_and_push(session_dir, ['f.txt'], 'second', remote='g')
    log = subprocess.run(
        ['git', 'log', '--format=%s'], cwd=session_dir, capture_output=True, text=True, check=True,
    ).stdout.split()
    assert sha is not None
    assert log == ['second', 'first']
    assert _remote_head(bare) is None


# --- create_gist (subprocess-mocked) ---

def test_create_gist_parses_url_from_gh_stdout(session_dir, monkeypatch):
    """`gh gist create` (secret by default) stdout is a URL; parse it to (gist_id, git_url)."""
    captured: list[list[str]] = []

    def fake_run(cmd, cwd=None, check=True, capture_output=True, text=True):
        captured.append(cmd)
        return subprocess.CompletedProcess(
            args=cmd, returncode=0,
            stdout='https://gist.github.com/abc123def456\n',
            stderr='',
        )
    monkeypatch.setattr(mirror.subprocess, 'run', fake_run)

    gid, git_url = create_gist(session_dir, description='thrds: trainium', files=['trainium.md'])
    assert gid == 'abc123def456'
    assert git_url == 'git@gist.github.com:abc123def456.git'
    assert captured == [[
        'gh', 'gist', 'create',
        '--desc', 'thrds: trainium', 'trainium.md',
    ]]


def test_create_gist_raises_mirror_error_on_gh_failure(session_dir, monkeypatch):
    """gh exit != 0 → MirrorError with the stderr embedded."""
    def fake_run(cmd, cwd=None, check=True, capture_output=True, text=True):
        raise subprocess.CalledProcessError(
            returncode=1, cmd=cmd, output='', stderr='gh: auth required',
        )
    monkeypatch.setattr(mirror.subprocess, 'run', fake_run)

    with pytest.raises(MirrorError, match=r'gh: auth required'):
        create_gist(session_dir, description='x', files=['foo.md'])


# --- commit_and_push ---

def test_commit_and_push_commits_locally_without_remote(session_dir):
    """No `g` remote: commit still fires, push is a no-op, no error."""
    (session_dir / 'foo.md').write_text('body')
    sha = commit_and_push(session_dir, ['foo.md'], 'add foo')
    assert sha is not None
    # Assert HEAD advanced (commit succeeded).
    head = subprocess.run(
        ['git', 'rev-parse', 'HEAD'],
        cwd=session_dir, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert head == sha


def test_commit_and_push_returns_none_when_no_changes(session_dir):
    (session_dir / 'foo.md').write_text('body')
    commit_and_push(session_dir, ['foo.md'], 'add foo')
    sha2 = commit_and_push(session_dir, ['foo.md'], 're-add foo')
    assert sha2 is None
