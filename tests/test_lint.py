"""Tests for the per-platform MD-compat linters (`thrds.lint`)."""
from __future__ import annotations

from thrds.lint import (
    BSKY_POST_LIMIT,
    MASTODON_POST_LIMIT,
    BskyLinter,
    DiscordLinter,
    LintIssue,
    LintReport,
    MastodonLinter,
)


def _lint(text: str) -> list[LintIssue]:
    return DiscordLinter().lint(text).issues


def _blint(text: str) -> list[LintIssue]:
    return BskyLinter().lint(text).issues


def _mlint(text: str) -> list[LintIssue]:
    return MastodonLinter().lint(text).issues


# --- masked links (Discord renders them fine since 2023; no rule) ---

def test_masked_link_not_flagged():
    """Discord's 2023 markdown update made `[text](url)` render as a hyperlink
    in normal user messages (with click-through warning for untrusted domains).
    The `discord/masked-link` rule was removed — see
    `specs/done/discord-masked-links-render.md`."""
    text = "See [the docs](https://example.com) for more.\n"
    assert _lint(text) == []


def test_bare_url_not_flagged():
    """Bare URLs auto-linkify in Discord — no warning."""
    text = "See https://example.com for more.\n"
    assert _lint(text) == []


# --- tables ---

def test_table_flagged_on_separator_line():
    text = "| Col A | Col B |\n|---|---|\n| a | b |\n"
    issues = _lint(text)
    # 3 warnings: separator line + both body lines (they're adjacent to the separator).
    assert [i.line for i in issues] == [1, 2, 3]
    assert all(i.rule == "discord/table" for i in issues)


def test_prose_with_pipes_not_flagged():
    """Line with pipes but no separator anywhere near it is prose, not a table."""
    text = "The cost | benefit tradeoff was clear.\n"
    assert _lint(text) == []


def test_table_inside_code_fence_ignored():
    text = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n"
    assert _lint(text) == []


def test_thematic_break_not_flagged():
    """A bare `---` is a horizontal rule, not a table separator. It carries no
    pipes and no adjacent table body, so nothing about it is table-shaped —
    and it's how thrds docs divide sections, so flagging it warns on every doc."""
    text = "Intro paragraph.\n\n---\n\nNext section.\n"
    assert _lint(text) == []


def test_setext_heading_not_flagged():
    """`text` + `---` is a setext H2, the other common bare-dashes construct."""
    text = "A Heading\n---\n\nBody text.\n"
    assert _lint(text) == []


def test_single_column_table_still_flagged():
    """The pipe is what makes dashes a table separator — `|---|` keeps warning."""
    text = "| Col |\n|---|\n| a |\n"
    issues = _lint(text)
    assert [i.line for i in issues] == [1, 2, 3]
    assert all(i.rule == "discord/table" for i in issues)


def test_pipeless_separator_flagged_when_a_table_body_adjoins_it():
    """Dashes with no pipes still read as a table when a pipe-delimited row sits
    against them — the sloppy-but-real `| a | b |` over a bare `---`."""
    text = "| Col A | Col B |\n---\n"
    issues = _lint(text)
    assert [i.line for i in issues] == [1, 2]
    assert all(i.rule == "discord/table" for i in issues)


# --- raw @mentions ---

def test_raw_mention_flagged():
    text = "Ping @alice about it.\n"
    issues = _lint(text)
    assert issues == [LintIssue(
        line=1, column=6, severity="warning", rule="discord/raw-mention",
        message="raw @alice won't ping in Discord; use <@user_id> to mention",
    )]


def test_valid_discord_mention_not_flagged():
    """`<@12345>` is Discord's real mention syntax — not a raw @name."""
    text = "Ping <@12345> about it.\n"
    assert _lint(text) == []


def test_everyone_and_here_not_flagged():
    """`@everyone`/`@here` are the two name-form mentions Discord resolves on
    paste — they ping, so they're not raw-mention mistakes. (Pinned by corpus
    cases `everyone`/`here`.) A username that merely starts with those words
    still warns."""
    assert _lint("Heads up @everyone and @here!\n") == []
    issues = _lint("Ping @heretic.\n")
    assert [(i.rule, i.column) for i in issues] == [('discord/raw-mention', 6)]


def test_email_address_not_flagged():
    """`x@y` (word char before `@`) is presumably an email, not a mention."""
    text = "Contact alice@example.com about it.\n"
    assert _lint(text) == []


def test_raw_mention_inside_code_fence_ignored():
    text = "```\nsee @alice\n```\nsee @bob elsewhere\n"
    issues = _lint(text)
    assert len(issues) == 1
    assert issues[0].line == 4


def test_raw_mention_excludes_trailing_period_punctuation():
    """Trailing sentence-ending punctuation isn't part of the username."""
    text = "Ping @alice.\n"
    issues = _lint(text)
    assert len(issues) == 1
    # The capture group is "alice" — the `.` belongs to the sentence.
    assert "@alice " in issues[0].message or "@alice won't" in issues[0].message
    assert "@alice." not in issues[0].message


def test_raw_mention_includes_embedded_period_dot_username():
    """Discord allows `.` in usernames (`alice.smith`); the dot is part of the name."""
    text = "Ping @alice.smith about it.\n"
    issues = _lint(text)
    assert len(issues) == 1
    assert "@alice.smith " in issues[0].message or "@alice.smith won't" in issues[0].message


# --- report shape ---

def test_report_sorted_by_line_then_column():
    """LintReport keeps issues in (line, column) order across multiple rule types."""
    text = (
        "Line one has @foo here.\n"
        "|---|\n"
    )
    report = DiscordLinter().lint(text)
    assert [(i.line, i.column, i.rule) for i in report.issues] == [
        (1, 14, "discord/raw-mention"),
        (2, 1, "discord/table"),
    ]


def test_report_format_prefixes_path_when_given():
    report = LintReport(issues=[LintIssue(
        line=3, column=5, severity="warning", rule="discord/table",
        message="msg",
    )])
    assert report.format(path="draft.md") == "draft.md:3:5: warning [discord/table] msg"
    assert report.format() == "3:5: warning [discord/table] msg"


def test_report_empty_when_no_issues():
    report = DiscordLinter().lint("just prose, no mentions or links.\n")
    assert report.issues == []
    assert not report.has_issues
    assert not report.has_errors


def test_report_format_empty_string_when_no_issues():
    assert LintReport().format() == ""


# --- bsky: post length ---


def test_bsky_short_paragraph_no_issue():
    assert _blint("Short paragraph.\n") == []


def test_bsky_at_limit_no_issue():
    """Exactly BSKY_POST_LIMIT chars is allowed; over is not."""
    at_limit = "x" * BSKY_POST_LIMIT
    assert _blint(at_limit + "\n") == []


def test_bsky_over_limit_flagged():
    over = "x" * (BSKY_POST_LIMIT + 1)
    issues = _blint(over + "\n")
    assert len(issues) == 1
    assert issues[0].rule == "bsky/post-too-long"
    assert issues[0].line == 1
    assert issues[0].column == 1
    assert f"{BSKY_POST_LIMIT + 1} chars" in issues[0].message


def test_bsky_multi_line_paragraph_joined_with_space_before_length_check():
    """Two wrapped lines whose join exceeds the limit → one warning at the first line."""
    line = "y" * 200
    text = f"{line}\n{line}\n"  # 200 + 1(space) + 200 = 401 > 300
    issues = _blint(text)
    assert [i.line for i in issues] == [1]
    assert issues[0].rule == "bsky/post-too-long"


def test_bsky_multiple_paragraphs_checked_independently():
    """Blank line ends the paragraph; each is checked on its own."""
    p1 = "a" * 400
    p2 = "short"
    p3 = "b" * 500
    text = f"{p1}\n\n{p2}\n\n{p3}\n"
    issues = _blint(text)
    assert [i.line for i in issues] == [1, 5]
    assert all(i.rule == "bsky/post-too-long" for i in issues)


def test_bsky_thrds_separators_excluded_from_paragraph():
    """`=== slug` and `---` are thrds doc-structure metadata, not post content."""
    body = "z" * 250  # well under limit
    text = f"=== a\n\n{body}\n---\n{body}\n"
    # Each 250-char paragraph is a separate post (separators break); no warnings.
    assert _blint(text) == []


def test_bsky_trailing_paragraph_without_final_blank_line_still_checked():
    """A paragraph at end-of-file (no trailing blank) still gets length-checked."""
    over = "q" * 400
    issues = _blint(over)  # no trailing newline
    assert len(issues) == 1
    assert issues[0].rule == "bsky/post-too-long"


# --- bsky: masked links ---


def test_bsky_masked_link_flagged():
    issues = _blint("See [docs](https://ex.com).\n")
    assert len(issues) == 1
    assert issues[0].rule == "bsky/masked-link"
    assert issues[0].line == 1
    assert issues[0].column == 5


def test_bsky_bare_url_not_flagged():
    """bsky auto-linkifies bare URLs via facets — no warning."""
    assert _blint("See https://ex.com for more.\n") == []


def test_bsky_masked_link_and_post_length_both_reported():
    """Both rules fire independently; report is sorted (line, column)."""
    # Long para (>300 chars) that also contains a masked link.
    prefix = "a" * 290 + " "  # 291 chars; +19 (masked link) +7 (extra) = 317 total → over limit
    para = f"{prefix}[a](https://ex.com) extra."
    text = f"{para}\n"
    issues = _blint(text)
    # Two issues: post-too-long at col 1, masked-link at col 292 (after 291-char prefix).
    # Sort order is (line, column) → post-too-long first.
    assert [(i.line, i.column, i.rule) for i in issues] == [
        (1, 1, "bsky/post-too-long"),
        (1, len(prefix) + 1, "bsky/masked-link"),
    ]


def test_bsky_masked_link_inside_code_fence_ignored():
    text = "```\n[link](https://x.example)\n```\nsee [link](https://y.example)\n"
    issues = _blint(text)
    # One masked-link (line 4). Note: line 2's short content doesn't trip length.
    ml_issues = [i for i in issues if i.rule == "bsky/masked-link"]
    assert len(ml_issues) == 1
    assert ml_issues[0].line == 4


# --- mastodon: post length (default 500) ---


def test_mastodon_limit_is_500():
    assert MASTODON_POST_LIMIT == 500


def test_mastodon_short_paragraph_no_issue():
    assert _mlint("Short toot.\n") == []


def test_mastodon_at_limit_no_issue():
    """Exactly MASTODON_POST_LIMIT chars is allowed; over is not."""
    assert _mlint("x" * MASTODON_POST_LIMIT + "\n") == []


def test_mastodon_over_limit_flagged():
    over = "x" * (MASTODON_POST_LIMIT + 1)
    assert _mlint(over + "\n") == [LintIssue(
        line=1,
        column=1,
        severity="warning",
        rule="mastodon/post-too-long",
        message=f"paragraph is {MASTODON_POST_LIMIT + 1} chars; Mastodon default post limit is {MASTODON_POST_LIMIT}",
    )]


def test_mastodon_bsky_length_ok_on_mastodon():
    """A 400-char paragraph is over bsky's 300 limit but under Mastodon's 500."""
    para = "z" * 400
    assert _blint(para + "\n")[0].rule == "bsky/post-too-long"
    assert _mlint(para + "\n") == []


def test_mastodon_thrds_separators_excluded_from_paragraph():
    body = "z" * 300  # under the 500 limit
    text = f"=== a\n\n{body}\n---\n{body}\n"
    assert _mlint(text) == []


def test_mastodon_multiple_paragraphs_checked_independently():
    p1 = "a" * 600
    p2 = "short"
    p3 = "b" * 700
    text = f"{p1}\n\n{p2}\n\n{p3}\n"
    assert [(i.line, i.rule) for i in _mlint(text)] == [
        (1, "mastodon/post-too-long"),
        (5, "mastodon/post-too-long"),
    ]


# --- mastodon: masked links ---


def test_mastodon_masked_link_flagged():
    assert _mlint("See [docs](https://ex.com).\n") == [LintIssue(
        line=1,
        column=5,
        severity="warning",
        rule="mastodon/masked-link",
        message="masked link '[docs](https://ex.com)' renders as literal text on Mastodon; use a bare URL (auto-linked)",
    )]


def test_mastodon_bare_url_not_flagged():
    """Mastodon auto-links bare URLs — no warning."""
    assert _mlint("See https://ex.com for more.\n") == []


def test_mastodon_masked_link_inside_code_fence_ignored():
    text = "```\n[link](https://x.example)\n```\nsee [link](https://y.example)\n"
    ml_issues = [i for i in _mlint(text) if i.rule == "mastodon/masked-link"]
    assert [i.line for i in ml_issues] == [4]


def test_mastodon_masked_link_and_post_length_both_reported():
    """Both rules fire independently; report is sorted (line, column)."""
    prefix = "a" * 490 + " "  # 491 chars; + masked link + extra → over 500
    para = f"{prefix}[a](https://ex.com) extra."
    assert [(i.line, i.column, i.rule) for i in _mlint(para + "\n")] == [
        (1, 1, "mastodon/post-too-long"),
        (1, len(prefix) + 1, "mastodon/masked-link"),
    ]
