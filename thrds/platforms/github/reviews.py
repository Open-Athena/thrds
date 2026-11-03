"""Pull/push/diff for PR review-thread (inline) comments.

Review threads are stored as *flat* files alongside the description and
top-level comments (gists have no directories, so the per-PR repo's tree —
which is force-pushed to the mirror gist — must stay flat). Each comment is one
file:

    z-<head_id>-<NN>-<author>.md

where `<head_id>` is the thread's first (top) comment id, `<NN>` is a
zero-padded sequence (`00` = head, `01`, `02`, … = replies in chronological
order). Lexical sort therefore groups a thread together and keeps the head
first. Per-comment frontmatter (`<!-- key: value -->`) carries `author`, `id`,
`created_at`, `updated_at`, and `in_reply_to` (replies only); the *head* file
additionally carries the thread metadata (`path`, `line`, `side`, `commit_id`,
`thread_node_id`, `resolved`, …).

Draft replies are `z-<head_id>-new[-<slug>].md` (body only, no frontmatter); on
push they're posted and renamed to the next `z-<head_id>-<NN>-<author>.md`.

See `specs/done/threaded-review-comments.md` for the design.
"""

import json
import re
from glob import glob
from os import unlink
from pathlib import Path
from tempfile import NamedTemporaryFile

from utz import proc, err

from .api import (
    list_review_comments,
    list_review_threads,
    reply_to_review_comment,
    update_review_comment,
    resolve_review_thread,
    unresolve_review_thread,
)
from .render import render_unified_diff, link


# z-<head_id>-<NN>-<author>.md  (synced head/reply)
SYNCED_RE = re.compile(r'^z-(\d+)-(\d+)-(.+)\.md$')
# z-<head_id>-new[-<slug>].md  (local draft reply)
DRAFT_RE = re.compile(r'^z-(\d+)-new(?:-.*)?\.md$')

# Frontmatter field order (stable output); None-valued fields omitted.
_FIELD_ORDER = [
    'author', 'id', 'created_at', 'updated_at', 'in_reply_to',
    'path', 'line', 'side', 'start_line', 'start_side',
    'commit_id', 'original_line', 'thread_node_id', 'resolved', 'is_outdated',
]
_INT_FIELDS = {'line', 'start_line', 'original_line'}
_BOOL_FIELDS = {'resolved', 'is_outdated'}

_FRONTMATTER_RE = re.compile(r'^<!--\s*([a-z_]+):\s*(.*?)\s*-->$')


# ---------------------------------------------------------------------------
# Comment file frontmatter I/O
# ---------------------------------------------------------------------------

def parse_comment_file(path: Path) -> tuple[dict, str]:
    """Parse a review comment file's frontmatter + body.

    Returns (fields, body). `fields` values are typed: int fields → int,
    bool fields → bool, everything else → str.
    """
    return _parse_comment_text(path.read_text())


def parse_comment_file_at_head(filename: str) -> tuple[dict, str] | None:
    """Parse a review comment file as committed at HEAD; None if absent.

    Use this from `push_reviews` so the sync mirrors committed state — WT
    changes are ignored unless explicitly committed (Contract A).
    """
    text = proc.text('git', 'show', f'HEAD:{filename}', err_ok=True, log=None)
    if not text:
        return None
    return _parse_comment_text(text)


def _parse_comment_text(text: str) -> tuple[dict, str]:
    lines = text.splitlines(keepends=True)
    raw = {}
    body_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        m = _FRONTMATTER_RE.match(stripped)
        if m:
            raw[m.group(1)] = m.group(2)
            continue
        if stripped.startswith('<!--'):
            continue  # unrecognized comment line in header — skip
        body_start = i
        break

    fields = {}
    for key, value in raw.items():
        if key in _INT_FIELDS:
            fields[key] = int(value) if re.fullmatch(r'-?\d+', value) else None
        elif key in _BOOL_FIELDS:
            fields[key] = value.strip().lower() == 'true'
        else:
            fields[key] = value
    body = ''.join(lines[body_start:]).lstrip()
    return fields, body


def build_comment_text(fields: dict, body: str) -> str:
    """Render frontmatter (in canonical order) + body."""
    header = []
    for key in _FIELD_ORDER:
        value = fields.get(key)
        if value is None:
            continue
        if isinstance(value, bool):
            value = 'true' if value else 'false'
        header.append(f'<!-- {key}: {value} -->')
    return '\n'.join(header) + '\n\n' + body


def write_comment_file(path: Path, fields: dict, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(build_comment_text(fields, body))
    return path


# ---------------------------------------------------------------------------
# Filename helpers
# ---------------------------------------------------------------------------

def parse_review_filename(name: str) -> dict | None:
    """Classify a review filename.

    Returns {'kind': 'synced', 'head_id', 'seq', 'author'} or
    {'kind': 'draft', 'head_id'} or None.
    """
    m = SYNCED_RE.match(name)
    if m:
        return {'kind': 'synced', 'head_id': m.group(1), 'seq': int(m.group(2)), 'author': m.group(3)}
    m = DRAFT_RE.match(name)
    if m:
        return {'kind': 'draft', 'head_id': m.group(1)}
    return None


def synced_filename(head_id: str, seq: int, author: str) -> str:
    return f'z-{head_id}-{seq:02d}-{author}.md'


def scan_local_threads() -> dict:
    """Group local review files by head id.

    Returns head_id -> {'synced': [(seq, author, Path)], 'drafts': [Path]}.
    """
    groups: dict[str, dict] = {}
    for name in sorted(glob('z-*.md')):
        info = parse_review_filename(name)
        if not info:
            continue
        g = groups.setdefault(info['head_id'], {'synced': [], 'drafts': []})
        if info['kind'] == 'synced':
            g['synced'].append((info['seq'], info['author'], Path(name)))
        else:
            g['drafts'].append(Path(name))
    for g in groups.values():
        g['synced'].sort(key=lambda t: t[0])
    return groups


def committed_resolved(filename: str) -> bool | None:
    """The `resolved` value of a head file as committed at HEAD (None if absent)."""
    text = proc.text('git', 'show', f'HEAD:{filename}', err_ok=True, log=None)
    if not text:
        return None
    for line in text.splitlines():
        m = _FRONTMATTER_RE.match(line.strip())
        if m and m.group(1) == 'resolved':
            return m.group(2).strip().lower() == 'true'
    return None


def head_path(head_id: str, groups: dict | None = None) -> Path | None:
    """Path to the head (seq 00) file for a thread, or None."""
    groups = groups if groups is not None else scan_local_threads()
    g = groups.get(head_id)
    if not g:
        return None
    for seq, _author, path in g['synced']:
        if seq == 0:
            return path
    return None


# ---------------------------------------------------------------------------
# Baseline tracking (last-pulled resolved state, for drift detection)
# ---------------------------------------------------------------------------

def _git_dir() -> Path:
    out = proc.line('git', 'rev-parse', '--git-dir', err_ok=True, log=None)
    return Path(out) if out else Path('.git')


def _baseline_dir() -> Path:
    return _git_dir() / 'ghpr' / 'reviews'


def write_baseline(head_id: str, resolved: bool) -> None:
    bdir = _baseline_dir()
    bdir.mkdir(parents=True, exist_ok=True)
    (bdir / f'{head_id}.json').write_text(json.dumps({'resolved': bool(resolved)}) + '\n')


def read_baseline(head_id: str) -> dict | None:
    path = _baseline_dir() / f'{head_id}.json'
    if not path.exists():
        return None
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Grouping REST comments into threads using GraphQL thread membership
# ---------------------------------------------------------------------------

def _head_meta_fields(head: dict, thread: dict) -> dict:
    return {
        'path': head.get('path'),
        'line': head.get('line'),
        'side': head.get('side'),
        'start_line': head.get('start_line'),
        'start_side': head.get('start_side'),
        'commit_id': head.get('commit_id'),
        'original_line': head.get('original_line'),
        'thread_node_id': thread['id'],
        'resolved': bool(thread['isResolved']),
        'is_outdated': bool(thread['isOutdated']),
    }


def group_threads(comments: list[dict], threads: list[dict]) -> tuple[list[dict], list[int]]:
    """Join REST comments to GraphQL threads.

    Returns (grouped, orphan_ids) where `grouped` is a list of dicts
    {head, comments (id-sorted), meta} and `orphan_ids` lists REST comment ids
    not in any thread.
    """
    rest_by_id = {c['id']: c for c in comments}
    claimed = set()
    grouped = []
    for thread in threads:
        members = [rest_by_id[i] for i in thread['comment_db_ids'] if i in rest_by_id]
        claimed.update(c['id'] for c in members)
        if not members:
            continue
        members.sort(key=lambda c: c['id'])
        head = next((c for c in members if not c.get('in_reply_to_id')), members[0])
        grouped.append({
            'head': head,
            'comments': members,
            'meta': _head_meta_fields(head, thread),
        })
    orphan_ids = [c['id'] for c in comments if c['id'] not in claimed]
    return grouped, orphan_ids


def _comment_fields(comment: dict, head_id: str, is_head: bool, meta: dict) -> dict:
    fields = {
        'author': comment['user']['login'],
        'id': str(comment['id']),
        'created_at': comment['created_at'],
    }
    updated_at = comment.get('updated_at')
    if updated_at and updated_at != comment['created_at']:
        fields['updated_at'] = updated_at
    if is_head:
        fields.update(meta)
    else:
        fields['in_reply_to'] = head_id
    return fields


# ---------------------------------------------------------------------------
# Pull
# ---------------------------------------------------------------------------

def pull(owner: str, repo: str, number: str) -> tuple[int, int, int]:
    """Pull review threads to local flat files. Stages changes (does not commit).

    Overwrites local files with remote content, so callers that must not clobber
    the user's work run this inside a scratch worktree (see `commands/fetch.py`).

    Returns (threads, new_comments, updated_comments).
    """
    comments = list_review_comments(owner, repo, number)
    threads = list_review_threads(owner, repo, number)

    if not comments and not threads:
        err("No review threads found remotely")
        return 0, 0, 0

    grouped, orphan_ids = group_threads(comments, threads)
    if orphan_ids:
        err(f"Warning: {len(orphan_ids)} review comment(s) not matched to a thread "
            f"(pagination limit?): {orphan_ids}")

    new_comments = 0
    updated_comments = 0

    for g in grouped:
        head_id = str(g['head']['id'])
        for seq, comment in enumerate(g['comments']):
            author = comment['user']['login']
            body = comment.get('body', '')
            is_head = comment['id'] == g['head']['id']
            fields = _comment_fields(comment, head_id, is_head, g['meta'])
            target = Path(synced_filename(head_id, seq, author))
            new_text = build_comment_text(fields, body)

            if not target.exists():
                target.write_text(new_text)
                proc.run('git', 'add', str(target), log=None)
                new_comments += 1
            elif target.read_text() != new_text:
                target.write_text(new_text)
                proc.run('git', 'add', str(target), log=None)
                updated_comments += 1

        write_baseline(head_id, g['meta']['resolved'])

    n_threads = len(grouped)
    if new_comments or updated_comments:
        err(f"Review threads: {n_threads} thread(s), "
            f"{new_comments} new comment(s), {updated_comments} updated")
    else:
        err(f"Review threads: {n_threads} thread(s), all up to date")
    return n_threads, new_comments, updated_comments


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

def _git_tracked(path: Path) -> bool:
    return proc.check('git', 'ls-files', '--error-unmatch', str(path), log=None)


def _patch_body(owner: str, repo: str, comment_id: str, body: str, env: dict | None = None) -> None:
    with NamedTemporaryFile(mode='w', suffix='.md', delete=False) as tf:
        tf.write(body)
        body_file = tf.name
    try:
        update_review_comment(owner, repo, comment_id, body_file, env=env)
    finally:
        unlink(body_file)


def _post_reply(owner: str, repo: str, number: str, head_id: str, body: str, env: dict | None = None) -> dict:
    with NamedTemporaryFile(mode='w', suffix='.md', delete=False) as tf:
        tf.write(body)
        body_file = tf.name
    try:
        return reply_to_review_comment(owner, repo, number, head_id, body_file, env=env)
    finally:
        unlink(body_file)


def _wt_dirty(filename: str) -> bool:
    """True iff `filename` is tracked and has uncommitted WT modifications."""
    out = proc.line('git', 'status', '--porcelain', '--', filename, err_ok=True, log=None)
    return bool(out) and not out.startswith('?? ')


def push(
    owner: str,
    repo: str,
    number: str,
    dry_run: bool = False,
    current_user: str | None = None,
    force_others: bool = False,
    env: dict | None = None,
) -> None:
    """Push local review-thread edits/replies/resolve-toggles back to GitHub.

    `env` (when set) is applied to every write subprocess (reply/edit/resolve),
    e.g. to author as an alternate `GH_TOKEN` identity. Reads run with the
    ambient environment.
    """
    groups = scan_local_threads()
    if not groups:
        return

    err("Checking for review-thread changes...")

    comments = list_review_comments(owner, repo, number)
    remote_by_id = {str(c['id']): c for c in comments}
    threads = list_review_threads(owner, repo, number)
    threads_by_node = {t['id']: t for t in threads}

    replies_posted = 0
    edits_pushed = 0
    resolves = 0
    others_skipped = 0
    renames = []  # (old_path, new_path)

    for head_id in sorted(groups):
        g = groups[head_id]
        hp = head_path(head_id, groups)
        # All comparisons read from HEAD: push mirrors *committed* state to the
        # remote, never WT. User must commit edits / resolve flips before push.
        head_at_head = parse_comment_file_at_head(hp.name) if hp else None
        head_fields = head_at_head[0] if head_at_head else {}
        node_id = head_fields.get('thread_node_id')
        baseline = read_baseline(head_id)
        # Safety: if the head file has uncommitted WT changes, skip resolve
        # mutations on this thread. Otherwise an unsynced `resolved:` flip in
        # WT would cause push to apply HEAD's (stale) state and silently
        # *reverse* the user's intent on GitHub.
        head_wt_dirty = hp is not None and _wt_dirty(hp.name)

        # 1. Resolve / unresolve
        if node_id and not head_wt_dirty:
            local_resolved = bool(head_fields.get('resolved'))
            remote_thread = threads_by_node.get(node_id)
            remote_resolved = remote_thread['isResolved'] if remote_thread else None
            if remote_resolved is not None and local_resolved != remote_resolved:
                baseline_resolved = baseline.get('resolved') if baseline else None
                if baseline is not None and baseline_resolved != remote_resolved:
                    err(f"⚠ Thread {head_id}: resolved-state changed remotely "
                        f"(pulled={baseline_resolved}, remote={remote_resolved}, "
                        f"local={local_resolved}). Pull first; skipping.")
                elif dry_run:
                    err(f"[DRY-RUN] Would {'resolve' if local_resolved else 'unresolve'} thread {head_id}")
                    resolves += 1
                else:
                    if local_resolved:
                        resolve_review_thread(node_id, env=env)
                        err(f"Resolved thread {head_id}")
                    else:
                        unresolve_review_thread(node_id, env=env)
                        err(f"Unresolved thread {head_id}")
                    resolves += 1

        # 2. Comment edits (read from HEAD; WT edits without a commit are ignored)
        for _seq, author, path in g['synced']:
            # Same safety as the resolve gate above: if the file has uncommitted
            # WT changes, skip it. Otherwise a `$EDITOR` edit that wasn't
            # committed would cause push to send HEAD's (stale) body to GitHub,
            # silently reverting a remote edit made out of band. The pre-push
            # warning surfaces the dirty file to the user separately.
            if _wt_dirty(path.name):
                continue
            parsed = parse_comment_file_at_head(path.name)
            if parsed is None:
                continue  # untracked WT-only file; nothing to push
            fields, body = parsed
            cid = fields.get('id')
            if cid is None or cid not in remote_by_id:
                err(f"Warning: {path} has no/unknown remote id; skipping")
                continue
            remote_body = remote_by_id[cid].get('body', '')
            if body == remote_body:
                continue
            if author != current_user and not force_others:
                err(f"Skipping {path} (author: {author}, not you)")
                others_skipped += 1
                continue
            if dry_run:
                err(f"[DRY-RUN] Would edit review comment {cid}")
            else:
                _patch_body(owner, repo, cid, body, env=env)
                err(f"Updated review comment {cid}")
            edits_pushed += 1

        # 3. Draft replies (read from HEAD; uncommitted drafts stay unposted —
        # this lets users selectively publish by committing only the drafts
        # they're ready to send.)
        next_seq = (max((s for s, _a, _p in g['synced']), default=-1)) + 1
        for draft in sorted(g['drafts']):
            body = proc.text('git', 'show', f'HEAD:{draft.name}', err_ok=True, log=None)
            if body is None or not body.strip():
                # WT-only or empty → skip silently; pre-push warning surfaces
                # the dirty-WT case to the user separately.
                continue
            if dry_run:
                err(f"[DRY-RUN] Would post reply from {draft} to thread {head_id}")
                replies_posted += 1
                continue
            result = _post_reply(owner, repo, number, head_id, body, env=env)
            new_id = str(result['id'])
            author = result['user']['login']
            posted_body = (result.get('body') or '').replace('\r\n', '\n')
            new_path = Path(synced_filename(head_id, next_seq, author))
            fields = {
                'author': author,
                'id': new_id,
                'created_at': result['created_at'],
                'in_reply_to': head_id,
            }
            updated_at = result.get('updated_at')
            if updated_at and updated_at != result['created_at']:
                fields['updated_at'] = updated_at
            write_comment_file(new_path, fields, posted_body)
            err(f"Posted reply {new_id} ({draft.name} → {new_path.name})")
            renames.append((draft, new_path))
            replies_posted += 1
            next_seq += 1

        # Refresh baseline to the state we just pushed (== HEAD). Skip if the
        # head file is dirty (we deliberately didn't sync resolve for it).
        if not dry_run and node_id and not head_wt_dirty:
            write_baseline(head_id, bool(head_fields.get('resolved')))

    if renames and not dry_run:
        for old_path, new_path in renames:
            if _git_tracked(old_path):
                proc.run('git', 'rm', '-f', '-q', str(old_path), log=None)
            else:
                old_path.unlink(missing_ok=True)
            proc.run('git', 'add', str(new_path), log=None)
        msg = f'Post {replies_posted} review repl{"y" if replies_posted == 1 else "ies"}'
        proc.run('git', 'commit', '-m', msg, log=None)
        err(f"Committed {replies_posted} review reply(ies)")

    if replies_posted or edits_pushed or resolves:
        err(f"Review threads: {replies_posted} repl(y/ies), "
            f"{edits_pushed} edit(s), {resolves} resolve toggle(s)")
    if others_skipped:
        err(f"⚠ {others_skipped} review comment(s) with local changes skipped "
            f"(not yours). Use `ghprp -C` to force.")


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------

def diff(
    owner: str,
    repo: str,
    number: str,
    use_color: bool = True,
    current_user: str | None = None,
) -> None:
    """Show local-vs-remote differences for review threads."""
    groups = scan_local_threads()
    if not groups:
        return

    YELLOW = '\033[33m' if use_color else ''
    GREEN = '\033[32m' if use_color else ''
    CYAN = '\033[36m' if use_color else ''
    RESET = '\033[0m' if use_color else ''
    BOLD = '\033[1m' if use_color else ''

    comments = list_review_comments(owner, repo, number)
    remote_by_id = {str(c['id']): c for c in comments}
    threads = list_review_threads(owner, repo, number)
    threads_by_node = {t['id']: t for t in threads}

    err(f"\n{BOLD}=== Review threads ==={RESET}")
    for head_id in sorted(groups):
        g = groups[head_id]
        hp = head_path(head_id, groups)
        head_fields = parse_comment_file(hp)[0] if hp else {}
        node_id = head_fields.get('thread_node_id')
        line = head_fields.get('line')
        if line is None:
            line = head_fields.get('original_line')
        location = f"{head_fields.get('path')}:{line}"

        head_url = remote_by_id.get(head_id, {}).get('html_url')
        local_resolved = bool(head_fields.get('resolved'))
        remote_thread = threads_by_node.get(node_id) if node_id else None
        remote_resolved = remote_thread['isResolved'] if remote_thread else None
        head_committed = committed_resolved(hp.name) if hp else None
        # Always print a per-thread status line. Distinguish three cases so a
        # local resolve edit is never silently absent:
        #   - pending push   (local != remote): push will resolve/unresolve
        #   - local-only edit (local == remote but != committed HEAD): you
        #     toggled it, but GitHub already agrees — nothing to push
        #   - in sync        (local == remote == committed)
        status = 'resolved' if local_resolved else 'open'
        prefix = f"Thread {head_id} ({location}) [{status}]"
        url = link(head_url, use_color)
        if remote_resolved is not None and local_resolved != remote_resolved:
            action = 'resolve' if local_resolved else 'unresolve'
            err(f"{YELLOW}{prefix} → would {action} on push "
                f"(remote={'resolved' if remote_resolved else 'open'}){RESET} {url}")
        elif head_committed is not None and local_resolved != head_committed:
            was = 'resolved' if head_committed else 'open'
            note = "matches GitHub, nothing to push" if remote_resolved is not None else "not yet pushed"
            err(f"{GREEN}{prefix} → locally changed from {was} ({note}){RESET} {url}")
        else:
            err(f"{CYAN}{prefix}{RESET} {url}")

        for _seq, author, path in g['synced']:
            fields, body = parse_comment_file(path)
            cid = fields.get('id')
            if cid is None or cid not in remote_by_id:
                err(f"{YELLOW}Comment {cid} ({location}) exists locally but not remotely{RESET}")
                continue
            remote_body = remote_by_id[cid].get('body', '')
            comment_url = remote_by_id[cid].get('html_url')
            if body != remote_body:
                is_others = current_user and author != current_user
                err(f"\n{BOLD}{YELLOW}Review comment {cid} (by {author}, "
                    f"{location}) - Differences:{RESET} {link(comment_url, use_color)}")
                if is_others:
                    err(f"{YELLOW}  ⚠ Not your comment; won't be pushed without `-C`{RESET}")
                render_unified_diff(
                    remote_body, body,
                    fromfile=comment_url or f'Comment {cid}',
                    tofile=str(path), use_color=use_color, log=print,
                )

        for draft in sorted(g['drafts']):
            err(f"\n{BOLD}New reply to thread {head_id} ({location}) from {draft.name}:{RESET} "
                f"{link(head_url, use_color)}")
            preview = '\n'.join(draft.read_text().strip().split('\n')[:10])
            err(f"{GREEN}{preview}{RESET}")


# ---------------------------------------------------------------------------
# Convenience helpers (used by `ghpr review`)
# ---------------------------------------------------------------------------

def find_thread(arg: str) -> str | None:
    """Resolve a thread head id from a head id or a `PRRT_…` node id."""
    groups = scan_local_threads()
    if arg in groups:
        return arg
    for head_id in groups:
        hp = head_path(head_id, groups)
        if hp and parse_comment_file(hp)[0].get('thread_node_id') == arg:
            return head_id
    return None


def set_thread_resolved(head_id: str, resolved: bool) -> bool:
    """Toggle `resolved` in a thread's head file. Returns True if it changed."""
    hp = head_path(head_id)
    if hp is None:
        raise FileNotFoundError(f"No head file for thread {head_id}")
    fields, body = parse_comment_file(hp)
    if bool(fields.get('resolved')) == resolved:
        return False
    fields['resolved'] = resolved
    hp.write_text(build_comment_text(fields, body))
    return True


def new_reply_draft_path(head_id: str) -> Path:
    """Next unused `z-<head_id>-new[-N].md` draft path."""
    base = Path(f'z-{head_id}-new.md')
    if not base.exists():
        return base
    n = 2
    while Path(f'z-{head_id}-new-{n}.md').exists():
        n += 1
    return Path(f'z-{head_id}-new-{n}.md')
