"""Shared fixtures for the GitHub (`ghpr`) test suite.

Fail-safe against real gist creation. `commands/create.py`'s `init` calls
`gist.create_gist` (which shells out to `gh gist create --public`) inside a
`try/except Exception` that only warns on failure. A test that patches the
`create` module's `proc` does **not** stop `create_gist` — it imports `proc`
from `utz` under its own module, so the call runs for real and silently creates
a public gist on the authenticated account (186 `Draft PR for o/r` /
`Draft PR for test-owner/test-repo` gists accumulated this way before this
fixture existed). Mock it at the source for every non-`e2e` test, so no unit
test can ever reach the network regardless of which `proc` it patches.

`e2e` tests (`test_clone_e2e.py`, gated by `-m e2e` + gh auth) exercise the real
gist round-trip deliberately, so they are exempted.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def no_real_gists(request):
    """Mock `gist.create_gist` for every non-`e2e` test (fail-safe, see module doc)."""
    if 'e2e' in request.keywords:
        yield None
        return
    with patch('thrds.platforms.github.gist.create_gist', return_value='fakegistid') as m:
        yield m
