"""Gist mirror + git version-control for a thrds session.

Session dir layout (ghpr-style, per `gh/{number}/`):

    <parent-git-root-or-cwd>/<platform>/<slug>/   session dir; one per doc
      .git/                                   private git repo (nested is fine)
      thrds.yml                              thrds state (flat: gists reject dirs)
      <slug>.md                               the doc

The nested `.git/` is invisible to any surrounding project's git — parent's
`git status` shows the session dir as a single untracked entry, no
recursion (git treats a dir containing `.git/` as opaque).

A secret gist created at init becomes the `g` remote. Every state-mutating
verb (`push`, `pull --write`, `archive`) auto-commits + pushes; the gist
carries the full state.json + doc.md edit history for multi-machine sync.

Set ``THRDS_NO_PUSH=1`` to keep the local commits but skip every push — the
escape hatch for exercising a real session's code paths (or a copy of one)
without writing to its gist.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


# Set to any non-empty value to make every `push` a no-op while still
# committing locally. Exists because *every* mutating verb auto-pushes, so
# there is otherwise no way to exercise a real session's code paths without
# writing to its gist — including from a *copy* of a session dir, which
# carries `.git` and its remotes with it.
NO_PUSH_ENV = 'THRDS_NO_PUSH'


class MirrorError(RuntimeError):
    """Wraps `subprocess.CalledProcessError` with command + stderr for context."""


def push_disabled() -> bool:
    """True when ``THRDS_NO_PUSH`` is set to a non-empty value."""
    return bool(os.environ.get(NO_PUSH_ENV, ''))


def _run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    """Run ``cmd`` (list form, no shell); raise `MirrorError` on non-zero exit.

    stdout / stderr captured. Text mode so stdout/stderr are ``str``.
    """
    try:
        return subprocess.run(
            cmd, cwd=cwd, check=True, capture_output=True, text=True,
        )
    except subprocess.CalledProcessError as e:
        raise MirrorError(
            f"{' '.join(cmd)} failed (exit {e.returncode}):\n{e.stderr.rstrip()}"
        ) from e


def find_git_root(start: Path) -> Path | None:
    """Walk up from ``start`` to the nearest git repo root; None if none.

    Used to place ``<platform>/<slug>/`` under the enclosing project's root when
    one exists (co-located with the work it's for); falls back to ``start``
    otherwise.
    """
    try:
        result = _run(['git', 'rev-parse', '--show-toplevel'], cwd=start)
        return Path(result.stdout.strip())
    except MirrorError:
        return None


def is_git_repo(path: Path) -> bool:
    """True iff ``path`` has a ``.git`` dir (i.e. is a repo top-level)."""
    return (path / '.git').is_dir()


# A session dir is named for its *platform*, not for the tool: one repo can
# hold `gh/` PR clones beside `slck/` Slack sessions and they stay visibly
# separate. Each name is that platform's conventional short form — the same
# one its CLI alias uses. (`gh/` follows the same rule from the GitHub side:
# it names the platform, while `ghpr` names the tool.)
SESSION_DIRS = {
    'slack': 'slck',
    'discord': 'dscrd',
    'bsky': 'bsky',
    'mastodon': 'mastodon',
    'capture': 'capture',
}


def resolve_session_dir(cwd: Path, doc_slug: str, platform: str) -> Path:
    """Compute the target session dir: ``<git-root-or-cwd>/<platform>/<slug>/``."""
    root = find_git_root(cwd) or cwd
    if platform not in SESSION_DIRS:
        raise ValueError(
            f"No session dir configured for platform {platform!r} "
            f"(known: {', '.join(sorted(SESSION_DIRS))})"
        )
    return root / SESSION_DIRS[platform] / doc_slug


def init_repo(session_dir: Path) -> None:
    """``git init -q -b main`` inside ``session_dir``. Idempotent."""
    if not is_git_repo(session_dir):
        _run(['git', 'init', '-q', '-b', 'main'], cwd=session_dir)


def _has_staged_changes(session_dir: Path) -> bool:
    """True iff `git diff --cached` has any hunks."""
    r = _run(['git', 'diff', '--cached', '--stat'], cwd=session_dir)
    return bool(r.stdout.strip())


def commit(session_dir: Path, paths: list[str], message: str) -> str | None:
    """Stage ``paths`` and commit with ``message``; return HEAD SHA, or None
    if nothing was staged (idempotent when files are already committed at
    current content — no empty commits)."""
    _run(['git', 'add', *paths], cwd=session_dir)
    if not _has_staged_changes(session_dir):
        return None
    _run(['git', 'commit', '-q', '-m', message], cwd=session_dir)
    return _run(['git', 'rev-parse', 'HEAD'], cwd=session_dir).stdout.strip()


def amend(session_dir: Path, paths: list[str], message: str | None = None) -> str:
    """Fold ``paths``' current content into the tip commit; return the new SHA.

    The second half of push's commit-first shape: content is committed and
    pushed to Slack from HEAD, then the state the push itself produced
    (`staging_ts` assignments, chrome targets) folds into that same commit —
    one commit per push, whose thread content is byte-for-byte what went out.
    Safe because nothing external has seen the SHA yet: the gist push runs
    after the amend.
    """
    _run(['git', 'add', *paths], cwd=session_dir)
    args = ['git', 'commit', '-q', '--amend']
    args += ['-m', message] if message is not None else ['--no-edit']
    _run(args, cwd=session_dir)
    return _run(['git', 'rev-parse', 'HEAD'], cwd=session_dir).stdout.strip()


def is_tracked(session_dir: Path, path: str) -> bool:
    """True iff ``path`` is tracked in ``session_dir``'s repo (even if deleted
    from the working tree — `git add` can then stage the deletion)."""
    r = _run(['git', 'ls-files', '--', path], cwd=session_dir)
    return bool(r.stdout.strip())


def has_remote(session_dir: Path, name: str) -> bool:
    """True iff ``session_dir`` has a git remote named ``name``."""
    r = _run(['git', 'remote'], cwd=session_dir)
    return name in r.stdout.split()


def add_remote(session_dir: Path, name: str, url: str) -> None:
    """``git remote add`` (or ``set-url`` if it already exists)."""
    if has_remote(session_dir, name):
        _run(['git', 'remote', 'set-url', name, url], cwd=session_dir)
    else:
        _run(['git', 'remote', 'add', name, url], cwd=session_dir)


def push(session_dir: Path, remote: str = 'g', branch: str = 'main') -> None:
    """``git push <remote> HEAD:<branch>``. No-op if remote isn't configured
    (a `--no-gist` init leaves no ``g`` remote; commits still happen locally).

    Also a no-op when :data:`NO_PUSH_ENV` is set — announced on stderr rather
    than skipped silently, since "I thought it pushed" is exactly the failure
    this guard is meant to prevent in the other direction.
    """
    if not has_remote(session_dir, remote):
        return
    if push_disabled():
        print(f"{NO_PUSH_ENV} set — skipping push to {remote}", file=sys.stderr)
        return
    _run(['git', 'push', '-q', remote, f'HEAD:{branch}'], cwd=session_dir)


def commit_merge(
    session_dir: Path,
    paths: list[str],
    message: str,
    extra_parent: str,
) -> str:
    """Like :func:`commit`, but the commit records ``extra_parent`` too.

    `pull -m merge` uses this to connect the fetched remote-state commit into
    the branch's history: the merged content becomes an ordinary commit whose
    second parent is the `upstream` snapshot it reconciled against. Built
    with plumbing (`write-tree` / `commit-tree`) because `git merge` insists
    on driving the reconcile itself, and the reconcile already happened in
    `merge_trees`.

    Always commits, even when ``paths`` staged nothing new: a two-parent
    commit with an unchanged tree is exactly how git records "these histories
    are now synchronized", and that's the fact being recorded.
    """
    _run(['git', 'add', *paths], cwd=session_dir)
    tree = _run(['git', 'write-tree'], cwd=session_dir).stdout.strip()
    head = _run(['git', 'rev-parse', 'HEAD'], cwd=session_dir).stdout.strip()
    sha = _run(
        ['git', 'commit-tree', tree, '-p', head, '-p', extra_parent, '-m', message],
        cwd=session_dir,
    ).stdout.strip()
    branch = _run(['git', 'symbolic-ref', 'HEAD'], cwd=session_dir).stdout.strip()
    _run(['git', 'update-ref', branch, sha], cwd=session_dir)
    return sha


def align_to_remote(session_dir: Path, remote: str = 'g', branch: str = 'main') -> None:
    """`git fetch <remote>` + `git reset --hard <remote>/<branch>`.

    After `create_gist` populates a gist from a file directly, our local git
    history has no shared ancestor with the gist's initial commit — a
    subsequent `git push` would be rejected as non-fast-forward. Aligning
    here (drop any pre-existing local HEAD, adopt gist HEAD verbatim) lets
    our subsequent state.json commit fast-forward cleanly. Only safe on a
    freshly-init'd session dir where no meaningful commits exist yet.
    """
    _run(['git', 'fetch', '-q', remote], cwd=session_dir)
    _run(['git', 'reset', '-q', '--hard', f'{remote}/{branch}'], cwd=session_dir)


def create_gist(session_dir: Path, description: str, files: list[str]) -> tuple[str, str]:
    """Create a secret gist via ``gh gist create`` and return (gist_id, git_url).

    Depends on the ``gh`` CLI (authenticated). ``gh gist create`` defaults to
    secret (``--public`` to opt out; there is no ``--secret`` flag). Stdout
    is the gist URL — parse out the gist ID and construct the git-clone URL
    so `add_remote` can point ``g`` at it.
    """
    r = _run(
        ['gh', 'gist', 'create', '--desc', description, *files],
        cwd=session_dir,
    )
    # gh writes progress to stderr; the URL is the last non-empty stdout line.
    url_lines = [ln for ln in r.stdout.strip().splitlines() if ln.strip()]
    if not url_lines:
        raise MirrorError(f"gh gist create produced no output; stderr: {r.stderr}")
    url = url_lines[-1]
    gist_id = url.rsplit('/', 1)[-1]
    # SSH URL (not HTTPS) — the HTTPS variant would prompt for a username on
    # `git push` unless the user has run `gh auth setup-git`; SSH just works
    # as long as their GH SSH key is set up (the common case).
    git_url = f'git@gist.github.com:{gist_id}.git'
    return gist_id, git_url


def commit_and_push(
    session_dir: Path,
    paths: list[str],
    message: str,
    remote: str = 'g',
) -> str | None:
    """`commit()` then `push()` — the standard "state changed, mirror it" call.

    Returns the new HEAD SHA if a commit happened, else None. If no remote is
    configured, the commit still fires but push is a no-op — local history
    accumulates even without a gist mirror.
    """
    sha = commit(session_dir, paths, message)
    if sha is not None:
        push(session_dir, remote=remote)
    return sha
