"""Tests for flat review-thread sync (reviews.py)."""

from dataclasses import dataclass
from pathlib import Path

import pytest
from utz import proc

from thrds.platforms.github import reviews


def make_head(head_id, author='Copilot', node_id='PRRT_x', resolved=False,
              path='a.py', line=1, body='head body\n'):
    fields = {
        'author': author, 'id': head_id, 'created_at': '2025-01-01T00:00:00Z',
        'path': path, 'line': line, 'side': 'RIGHT', 'commit_id': 'sha',
        'original_line': line, 'thread_node_id': node_id,
        'resolved': resolved, 'is_outdated': False,
    }
    return reviews.write_comment_file(Path(reviews.synced_filename(head_id, 0, author)), fields, body)


class TestFrontmatter:
    def test_build_head_exact(self):
        fields = {
            'author': 'Copilot', 'id': '100', 'created_at': '2025-01-01T00:00:00Z',
            'path': 'a.py', 'line': 8, 'side': 'RIGHT', 'commit_id': 'sha1',
            'original_line': 8, 'thread_node_id': 'PRRT_x',
            'resolved': True, 'is_outdated': False,
        }
        assert reviews.build_comment_text(fields, 'head body\n') == (
            '<!-- author: Copilot -->\n'
            '<!-- id: 100 -->\n'
            '<!-- created_at: 2025-01-01T00:00:00Z -->\n'
            '<!-- path: a.py -->\n'
            '<!-- line: 8 -->\n'
            '<!-- side: RIGHT -->\n'
            '<!-- commit_id: sha1 -->\n'
            '<!-- original_line: 8 -->\n'
            '<!-- thread_node_id: PRRT_x -->\n'
            '<!-- resolved: true -->\n'
            '<!-- is_outdated: false -->\n'
            '\n'
            'head body\n'
        )

    def test_build_reply_exact(self):
        fields = {
            'author': 'ryan-williams', 'id': '101',
            'created_at': '2025-01-01T00:00:00Z', 'updated_at': '2025-01-02T00:00:00Z',
            'in_reply_to': '100',
        }
        assert reviews.build_comment_text(fields, 'reply body\n') == (
            '<!-- author: ryan-williams -->\n'
            '<!-- id: 101 -->\n'
            '<!-- created_at: 2025-01-01T00:00:00Z -->\n'
            '<!-- updated_at: 2025-01-02T00:00:00Z -->\n'
            '<!-- in_reply_to: 100 -->\n'
            '\n'
            'reply body\n'
        )

    def test_parse_typed_round_trip(self, tmp_path):
        fields = {
            'author': 'Copilot', 'id': '100', 'created_at': '2025-01-01T00:00:00Z',
            'path': 'a.py', 'line': 8, 'side': 'RIGHT', 'commit_id': 'sha1',
            'original_line': 8, 'thread_node_id': 'PRRT_x',
            'resolved': True, 'is_outdated': False,
        }
        path = tmp_path / 'c.md'
        reviews.write_comment_file(path, fields, 'body text\n')
        parsed, body = reviews.parse_comment_file(path)
        assert parsed == fields  # ints/bools coerced back exactly
        assert body == 'body text\n'

    def test_parse_outdated_null_line(self, tmp_path):
        path = tmp_path / 'c.md'
        # line absent (outdated thread); original_line present
        reviews.write_comment_file(path, {
            'author': 'x', 'id': '5', 'created_at': 't',
            'original_line': 3, 'thread_node_id': 'PRRT_y', 'resolved': False,
        }, 'b\n')
        parsed, _ = reviews.parse_comment_file(path)
        assert parsed.get('line') is None
        assert parsed['original_line'] == 3


class TestFilenameParsing:
    def test_synced_filename(self):
        assert reviews.synced_filename('3012924106', 0, 'Copilot') == 'z-3012924106-00-Copilot.md'
        assert reviews.synced_filename('3012924106', 12, 'ryan-williams') == 'z-3012924106-12-ryan-williams.md'

    def test_parse_synced(self):
        assert reviews.parse_review_filename('z-3012924106-00-Copilot.md') == {
            'kind': 'synced', 'head_id': '3012924106', 'seq': 0, 'author': 'Copilot',
        }
        assert reviews.parse_review_filename('z-100-02-ryan-williams.md') == {
            'kind': 'synced', 'head_id': '100', 'seq': 2, 'author': 'ryan-williams',
        }

    def test_parse_draft(self):
        assert reviews.parse_review_filename('z-100-new.md') == {'kind': 'draft', 'head_id': '100'}
        assert reviews.parse_review_filename('z-100-new-followup.md') == {'kind': 'draft', 'head_id': '100'}

    def test_parse_non_review(self):
        # top-level issue comments (digit after z) are NOT review files
        assert reviews.parse_review_filename('z123456789-ryan-williams.md') is None
        assert reviews.parse_review_filename('z123.md') is None
        assert reviews.parse_review_filename('new.md') is None
        assert reviews.parse_review_filename('owner-repo#123.md') is None


class TestScanLocalThreads:
    def test_groups_and_orders(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        for name in [
            'z-100-00-Copilot.md', 'z-100-02-jder.md', 'z-100-01-ryan-williams.md',
            'z-200-00-jder.md', 'z-100-new.md',
            'z999-someone.md',  # top-level issue comment — ignored
            'repo#5.md',        # description — ignored
        ]:
            (tmp_path / name).write_text('x')

        groups = reviews.scan_local_threads()
        assert sorted(groups) == ['100', '200']
        assert [(s, a) for s, a, _p in groups['100']['synced']] == [
            (0, 'Copilot'), (1, 'ryan-williams'), (2, 'jder'),
        ]
        assert [p.name for p in groups['100']['drafts']] == ['z-100-new.md']
        assert groups['200']['drafts'] == []

    def test_head_path(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / 'z-100-00-Copilot.md').write_text('x')
        (tmp_path / 'z-100-01-ryan.md').write_text('x')
        assert reviews.head_path('100') == Path('z-100-00-Copilot.md')
        assert reviews.head_path('999') is None


@dataclass
class GroupShape:
    head_id: int
    comment_ids: list
    resolved: bool
    node_id: str
    path: str
    line: int


def _shape(grouped):
    return [
        GroupShape(
            head_id=g['head']['id'],
            comment_ids=[c['id'] for c in g['comments']],
            resolved=g['meta']['resolved'],
            node_id=g['meta']['thread_node_id'],
            path=g['meta']['path'],
            line=g['meta']['line'],
        )
        for g in grouped
    ]


def _rest(id, in_reply_to, login, body, path='a.py', line=3, sha='sha1'):
    return {
        'id': id, 'in_reply_to_id': in_reply_to, 'path': path, 'line': line,
        'side': 'RIGHT', 'start_line': None, 'start_side': None, 'commit_id': sha,
        'original_line': line, 'user': {'login': login}, 'body': body,
        'created_at': '2025-01-01T00:00:00Z', 'updated_at': '2025-01-01T00:00:00Z',
        'html_url': f'https://github.com/o/r/pull/5#discussion_r{id}',
    }


class TestGroupThreads:
    def test_groups_sorts_members_and_picks_head(self):
        comments = [
            _rest(101, 100, 'ryan-williams', 'reply A'),
            _rest(100, None, 'jder', 'head A'),
            _rest(200, None, 'jder', 'head B', path='b.py', line=9, sha='sha2'),
        ]
        threads = [
            {'id': 'PRRT_A', 'isResolved': False, 'isOutdated': False, 'comment_db_ids': [100, 101]},
            {'id': 'PRRT_B', 'isResolved': True, 'isOutdated': False, 'comment_db_ids': [200]},
        ]
        grouped, orphans = reviews.group_threads(comments, threads)
        assert orphans == []
        assert _shape(grouped) == [
            GroupShape(100, [100, 101], False, 'PRRT_A', 'a.py', 3),
            GroupShape(200, [200], True, 'PRRT_B', 'b.py', 9),
        ]

    def test_orphan(self):
        comments = [_rest(100, None, 'jder', 'head'), _rest(999, None, 'x', 'orphan')]
        threads = [{'id': 'PRRT_A', 'isResolved': False, 'isOutdated': False, 'comment_db_ids': [100]}]
        grouped, orphans = reviews.group_threads(comments, threads)
        assert [g['head']['id'] for g in grouped] == [100]
        assert orphans == [999]


class TestCommentFields:
    def test_head_fields_include_meta_no_reply(self):
        meta = {'path': 'a.py', 'line': 3, 'thread_node_id': 'PRRT_A', 'resolved': True}
        head = _rest(100, None, 'jder', 'head')
        fields = reviews._comment_fields(head, '100', is_head=True, meta=meta)
        assert fields['thread_node_id'] == 'PRRT_A'
        assert fields['resolved'] is True
        assert 'in_reply_to' not in fields

    def test_reply_fields_have_in_reply_to_not_meta(self):
        meta = {'path': 'a.py'}
        reply = _rest(101, 100, 'ryan-williams', 'reply')
        fields = reviews._comment_fields(reply, '100', is_head=False, meta=meta)
        assert fields['in_reply_to'] == '100'
        assert 'path' not in fields


class TestThreadConvenience:
    def test_find_thread_by_head_and_node(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        make_head('100', node_id='PRRT_aaa')
        make_head('200', author='jder', node_id='PRRT_bbb', resolved=True)
        assert reviews.find_thread('100') == '100'
        assert reviews.find_thread('PRRT_bbb') == '200'
        assert reviews.find_thread('nope') is None

    def test_set_thread_resolved(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        make_head('100', resolved=False)
        assert reviews.set_thread_resolved('100', True) is True
        assert reviews.parse_comment_file(reviews.head_path('100'))[0]['resolved'] is True
        assert reviews.set_thread_resolved('100', True) is False  # no-op

    def test_new_reply_draft_path_increments(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        make_head('100')
        assert reviews.new_reply_draft_path('100') == Path('z-100-new.md')
        Path('z-100-new.md').write_text('x')
        assert reviews.new_reply_draft_path('100') == Path('z-100-new-2.md')


class TestReviewCommands:
    def test_resolve_and_unresolve(self, tmp_path, monkeypatch):
        from click.testing import CliRunner
        from thrds.platforms.github.cli import cli
        monkeypatch.chdir(tmp_path)
        make_head('100', resolved=False)

        runner = CliRunner()
        assert runner.invoke(cli, ['review', 'resolve', '100']).exit_code == 0
        assert reviews.parse_comment_file(reviews.head_path('100'))[0]['resolved'] is True
        assert runner.invoke(cli, ['review', 'unresolve', '100']).exit_code == 0
        assert reviews.parse_comment_file(reviews.head_path('100'))[0]['resolved'] is False

    def test_reply_with_message(self, tmp_path, monkeypatch):
        from click.testing import CliRunner
        from thrds.platforms.github.cli import cli
        monkeypatch.chdir(tmp_path)
        make_head('100')
        runner = CliRunner()
        r = runner.invoke(cli, ['review', 'reply', '-m', 'Thanks, fixed.', '100'])
        assert r.exit_code == 0
        assert Path('z-100-new.md').read_text() == 'Thanks, fixed.\n'

    def test_unknown_thread_errors(self, tmp_path, monkeypatch):
        from click.testing import CliRunner
        from thrds.platforms.github.cli import cli
        monkeypatch.chdir(tmp_path)
        assert runner_invoke_exit(cli, ['review', 'resolve', '999']) == 1


def runner_invoke_exit(cli, args):
    from click.testing import CliRunner
    return CliRunner().invoke(cli, args).exit_code


class TestDiffStatusLines:
    def test_per_thread_status_in_sync_and_pending(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        make_head('100', resolved=True, node_id='PRRT_A', path='a.py', line=3, body='head body')
        make_head('200', author='jder', resolved=False, node_id='PRRT_B', path='b.py', line=9, body='head body')
        remote = [_rest(100, None, 'Copilot', 'head body', path='a.py', line=3),
                  _rest(200, None, 'jder', 'head body', path='b.py', line=9)]
        # PRRT_A resolved (== local) → in sync; PRRT_B resolved remotely but local open → pending unresolve
        _mock_api(monkeypatch, remote, [_thread('PRRT_A', True, [100]), _thread('PRRT_B', True, [200])])

        out = []
        monkeypatch.setattr(reviews, 'err', lambda *a: out.append(' '.join(str(x) for x in a)))
        reviews.diff('o', 'r', '5', use_color=False, current_user='ryan-williams')
        lines = [l for l in out if l.startswith('Thread')]
        assert lines == [
            'Thread 100 (a.py:3) [resolved] https://github.com/o/r/pull/5#discussion_r100',
            'Thread 200 (b.py:9) [open] → would unresolve on push (remote=resolved) '
            'https://github.com/o/r/pull/5#discussion_r200',
        ]


    def test_local_only_resolve_edit_is_flagged(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        make_head('100', resolved=False, node_id='PRRT_A', path='a.py', line=3, body='head body')
        proc.run('git', 'add', reviews.synced_filename('100', 0, 'Copilot'), log=None)
        proc.run('git', 'commit', '-q', '-m', 'init', log=None)
        # Toggle the working copy to resolved (uncommitted); GitHub is already resolved.
        reviews.set_thread_resolved('100', True)
        remote = [_rest(100, None, 'Copilot', 'head body', path='a.py', line=3)]
        _mock_api(monkeypatch, remote, [_thread('PRRT_A', True, [100])])

        out = []
        monkeypatch.setattr(reviews, 'err', lambda *a: out.append(' '.join(str(x) for x in a)))
        reviews.diff('o', 'r', '5', use_color=False, current_user='ryan-williams')
        lines = [l for l in out if l.startswith('Thread')]
        assert lines == [
            'Thread 100 (a.py:3) [resolved] → locally changed from open '
            '(matches GitHub, nothing to push) https://github.com/o/r/pull/5#discussion_r100',
        ]


class TestBaseline:
    def test_write_and_read(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        proc.run('git', 'init', '-q', log=None)
        reviews.write_baseline('3438519490', True)
        assert reviews.read_baseline('3438519490') == {'resolved': True}
        assert reviews.read_baseline('nonexistent') is None


def _thread(node_id, resolved, db_ids, outdated=False):
    return {'id': node_id, 'isResolved': resolved, 'isOutdated': outdated, 'comment_db_ids': db_ids}


def _git_init(tmp_path):
    proc.run('git', 'init', '-q', log=None)
    proc.run('git', 'config', 'user.email', 't@t.com', log=None)
    proc.run('git', 'config', 'user.name', 't', log=None)


def _commit(*paths: str, msg: str = 'wip') -> None:
    """Stage the given paths and commit.

    Under the Contract A push contract, `push` reads from HEAD only; tests that
    write files and then exercise push need to commit first to mirror real
    user workflow (edit → commit → push).
    """
    proc.run('git', 'add', *paths, log=None)
    proc.run('git', 'commit', '-q', '-m', msg, log=None)


def _mock_api(monkeypatch, comments, threads):
    """Stub every GH-touching api function reviews.py imported. Returns a
    `calls` dict that records mutating-call args."""
    calls = {'patch': [], 'reply': [], 'resolve': [], 'unresolve': []}
    monkeypatch.setattr(reviews, 'list_review_comments', lambda o, r, n: comments)
    monkeypatch.setattr(reviews, 'list_review_threads', lambda o, r, n: threads)

    def fake_update(owner, repo, cid, body_file, env=None):
        calls['patch'].append((cid, Path(body_file).read_text()))
        return {'id': int(cid)}

    def fake_reply(owner, repo, number, head_id, body_file, env=None):
        calls['reply'].append((head_id, Path(body_file).read_text()))
        new_id = 9000 + len(calls['reply'])
        return {'id': new_id, 'user': {'login': 'ryan-williams'},
                'created_at': '2025-02-02T00:00:00Z', 'updated_at': '2025-02-02T00:00:00Z',
                'body': Path(body_file).read_text()}

    monkeypatch.setattr(reviews, 'update_review_comment', fake_update)
    monkeypatch.setattr(reviews, 'reply_to_review_comment', fake_reply)
    monkeypatch.setattr(reviews, 'resolve_review_thread', lambda nid, env=None: calls['resolve'].append(nid))
    monkeypatch.setattr(reviews, 'unresolve_review_thread', lambda nid, env=None: calls['unresolve'].append(nid))
    return calls


class TestPullOrchestration:
    def test_pull_writes_flat_files_and_baseline(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        comments = [
            _rest(100, None, 'Copilot', 'head body', path='a.py', line=8),
            _rest(101, 100, 'ryan-williams', 'reply body', path='a.py', line=8),
        ]
        _mock_api(monkeypatch, comments, [_thread('PRRT_A', True, [100, 101])])

        assert reviews.pull('o', 'r', '5') == (1, 2, 0)
        from glob import glob
        assert sorted(glob('z-*.md')) == ['z-100-00-Copilot.md', 'z-100-01-ryan-williams.md']

        hf, hbody = reviews.parse_comment_file(Path('z-100-00-Copilot.md'))
        assert hf['resolved'] is True
        assert hf['thread_node_id'] == 'PRRT_A'
        assert hf['line'] == 8
        assert 'in_reply_to' not in hf
        assert hbody == 'head body'  # bodies mirror remote verbatim (no forced newline)

        rf, _ = reviews.parse_comment_file(Path('z-100-01-ryan-williams.md'))
        assert rf['in_reply_to'] == '100'
        assert 'thread_node_id' not in rf

        assert reviews.read_baseline('100') == {'resolved': True}

    def test_pull_is_idempotent(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        comments = [_rest(100, None, 'Copilot', 'head body')]
        _mock_api(monkeypatch, comments, [_thread('PRRT_A', False, [100])])
        assert reviews.pull('o', 'r', '5') == (1, 1, 0)
        assert reviews.pull('o', 'r', '5') == (1, 0, 0)  # no changes second time


class TestPushOrchestration:
    def _seed_thread(self, head_body='head body', resolved=False, node_id='PRRT_A'):
        """Write a local head + reply pair and commit (as pull would)."""
        head_fields = {
            'author': 'Copilot', 'id': '100', 'created_at': '2025-01-01T00:00:00Z',
            'path': 'a.py', 'line': 8, 'side': 'RIGHT', 'commit_id': 'sha',
            'original_line': 8, 'thread_node_id': node_id, 'resolved': resolved,
            'is_outdated': False,
        }
        reviews.write_comment_file(Path('z-100-00-Copilot.md'), head_fields, head_body)
        reply_fields = {'author': 'ryan-williams', 'id': '101',
                        'created_at': '2025-01-01T00:00:00Z', 'in_reply_to': '100'}
        reviews.write_comment_file(Path('z-100-01-ryan-williams.md'), reply_fields, 'reply body')
        _commit('z-100-00-Copilot.md', 'z-100-01-ryan-williams.md', msg='seed thread')

    def test_push_edits_own_comment(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread()
        # Locally edit the reply, then commit (push reads from HEAD).
        f = Path('z-100-01-ryan-williams.md')
        flds, _ = reviews.parse_comment_file(f)
        reviews.write_comment_file(f, flds, 'reply body EDITED\n')
        _commit('z-100-01-ryan-williams.md', msg='edit reply')

        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', False, [100, 101])])

        reviews.push('o', 'r', '5', current_user='ryan-williams')
        assert calls['patch'] == [('101', 'reply body EDITED\n')]
        assert calls['reply'] == []

    def test_push_skips_others_comment_without_force(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread(head_body='head body')
        # Edit the head comment (authored by Copilot, not us), then commit.
        f = Path('z-100-00-Copilot.md')
        flds, _ = reviews.parse_comment_file(f)
        reviews.write_comment_file(f, flds, 'head body HACKED\n')
        _commit('z-100-00-Copilot.md', msg='edit head')

        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', False, [100, 101])])

        reviews.push('o', 'r', '5', current_user='ryan-williams')
        assert calls['patch'] == []  # not ours, not forced

        reviews.push('o', 'r', '5', current_user='ryan-williams', force_others=True)
        assert calls['patch'] == [('100', 'head body HACKED\n')]

    def test_push_posts_reply_and_renames(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread()
        Path('z-100-new.md').write_text('Acknowledged, thanks!\n')
        _commit('z-100-new.md', msg='add draft')

        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', False, [100, 101])])

        reviews.push('o', 'r', '5', current_user='ryan-williams')
        assert calls['reply'] == [('100', 'Acknowledged, thanks!\n')]

        from glob import glob
        assert sorted(glob('z-100-*.md')) == [
            'z-100-00-Copilot.md', 'z-100-01-ryan-williams.md', 'z-100-02-ryan-williams.md',
        ]
        assert not Path('z-100-new.md').exists()
        nf, nbody = reviews.parse_comment_file(Path('z-100-02-ryan-williams.md'))
        assert nf['in_reply_to'] == '100'
        assert nbody == 'Acknowledged, thanks!\n'
        # rename was committed
        assert proc.line('git', 'log', '--oneline', '-1', '--format=%s', log=None) == 'Post 1 review reply'

    def test_push_resolve_toggle_fires_mutation(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread(resolved=True)  # local wants resolved
        reviews.write_baseline('100', False)  # pulled as unresolved

        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', False, [100, 101])])

        reviews.push('o', 'r', '5', current_user='ryan-williams')
        assert calls['resolve'] == ['PRRT_A']
        assert calls['unresolve'] == []

    def test_push_skips_resolve_when_head_file_dirty(self, tmp_path, monkeypatch):
        """If the head file has uncommitted WT changes, push must NOT apply
        resolve/unresolve from HEAD — HEAD's state may be stale relative to the
        user's intent in WT, and acting on it could silently reverse a desired
        resolve on GitHub."""
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread(resolved=False)  # HEAD committed as unresolved
        reviews.write_baseline('100', False)
        # User toggled the head file to resolved=true in WT but didn't commit.
        f = Path('z-100-00-Copilot.md')
        flds, body = reviews.parse_comment_file(f)
        flds['resolved'] = True
        reviews.write_comment_file(f, flds, body)
        # Remote already moved to resolved=true (e.g., from a prior push).
        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', True, [100, 101])])
        reviews.push('o', 'r', '5', current_user='ryan-williams')
        # No mutation in either direction — safety prevents the dangerous
        # "HEAD says false, remote says true → unresolve" path.
        assert calls['resolve'] == [] and calls['unresolve'] == []
        # Baseline unchanged (no sync happened for this thread).
        assert reviews.read_baseline('100') == {'resolved': False}

    def test_push_skips_edit_when_synced_file_dirty(self, tmp_path, monkeypatch):
        """Symmetric to the resolve gate: if a synced comment file has
        uncommitted WT changes, push must NOT PATCH its HEAD body onto GitHub.
        HEAD may be stale relative to the user's WT intent (and to a remote edit
        made out of band), so acting on it could silently revert either."""
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread()
        # User edits the reply in WT but has NOT committed it.
        f = Path('z-100-01-ryan-williams.md')
        flds, _ = reviews.parse_comment_file(f)
        reviews.write_comment_file(f, flds, 'reply body WIP\n')
        # Remote body differs from HEAD (someone edited it out of band).
        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body REMOTE')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', False, [100, 101])])
        reviews.push('o', 'r', '5', current_user='ryan-williams')
        # No PATCH: the dirty WT file is skipped rather than pushing stale HEAD.
        assert calls['patch'] == []

    def test_push_resolve_noop_when_already_matches(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread(resolved=False)
        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', False, [100, 101])])
        reviews.push('o', 'r', '5', current_user='ryan-williams')
        assert calls['resolve'] == [] and calls['unresolve'] == []

    def test_push_refuses_resolve_on_remote_drift(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _git_init(tmp_path)
        self._seed_thread(resolved=False)   # local unresolved
        reviews.write_baseline('100', False)  # pulled unresolved
        remote = [_rest(100, None, 'Copilot', 'head body'),
                  _rest(101, 100, 'ryan-williams', 'reply body')]
        # remote moved to resolved=True out of band → drift
        calls = _mock_api(monkeypatch, remote, [_thread('PRRT_A', True, [100, 101])])
        reviews.push('o', 'r', '5', current_user='ryan-williams')
        assert calls['resolve'] == [] and calls['unresolve'] == []  # refused
