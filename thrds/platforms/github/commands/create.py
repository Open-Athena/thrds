"""Create and Init commands - initialize and create PR/Issue."""

import re
from os.path import exists, join
from pathlib import Path
from utz import proc, err, cd
from utz.cli import opt, flag, arg

from ..files import read_description_file, write_description_with_link_ref
from ..identity import resolve_identity
from ..patterns import GIST_ID_PATTERN


def _resolve_draft_path(path: str | None) -> Path:
    """Resolve a draft directory path argument.

    - None → `gh/new` (default, single-draft mode, back-compat)
    - Contains `/` → use as-is (absolute or relative path)
    - Bare slug → `gh/drafts/<slug>` (multi-draft mode)
    """
    if not path:
        return Path('gh/new')
    if '/' in path:
        return Path(path)
    return Path('gh/drafts') / path


def _ensure_nested_git_repo(
    owner: str,
    repo: str,
    number: str,
    url: str,
    item_type: str,
) -> None:
    """Ensure cwd is the toplevel of its own git repo; `git init` if not.

    Without this, when the parent project has `gh/` in `.gitignore`, the
    finalize step's git ops walk up to the parent repo and fail (the
    files we're trying to add are gitignored there). Mirrors what
    `ghpr clone` does so a create-then-finalize matches a clone exactly.
    """
    toplevel = proc.line('git', 'rev-parse', '--show-toplevel', err_ok=True, log=None)
    cwd = str(Path.cwd().resolve())
    if toplevel:
        toplevel = str(Path(toplevel).resolve())
    if toplevel == cwd:
        return
    proc.run('git', 'init', '-q', log=None)
    proc.run('git', 'config', 'pr.owner', owner, log=None)
    proc.run('git', 'config', 'pr.repo', repo, log=None)
    proc.run('git', 'config', 'pr.number', str(number), log=None)
    proc.run('git', 'config', 'pr.url', url, log=None)
    proc.run('git', 'config', 'pr.type', item_type, log=None)
    err(f"Initialized nested git repo at {cwd}")

# Import resolve_remote_ref from utz
try:
    from utz.git.branch import resolve_remote_ref
except ImportError:
    # Fallback: define a stub that raises an informative error
    def resolve_remote_ref(verbose=False):
        raise ImportError(
            "utz.git.branch.resolve_remote_ref not available. Update utz or specify --head explicitly."
        )


def get_owner_repo(repo_arg: str | None = None) -> tuple[str, str]:
    """Get owner and repo, trying multiple sources.

    Tries in order:
    1. Explicit -r/--repo argument (owner/repo format)
    2. Git config (pr.owner, pr.repo)
    3. Parent directory's GitHub repo
    4. Current directory's git remotes (origin, then any)

    Returns:
        Tuple of (owner, repo)

    Raises:
        SystemExit: If repository cannot be determined
    """
    # 1. Try explicit argument
    if repo_arg:
        try:
            owner, repo = repo_arg.split('/')
            return owner, repo
        except ValueError:
            err(f"Error: Invalid repo format '{repo_arg}'. Use owner/repo format.")
            exit(1)

    # 2. Try git config
    owner = proc.line('git', 'config', 'pr.owner', err_ok=True, log=None)
    repo = proc.line('git', 'config', 'pr.repo', err_ok=True, log=None)
    if owner and repo:
        return owner, repo

    # 3. Try parent directory
    parent_dir = Path('..').resolve()
    if exists(join(parent_dir, '.git')):
        try:
            with cd(parent_dir):
                repo_data = proc.json('gh', 'repo', 'view', '--json', 'owner,name', log=None)
                owner = repo_data['owner']['login']
                repo = repo_data['name']
                return owner, repo
        except Exception:
            pass

    # 4. Try current directory's git remotes
    try:
        remotes = proc.lines('git', 'remote', log=None)
        # Try origin first
        if 'origin' in remotes:
            url = proc.line('git', 'remote', 'get-url', 'origin', log=None)
            owner, repo = _parse_github_url(url)
            if owner and repo:
                return owner, repo

        # Try any remote
        for remote in remotes:
            url = proc.line('git', 'remote', 'get-url', remote, log=None)
            owner, repo = _parse_github_url(url)
            if owner and repo:
                return owner, repo
    except Exception:
        pass

    err("Error: Could not determine repository. Configure with 'ghpr init -r owner/repo' or use -r/--repo")
    exit(1)


def _parse_github_url(url: str) -> tuple[str | None, str | None]:
    """Parse owner and repo from a GitHub URL."""
    import re
    # Match git@github.com:owner/repo.git or https://github.com/owner/repo
    match = re.search(r'github\.com[:/]([^/]+)/([^/\.]+)', url)
    if match:
        return match.group(1), match.group(2)
    return None, None


def _read_and_parse_description() -> tuple[str, str]:
    """Read DESCRIPTION.md and parse title and body (expects plain format).

    Returns:
        (title, body) tuple
    """
    if not exists('DESCRIPTION.md'):
        err("Error: DESCRIPTION.md not found. Run 'ghpr init' first")
        exit(1)

    # Read plain format (pre-creation)
    title, body = read_description_file(expect_plain=True)
    if not title:
        err("Error: Could not parse DESCRIPTION.md")
        exit(1)

    return title, body or ''


def _finalize_created_item(
    owner: str,
    repo: str,
    number: str,
    url: str,
    item_type: str,
    as_login: str | None = None,
) -> None:
    """Finalize after creating PR/issue: rename file, commit, rename directory.

    Args:
        owner: Repository owner
        repo: Repository name
        number: PR/issue number
        url: GitHub URL
        item_type: 'pr' or 'issue'
        as_login: Alternate GitHub login for the body-edit write (see `identity.py`).
    """
    old_file = Path('DESCRIPTION.md')
    new_filename = f'{repo}#{number}.md'
    new_file = Path(new_filename)

    # Read title and body from DESCRIPTION.md (plain format)
    title, body = read_description_file(expect_plain=True)
    if not title:
        err("Warning: Could not parse title from DESCRIPTION.md")
        return

    # Write using helper with link-reference format
    write_description_with_link_ref(
        new_file,
        owner,
        repo,
        number,
        title,
        body or '',
        url
    )

    # Ensure we're inside a nested git repo before git ops, so a
    # gitignored `gh/` in the parent project doesn't break add/commit.
    _ensure_nested_git_repo(owner, repo, number, url, item_type)

    # Remove old file from index (if tracked) and from disk.
    # --ignore-unmatch handles the case where it was never tracked
    # (e.g. fresh nested git repo we just initialized, or gitignored).
    if old_file != new_file:
        proc.run('git', 'rm', '-q', '--ignore-unmatch', 'DESCRIPTION.md', log=None)
        if old_file.exists():
            old_file.unlink()
        err(f"Renamed DESCRIPTION.md to {new_filename}")

    # Git operations
    proc.run('git', 'add', new_filename, log=None)
    item_label = 'PR' if item_type == 'pr' else 'issue'
    proc.run('git', 'commit', '-m', f'Rename to {new_filename} and add {item_label} #{number} link', log=None)
    err(f"Updated {new_filename} with {item_label} link")

    # Push updates to GitHub (link-def and footer)
    from . import push as push_module
    err("Pushing updates to GitHub...")
    push_module.push(
        gist=False,
        dry_run=False,
        footer=0,  # Auto-detect footer based on gist existence
        no_footer=False,
        open_browser=False,
        images=False,
        gist_private=None,
        no_comments=True,  # Don't sync comments during create
        force_others=False,
        as_login=as_login,  # Route the body edit through the alternate account, if any
    )

    # Push to gist remote if it exists
    from ..gist import find_gist_remote
    gist_remote = find_gist_remote()
    if gist_remote:
        try:
            proc.run('git', 'push', gist_remote, 'main', log=None)
            err(f"Pushed to gist remote '{gist_remote}'")
        except Exception as e:
            err(f"Warning: Could not push to gist: {e}")
    else:
        err("No gist remote found, skipping gist push")

    # Rename draft directory to gh/{number}, regardless of where it lives
    # under gh/ (e.g. gh/new/, gh/drafts/<slug>/, gh/new-<slug>/ legacy)
    current_dir = Path.cwd()
    current_name = current_dir.name

    gh_ancestor = next(
        (p for p in [current_dir.parent, *current_dir.parents] if p.name == 'gh'),
        None,
    )
    if gh_ancestor and current_name != number:
        new_dir = gh_ancestor / number
        if not new_dir.exists():
            # Note: After this, our cwd will be invalid, but we're done anyway
            import os
            old_rel = current_dir.relative_to(gh_ancestor.parent)
            os.rename(str(current_dir), str(new_dir))
            err(f"Renamed directory: {old_rel} → gh/{number}")
        else:
            err(f"Warning: Directory gh/{number} already exists, not renaming")


def init(
    repo: str | None,
    base: str | None,
    path: str | None = None,
) -> None:
    """Initialize a new PR draft.

    By default the draft is created at `gh/new/`. Pass a slug or path to
    stage multiple drafts in parallel:
      - bare slug `foo` → `gh/drafts/foo/`
      - path containing `/` → used as-is
    """
    new_dir = _resolve_draft_path(path)
    if new_dir.exists():
        if (new_dir / 'DESCRIPTION.md').exists():
            err(f"Error: {new_dir}/DESCRIPTION.md already exists. Are you already managing a PR here?")
            exit(1)
    else:
        new_dir.mkdir(parents=True)
        err(f"Created {new_dir}/")

    # Get and store repo config BEFORE creating .git
    if repo:
        # Explicit repo provided
        owner, repo_name = repo.split('/')
    else:
        # Try to auto-detect from current directory or parent's git repo
        owner = None
        repo_name = None
        current = Path.cwd()

        # Walk up to find a git repo (starting from current dir)
        for check_dir in [current] + list(current.parents):
            if (check_dir / '.git').exists():
                try:
                    with cd(check_dir):
                        repo_data = proc.json('gh', 'repo', 'view', '--json', 'owner,name', log=None, err_ok=True)
                        if repo_data:
                            owner = repo_data['owner']['login']
                            repo_name = repo_data['name']
                            err(f"Auto-detected repository: {owner}/{repo_name}")
                            break
                except Exception:
                    pass

    # Work inside gh/new/
    with cd(new_dir):
        # Initialize git repo if needed
        if not exists('.git'):
            proc.run('git', 'init', '-q', log=None)
            err("Initialized git repository")

        if owner and repo_name:
            proc.run('git', 'config', 'pr.owner', owner, log=None)
            proc.run('git', 'config', 'pr.repo', repo_name, log=None)
            if repo:
                err(f"Configured for {owner}/{repo_name}")

        if base:
            proc.run('git', 'config', 'pr.base', base, log=None)
            err(f"Base branch: {base}")

        # Create initial DESCRIPTION.md (plain format - link-reference added after PR creation)
        with open('DESCRIPTION.md', 'w') as f:
            f.write("# Title\n\n")
            f.write("Description of the PR...\n")

        err("Created DESCRIPTION.md template")

        # Create initial commit
        proc.run('git', 'add', 'DESCRIPTION.md', log=None)
        proc.run('git', 'commit', '-m', 'Initial PR draft', log=None)
        err("Created initial commit")

        # Create and configure gist mirror
        from ..gist import create_gist
        try:
            # Create gist (public by default, matching typical repo visibility)
            description = f'Draft PR for {owner}/{repo_name}' if owner and repo_name else 'Draft PR'
            gist_id = create_gist(
                file_path='DESCRIPTION.md',
                description=description,
                is_public=True,
                store_id=True  # Automatically stores in git config pr.gist
            )

            if gist_id:
                # Add gist as remote
                gist_url = f'git@gist.github.com:{gist_id}.git'
                proc.run('git', 'remote', 'add', 'g', gist_url, log=None)
                proc.run('git', 'config', 'pr.gist-remote', 'g', log=None)
                err(f"Created gist: https://gist.github.com/{gist_id}")
                err("Added remote 'g' for gist mirror")

                # Fetch and set up tracking
                proc.run('git', 'fetch', 'g', log=None)
                proc.run('git', 'branch', '--set-upstream-to=g/main', 'main', log=None)
                err("Configured main branch to track g/main")

                # Push initial commit to gist (with history)
                proc.run('git', 'push', '-f', 'g', 'main', log=None)
                err("Pushed initial commit to gist")
        except Exception as e:
            err(f"Warning: Could not create gist mirror: {e}")
            err("You can add it later with 'ghpr push -g'")

        # End of cd(new_dir) context - we're done working in gh/new/

    err("")
    err("Next steps:")
    err(f"  cd {new_dir}")
    err("  vim DESCRIPTION.md  # Edit title and description")
    err("  git commit -am 'Update PR description'")
    err("  ghpr create")

    # Output directory path to stdout for shell integration (with marker for reliable parsing)
    print(f"GHPR_DIR:{new_dir}")


def create(
    head: str | None,
    base: str | None,
    draft: bool,
    issue: bool,
    repo: str | None,
    yes: int,
    dry_run: bool,
    path: str | None = None,
    as_login: str | None = None,
) -> None:
    """Create a new PR or Issue from the current draft.

    By default, opens GitHub's web editor for interactive creation.
    Use -y to skip the web editor and create via API instead.

    If PATH is given, cd into the resolved draft directory first
    (e.g. `ghpr create foo` operates on `gh/new-foo/`).

    When an alternate identity is selected (`as_login` / `$GHPR_AS` /
    `git config pr.as`), the PR/issue is *opened* and its body *edited* as that
    account; with none set, behavior is unchanged.
    """
    # Validate draft flag with web editor mode
    if draft and yes == 0:
        err("Error: --draft flag requires -y (cannot use draft mode with web editor)")
        err("Use: ghpr create -d -y  (or -yy for silent creation)")
        exit(1)

    def _do_create():
        if issue:
            create_new_issue(repo, yes, dry_run, as_login)
        else:
            create_new_pr(head, base, draft, repo, yes, dry_run, as_login)

    if path:
        draft_dir = _resolve_draft_path(path)
        if not draft_dir.exists():
            err(f"Error: {draft_dir} does not exist. Run `ghpr init {path}` first.")
            exit(1)
        with cd(draft_dir):
            _do_create()
    else:
        _do_create()


def create_new_pr(
    head: str | None,
    base: str | None,
    draft: bool,
    repo_arg: str | None,
    yes: int,
    dry_run: bool,
    as_login: str | None = None,
) -> None:
    """Create a new PR from DESCRIPTION.md.

    Args:
        yes: 0 = open web editor during creation (default)
             1 = skip prompt, create then open result
             2+ = skip all, create silently
        as_login: Alternate GitHub login to open the PR as (see `identity.py`).
    """
    # Read and parse DESCRIPTION.md
    title, body = _read_and_parse_description()

    # Get repo info from config or parent directory
    owner = proc.line('git', 'config', 'pr.owner', err_ok=True, log=None)
    repo = proc.line('git', 'config', 'pr.repo', err_ok=True, log=None)

    if not owner or not repo:
        # Try to get from parent directory
        parent_dir = Path('..').resolve()
        if exists(join(parent_dir, '.git')):
            try:
                with cd(parent_dir):
                    repo_data = proc.json('gh', 'repo', 'view', '--json', 'owner,name', log=None)
                    owner = repo_data['owner']['login']
                    repo = repo_data['name']
            except Exception as e:
                err(f"Error: Could not determine repository: {e}")
                err("Configure with 'ghpr init -r owner/repo'")
                exit(1)
        else:
            err("Error: Could not determine repository. Configure with 'ghpr init -r owner/repo'")
            exit(1)

    # Get base branch from config or default
    if not base:
        base = proc.line('git', 'config', 'pr.base', err_ok=True, log=None)
        if not base:
            # Try to get default branch from parent repo
            try:
                parent_dir = Path('..').resolve()
                if exists(join(parent_dir, '.git')):
                    with cd(parent_dir):
                        # Get default branch from GitHub
                        default_branch = proc.line('gh', 'repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name', log=None)
                        base = default_branch
                    err(f"Auto-detected base branch: {base}")
                else:
                    base = 'main'  # Fallback to main
            except Exception as e:
                err(f"Error: Could not detect base branch: {e}")
                raise

    # Get head branch - try to auto-detect from parent repo
    if not head:
        # Go up one level (to get out of gh/new/) and find the git repo root
        parent_dir = Path('..').resolve()
        try:
            with cd(parent_dir):
                # Find the git repo root
                repo_root = proc.line('git', 'rev-parse', '--show-toplevel', err_ok=True, log=None)
                if not repo_root:
                    err("Error: Could not detect head branch. Specify --head explicitly")
                    exit(1)

                with cd(repo_root):
                    # Use branch resolution to get remote tracking branch
                    ref_name, remote_ref = resolve_remote_ref(verbose=False)
                    if remote_ref:
                        # Extract branch name from remote_ref (e.g., "m/rw/ws3" -> "rw/ws3")
                        # GitHub expects just the branch name without the remote prefix
                        if '/' in remote_ref:
                            head = '/'.join(remote_ref.split('/')[1:])
                        else:
                            head = remote_ref
                        err(f"Auto-detected head branch from remote: {head}")
                    elif ref_name:
                        # Fallback to local branch name if no remote tracking
                        head = ref_name
                        err(f"Auto-detected head branch (local): {head}")

                    if not head:
                        # Fallback to current branch
                        head = proc.line('git', 'rev-parse', '--abbrev-ref', 'HEAD', log=None)
                        if head == 'HEAD':
                            err("Error: Parent repo is in detached HEAD state. Specify --head explicitly")
                            exit(1)
        except Exception as e:
            err(f"Error detecting head branch: {e}")
            err("Specify --head explicitly")
            exit(1)

    # Create the PR
    if dry_run:
        err(f"[DRY-RUN] Would create PR in {owner}/{repo}")
        err(f"  Title: {title}")
        err(f"  Base: {base}")
        err(f"  Head: {head}")
        if draft:
            err("  Type: Draft PR")
        if body:
            err(f"  Body ({len(body)} chars):")
            # Show first few lines of body
            body_preview = body[:500] + ('...' if len(body) > 500 else '')
            for line in body_preview.split('\n')[:10]:
                err(f"    {line}")
    else:
        # Resolve (and verify) the alternate author identity before opening the
        # PR. None → open as the default `gh` account (unchanged behavior).
        identity = resolve_identity(as_login)
        bot_env = identity.env() if identity else None

        cmd = ['gh', 'pr', 'create',
               '-R', f'{owner}/{repo}',
               '--title', title,
               '--body', body,
               '--base', base,
               '--head', head]

        if draft:
            cmd.append('--draft')

        # Determine opening behavior based on yes count
        use_web_editor = (yes == 0)
        open_after = (yes == 1)

        if use_web_editor:
            cmd.append('--web')

        try:
            output = proc.text(*cmd, env=bot_env, log=None).strip()

            if use_web_editor:
                # Web editor mode: wait for user to finish editing in browser
                err("Opened PR in web editor")
                err("Press Enter when you've finished creating the PR in the browser...")
                input()

                # Query GitHub to find the newly created PR
                err("Fetching PR information...")
                try:
                    # List PRs for the head branch
                    prs = proc.json('gh', 'pr', 'list', '-R', f'{owner}/{repo}', '--head', head, '--json', 'number,url', log=None)
                    if prs and len(prs) > 0:
                        pr_number = str(prs[0]['number'])
                        pr_url = prs[0]['url']

                        # Store PR info in git config
                        proc.run('git', 'config', 'pr.number', pr_number, log=None)
                        proc.run('git', 'config', 'pr.url', pr_url, log=None)
                        err(f"Found PR #{pr_number}: {pr_url}")

                        # Check for gist remote and store its ID if found
                        try:
                            remotes = proc.lines('git', 'remote', '-v', log=None)
                            for remote_line in remotes:
                                if 'gist.github.com' in remote_line:
                                    gist_match = GIST_ID_PATTERN.search(remote_line)
                                    if gist_match:
                                        gist_id = gist_match.group(1)
                                        proc.run('git', 'config', 'pr.gist', gist_id, log=None)
                                        err(f"Detected and stored gist ID: {gist_id}")
                                        break
                        except Exception:
                            pass

                        # Finalize: rename file, commit, rename directory
                        _finalize_created_item(owner, repo, pr_number, pr_url, 'pr', as_login)
                    else:
                        err("Warning: Could not find newly created PR")
                        err("You may need to run 'ghpr pull' to sync with GitHub")
                except Exception as e:
                    err(f"Error: Could not fetch PR information: {e}")
                    raise
            else:
                # API mode: PR number returned immediately
                # Extract PR number from URL
                match = re.search(r'/pull/(\d+)', output)
                if match:
                    pr_number = match.group(1)
                    # Store PR info in git config
                    proc.run('git', 'config', 'pr.number', pr_number, log=None)
                    proc.run('git', 'config', 'pr.url', output, log=None)
                    err(f"Created PR #{pr_number}: {output}")
                    err("PR info stored in git config")

                    # Open PR in browser if requested
                    if open_after:
                        proc.run('gh', 'pr', 'view', pr_number, '--web', '-R', f'{owner}/{repo}', log=None)

                    # Check for gist remote and store its ID if found
                    try:
                        remotes = proc.lines('git', 'remote', '-v', log=None)
                        for remote_line in remotes:
                            if 'gist.github.com' in remote_line:
                                # Extract gist ID from URL like git@gist.github.com:GIST_ID.git
                                gist_match = GIST_ID_PATTERN.search(remote_line)
                                if gist_match:
                                    gist_id = gist_match.group(1)
                                    proc.run('git', 'config', 'pr.gist', gist_id, log=None)
                                    err(f"Detected and stored gist ID: {gist_id}")
                                    break
                    except Exception:
                        # Gist detection is optional, silently continue
                        pass

                    # Finalize: rename file, commit, rename directory
                    _finalize_created_item(owner, repo, pr_number, output, 'pr', as_login)
                else:
                    err(f"Created PR: {output}")
        except Exception as e:
            err(f"Error creating PR: {e}")
            exit(1)


def create_new_issue(
    repo_arg: str | None,
    yes: int,
    dry_run: bool,
    as_login: str | None = None,
) -> None:
    """Create a new Issue from DESCRIPTION.md.

    Args:
        yes: 0 = open web editor during creation (default)
             1 = skip prompt, create then open result
             2+ = skip all, create silently
        as_login: Alternate GitHub login to open the issue as (see `identity.py`).
    """
    # Read and parse DESCRIPTION.md
    title, body = _read_and_parse_description()

    # Get repo info
    owner, repo = get_owner_repo(repo_arg)

    # Create the issue
    if dry_run:
        err(f"[DRY-RUN] Would create issue in {owner}/{repo}")
        err(f"  Title: {title}")
        if body:
            err(f"  Body ({len(body)} chars):")
            # Show first few lines of body
            body_preview = body[:500] + ('...' if len(body) > 500 else '')
            for line in body_preview.split('\n')[:10]:
                err(f"    {line}")
    else:
        # Resolve (and verify) the alternate author identity before opening the
        # issue. None → open as the default `gh` account (unchanged behavior).
        identity = resolve_identity(as_login)
        bot_env = identity.env() if identity else None

        cmd = ['gh', 'issue', 'create',
               '-R', f'{owner}/{repo}',
               '--title', title,
               '--body', body]

        # Determine opening behavior based on yes count
        use_web_editor = (yes == 0)
        open_after = (yes == 1)

        if use_web_editor:
            cmd.append('--web')

        try:
            output = proc.text(*cmd, env=bot_env, log=None).strip()

            if use_web_editor:
                # Web editor mode: wait for user to finish editing in browser
                err("Opened issue in web editor")
                err("Press Enter when you've finished creating the issue in the browser...")
                input()

                # Query GitHub to find the newly created issue
                err("Fetching issue information...")
                try:
                    # List recent issues in the repo and find the newest one
                    issues = proc.json('gh', 'issue', 'list', '-R', f'{owner}/{repo}', '--json', 'number,url', '--limit', '1', log=None)
                    if issues and len(issues) > 0:
                        issue_number = str(issues[0]['number'])
                        issue_url = issues[0]['url']

                        # Store issue info in git config
                        proc.run('git', 'config', 'pr.number', issue_number, log=None)
                        proc.run('git', 'config', 'pr.type', 'issue', log=None)
                        proc.run('git', 'config', 'pr.url', issue_url, log=None)
                        err(f"Found issue #{issue_number}: {issue_url}")

                        # Finalize: rename file, commit, rename directory
                        _finalize_created_item(owner, repo, issue_number, issue_url, 'issue', as_login)
                    else:
                        err("Warning: Could not find newly created issue")
                        err("You may need to run 'ghpr pull' to sync with GitHub")
                except Exception as e:
                    err(f"Error: Could not fetch issue information: {e}")
                    raise
            else:
                # API mode: issue number returned immediately
                # Extract issue number from URL
                match = re.search(r'/issues/(\d+)', output)
                if match:
                    issue_number = match.group(1)
                    # Store issue info in git config
                    proc.run('git', 'config', 'pr.number', issue_number, log=None)
                    proc.run('git', 'config', 'pr.type', 'issue', log=None)
                    proc.run('git', 'config', 'pr.url', output, log=None)
                    err(f"Created issue #{issue_number}: {output}")
                    err("Issue info stored in git config")

                    # Open issue in browser if requested
                    if open_after:
                        proc.run('gh', 'issue', 'view', issue_number, '--web', '-R', f'{owner}/{repo}', log=None)

                    # Finalize: rename file, commit, rename directory
                    _finalize_created_item(owner, repo, issue_number, output, 'issue', as_login)
                else:
                    err(f"Created issue: {output}")
        except Exception as e:
            err(f"Error creating issue: {e}")
            exit(1)


def register(cli):
    """Register commands with CLI."""

    # Register init command
    @cli.command()
    @opt('-r', '--repo', help='Repository (owner/repo format)')
    @opt('-b', '--base', help='Base branch (default: repo default branch)')
    @arg('path', required=False)
    def init_cmd(repo, base, path):
        """Initialize a new PR/Issue draft (default: gh/new; PATH=slug → gh/drafts/<slug>)."""
        init(repo, base, path)

    # Register create command
    @cli.command(name='create')
    @opt('-a', '--as', 'as_login', help='Open the PR/issue + edit its body as this GitHub login (gist + reads stay default); also $GHPR_AS / `git config pr.as`')
    @opt('-y', '--yes', count=True, default=0, help='Skip web editor: -y = create via API then view, -yy = create silently (default: interactive web editor)')
    @opt('-r', '--repo', help='Repository (owner/repo format, default: auto-detect)')
    @flag('-n', '--dry-run', help='Show what would be done without creating')
    @flag('-i', '--issue', help='Create an issue instead of a PR')
    @opt('-h', '--head', help='Head branch (default: auto-detect from parent repo)')
    @flag('-d', '--draft', help='Create as draft PR (requires -y; incompatible with web editor)')
    @opt('-b', '--base', help='Base branch (default: repo default branch)')
    @arg('path', required=False)
    def create_cmd(as_login, yes, repo, dry_run, issue, head, draft, base, path):
        """Create a PR or Issue from a draft directory (default: cwd; PATH=slug → gh/drafts/<slug>)."""
        create(head, base, draft, issue, repo, yes, dry_run, path, as_login)
