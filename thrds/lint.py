"""MD-compat linters for platforms that render (or don't render) their own
subset of markdown.

Slack, Discord, and Bluesky each render a *different* subset of common
markdown; a document written in one platform's dialect will render badly in
the other. The linters here flag those mismatches in the source `.md` so the
author can fix them before pasting/posting.

Currently:

- :class:`DiscordLinter` — catches the two MD constructs that don't render
  as expected in a normal Discord user message:

  - **markdown tables** (``| col | col |``) don't render at all; use a code
    block or bullets.
  - **raw ``@name``** doesn't ping — Discord requires ``<@user_id>`` for a
    real user mention (name-based mentions don't resolve on paste).

  (Masked links ``[text](url)`` render fine in normal user messages since
  Discord's 2023 markdown update — see ``specs/done/discord-masked-links-render.md``
  for the correction to the original phase-2c scope.)

- :class:`BskyLinter` — Bluesky's constraints look different from Discord's
  but with some overlap:

  - **300-char post limit** — each paragraph (blank-line-separated block, with
    thrds `===`/`---` separators stripped) that exceeds the limit is flagged.
    This is bsky's main drafting pain and the linter's headline value-add.
  - **masked links** — bsky renders them as literal text; bare URLs auto-link
    via facets. Same rule as Discord, different rule slug.

- :class:`MastodonLinter` — same two rules as bsky (vanilla Mastodon doesn't
  parse markdown either), with a **500-char** default limit
  (``mastodon/post-too-long``) and ``mastodon/masked-link``.

Extending to another platform: add a linter class here (each with a
``lint(text: str) -> LintReport`` method); the CLI's platform subgroup wires
its verbs into it. See ``specs/done/discord-platform.md`` for the phase-2
scope this file implements.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class LintIssue:
    """One lint finding, anchored to a 1-indexed line + column in the source.

    ``severity`` is either ``"warning"`` or ``"error"`` — today all Discord
    rules are warnings (the doc still renders, just not as the author
    probably intended); reserved for future platforms with hard limits.
    """
    line: int
    column: int
    severity: str  # "warning" | "error"
    rule: str
    message: str


@dataclass
class LintReport:
    """Collection of :class:`LintIssue` from one lint pass.

    Sorted by ``(line, column)`` on construction/append so ``format()``
    output reads top-to-bottom in file order.
    """
    issues: list[LintIssue] = field(default_factory=list)

    @property
    def has_issues(self) -> bool:
        return bool(self.issues)

    @property
    def has_errors(self) -> bool:
        return any(i.severity == "error" for i in self.issues)

    def append(self, issue: LintIssue) -> None:
        self.issues.append(issue)
        self.issues.sort(key=lambda i: (i.line, i.column))

    def format(self, path: str | None = None) -> str:
        """Human-readable stderr output. ``<path>:<line>:<col>: <severity> [<rule>] <message>``."""
        prefix = f"{path}:" if path else ""
        return "\n".join(
            f"{prefix}{i.line}:{i.column}: {i.severity} [{i.rule}] {i.message}"
            for i in self.issues
        )


# Regex for `[text](url)` — matches non-greedy inside `[]`, then `(...)`. Doesn't
# handle nested brackets (Discord's parser wouldn't either); catches the 99% case.
_MASKED_LINK_RE = re.compile(r"\[[^\]\n]+\]\([^)\n]+\)")

# A table separator line: `|---|`, `|---|---|`, `---|---`, etc. Dashes optionally
# with `:` for alignment. Uses `*` (not `+`) on the extra-column group so
# single-column tables like `|---|` also match.
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")

# A table body line: starts with `|`, has at least one more `|`, no code-fence context.
_TABLE_BODY_RE = re.compile(r"^\s*\|.*\|\s*$")

# `@name` — word chars after `@`, not preceded by another word char (so `x@y` doesn't
# match) and not the well-formed `<@id>` Discord mention. Embedded `.` allowed
# (Discord usernames can contain dots — `alice.smith`) but trailing punctuation
# is excluded via the `(?:\.\w+)*` shape (no bare trailing `.`).
# `@everyone`/`@here` are excluded: those are the two name-form mentions Discord
# *does* resolve on paste (corpus cases `everyone`/`here`), so warning on them
# is a false positive.
_RAW_MENTION_RE = re.compile(r"(?<![\w<])@(?!(?:everyone|here)\b)([A-Za-z][\w-]*(?:\.\w+)*)")


def _is_fence(line: str) -> bool:
    """A markdown code-fence line (``` or ~~~ optionally followed by a language)."""
    stripped = line.lstrip()
    return stripped.startswith("```") or stripped.startswith("~~~")


class DiscordLinter:
    """Flag markdown constructs that don't render in normal Discord user messages.

    The two rules (tables, raw ``@name``) are described in the module
    docstring. Code blocks are skipped — anything inside \\`\\`\\` fences
    (or indented code, though we don't detect that) is presumed literal.
    """

    def lint(self, text: str) -> LintReport:
        report = LintReport()
        in_fence = False
        lines = text.split("\n")
        for i, line in enumerate(lines, start=1):
            if _is_fence(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue

            # Tables: separator line + adjacent body lines.
            if _TABLE_SEP_RE.match(line) and self._is_table_sep_in_context(lines, i - 1):
                report.append(LintIssue(
                    line=i,
                    column=1,
                    severity="warning",
                    rule="discord/table",
                    message="markdown table doesn't render in Discord; use a code block or bullets",
                ))
            elif _TABLE_BODY_RE.match(line) and self._prev_or_next_is_table_sep(lines, i - 1):
                # Standalone body lines without a separator are likely just prose with pipes;
                # only flag when there's a nearby separator to disambiguate from `foo | bar`.
                report.append(LintIssue(
                    line=i,
                    column=1,
                    severity="warning",
                    rule="discord/table",
                    message="markdown table doesn't render in Discord; use a code block or bullets",
                ))

            # Raw @mentions: `@name` won't ping in Discord (needs `<@id>`).
            for m in _RAW_MENTION_RE.finditer(line):
                report.append(LintIssue(
                    line=i,
                    column=m.start() + 1,
                    severity="warning",
                    rule="discord/raw-mention",
                    message=f"raw @{m.group(1)} won't ping in Discord; use <@user_id> to mention",
                ))

        return report

    @staticmethod
    def _is_table_sep_in_context(lines: list[str], idx: int) -> bool:
        """True iff the dashes at ``lines[idx]`` are a *table* separator rather
        than a thematic break (``---``) or setext heading underline.

        A pipe settles it on its own (``|---|``, ``---|---``). Without one, the
        dashes only read as a table when a pipe-delimited row adjoins them.
        Bare ``---`` is neither, and it's how thrds docs divide sections — so
        flagging it unconditionally warned on essentially every doc."""
        if "|" in lines[idx]:
            return True
        for j in (idx - 1, idx + 1):
            if 0 <= j < len(lines) and _TABLE_BODY_RE.match(lines[j]):
                return True
        return False

    @staticmethod
    def _prev_or_next_is_table_sep(lines: list[str], idx: int) -> bool:
        """True iff the line at ``lines[idx-1]`` or ``lines[idx+1]`` matches the
        table-separator regex (idx here is 0-indexed into ``lines``)."""
        for j in (idx - 1, idx + 1):
            if 0 <= j < len(lines) and _TABLE_SEP_RE.match(lines[j]):
                return True
        return False


# Bluesky's post limit is 300 graphemes; we approximate as Python string length
# (`len(str)` counts code points, not graphemes — close enough for lint purposes;
# a paragraph near the limit that fails hard on paste is a rare corner).
BSKY_POST_LIMIT = 300


def _is_thrds_separator(line: str) -> bool:
    """thrds' multi-thread doc format uses ``=== slug`` for thread starts and
    ``---`` for message separators; both are metadata, not post content, and
    should be excluded from bsky's paragraph-length check."""
    stripped = line.lstrip()
    return stripped.startswith("=== ") or stripped == "---" or stripped.startswith("--- ")


class BskyLinter:
    """Flag markdown constructs / lengths that break on Bluesky.

    Rules today: paragraph length vs :data:`BSKY_POST_LIMIT`, and masked links
    (bsky auto-linkifies bare URLs via facets, so the ``[text](url)`` form
    renders as literal text — same failure mode as Discord).

    "Paragraph" = one or more consecutive non-blank, non-thrds-separator lines,
    joined by ``" "`` to approximate the rendered length (bsky trims runs of
    whitespace before posting). thrds ``===``/``---`` separators are stripped
    since they're doc-structure metadata, not post content.
    """

    def lint(self, text: str) -> LintReport:
        report = LintReport()
        in_fence = False
        lines = text.split("\n")

        # Masked links: same rule as Discord, different slug.
        for i, line in enumerate(lines, start=1):
            if _is_fence(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            for m in _MASKED_LINK_RE.finditer(line):
                report.append(LintIssue(
                    line=i,
                    column=m.start() + 1,
                    severity="warning",
                    rule="bsky/masked-link",
                    message=f"masked link {m.group()!r} renders as literal text on Bluesky; use bare URL (auto-linkified via facets)",
                ))

        # Paragraph length: gather blank-separated blocks, joined by space.
        para_start: int | None = None  # 1-indexed line of the first line of the current paragraph
        para_lines: list[str] = []
        for i, line in enumerate(lines, start=1):
            if _is_fence(line) or _is_thrds_separator(line):
                # Fences aren't post content; separators are doc metadata. Break paragraph.
                if para_start is not None:
                    self._check_paragraph(report, para_start, para_lines)
                    para_start, para_lines = None, []
                continue
            if not line.strip():
                # Blank line ends the paragraph.
                if para_start is not None:
                    self._check_paragraph(report, para_start, para_lines)
                    para_start, para_lines = None, []
                continue
            # Non-blank content line — join into current paragraph.
            if para_start is None:
                para_start = i
            para_lines.append(line.strip())

        # Flush trailing paragraph (no trailing blank line).
        if para_start is not None:
            self._check_paragraph(report, para_start, para_lines)

        return report

    @staticmethod
    def _check_paragraph(report: LintReport, start_line: int, lines: list[str]) -> None:
        """Emit a `bsky/post-too-long` warning if the joined paragraph exceeds the limit."""
        text = " ".join(lines)
        if len(text) > BSKY_POST_LIMIT:
            report.append(LintIssue(
                line=start_line,
                column=1,
                severity="warning",
                rule="bsky/post-too-long",
                message=(
                    f"paragraph is {len(text)} chars; bsky post limit is {BSKY_POST_LIMIT}"
                ),
            ))


# Mastodon's default post limit is 500 characters. Instances can raise it
# (`configuration.statuses.max_characters`), so this is a lint-time baseline,
# not a hard rule — a doc that trips it may still fit on a roomier instance.
MASTODON_POST_LIMIT = 500


class MastodonLinter:
    """Flag markdown constructs / lengths that break on Mastodon.

    Mastodon's constraints mirror Bluesky's — vanilla Mastodon does not parse
    markdown, so it shares bsky's two failure modes with a longer limit:

    - **500-char post limit** (per paragraph) — the default `max_characters`;
      raise-able per instance, so this is a warning, not an error.
    - **masked links** — ``[text](url)`` renders as literal text; bare URLs
      auto-link. Same rule as bsky/Discord, different slug.

    "Paragraph" is defined exactly as in :class:`BskyLinter`: blank-separated
    blocks with thrds ``===``/``---`` separators stripped, joined by ``" "``.
    """

    def lint(self, text: str) -> LintReport:
        report = LintReport()
        in_fence = False
        lines = text.split("\n")

        # Masked links: same rule as bsky, different slug.
        for i, line in enumerate(lines, start=1):
            if _is_fence(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            for m in _MASKED_LINK_RE.finditer(line):
                report.append(LintIssue(
                    line=i,
                    column=m.start() + 1,
                    severity="warning",
                    rule="mastodon/masked-link",
                    message=f"masked link {m.group()!r} renders as literal text on Mastodon; use a bare URL (auto-linked)",
                ))

        # Paragraph length: gather blank-separated blocks, joined by space.
        para_start: int | None = None
        para_lines: list[str] = []
        for i, line in enumerate(lines, start=1):
            if _is_fence(line) or _is_thrds_separator(line):
                if para_start is not None:
                    self._check_paragraph(report, para_start, para_lines)
                    para_start, para_lines = None, []
                continue
            if not line.strip():
                if para_start is not None:
                    self._check_paragraph(report, para_start, para_lines)
                    para_start, para_lines = None, []
                continue
            if para_start is None:
                para_start = i
            para_lines.append(line.strip())

        if para_start is not None:
            self._check_paragraph(report, para_start, para_lines)

        return report

    @staticmethod
    def _check_paragraph(report: LintReport, start_line: int, lines: list[str]) -> None:
        """Emit a `mastodon/post-too-long` warning if the joined paragraph exceeds the limit."""
        text = " ".join(lines)
        if len(text) > MASTODON_POST_LIMIT:
            report.append(LintIssue(
                line=start_line,
                column=1,
                severity="warning",
                rule="mastodon/post-too-long",
                message=(
                    f"paragraph is {len(text)} chars; Mastodon default post limit is {MASTODON_POST_LIMIT}"
                ),
            ))
