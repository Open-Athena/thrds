"""Sync command - `pull` then `push`: the full round trip, in one verb.

`pull` used to end by pushing, which made it the one place ghpr's git analogy
broke (git's `pull` never writes to the remote) and gave `-n` two meanings at
once. The round trip is still the common workflow, so it keeps a name — just an
honest one, that says a remote write is about to happen.
"""

from click import Choice
from utz.cli import flag, opt

from .pull import MODES, pull
from .push import push


def sync(
    gist: bool,
    dry_run: bool,
    footer: int,
    no_footer: bool,
    open_browser: bool,
    images: bool,
    gist_private: bool | None,
    no_comments: bool,
    force_others: bool,
    mode: str | None = None,
    as_login: str | None = None,
) -> None:
    """Pull GitHub's state into the local branch, then push the result back."""
    pull(gist, dry_run, open_browser=False, gist_private=gist_private,
         no_comments=no_comments, mode=mode)
    # `pull` just fetched and reconciled, so push's upstream gate would only
    # re-ask a question answered seconds ago. The TOCTOU window that remains is
    # the same one any push has between its gate and its writes.
    push(gist, dry_run, footer, no_footer, open_browser, images, gist_private,
         no_comments, force_others, no_gate=True, as_login=as_login)


def register(cli):
    """Register command with CLI."""

    @cli.command()
    @opt('-a', '--as', 'as_login', help='Post/edit comments + review replies as this GitHub login (gist + reads stay default); also $GHPR_AS / `git config pr.as`')
    @flag('-C', '--force-others', help='Allow pushing edits to other users\' comments (may fail at API level)')
    @flag('--no-comments', help='Skip syncing comments')
    @opt('-p/-P', '--private/--public', 'gist_private', default=None, help='Gist visibility: -p = private, -P = public (default: match repo visibility)')
    @flag('-i', '--images', help='Upload local images and replace references')
    @flag('-o', '--open', 'open_browser', help='Open PR in browser afterward')
    @opt('-m', '--mode', type=Choice(MODES), default=None, help='Reconcile local commits with fetched state (default: `git config ghpr.pullMode`, else rebase)')
    @flag('-F', '--no-footer', help='Disable footer completely')
    @opt('-f', '--footer', count=True, help='Footer level: -f = hidden footer, -ff = visible footer')
    @flag('-n', '--dry-run', help='Show what would be done without making changes')
    @flag('-g', '--gist', help='Also sync to gist')
    def sync_cmd(as_login, force_others, no_comments, gist_private, images, open_browser, mode, no_footer, footer, dry_run, gist):
        """Pull from GitHub, reconcile, then push the result back (pull + push)."""
        sync(gist, dry_run, footer, no_footer, open_browser, images, gist_private,
             no_comments, force_others, mode, as_login)
