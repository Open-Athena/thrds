"""Push command - push local description and comments to GitHub PR/Issue."""

import sys
import webbrowser
from glob import glob
from os import unlink
from os.path import exists
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from click import Context
from utz import proc, err
from utz.cli import opt, flag

from ..api import get_item_metadata, get_item_comments, get_current_github_user
from ..comments import read_comment_file, write_comment_file, get_comment_id_from_filename
from ..config import get_pr_info_from_path
from ..files import read_description_from_git, get_expected_description_filename, process_images_in_description
from ..gist import add_gist_footer, create_gist, GIST_URL_WITH_USER_PATTERN, DEFAULT_GIST_REMOTE, find_gist_remote
from ..identity import resolve_identity
from ..patterns import extract_title_from_first_line
from ..refs import REMOTE_REF, read_remote_ref, set_remote_ref
from ..render import render_comment_diff, render_unified_diff


_GHPR_FILE_GLOBS = ['DESCRIPTION.md', '*#*.md', '[0-9]*.md', 'new*.md', 'z-*.md']


def _gate_upstream(
    owner: str,
    repo: str,
    number: str,
    item_type: str,
    no_comments: bool,
    dry_run: bool,
) -> None:
    """Refuse to push a HEAD that doesn't contain GitHub's current state.

    `push` overwrites the item's description and comment bodies wholesale, so
    pushing over a remote edit HEAD never incorporated silently reverts it. This
    is git's non-fast-forward rule, and it is deliberately stated the same way:
    the test is "is the remote-tracking ref an ancestor of HEAD", *not* "did this
    fetch see anything new". The latter clears itself the moment the fetch is
    recorded, so a second `push` would sail through and do the damage the first
    one refused — which is exactly what it did before this was fixed.

    Every reconcile makes the ref an ancestor, so `pull` (rebase, merge, or
    overwrite alike) is the fix, and `-G` is the override.

    A refusal still advances the ref: the fetch is an observation, and recording
    it is what makes `git diff HEAD <ref>` show the change that caused the
    refusal. `pull` reconciles off the same ancestry question, so the advance
    can't strand local work.

    Bootstrap pushes are deliberately ungated — with no recorded base there is
    nothing to compare against, and `push` *is* the "local wins" resolution that
    `bootstrap_is_ambiguous` names.
    """
    from .fetch import build_snapshot

    base = read_remote_ref()
    if base is None:
        return
    snap = build_snapshot(owner, repo, number, item_type, base, no_comments, keep=not dry_run)
    if snap.changed and not dry_run:
        set_remote_ref(snap.sha)
    if proc.check('git', 'merge-base', '--is-ancestor', snap.sha, 'HEAD', log=None):
        return
    if dry_run:
        # Report and keep going: the diff `-n` exists to show is still worth printing.
        err(f"[DRY-RUN] HEAD does not contain the current {snap.item_label} state "
            f"({snap.summary()}) — a real push would refuse (see `ghpr push -G`)")
        return
    err(f"Error: HEAD does not contain the current {snap.item_label} state: {snap.summary()}")
    err(f"Pushing now would overwrite it. {REMOTE_REF} holds what was just observed:")
    err(f"  Inspect:    git diff HEAD {REMOTE_REF}")
    err("  Reconcile:  ghpr pull      (then re-run push)")
    err("  Override:   ghpr push -G   (push anyway, discarding the remote change)")
    exit(1)


def _warn_uncommitted_ghpr_files() -> list[str]:
    """Warn if any ghpr-managed file has uncommitted WT changes; return their names.

    `ghpr push` syncs the *committed* state of every file (description, top-level
    comments, drafts, review threads) to GitHub + gist. WT changes that aren't
    committed are silently ignored — surface them here so the user can decide to
    commit and re-run instead of being surprised by post-push drift.
    """
    try:
        lines = proc.lines('git', 'status', '--porcelain', log=None)
    except Exception:
        return []  # not a git repo / git missing — out of scope
    dirty = []
    for line in lines:
        if len(line) < 4:
            continue
        status, name = line[:2], line[3:]
        # Skip untracked files (`??`) — drafts (z-*-new.md) are expected
        # untracked until they're committed-or-posted.
        if status.strip() == '??':
            continue
        # Strip rename arrows for accurate matching
        if ' -> ' in name:
            name = name.split(' -> ', 1)[1]
        for pat in _GHPR_FILE_GLOBS:
            if Path(name).match(pat):
                dirty.append(name)
                break
    if dirty:
        err(f"⚠ {len(dirty)} file(s) with uncommitted changes will be ignored "
            f"(push syncs HEAD; commit + re-run to include):")
        for name in dirty:
            err(f"    {name}")
    return dirty


def push(
    gist: bool,
    dry_run: bool,
    footer: int,
    no_footer: bool,
    open_browser: bool,
    images: bool,
    gist_private: bool | None,
    no_comments: bool,
    force_others: bool,
    no_gate: bool = False,
    as_login: str | None = None,
) -> None:
    """Push local description and comments to the PR/Issue.

    When an alternate identity is selected (`as_login` / `$GHPR_AS` /
    `git config pr.as`), the author-visible *writes* — the description/body
    edit, comment posts/edits, and review-thread replies/resolves — run as that
    account, while the gist mirror and all reads stay on the default `gh`
    account. See `identity.py`.
    """

    # Resolve (and verify) an alternate author identity, if configured. None →
    # unchanged behavior (act as the active `gh` account).
    identity = resolve_identity(as_login)
    bot_env = identity.env() if identity else None

    # Get item info from current directory
    owner, repo, number = get_pr_info_from_path()
    item_type = None

    dirty_files = _warn_uncommitted_ghpr_files()
    others_skipped = 0

    if not all([owner, repo, number]):
        # Try git config
        try:
            owner = proc.line('git', 'config', 'pr.owner', err_ok=True, log=None) or ''
            repo = proc.line('git', 'config', 'pr.repo', err_ok=True, log=None) or ''
            number = proc.line('git', 'config', 'pr.number', err_ok=True, log=None) or ''
            item_type = proc.line('git', 'config', 'pr.type', err_ok=True, log=None)
        except Exception as e:
            err(f"Error: Could not determine PR/Issue from directory or git config: {e}")
            exit(1)

    # Detect type if not specified
    if not item_type:
        # Try to detect by checking both PR and issue
        _, item_type = get_item_metadata(owner, repo, number)

    item_label = 'issue' if item_type == 'issue' else 'PR'

    if not no_gate:
        _gate_upstream(owner, repo, number, item_type, no_comments, dry_run)

    # Read the current description file (from HEAD, not working directory)
    desc_content, desc_file = read_description_from_git('HEAD')
    if not desc_content:
        expected_filename = get_expected_description_filename(owner, repo, number)
        err(f"Error: Could not read {expected_filename} or DESCRIPTION.md from HEAD")
        err("Make sure you've committed your changes")
        exit(1)

    lines = desc_content.split('\n')
    if not lines:
        err("Error: Description file is empty")
        exit(1)

    # Parse the file
    first_line = lines[0].strip()
    # Remove the [owner/repo#num] or [owner/repo#num](url) prefix to get the title
    title = extract_title_from_first_line(first_line)

    # Get body (skip first line and any immediately following blank lines)
    body_lines = lines[1:]
    while body_lines and not body_lines[0].strip():
        body_lines = body_lines[1:]
    body = '\n'.join(body_lines).rstrip()

    # Process images if requested
    if images:
        err("Processing images in description...")
        body = process_images_in_description(body, owner, repo, dry_run)

    # Check if we have an existing gist
    try:
        gist_id = proc.line('git', 'config', 'pr.gist', err_ok=True, log=None)
        has_gist = bool(gist_id)
    except Exception:
        # Reading git config is optional, silently set to False
        has_gist = False
        gist_id = None

    # Compatibility: support pr_number variable name for now
    pr_number = number

    # Determine footer behavior
    if no_footer:
        # -F flag: disable footer completely
        should_add_footer = False
        footer_visible = False
    elif footer == 0:
        # No -f flag: auto mode (add footer if gist exists)
        should_add_footer = has_gist
        footer_visible = False  # Default to hidden
    elif footer == 1:
        # -f: Hidden footer (HTML comment)
        should_add_footer = True
        footer_visible = False
        gist = True  # Ensure we sync to gist if adding footer
    elif footer >= 2:
        # -ff: Visible footer (markdown)
        should_add_footer = True
        footer_visible = True
        gist = True  # Ensure we sync to gist if adding footer
    else:
        should_add_footer = False
        footer_visible = False

    # Handle gist syncing first (to get URL for footer if needed)
    gist_url = None
    if gist or should_add_footer:
        if dry_run:
            err("[DRY-RUN] Would sync to gist")
            # Try to get existing gist URL
            if has_gist:
                gist_url = f'https://gist.github.com/{gist_id}'
            else:
                gist_url = 'https://gist.github.com/NEW_GIST'
        else:
            if gist or has_gist:  # Sync if explicitly requested or if gist exists
                gist_url = sync_to_gist(owner, repo, pr_number, desc_content, return_url=True, gist_private=gist_private)

    # Add footer if we should
    if should_add_footer and gist_url:
        body = add_gist_footer(body, gist_url, visible=footer_visible)
        if dry_run:
            err(f"[DRY-RUN] Would add {'visible' if footer_visible else 'hidden'} footer with gist URL: {gist_url}")
        else:
            err(f"Added {'visible' if footer_visible else 'hidden'} footer with gist URL: {gist_url}")
    elif should_add_footer and not gist_url:
        err("Error: Should add footer but no gist URL available")
        raise ValueError("Footer requires gist URL but none available")

    # Update the PR/Issue
    if dry_run:
        # Determine if we should use color
        use_color = sys.stderr.isatty()

        # Import difflib for comparison
        import difflib

        # ANSI color codes
        RED = '\033[31m' if use_color else ''
        GREEN = '\033[32m' if use_color else ''
        CYAN = '\033[36m' if use_color else ''
        YELLOW = '\033[33m' if use_color else ''
        RESET_COLOR = '\033[0m' if use_color else ''
        BOLD = '\033[1m' if use_color else ''

        # Show diff instead of preview
        err(f"\n{BOLD}=== Preview of changes (dry-run) ==={RESET_COLOR}\n")

        # Get remote data for comparison
        pr_data, _ = get_item_metadata(owner, repo, pr_number, item_type)
        if pr_data:
            remote_title = pr_data['title']
            remote_body = (pr_data['body'] or '').rstrip()

            # Strip footers for comparison
            from thrds.platforms.github.gist import extract_gist_footer
            local_body_without_footer, _ = extract_gist_footer(body)
            remote_body_without_footer, _ = extract_gist_footer(remote_body)

            # Compare titles
            if title != remote_title:
                err(f"{BOLD}{YELLOW}=== Title Changes ==={RESET_COLOR}")
                err(f"{RED}Remote:{RESET_COLOR} {remote_title}")
                err(f"{GREEN}Local: {RESET_COLOR} {title}\n")
            else:
                err(f"{BOLD}{CYAN}=== Title: No changes ==={RESET_COLOR}\n")

            # Compare bodies
            if local_body_without_footer != remote_body_without_footer:
                err(f"{BOLD}{YELLOW}=== Body Changes ==={RESET_COLOR}")
                render_unified_diff(
                    remote_body_without_footer,
                    local_body_without_footer,
                    fromfile='Remote',
                    tofile='Local (will be pushed)',
                    use_color=use_color
                )
                err("")  # blank line
            else:
                err(f"{BOLD}{CYAN}=== Body: No changes ==={RESET_COLOR}\n")
        else:
            err(f"[DRY-RUN] Would update {item_label} {owner}/{repo}#{pr_number}")
            err(f"  Title: {title}")
            err(f"  Body: {len(body)} chars")
    else:
        err(f"Updating {item_label} {owner}/{repo}#{pr_number}...")

        # Use appropriate command for PR vs issue
        gh_cmd = 'pr' if item_type == 'pr' else 'issue'
        cmd = ['gh', gh_cmd, 'edit', pr_number, '-R', f'{owner}/{repo}']

        if title:
            cmd.extend(['--title', title])

        if body is not None:  # Allow empty body
            # Use --body-file to avoid command line length issues and special character problems
            with NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
                f.write(body)
                body_file = f.name

            cmd.extend(['--body-file', body_file])

        try:
            proc.run(*cmd, env=bot_env, log=None)
            if body is not None:
                unlink(body_file)  # Clean up temp file
            err(f"Successfully updated {item_label}")

            # Get item URL if we need to open it
            if open_browser:
                item_url = proc.line('git', 'config', 'pr.url', err_ok=True, log=None)
                if not item_url:
                    path_part = 'pull' if item_type == 'pr' else 'issues'
                    item_url = f"https://github.com/{owner}/{repo}/{path_part}/{pr_number}"

                webbrowser.open(item_url)
                err(f"Opened: {item_url}")
        except Exception as e:
            err(f"Error updating {item_label}: {e}")
            exit(1)

    # Handle comment pushing (default enabled, skip if --no-comments)
    new_comment_renames = []  # Track (old_name, new_name) for commit message
    if not no_comments:
        if dry_run:
            # In dry-run mode, just show the diff
            current_user = identity.login if identity else get_current_github_user()
            render_comment_diff(owner, repo, number, item_type, use_color=use_color, dry_run=True, current_user=current_user)
        else:
            err("Checking for comment changes...")
            current_user = identity.login if identity else get_current_github_user()

            # First, handle new draft comments (new*.md files from HEAD)
            # Get list of files in HEAD
            try:
                head_files = proc.lines('git', 'ls-tree', '--name-only', 'HEAD', log=False)
                draft_files = [f for f in head_files if f.startswith('new') and f.endswith('.md')]
            except Exception:
                draft_files = []

            if draft_files:
                err(f"Found {len(draft_files)} draft comment(s) to post: {', '.join(draft_files)}")

                for draft_file in draft_files:
                    # Read content from HEAD
                    try:
                        draft_content = proc.text('git', 'show', f'HEAD:{draft_file}', log=False)
                    except Exception as e:
                        err(f"Warning: Could not read {draft_file} from HEAD: {e}")
                        continue

                    if not draft_content.strip():
                        err(f"Warning: Skipping empty draft file: {draft_file}")
                        continue

                    # Post as new comment
                    err(f"Posting {draft_file} as new comment...")
                    with NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
                        f.write(draft_content)
                        temp_file = f.name

                    try:
                        result = proc.json(
                            'gh', 'api',
                            '-X', 'POST',
                            f'repos/{owner}/{repo}/issues/{number}/comments',
                            '-F', f'body=@{temp_file}',
                            env=bot_env,
                            log=False
                        )
                        comment_id = str(result['id'])
                        created_at = result['created_at']
                        updated_at = result.get('updated_at', created_at)

                        # Get the body from the response (GitHub's canonical version)
                        posted_body = result.get('body', '').replace('\r\n', '\n')

                        # Create the z{id}-{author}.md file with GitHub's version
                        comment_file = write_comment_file(comment_id, current_user, created_at, updated_at, posted_body)
                        new_filename = comment_file.name

                        err(f"Posted comment {comment_id}, created {new_filename}")

                        # Track for commit
                        new_comment_renames.append((draft_file, new_filename))

                    except Exception as e:
                        err(f"Error posting {draft_file}: {e}")
                    finally:
                        unlink(temp_file)

            # Find all local comment files (z*.md)
            comment_files = sorted(glob('z[0-9]*.md'))

            if not comment_files:
                err("No comment files found")
            else:
                err(f"Found {len(comment_files)} comment file(s)")

                # Get remote comments to check which are new vs edited
                remote_comments = get_item_comments(owner, repo, number, item_type)
                remote_comment_ids = {str(c['id']) for c in remote_comments}
                remote_comments_by_id = {str(c['id']): c for c in remote_comments}

            comments_pushed = 0
            comments_skipped = 0

            for comment_file_path in comment_files:
                comment_id = get_comment_id_from_filename(comment_file_path)
                if not comment_id:
                    err(f"Warning: Skipping invalid filename: {comment_file_path}")
                    continue

                # Read local comment
                author, created_at, updated_at, body = read_comment_file(Path(comment_file_path))

                if not author:
                    err(f"Warning: Skipping {comment_file_path} - no author metadata")
                    continue

                # Check if this is a new comment or an edit
                if comment_id in remote_comment_ids:
                    # Editing existing comment
                    remote_comment = remote_comments_by_id[comment_id]
                    remote_body = remote_comment.get('body', '').replace('\r\n', '\n')
                    comment_url = remote_comment.get('html_url', f'Comment {comment_id}')

                    if body == remote_body:
                        comments_skipped += 1
                        continue

                    # Check if we own this comment (only matters if there are changes)
                    if author != current_user and not force_others:
                        err(f"Skipping {comment_file_path} (author: {author}, not you)")
                        others_skipped += 1
                        continue

                    if dry_run:
                        # Show diff for this comment
                        err(f"\n{BOLD}{YELLOW}=== Comment {comment_id} (by {author}) - Changes ==={RESET_COLOR}")
                        render_unified_diff(
                            remote_body,
                            body,
                            fromfile=comment_url,
                            tofile=f'{comment_file_path} (will be pushed)',
                            use_color=use_color
                        )
                        err("")  # blank line
                    else:
                        # Update existing comment
                        try:
                            # Create temp file for body
                            with NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
                                f.write(body)
                                temp_file = f.name

                            proc.run('gh', 'api', '-X', 'PATCH',
                                    f'repos/{owner}/{repo}/issues/comments/{comment_id}',
                                    '-F', f'body=@{temp_file}', env=bot_env, log=None)
                            unlink(temp_file)
                            err(f"Updated comment {comment_id}")
                            comments_pushed += 1
                        except Exception as e:
                            err(f"Error updating comment {comment_id}: {e}")
                            if temp_file and exists(temp_file):
                                unlink(temp_file)
                else:
                    # New comment - but we can't create with specific ID
                    err(f"Warning: {comment_file_path} is a new comment (ID not found remotely)")
                    err("  Cannot push new comments yet (ID would change)")
                    comments_skipped += 1

            err(f"Comments: {comments_pushed} pushed, {comments_skipped} unchanged")
            if others_skipped:
                err(f"⚠ {others_skipped} comment(s) with local changes skipped (not yours). Use `ghprp -C` to force.")

        # Commit the new comment renames (new*.md → z{id}-{author}.md)
        if new_comment_renames and not dry_run:
            # Remove old draft files and add new comment files
            for old_name, new_name in new_comment_renames:
                # Use -f to force removal even if there are local modifications
                proc.run('git', 'rm', '-f', old_name, log=False)
                proc.run('git', 'add', new_name, log=False)

            # Create commit message
            if len(new_comment_renames) == 1:
                old, new = new_comment_renames[0]
                commit_msg = f'Post new comment: {old} → {new}'
            else:
                commit_msg = f'Post {len(new_comment_renames)} new comments'

            proc.run('git', 'commit', '-m', commit_msg, log=False)
            err(f"Committed {len(new_comment_renames)} new comment(s)")

    # Push review-thread changes (PR-only, default enabled, skip if --no-comments)
    if not no_comments and item_type == 'pr':
        from .. import reviews
        current_user = identity.login if identity else get_current_github_user()
        use_color = sys.stderr.isatty()
        if dry_run:
            reviews.diff(owner, repo, number, use_color=use_color, current_user=current_user)
        else:
            reviews.push(owner, repo, number, current_user=current_user, force_others=force_others, env=bot_env)

    # GitHub now matches HEAD, so HEAD is the base future pulls reconcile against
    # (see ghpr/refs.py). Only advance the ref when the push was complete: if
    # anything was held back (dirty files, others' comments, --no-comments), the
    # remote still differs from HEAD, and claiming otherwise would let the next
    # pull treat a local edit as already-pushed and silently drop it.
    if not dry_run:
        held_back = {
            'uncommitted file(s)': len(dirty_files),
            "other user(s)' comment(s)": others_skipped,
            '--no-comments': int(no_comments),
        }
        if reasons := [k for k, v in held_back.items() if v]:
            err(f"Not advancing {REMOTE_REF} (not fully synced: {', '.join(reasons)})")
        else:
            set_remote_ref('HEAD')


def sync_to_gist(
    owner: str,
    repo: str,
    pr_number: str,
    content: str,
    return_url: bool = False,
    add_remote: bool = True,
    gist_private: bool = None,
) -> str | None:
    """Sync PR description to a gist.

    Args:
        owner: Repository owner
        repo: Repository name
        pr_number: PR number
        content: Content to sync to gist
        return_url: If True, return the gist URL with revision instead of None
        add_remote: If True, add gist as a git remote
        gist_private: If True, create private gist; if False, create public; if None, match repo visibility

    Returns:
        None or gist URL with revision if return_url=True
    """

    # Check if we already have a gist ID stored
    gist_id = proc.line('git', 'config', 'pr.gist', err_ok=True, log=None)

    # Find the gist remote intelligently
    gist_remote = find_gist_remote()
    if not gist_remote:
        # Only set a default if we're actually going to use it
        if gist_id or add_remote:
            gist_remote = DEFAULT_GIST_REMOTE
            err(f"No gist remote found, will use '{gist_remote}'")

    # Determine gist visibility
    if gist_private is not None:
        # Explicit visibility specified
        is_public = not gist_private  # Invert: if private flag is True, public is False
        err(f"Using explicit gist visibility: {'PUBLIC' if is_public else 'PRIVATE'}")
    else:
        # Check repository visibility to determine gist visibility
        try:
            repo_data = proc.json('gh', 'repo', 'view', f'{owner}/{repo}', '--json', 'visibility', err_ok=True, log=None) or {}
            is_public = repo_data.get('visibility', 'PUBLIC').upper() == 'PUBLIC'
            err(f"Repository visibility: {'PUBLIC' if is_public else 'PRIVATE'}, gist will match")
        except Exception as e:
            err(f"Error: Could not determine repository visibility: {e}")
            raise

    # Use PR-specific filename for better gist organization
    pr_filename = f'{repo}#{pr_number}.md'
    local_filename = pr_filename  # Use same filename locally
    description = f'{owner}/{repo}#{pr_number} - 2-way sync via ghpr (https://github.com/runsascoded/ghpr)'
    gist_url = None

    if gist_id:
        # Update existing gist
        err(f"Updating gist {gist_id}...")

        # Check if we need to rename the file in the gist
        try:
            gist_files = proc.json('gh', 'api', f'gists/{gist_id}', '--jq', '.files', log=None) or {}
            old_filename = None

            # Find the existing markdown file (could be DESCRIPTION.md or a PR-specific name)
            for fname in gist_files.keys():
                if fname.endswith('.md'):
                    old_filename = fname
                    break

            # Update gist with new filename if needed
            if old_filename and old_filename != pr_filename:
                # Rename file by deleting old and adding new
                proc.run('gh', 'api', f'gists/{gist_id}', '-X', 'PATCH',
                           '-f', f'description={description}',
                           '-f', f'files[{old_filename}][filename]={pr_filename}', log=None)
                err(f"Renamed gist file from {old_filename} to {pr_filename}")
            else:
                # Just update description
                proc.run('gh', 'api', f'gists/{gist_id}', '-X', 'PATCH',
                           '-f', f'description={description}', log=None)
        except Exception as e:
            err(f"Error: Could not update gist metadata: {e}")
            raise

        # Check if remote exists and push to it
        if add_remote:
            # Push HEAD to the gist mirror; uncommitted WT changes are
            # intentionally not auto-committed (Contract A: user commits,
            # ghpr push syncs HEAD to GitHub and the gist). A pre-push
            # warning surfaces dirty-WT cases to the user separately.
            try:
                proc.run('git', 'push', gist_remote, 'main', '--force', log=None)
                err(f"Pushed to gist remote '{gist_remote}'")
            except Exception as e:
                err(f"Error: Could not push to gist remote '{gist_remote}': {e}")
                raise

        # Get the latest revision SHA
        try:
            gist_info = proc.line('gh', 'api', f'gists/{gist_id}', '--jq', '.history[0].version', log=None)
            revision = gist_info
        except Exception as e:
            err(f"Error: Could not get gist revision: {e}")
            raise

        if revision:
            gist_url = f"https://gist.github.com/{gist_id}/{revision}"
        else:
            gist_url = f"https://gist.github.com/{gist_id}"
        err(f"Updated gist: {gist_url}")
    else:
        # Create new gist
        err(f"Creating new {'public' if is_public else 'secret'} gist...")

        # Create a temporary file with the PR-specific name for gist creation
        with TemporaryDirectory() as tmpdir:
            # Create temp file with PR-specific name
            temp_file = Path(tmpdir) / pr_filename
            with open(temp_file, 'w') as f:
                f.write(content)

            # Also update local DESCRIPTION.md
            desc_file = Path(local_filename)
            with open(desc_file, 'w') as f:
                f.write(content)

            try:
                # Create gist from PR-specific filename (visibility based on repo)
                output = None
                gist_id_from_creation = create_gist(temp_file, description, is_public=is_public, store_id=False)
                if gist_id_from_creation:
                    output = f"https://gist.github.com/{gist_id_from_creation}"
                if not output:
                    err("Error creating gist")
                    return None
                output = output.strip()
                err(f"Gist create output: {output}")
                # Extract gist ID from URL (format: https://gist.github.com/username/gist_id or https://gist.github.com/gist_id)
                match = GIST_URL_WITH_USER_PATTERN.search(output)
                if match:
                    gist_id = match.group(1)
                    proc.run('git', 'config', 'pr.gist', gist_id, log=None)
                    err(f"Stored gist ID: {gist_id}")

                    # Add gist as a remote if requested
                    if add_remote:
                        gist_ssh_url = f"git@gist.github.com:{gist_id}.git"
                        try:
                            # Check if remote already exists
                            existing_url = proc.line('git', 'remote', 'get-url', gist_remote, err_ok=True, log=None)
                            if existing_url != gist_ssh_url:
                                # Update existing remote
                                proc.run('git', 'remote', 'set-url', gist_remote, gist_ssh_url, log=None)
                                err(f"Updated remote '{gist_remote}' to {gist_ssh_url}")
                        except Exception:
                            # Add new remote
                            proc.run('git', 'remote', 'add', gist_remote, gist_ssh_url, log=None)
                            err(f"Added remote '{gist_remote}': {gist_ssh_url}")

                    # Fetch from the gist remote first
                    try:
                        proc.run('git', 'fetch', gist_remote, log=None)
                    except Exception as e:
                        # Fetch might fail if gist is empty, which is OK for new gists
                        err(f"Note: Could not fetch from gist (may be empty): {e}")

                    # Set up branch tracking
                    try:
                        current_branch = proc.line('git', 'rev-parse', '--abbrev-ref', 'HEAD', log=None)
                        proc.run('git', 'branch', '--set-upstream-to', f'{gist_remote}/main', current_branch, log=None)
                        err(f"Set {current_branch} to track {gist_remote}/main")
                    except Exception as e:
                        err(f"Could not set up branch tracking: {e}")

                    # Commit and push to the gist
                    try:
                        # Check if there are uncommitted changes
                        proc.check('git', 'diff', '--quiet', 'DESCRIPTION.md', log=None)
                    except Exception:
                        # There are changes, commit them
                        proc.run('git', 'add', 'DESCRIPTION.md', log=None)
                        proc.run('git', 'commit', '-m', f'Sync PR {owner}/{repo}#{pr_number} to gist', log=None)

                        # Push to the gist remote
                        try:
                            proc.run('git', 'push', gist_remote, 'main', '--force', log=None)
                            err(f"Pushed to gist remote '{gist_remote}'")
                        except Exception as e:
                            err(f"Error: Could not push to gist remote '{gist_remote}': {e}")
                            raise

                    # Get the revision SHA for the newly created gist
                    try:
                        gist_info = proc.line('gh', 'api', f'gists/{gist_id}', '--jq', '.history[0].version', log=None)
                        revision = gist_info
                        gist_url = f"https://gist.github.com/{gist_id}/{revision}"
                    except Exception as e:
                        err(f"Error: Could not get gist revision: {e}")
                        raise

                    err(f"Created gist: {gist_url}")
            except Exception as e:
                err(f"Error creating gist: {e}")
                return None

    if return_url:
        return gist_url


def register(cli):
    """Register command with CLI."""

    @cli.command()
    @opt('-a', '--as', 'as_login', help='Post/edit comments + review replies as this GitHub login (gist + reads stay default); also $GHPR_AS / `git config pr.as`')
    @flag('-C', '--force-others', help='Allow pushing edits to other users\' comments (may fail at API level)')
    @flag('-G', '--no-gate', help='Push even if GitHub changed since the last fetch (discards the remote change)')
    @flag('--no-comments', help='Skip pushing comment changes')
    @opt('-p/-P', '--private/--public', 'gist_private', default=None, help='Gist visibility: -p = private, -P = public (default: match repo visibility)')
    @flag('-i', '--images', help='Upload local images and replace references')
    @flag('-o', '--open', 'open_browser', help='Open PR in browser after pushing')
    @flag('-F', '--no-footer', help='Disable footer completely')
    @opt('-f', '--footer', count=True, help='Footer level: -f = hidden footer, -ff = visible footer')
    @flag('-n', '--dry-run', help='Show what would be done without making changes')
    @flag('-g', '--gist', help='Also sync to gist')
    def push_cmd(as_login, force_others, no_gate, no_comments, gist_private, images, open_browser, no_footer, footer, dry_run, gist):
        """Push local changes to GitHub PR/Issue and gist."""
        push(gist, dry_run, footer, no_footer, open_browser, images, gist_private, no_comments, force_others, no_gate, as_login)
