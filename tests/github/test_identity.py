"""Tests for the optional alternate-author identity for comment/review writes.

`ghpr` normally acts as the active `gh` account. When an alternate login is
selected (`--as` / `$GHPR_AS` / `git config pr.as`), comment + review *writes*
run as that account (via a `GH_TOKEN` env override on those subprocess calls),
while the gist mirror, the PR/issue description edit, and every read stay on the
default account. These tests pin that split exactly.

See `specs/gh-comment-alt-account.md`.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from thrds.platforms.github import api, identity, reviews
from thrds.platforms.github.commands import create as create_mod
from thrds.platforms.github.commands import push as push_mod


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

@dataclass
class FakeProc:
    """Stand-in for `utz.proc` that answers `git config` / `gh` lookups from
    dicts and records nothing else. Values keyed by the config name or by a
    label the test controls."""
    config: dict[str, str] = field(default_factory=dict)
    keyring: dict[str, str] = field(default_factory=dict)
    shell: dict[str, str] = field(default_factory=dict)
    user_login: str | None = None
    user_envs: list[dict | None] = field(default_factory=list)

    def line(self, *cmd, **kwargs):
        cmd = [str(c) for c in cmd]
        if cmd[:2] == ['git', 'config']:
            return self.config.get(cmd[2])
        if cmd[:3] == ['gh', 'auth', 'token']:
            # ['gh','auth','token','-u',<login>]
            return self.keyring.get(cmd[4])
        if kwargs.get('shell'):
            return self.shell.get(cmd[0])
        raise AssertionError(f"unexpected proc.line: {cmd}")

    def json(self, *cmd, **kwargs):
        cmd = [str(c) for c in cmd]
        if cmd[:3] == ['gh', 'api', 'user']:
            self.user_envs.append(kwargs.get('env'))
            return {'login': self.user_login} if self.user_login else None
        raise AssertionError(f"unexpected proc.json: {cmd}")


# Small sentinel env threaded directly into the api/reviews helpers in tests.
# (The real `Identity.env()` is the full ambient environment with GH_TOKEN
# swapped in, since subprocess `env=` replaces the environment wholesale.)
BOT_ENV = {'GH_TOKEN': 'bottok'}


class GhRecorder:
    """Intercepts `gh` invocations on the shared `proc.json` / `proc.run`,
    records each call's `(op, cmd, env)`, and returns canned responses;
    everything else (git) passes through to the real implementation."""

    def __init__(self, comments_get=None, review_comments=None, threads=None):
        self.calls: list[tuple[str, list[str], dict | None]] = []
        self.comments_get = comments_get if comments_get is not None else []
        self.review_comments = review_comments if review_comments is not None else []
        self.threads = threads if threads is not None else []
        self._real_json = api.proc.json
        self._real_run = api.proc.run
        self._real_text = api.proc.text

    def install(self, monkeypatch):
        monkeypatch.setattr(api.proc, 'json', self.json)
        monkeypatch.setattr(api.proc, 'run', self.run)
        monkeypatch.setattr(api.proc, 'text', self.text)

    def _record(self, op, cmd, kwargs):
        self.calls.append((op, [str(c) for c in cmd], kwargs.get('env')))

    def envs_for(self, needle: str) -> list[dict | None]:
        return [env for _op, cmd, env in self.calls if any(needle in c for c in cmd)]

    def method_envs(self, method: str, needle: str) -> list[dict | None]:
        """Envs of calls whose args include `method` (e.g. 'POST') and `needle`."""
        return [
            env for _op, cmd, env in self.calls
            if method in cmd and any(needle in c for c in cmd)
        ]

    def read_envs(self, needle: str) -> list[dict | None]:
        """Envs of read calls (no -X write method) matching `needle`."""
        return [
            env for _op, cmd, env in self.calls
            if 'POST' not in cmd and 'PATCH' not in cmd and any(needle in c for c in cmd)
        ]

    def json(self, *cmd, **kwargs):
        scmd = [str(c) for c in cmd]
        if scmd[0] != 'gh':
            return self._real_json(*cmd, **kwargs)
        self._record('json', cmd, kwargs)
        # GraphQL
        if 'graphql' in scmd:
            query = next((a for a in scmd if a.startswith('query=')), '')
            if 'resolveReviewThread' in query and 'unresolve' not in query:
                return {'data': {'resolveReviewThread': {'thread': {'id': 'PRRT_x', 'isResolved': True}}}}
            if 'unresolveReviewThread' in query:
                return {'data': {'unresolveReviewThread': {'thread': {'id': 'PRRT_x', 'isResolved': False}}}}
            return {'data': {'repository': {'pullRequest': {'reviewThreads': {'nodes': self.threads}}}}}
        # Review-comment reply (POST .../pulls/.../replies)
        if '-X' in scmd and 'POST' in scmd and any(c.endswith('/replies') for c in scmd):
            return {'id': 501, 'user': {'login': 'rbw-bot'},
                    'created_at': '2025-01-03T00:00:00Z', 'body': 'reply body\n'}
        # Top-level issue comment POST
        if '-X' in scmd and 'POST' in scmd and any('/issues/' in c and c.endswith('/comments') for c in scmd):
            return {'id': 900, 'user': {'login': 'rbw-bot'},
                    'created_at': '2025-01-03T00:00:00Z', 'updated_at': '2025-01-03T00:00:00Z',
                    'body': 'drafted body\n'}
        # Review-comment body edit (PATCH .../pulls/comments/<id>)
        if '-X' in scmd and 'PATCH' in scmd and any('/pulls/comments/' in c for c in scmd):
            return {'id': 100, 'user': {'login': 'rbw-bot'}, 'body': 'head local\n'}
        # PR/issue metadata detection (`gh pr view` / `gh issue view`)
        if scmd[:3] == ['gh', 'pr', 'view']:
            raise ValueError('not a pr (forces issue fallback)')
        if scmd[:3] == ['gh', 'issue', 'view']:
            return {'title': 'Title', 'body': 'body text', 'number': 1, 'url': 'https://gh/i/1'}
        # Review comments list (--paginate .../pulls/<n>/comments)
        if '--paginate' in scmd and any('/pulls/' in c and 'comments' in c for c in scmd):
            return self.review_comments
        # Top-level issue comments list (GET .../issues/<n>/comments)
        if any('/issues/' in c and c.endswith('/comments') for c in scmd):
            return self.comments_get
        raise AssertionError(f"unhandled gh json: {scmd}")

    def run(self, *cmd, **kwargs):
        scmd = [str(c) for c in cmd]
        if scmd[0] != 'gh':
            return self._real_run(*cmd, **kwargs)
        self._record('run', cmd, kwargs)
        return None

    def text(self, *cmd, **kwargs):
        scmd = [str(c) for c in cmd]
        if scmd[0] != 'gh':
            return self._real_text(*cmd, **kwargs)
        self._record('text', cmd, kwargs)
        if scmd[:3] == ['gh', 'pr', 'create']:
            return 'https://github.com/o/r/pull/5\n'
        if scmd[:3] == ['gh', 'issue', 'create']:
            return 'https://github.com/o/r/issues/7\n'
        raise AssertionError(f"unhandled gh text: {scmd}")


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ['git', *args], cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()


# ---------------------------------------------------------------------------
# select_login — precedence flag > env > git config
# ---------------------------------------------------------------------------

class TestSelectLogin:
    def _proc(self, monkeypatch, config=None):
        fake = FakeProc(config=config or {})
        monkeypatch.setattr(identity, 'proc', fake)
        return fake

    def test_flag_wins(self, monkeypatch):
        self._proc(monkeypatch, config={'pr.as': 'cfg-bot'})
        monkeypatch.setenv('GHPR_AS', 'env-bot')
        assert identity.select_login('flag-bot') == 'flag-bot'

    def test_env_over_config(self, monkeypatch):
        self._proc(monkeypatch, config={'pr.as': 'cfg-bot'})
        monkeypatch.setenv('GHPR_AS', 'env-bot')
        assert identity.select_login(None) == 'env-bot'

    def test_config_when_no_flag_or_env(self, monkeypatch):
        self._proc(monkeypatch, config={'pr.as': 'cfg-bot'})
        monkeypatch.delenv('GHPR_AS', raising=False)
        assert identity.select_login(None) == 'cfg-bot'

    def test_none_when_unset(self, monkeypatch):
        self._proc(monkeypatch, config={})
        monkeypatch.delenv('GHPR_AS', raising=False)
        assert identity.select_login(None) is None


# ---------------------------------------------------------------------------
# Token sources — env > gh keyring > config command
# ---------------------------------------------------------------------------

class TestTokenSources:
    def test_env_source(self, monkeypatch):
        monkeypatch.setenv('GHPR_AS_TOKEN', 'pat-from-env')
        assert identity._token_from_env('rbw-bot') == 'pat-from-env'

    def test_env_source_absent(self, monkeypatch):
        monkeypatch.delenv('GHPR_AS_TOKEN', raising=False)
        assert identity._token_from_env('rbw-bot') is None

    def test_keyring_source(self, monkeypatch):
        monkeypatch.setattr(identity, 'proc', FakeProc(keyring={'rbw-bot': 'pat-from-gh'}))
        assert identity._token_from_gh_keyring('rbw-bot') == 'pat-from-gh'

    def test_config_cmd_source(self, monkeypatch):
        fake = FakeProc(config={'pr.as-token-cmd': 'print-token'}, shell={'print-token': 'pat-from-cmd'})
        monkeypatch.setattr(identity, 'proc', fake)
        assert identity._token_from_config_cmd('rbw-bot') == 'pat-from-cmd'

    def test_config_cmd_source_unset(self, monkeypatch):
        monkeypatch.setattr(identity, 'proc', FakeProc(config={}))
        assert identity._token_from_config_cmd('rbw-bot') is None

    def test_resolve_token_prefers_env(self, monkeypatch):
        monkeypatch.setenv('GHPR_AS_TOKEN', 'pat-from-env')
        monkeypatch.setattr(identity, 'proc', FakeProc(keyring={'rbw-bot': 'pat-from-gh'}))
        assert identity.resolve_token('rbw-bot') == 'pat-from-env'

    def test_resolve_token_falls_back_to_keyring(self, monkeypatch):
        monkeypatch.delenv('GHPR_AS_TOKEN', raising=False)
        monkeypatch.setattr(identity, 'proc', FakeProc(keyring={'rbw-bot': 'pat-from-gh'}))
        assert identity.resolve_token('rbw-bot') == 'pat-from-gh'

    def test_resolve_token_falls_back_to_config_cmd(self, monkeypatch):
        monkeypatch.delenv('GHPR_AS_TOKEN', raising=False)
        fake = FakeProc(keyring={}, config={'pr.as-token-cmd': 'print-token'}, shell={'print-token': 'pat-from-cmd'})
        monkeypatch.setattr(identity, 'proc', fake)
        assert identity.resolve_token('rbw-bot') == 'pat-from-cmd'

    def test_resolve_token_all_miss(self, monkeypatch):
        monkeypatch.delenv('GHPR_AS_TOKEN', raising=False)
        monkeypatch.setattr(identity, 'proc', FakeProc(keyring={}, config={}))
        assert identity.resolve_token('rbw-bot') is None


# ---------------------------------------------------------------------------
# verify_login + resolve_identity — verify before any write, refuse on mismatch
# ---------------------------------------------------------------------------

class TestResolveIdentity:
    def test_verify_login_passes_token_env(self, monkeypatch):
        fake = FakeProc(user_login='rbw-bot')
        monkeypatch.setattr(identity, 'proc', fake)
        assert identity.verify_login('bottok') == 'rbw-bot'
        assert fake.user_envs == [{**os.environ, 'GH_TOKEN': 'bottok'}]

    def test_none_when_no_login_selected(self, monkeypatch):
        monkeypatch.setattr(identity, 'proc', FakeProc(config={}))
        monkeypatch.delenv('GHPR_AS', raising=False)
        assert identity.resolve_identity(None) is None

    def test_success(self, monkeypatch):
        monkeypatch.setenv('GHPR_AS_TOKEN', 'bottok')
        monkeypatch.setattr(identity, 'proc', FakeProc(user_login='rbw-bot'))
        got = identity.resolve_identity('rbw-bot')
        assert got == identity.Identity(login='rbw-bot', token='bottok')

    def test_mismatch_refuses(self, monkeypatch):
        monkeypatch.setenv('GHPR_AS_TOKEN', 'bottok')
        monkeypatch.setattr(identity, 'proc', FakeProc(user_login='someone-else'))
        with pytest.raises(RuntimeError) as exc:
            identity.resolve_identity('rbw-bot')
        assert str(exc.value) == (
            "Refusing to act as 'rbw-bot': token authenticates as 'someone-else'."
        )

    def test_no_token_refuses(self, monkeypatch):
        monkeypatch.delenv('GHPR_AS_TOKEN', raising=False)
        monkeypatch.setattr(identity, 'proc', FakeProc(keyring={}, config={}))
        with pytest.raises(RuntimeError) as exc:
            identity.resolve_identity('rbw-bot')
        assert str(exc.value) == (
            "No token for GitHub login 'rbw-bot'. Set $GHPR_AS_TOKEN, run "
            "`gh auth login` as 'rbw-bot', or set `git config pr.as-token-cmd`."
        )

    def test_env(self):
        assert identity.Identity('rbw-bot', 'bottok').env()['GH_TOKEN'] == 'bottok'


# ---------------------------------------------------------------------------
# api write helpers thread `env`; read helpers never do
# ---------------------------------------------------------------------------

class TestApiHelpersEnv:
    def _spy(self, monkeypatch):
        seen = []

        def fake_json(*cmd, **kwargs):
            scmd = [str(c) for c in cmd]
            seen.append((scmd, kwargs.get('env')))
            if 'graphql' in scmd:
                return {'data': {'resolveReviewThread': {'thread': {}},
                                 'unresolveReviewThread': {'thread': {}}}}
            if '-X' in scmd:  # POST/PATCH writes — result unwrapped by caller, unused here
                return {}
            return []  # reads iterate over the result

        monkeypatch.setattr(api.proc, 'json', fake_json)
        return seen

    def test_reply_passes_env(self, monkeypatch):
        seen = self._spy(monkeypatch)
        api.reply_to_review_comment('o', 'r', '1', '100', '/tmp/b.md', env=BOT_ENV)
        assert seen[0][1] == BOT_ENV

    def test_update_passes_env(self, monkeypatch):
        seen = self._spy(monkeypatch)
        api.update_review_comment('o', 'r', '100', '/tmp/b.md', env=BOT_ENV)
        assert seen[0][1] == BOT_ENV

    def test_resolve_passes_env(self, monkeypatch):
        seen = self._spy(monkeypatch)
        api.resolve_review_thread('PRRT_x', env=BOT_ENV)
        assert seen[0][1] == BOT_ENV

    def test_unresolve_passes_env(self, monkeypatch):
        seen = self._spy(monkeypatch)
        api.unresolve_review_thread('PRRT_x', env=BOT_ENV)
        assert seen[0][1] == BOT_ENV

    def test_reads_pass_no_env(self, monkeypatch):
        seen = self._spy(monkeypatch)
        api.list_review_comments('o', 'r', '1')
        api.get_item_comments('o', 'r', '1', 'pr')
        assert [env for _cmd, env in seen] == [None, None]

    def test_write_helpers_default_env_none(self, monkeypatch):
        seen = self._spy(monkeypatch)
        api.reply_to_review_comment('o', 'r', '1', '100', '/tmp/b.md')
        assert seen[0][1] is None


# ---------------------------------------------------------------------------
# reviews.push — writes carry the bot env, reads do not
# ---------------------------------------------------------------------------

def _init_review_repo(tmp_path: Path) -> Path:
    repo = tmp_path
    _git(repo, 'init', '-q')
    _git(repo, 'config', 'user.email', 'test@example.com')
    _git(repo, 'config', 'user.name', 'Test')
    # Head comment (thread PRRT_x): locally resolved + body edited vs. remote.
    head = reviews.build_comment_text(
        {
            'author': 'rbw-bot', 'id': '100', 'created_at': '2025-01-01T00:00:00Z',
            'path': 'a.py', 'line': 1, 'side': 'RIGHT', 'commit_id': 'sha',
            'original_line': 1, 'thread_node_id': 'PRRT_x',
            'resolved': True, 'is_outdated': False,
        },
        'head local\n',
    )
    (repo / 'z-100-00-rbw-bot.md').write_text(head)
    (repo / 'z-100-new.md').write_text('a fresh reply\n')
    _git(repo, 'add', '.')
    _git(repo, 'commit', '-qm', 'review files')
    return repo


REMOTE_REVIEW_COMMENTS = [{
    'id': 100, 'in_reply_to_id': None, 'body': 'head remote\n',
    'user': {'login': 'rbw-bot'}, 'path': 'a.py', 'line': 1, 'side': 'RIGHT',
    'commit_id': 'sha', 'original_line': 1, 'created_at': '2025-01-01T00:00:00Z',
    'updated_at': '2025-01-01T00:00:00Z', 'html_url': 'https://gh/x',
}]
REMOTE_REVIEW_THREADS = [{
    'id': 'PRRT_x', 'isResolved': False, 'isOutdated': False,
    'comments': {'nodes': [{'databaseId': 100}]},
}]


class TestReviewsPushEnv:
    def test_writes_get_bot_env_reads_do_not(self, tmp_path, monkeypatch):
        repo = _init_review_repo(tmp_path)
        monkeypatch.chdir(repo)
        rec = GhRecorder(review_comments=REMOTE_REVIEW_COMMENTS, threads=REMOTE_REVIEW_THREADS)
        rec.install(monkeypatch)

        reviews.push('o', 'r', '1', current_user='rbw-bot', env=BOT_ENV)

        # Reads (GET comments, GraphQL threads query) carry no env override.
        assert rec.envs_for('--paginate') == [None]
        assert rec.envs_for('reviewThreads') == [None]
        # Writes: resolve mutation, edit PATCH, reply POST — all as the bot.
        assert rec.envs_for('resolveReviewThread') == [BOT_ENV]
        assert rec.envs_for('/replies') == [BOT_ENV]
        assert rec.envs_for('/pulls/comments/') == [BOT_ENV]

    def test_default_identity_sends_no_env(self, tmp_path, monkeypatch):
        repo = _init_review_repo(tmp_path)
        monkeypatch.chdir(repo)
        rec = GhRecorder(review_comments=REMOTE_REVIEW_COMMENTS, threads=REMOTE_REVIEW_THREADS)
        rec.install(monkeypatch)

        reviews.push('o', 'r', '1', current_user='rbw-bot', env=None)

        assert [env for _op, _cmd, env in rec.calls] == [None] * len(rec.calls)
        # And it still did the writes (env override is the only difference).
        assert rec.envs_for('resolveReviewThread') == [None]
        assert rec.envs_for('/replies') == [None]
        assert rec.envs_for('/pulls/comments/') == [None]


# ---------------------------------------------------------------------------
# push() command — top-level comment writes route; description edit + reads don't
# ---------------------------------------------------------------------------

def _init_issue_repo(tmp_path: Path) -> Path:
    repo = tmp_path
    _git(repo, 'init', '-q')
    _git(repo, 'config', 'user.email', 'test@example.com')
    _git(repo, 'config', 'user.name', 'Test')
    _git(repo, 'config', 'pr.owner', 'o')
    _git(repo, 'config', 'pr.repo', 'r')
    _git(repo, 'config', 'pr.number', '1')
    _git(repo, 'config', 'pr.type', 'issue')
    (repo / 'DESCRIPTION.md').write_text('# [o/r#1] Title\n\nbody text\n')
    return repo


class TestPushCommandEnv:
    def _run_push(self, repo, monkeypatch, rec, as_login):
        monkeypatch.chdir(repo)
        monkeypatch.setenv('GHPR_AS_TOKEN', 'bottok')
        monkeypatch.setattr(push_mod, '_gate_upstream', lambda *a, **k: None)
        monkeypatch.setattr(push_mod, 'set_remote_ref', lambda *a, **k: None)
        monkeypatch.setattr(identity, 'verify_login', lambda token: 'rbw-bot')
        monkeypatch.setattr(push_mod, 'get_current_github_user', lambda: 'ryan-williams')
        rec.install(monkeypatch)
        push_mod.push(
            gist=False, dry_run=False, footer=0, no_footer=False, open_browser=False,
            images=False, gist_private=None, no_comments=False, force_others=False,
            no_gate=True, as_login=as_login,
        )

    def test_new_comment_post_routes_as_bot(self, tmp_path, monkeypatch):
        repo = _init_issue_repo(tmp_path)
        (repo / 'new.md').write_text('drafted body\n')
        _git(repo, 'add', '.')
        _git(repo, 'commit', '-qm', 'init')
        rec = GhRecorder(comments_get=[{
            'id': 900, 'body': 'drafted body\n', 'user': {'login': 'rbw-bot'},
            'html_url': 'https://gh/c/900',
        }])
        self._run_push(repo, monkeypatch, rec, as_login='rbw-bot')

        # Comment POST and the description edit (gh issue edit) both authored as
        # the bot; the comments *read* (same endpoint, GET) stays default.
        assert rec.method_envs('POST', '/issues/1/comments') == [identity.Identity('rbw-bot', 'bottok').env()]
        assert rec.read_envs('/issues/1/comments') == [None]
        assert rec.envs_for('edit') == [identity.Identity('rbw-bot', 'bottok').env()]

    def test_default_identity_post_sends_no_env(self, tmp_path, monkeypatch):
        repo = _init_issue_repo(tmp_path)
        (repo / 'new.md').write_text('drafted body\n')
        _git(repo, 'add', '.')
        _git(repo, 'commit', '-qm', 'init')
        rec = GhRecorder(comments_get=[{
            'id': 900, 'body': 'drafted body\n', 'user': {'login': 'ryan-williams'},
            'html_url': 'https://gh/c/900',
        }])
        self._run_push(repo, monkeypatch, rec, as_login=None)

        assert [env for _op, _cmd, env in rec.calls] == [None] * len(rec.calls)

    def test_comment_edit_patch_routes_as_bot(self, tmp_path, monkeypatch):
        repo = _init_issue_repo(tmp_path)
        (repo / 'z900-rbw-bot.md').write_text(
            '<!-- author: rbw-bot -->\n'
            '<!-- created_at: 2025-01-01T00:00:00Z -->\n'
            '\n'
            'edited locally\n'
        )
        _git(repo, 'add', '.')
        _git(repo, 'commit', '-qm', 'init')
        rec = GhRecorder(comments_get=[{
            'id': 900, 'body': 'remote body\n', 'user': {'login': 'rbw-bot'},
            'html_url': 'https://gh/c/900',
        }])
        self._run_push(repo, monkeypatch, rec, as_login='rbw-bot')

        # PATCH of the existing comment and the description edit both as the bot.
        assert rec.method_envs('PATCH', '/issues/comments/900') == [identity.Identity('rbw-bot', 'bottok').env()]
        assert rec.envs_for('edit') == [identity.Identity('rbw-bot', 'bottok').env()]


# ---------------------------------------------------------------------------
# create() command — opening a PR/issue routes as the bot; reads stay default;
# the body edit is delegated to push() (covered above, now bot-routed too).
# ---------------------------------------------------------------------------

def _init_draft_repo(tmp_path: Path) -> Path:
    repo = tmp_path
    _git(repo, 'init', '-q')
    _git(repo, 'config', 'user.email', 'test@example.com')
    _git(repo, 'config', 'user.name', 'Test')
    _git(repo, 'config', 'pr.owner', 'o')
    _git(repo, 'config', 'pr.repo', 'r')
    (repo / 'DESCRIPTION.md').write_text('# My Title\n\nbody text\n')
    return repo


class TestCreateCommandEnv:
    def _prep(self, repo, monkeypatch, rec):
        monkeypatch.chdir(repo)
        monkeypatch.setenv('GHPR_AS_TOKEN', 'bottok')
        monkeypatch.delenv('GHPR_AS', raising=False)
        monkeypatch.setattr(identity, 'verify_login', lambda token: 'rbw-bot')
        # Isolate the create *call*: the body edit is push()'s job, tested above.
        self.finalize_calls = []
        monkeypatch.setattr(
            create_mod, '_finalize_created_item',
            lambda *a, **k: self.finalize_calls.append((a, k)),
        )
        rec.install(monkeypatch)

    def test_open_pr_routes_as_bot(self, tmp_path, monkeypatch):
        repo = _init_draft_repo(tmp_path)
        rec = GhRecorder()
        self._prep(repo, monkeypatch, rec)
        create_mod.create(
            head='feature', base='main', draft=False, issue=False, repo=None,
            yes=2, dry_run=False, path=None, as_login='rbw-bot',
        )
        assert rec.method_envs('create', 'pr') == [identity.Identity('rbw-bot', 'bottok').env()]
        # `as_login` is threaded into finalize (which routes the body edit).
        assert [a[-1] for a, _k in self.finalize_calls] == ['rbw-bot']

    def test_open_issue_routes_as_bot(self, tmp_path, monkeypatch):
        repo = _init_draft_repo(tmp_path)
        rec = GhRecorder()
        self._prep(repo, monkeypatch, rec)
        create_mod.create(
            head=None, base=None, draft=False, issue=True, repo=None,
            yes=2, dry_run=False, path=None, as_login='rbw-bot',
        )
        assert rec.method_envs('create', 'issue') == [identity.Identity('rbw-bot', 'bottok').env()]
        assert [a[-1] for a, _k in self.finalize_calls] == ['rbw-bot']

    def test_open_pr_default_identity_sends_no_env(self, tmp_path, monkeypatch):
        repo = _init_draft_repo(tmp_path)
        rec = GhRecorder()
        self._prep(repo, monkeypatch, rec)
        create_mod.create(
            head='feature', base='main', draft=False, issue=False, repo=None,
            yes=2, dry_run=False, path=None, as_login=None,
        )
        assert [env for _op, _cmd, env in rec.calls] == [None] * len(rec.calls)
        assert rec.method_envs('create', 'pr') == [None]
        assert [a[-1] for a, _k in self.finalize_calls] == [None]
