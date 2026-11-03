"""GitHub API helpers for fetching PR/Issue data."""

from utz import proc, err


def get_item_metadata(owner: str, repo: str, number: str, item_type: str | None = None) -> tuple[dict | None, str]:
    """Get PR or Issue metadata from GitHub.

    Returns:
        Tuple of (metadata dict, item_type) where item_type is 'pr' or 'issue'
    """
    # Try to detect type if not specified
    if not item_type:
        # Try PR first (use err_ok to suppress GraphQL errors for issues)
        try:
            from subprocess import DEVNULL
            data = proc.json('gh', 'pr', 'view', number, '-R', f'{owner}/{repo}', '--json', 'title,body,number,url', log=False, stderr=DEVNULL)
            # Normalize line endings from GitHub (convert \r\n to \n)
            if data.get('body'):
                data['body'] = data['body'].replace('\r\n', '\n')
            return data, 'pr'
        except Exception:
            # Try issue
            try:
                data = proc.json('gh', 'issue', 'view', number, '-R', f'{owner}/{repo}', '--json', 'title,body,number,url', log=False)
                if data.get('body'):
                    data['body'] = data['body'].replace('\r\n', '\n')
                return data, 'issue'
            except Exception as e:
                err(f"Error fetching PR/Issue metadata: {e}")
                return None, item_type or 'pr'

    # Use specified type
    cmd = 'pr' if item_type == 'pr' else 'issue'
    try:
        data = proc.json('gh', cmd, 'view', number, '-R', f'{owner}/{repo}', '--json', 'title,body,number,url', log=False)
        # Normalize line endings from GitHub (convert \r\n to \n)
        if data.get('body'):
            data['body'] = data['body'].replace('\r\n', '\n')
        return data, item_type
    except Exception as e:
        err(f"Error fetching {item_type} metadata: {e}")
        return None, item_type


def get_pr_metadata(owner: str, repo: str, pr_number: str) -> dict | None:
    """Legacy function for backwards compatibility."""
    data, _ = get_item_metadata(owner, repo, pr_number, 'pr')
    return data


def get_current_github_user() -> str | None:
    """Get the currently authenticated GitHub user."""
    from utz.git.gist import get_github_user
    return get_github_user()


def get_item_comments(owner: str, repo: str, number: str, item_type: str) -> list[dict]:
    """Fetch all comments for a PR or Issue from GitHub.

    Returns:
        List of comment dicts with keys: id, user.login, created_at, updated_at, body
    """
    try:
        if item_type == 'pr':
            comments = proc.json('gh', 'api', f'repos/{owner}/{repo}/issues/{number}/comments', log=False)
        else:
            comments = proc.json('gh', 'api', f'repos/{owner}/{repo}/issues/{number}/comments', log=False)

        # Normalize line endings in comment bodies
        for comment in comments:
            if comment.get('body'):
                comment['body'] = comment['body'].replace('\r\n', '\n')

        return comments
    except Exception as e:
        err(f"Error fetching comments: {e}")
        return []


def list_review_comments(owner: str, repo: str, number: str) -> list[dict]:
    """Fetch all PR review (inline) comments from GitHub, paginated.

    Returns:
        List of comment dicts with keys: id, in_reply_to_id, path, line, side,
        start_line, start_side, original_line, commit_id, user.login, body,
        created_at, updated_at, html_url.
    """
    try:
        comments = proc.json(
            'gh', 'api', '--paginate',
            f'repos/{owner}/{repo}/pulls/{number}/comments?per_page=100',
            log=False,
        )
    except Exception as e:
        err(f"Error fetching review comments: {e}")
        return []

    for comment in comments:
        if comment.get('body'):
            comment['body'] = comment['body'].replace('\r\n', '\n')
    return comments


# GraphQL query for review threads: node IDs + resolved state + member comment
# database IDs (the join key back to REST `id`s).
_REVIEW_THREADS_QUERY = '''
query($owner: String!, $repo: String!, $num: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $num) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) { nodes { databaseId } }
        }
      }
    }
  }
}
'''


def list_review_threads(owner: str, repo: str, number: str) -> list[dict]:
    """Fetch review threads via GraphQL.

    Returns:
        List of thread dicts with keys: id (GraphQL node id, `PRRT_…`),
        isResolved, isOutdated, comment_db_ids (list of REST comment ids, in order).
    """
    try:
        data = proc.json(
            'gh', 'api', 'graphql',
            '-f', f'query={_REVIEW_THREADS_QUERY}',
            '-f', f'owner={owner}',
            '-f', f'repo={repo}',
            '-F', f'num={number}',
            log=False,
        )
    except Exception as e:
        err(f"Error fetching review threads: {e}")
        return []

    nodes = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
    threads = []
    for node in nodes:
        threads.append({
            'id': node['id'],
            'isResolved': node['isResolved'],
            'isOutdated': node['isOutdated'],
            'comment_db_ids': [c['databaseId'] for c in node['comments']['nodes']],
        })
    return threads


def reply_to_review_comment(owner: str, repo: str, number: str, comment_id: str, body_file: str, env: dict | None = None) -> dict:
    """POST a threaded reply to an existing review comment. Returns the new comment dict.

    `env` (when set) overrides the subprocess environment — e.g. `GH_TOKEN` for
    an alternate author identity (see `identity.py`).
    """
    return proc.json(
        'gh', 'api', '-X', 'POST',
        f'repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies',
        '-F', f'body=@{body_file}',
        env=env,
        log=False,
    )


def update_review_comment(owner: str, repo: str, comment_id: str, body_file: str, env: dict | None = None) -> dict:
    """PATCH an existing review comment's body. Returns the updated comment dict.

    `env` (when set) overrides the subprocess environment — e.g. `GH_TOKEN` for
    an alternate author identity (see `identity.py`).
    """
    return proc.json(
        'gh', 'api', '-X', 'PATCH',
        f'repos/{owner}/{repo}/pulls/comments/{comment_id}',
        '-F', f'body=@{body_file}',
        env=env,
        log=False,
    )


_RESOLVE_MUTATION = '''
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}
'''

_UNRESOLVE_MUTATION = '''
mutation($threadId: ID!) {
  unresolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}
'''


def resolve_review_thread(thread_node_id: str, env: dict | None = None) -> dict:
    """Resolve a review thread via GraphQL. Returns the updated thread dict.

    `env` (when set) overrides the subprocess environment — e.g. `GH_TOKEN` for
    an alternate author identity (see `identity.py`).
    """
    data = proc.json(
        'gh', 'api', 'graphql',
        '-f', f'query={_RESOLVE_MUTATION}',
        '-f', f'threadId={thread_node_id}',
        env=env,
        log=False,
    )
    return data['data']['resolveReviewThread']['thread']


def unresolve_review_thread(thread_node_id: str, env: dict | None = None) -> dict:
    """Unresolve a review thread via GraphQL. Returns the updated thread dict.

    `env` (when set) overrides the subprocess environment — e.g. `GH_TOKEN` for
    an alternate author identity (see `identity.py`).
    """
    data = proc.json(
        'gh', 'api', 'graphql',
        '-f', f'query={_UNRESOLVE_MUTATION}',
        '-f', f'threadId={thread_node_id}',
        env=env,
        log=False,
    )
    return data['data']['unresolveReviewThread']['thread']
