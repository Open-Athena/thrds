"""Optionally run PR/issue *comment + review writes* as a different GitHub
account (e.g. a review bot), while the gist mirror and every read stay on the
default `gh` account.

`ghpr` normally shells out to a bare `gh …`, so it always acts as the active
`gh` account. This module resolves an alternate login + token and hands back an
`Identity` whose `env()` overrides only `GH_TOKEN` for the specific subprocess
calls that post/edit comments and review replies. Nothing here touches the
ambient environment, so gist ops and reads are unaffected.

See `specs/gh-comment-alt-account.md` for the full design.
"""
from __future__ import annotations

from dataclasses import dataclass
from os import environ
from typing import Callable

from utz import proc, err

# Env vars
AS_ENV = 'GHPR_AS'              # login to act as for comment/review writes
AS_TOKEN_ENV = 'GHPR_AS_TOKEN'  # explicit PAT for the alt login (highest-priority source)

# Per-clone git config keys (mirror the existing `pr.gist` mechanism)
AS_CONFIG = 'pr.as'
AS_TOKEN_CMD_CONFIG = 'pr.as-token-cmd'


def select_login(as_login: str | None = None) -> str | None:
    """Resolve the login to act as; precedence high→low: flag, env, git config.

    Returns None when none is set, so callers act as the default `gh` account
    (a pure no-op vs. prior behavior).
    """
    if as_login:
        return as_login
    env_login = environ.get(AS_ENV)
    if env_login:
        return env_login
    return proc.line('git', 'config', AS_CONFIG, err_ok=True, log=None) or None


# ---------------------------------------------------------------------------
# Token sources — tried in order, first non-empty wins. Add one by appending a
# `(login) -> str | None` callable to `TOKEN_SOURCES`.
# ---------------------------------------------------------------------------

def _token_from_env(login: str) -> str | None:
    """An explicit PAT in `$GHPR_AS_TOKEN` — direct token, no keyring needed."""
    return environ.get(AS_TOKEN_ENV) or None


def _token_from_gh_keyring(login: str) -> str | None:
    """`gh auth token -u <login>` — the gh multi-account keyring (recommended)."""
    return proc.line('gh', 'auth', 'token', '-u', login, err_ok=True, log=None) or None


def _token_from_config_cmd(login: str) -> str | None:
    """A user-configured command (`git config pr.as-token-cmd`) that prints a token.

    E.g. `security find-generic-password -a rbw-bot -s gh-rbw-bot -w` on macOS.
    """
    cmd = proc.line('git', 'config', AS_TOKEN_CMD_CONFIG, err_ok=True, log=None)
    if not cmd:
        return None
    return proc.line(cmd, shell=True, err_ok=True, log=None) or None


TOKEN_SOURCES: list[Callable[[str], str | None]] = [
    _token_from_env,
    _token_from_gh_keyring,
    _token_from_config_cmd,
]


def resolve_token(login: str) -> str | None:
    """First non-empty token from `TOKEN_SOURCES`, or None if all miss."""
    for source in TOKEN_SOURCES:
        token = source(login)
        if token:
            return token
    return None


def verify_login(token: str) -> str | None:
    """The login that `gh api user` reports for `token` (None on failure)."""
    data = proc.json(
        'gh', 'api', 'user',
        env={**environ, 'GH_TOKEN': token},
        err_ok=True, log=None,
    )
    return data.get('login') if data else None


@dataclass(frozen=True)
class Identity:
    """A resolved, verified GitHub identity to run comment/review writes as."""
    login: str
    token: str

    def env(self) -> dict:
        """Subprocess env that authenticates `gh` as this identity.

        Only `GH_TOKEN` is overridden; everything else is inherited, so a single
        write call switches identity without disturbing ambient config.
        """
        return {**environ, 'GH_TOKEN': self.token}


def resolve_identity(as_login: str | None = None) -> Identity | None:
    """Resolve + verify the identity for comment/review writes, or None.

    Returns None when no alternate login is selected — callers then act as the
    default `gh` account, unchanged. Raises when a login *is* selected but no
    token resolves, or the token authenticates as a *different* login; never
    silently falls back to the default identity for a write meant for another
    account.
    """
    login = select_login(as_login)
    if not login:
        return None
    token = resolve_token(login)
    if not token:
        raise RuntimeError(
            f"No token for GitHub login '{login}'. Set ${AS_TOKEN_ENV}, run "
            f"`gh auth login` as '{login}', or set `git config {AS_TOKEN_CMD_CONFIG}`."
        )
    actual = verify_login(token)
    if actual != login:
        raise RuntimeError(
            f"Refusing to act as '{login}': token authenticates as "
            f"'{actual or '<unknown>'}'."
        )
    err(f"Acting as GitHub '{login}' for comment/review writes")
    return Identity(login, token)
