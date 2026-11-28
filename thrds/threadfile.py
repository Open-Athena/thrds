"""Thread files: ``NN-slug.md``, one per Slack thread in a session.

The session directory holds one markdown file per thread, named with a
two-digit ordering prefix and the thread's slug::

    01-cw-quickwins.md
    02-cw-summary.md
    03-cw-mpu.md

Rationale (see ``specs/done/per-thread-model.md``): with N threads in one doc, the
gist's git history interleaves unrelated drafts, so a commit reads as "the doc
changed" rather than "*this message* went v2→v3". Since the gist history is the
artifact these sessions are collected for, that conflation is the costly part.
One file per thread makes per-file history exactly that message's revision
trajectory.

The ``NN`` prefix gives deterministic ordering for the batch case (post six
messages in a known order) and costs nothing for the reply case. It carries no
identity: the ``slug`` is what keys ``thrds.yml``'s ``threads`` map, is stamped
into each posted message's Slack metadata, and is the target of ``[text](#slug)``
cross-references from sibling threads. So renumbering is cheap — `reorder` (or
editing the name in a staged message's chrome line) moves files and nothing
else, and git reconstructs each thread's history across the rename from content.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .md import ParsedThread


# `01-cw-quickwins.md` → (1, 'cw-quickwins'). The slug charset matches
# `md._HEADER_RE`'s, so slugs that were legal as `=== slug` stay legal as
# filenames (and vice versa) — migration never has to rewrite a slug.
THREAD_FILE_RE = re.compile(r'^(\d{2})-([a-zA-Z0-9_-]+)\.md$')

INDEX_WIDTH = 2

# The slug charset on its own, for validating a name that arrived without an
# index (a chrome line naming a new thread `cuda-graph.md`).
SLUG_RE = re.compile(r'[a-zA-Z0-9_-]+')


@dataclass(frozen=True, order=True)
class ThreadFile:
    """One ``NN-slug.md`` in a session directory.

    Ordered by ``(index, slug)`` so a sorted list of these is the doc order —
    which is the order threads get posted in on a batch push.
    """
    index: int
    slug: str
    path: Path

    @property
    def name(self) -> str:
        """The canonical basename for this (index, slug) pair."""
        return thread_filename(self.index, self.slug)


def thread_filename(index: int, slug: str) -> str:
    """Canonical ``NN-slug.md`` basename for ``index`` and ``slug``.

    Raises for an index that doesn't fit the fixed width, rather than emitting
    a name that would sort wrongly against its siblings (``100-x.md`` sorting
    before ``99-x.md``).
    """
    if index < 0:
        raise ValueError(f"Thread index must be non-negative, got {index}")
    if len(str(index)) > INDEX_WIDTH:
        raise ValueError(
            f"Thread index {index} exceeds {INDEX_WIDTH} digits; "
            f"a session with >{10 ** INDEX_WIDTH - 1} threads needs a wider prefix"
        )
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', slug):
        raise ValueError(f"Invalid thread slug {slug!r}: expected [a-zA-Z0-9_-]+")
    return f"{index:0{INDEX_WIDTH}d}-{slug}.md"


def parse_thread_filename(name: str) -> tuple[int, str] | None:
    """Parse ``NN-slug.md`` → ``(index, slug)``; None if it isn't a thread file.

    Returning None (rather than raising) lets callers scan a session directory
    that also holds ``thrds.yml``, downloaded emoji, and a README without
    having to pre-filter.
    """
    m = THREAD_FILE_RE.match(name)
    if m is None:
        return None
    return (int(m.group(1)), m.group(2))


def thread_files(session_dir: Path | str = '.') -> list[ThreadFile]:
    """All ``NN-slug.md`` files in ``session_dir``, sorted by (index, slug).

    Raises on a duplicate slug across two files (e.g. ``01-foo.md`` and
    ``02-foo.md``) — slugs are the thread identity used by state, metadata,
    and cross-references, so a collision is unrecoverable ambiguity rather
    than something to resolve by picking one.
    """
    d = Path(session_dir)
    found: list[ThreadFile] = []
    by_slug: dict[str, ThreadFile] = {}
    for p in sorted(d.iterdir()) if d.is_dir() else []:
        if not p.is_file():
            continue
        parsed = parse_thread_filename(p.name)
        if parsed is None:
            continue
        index, slug = parsed
        tf = ThreadFile(index=index, slug=slug, path=p)
        if slug in by_slug:
            raise ValueError(
                f"Duplicate thread slug {slug!r}: {by_slug[slug].path.name} and {p.name}"
            )
        by_slug[slug] = tf
        found.append(tf)
    return sorted(found)


def read_thread(tf: ThreadFile) -> ParsedThread:
    """Parse one :class:`ThreadFile` into its `ParsedThread` (thread + frontmatter).

    The frontmatter rides along because per-thread-file sender profiles
    (``sender.<name>.*`` / ``op_sender``) live there, and `push` / `promote`
    need them to post per-sender (`+++ as <name>`). The slug comes from the
    filename.
    """
    from .md import parse_thread  # local import: md imports nothing from here, but keep the edge one-way
    return parse_thread(tf.path.read_text(), slug=tf.slug)


def read_threads(session_dir: Path | str = '.') -> list[ParsedThread]:
    """Every thread in ``session_dir`` (with its frontmatter), in file order.

    File order (the ``NN`` prefix) is post order for a batch push, which is why
    it's deterministic rather than whatever ``iterdir`` happens to yield.
    """
    return [read_thread(tf) for tf in thread_files(session_dir)]


def find_thread(session_dir: Path | str, slug: str) -> tuple[ThreadFile, ParsedThread]:
    """The ``(file, parsed)`` for ``slug``; raises with the available slugs if absent."""
    files = thread_files(session_dir)
    for tf in files:
        if tf.slug == slug:
            return tf, read_thread(tf)
    available = ', '.join(f.slug for f in files) or '(none)'
    raise ValueError(f"No thread {slug!r} in this session; available: {available}")


def next_index(files: list[ThreadFile]) -> int:
    """The index a newly-added thread should take: one past the highest in use.

    Gaps are left alone rather than compacted, so adding a thread never
    renumbers an existing one. Deliberate compaction is `renumber`.
    """
    return max((f.index for f in files), default=0) + 1


def slugify(text: str, max_words: int = 6) -> str:
    """A slug from a message's opening words, for naming an adopted thread.

    Reads the first line only — a draft's first line is its subject far more
    often than any other heuristic would find. Markdown emphasis, links and
    code fences are stripped so ``**MFU** update`` yields ``mfu-update``.
    Returns ``''`` when nothing survives, which callers turn into a fallback.
    """
    line = text.strip().split('\n')[0]
    line = re.sub(r'<[^>|]*\|([^>]*)>', r'\1', line)   # `<url|text>` → `text`
    line = re.sub(r'[*_`~]', '', line)
    words = re.findall(r'[a-zA-Z0-9]+', line.lower())
    return '-'.join(words[:max_words])


def dedupe_thread_filename(index: int, slug: str, taken: set[str]) -> str:
    """``NN-slug.md``, suffixed until it doesn't collide with ``taken``.

    Collisions are real: two drafts opening with the same words slugify the
    same. Suffixing the *slug* rather than bumping the index keeps the number
    meaning "where this sorts" instead of quietly meaning "how many retries".
    """
    candidate = thread_filename(index, slug)
    if candidate not in taken:
        return candidate
    for n in range(2, 100):
        candidate = thread_filename(index, f'{slug}-{n}')
        if candidate not in taken:
            return candidate
    raise ValueError(f"Could not find a free filename for {slug!r} at index {index}")
