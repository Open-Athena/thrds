"""Tests for single-thread `.md` parse/serialize (`parse_thread` / `serialize_thread`).

One file is one thread: `+++` still separates replies within it, `===` is
retired. The slug comes from the filename, not from an in-file marker.
See `specs/done/per-thread-model.md`.
"""
from __future__ import annotations

import pytest

from thrds import DocMessage, DocThread, Frontmatter
from thrds.md import parse_thread, serialize_thread


# --- parse_thread ---


def test_parse_thread_op_only():
    parsed = parse_thread("Just the OP.\n", slug='a')
    assert parsed.thread == DocThread(messages=[DocMessage(content='Just the OP.')], slug='a')
    assert parsed.frontmatter == Frontmatter()


def test_parse_thread_op_and_replies():
    text = "OP body.\n\n+++\n\nFirst reply.\n\n+++\n\nSecond reply.\n"
    parsed = parse_thread(text, slug='cw-mpu')
    assert parsed.thread == DocThread(
        messages=[
            DocMessage(content='OP body.'),
            DocMessage(content='First reply.'),
            DocMessage(content='Second reply.'),
        ],
        slug='cw-mpu',
    )


def test_parse_thread_foreign_reply_author_captured():
    text = "OP.\n\n+++ @rafal\n\nTheir reply.\n"
    parsed = parse_thread(text, slug='a')
    assert parsed.thread.messages == [
        DocMessage(content='OP.'),
        DocMessage(content='Their reply.', author='rafal'),
    ]


def test_parse_thread_preserves_internal_blank_lines():
    """Paragraph breaks within a message survive; surrounding whitespace doesn't."""
    text = "Para one.\n\nPara two.\n"
    assert parse_thread(text, slug='a').thread.messages == [
        DocMessage(content='Para one.\n\nPara two.'),
    ]


def test_parse_thread_with_frontmatter():
    text = "---\nchannel: C123\nthread_ts: 1.2\n---\n\nBody.\n"
    parsed = parse_thread(text, slug='a')
    assert parsed.frontmatter == Frontmatter(channel='C123', thread_ts='1.2')
    assert parsed.thread.messages == [DocMessage(content='Body.')]


def test_parse_thread_slug_defaults_to_none():
    assert parse_thread("Body.\n").thread.slug is None


def test_parse_thread_rejects_thread_header():
    """`===` is the retired multi-thread-per-file syntax; accepting it silently
    would let a file that means several threads post as one message."""
    text = "First.\n\n=== second\n\nSecond.\n"
    with pytest.raises(ValueError) as e:
        parse_thread(text, slug='a')
    assert str(e.value) == (
        "Thread 'a': unexpected `===` at line 2: one file is one thread; "
        "`===` (multi-thread-per-file) was retired — split into `NN-slug.md` files "
        "via `thrds slack migrate`"
    )


def test_parse_thread_rejects_empty_op():
    with pytest.raises(ValueError) as e:
        parse_thread("\n\n+++\n\nreply\n", slug='a')
    assert str(e.value) == "Thread 'a': OP (first message) is empty"


def test_parse_thread_rejects_empty_reply():
    with pytest.raises(ValueError) as e:
        parse_thread("OP.\n\n+++\n\n+++\n\nsecond\n", slug='a')
    assert str(e.value) == "Thread 'a': reply 1 is empty"


def test_parse_thread_unclosed_frontmatter_raises():
    with pytest.raises(ValueError) as e:
        parse_thread("---\nchannel: C1\n\nBody.\n", slug='a')
    assert str(e.value) == 'Frontmatter opened with `---` but no closing delimiter found'


# --- serialize_thread ---


def test_serialize_thread_op_only():
    t = DocThread(messages=[DocMessage(content='Just the OP.')], slug='a')
    assert serialize_thread(t) == 'Just the OP.\n'


def test_serialize_thread_emits_no_header():
    """The slug lives in the filename — a serialized thread file never has `===`."""
    t = DocThread(messages=[DocMessage(content='Body.')], slug='cw-summary')
    assert serialize_thread(t) == 'Body.\n'


def test_serialize_thread_with_replies():
    t = DocThread(
        messages=[
            DocMessage(content='OP.'),
            DocMessage(content='R1.'),
            DocMessage(content='R2.', author='rafal'),
        ],
        slug='a',
    )
    assert serialize_thread(t) == 'OP.\n\n+++\n\nR1.\n\n+++ @rafal\n\nR2.\n'


def test_serialize_thread_with_frontmatter():
    t = DocThread(messages=[DocMessage(content='Body.')], slug='a')
    fm = Frontmatter(channel='C123')
    assert serialize_thread(t, fm) == '---\nchannel: C123\n---\n\nBody.\n'


def test_serialize_thread_omits_all_none_frontmatter():
    t = DocThread(messages=[DocMessage(content='Body.')], slug='a')
    assert serialize_thread(t, Frontmatter()) == 'Body.\n'


def test_serialize_thread_rejects_authored_op():
    t = DocThread(messages=[DocMessage(content='OP.', author='rafal')], slug='a')
    with pytest.raises(ValueError) as e:
        serialize_thread(t)
    assert str(e.value) == (
        "Thread 'a': OP author/sender must be None (top-level = ours; OP sender lives "
        "in frontmatter `op_sender`), got author='rafal' sender=None"
    )


# --- round-trip ---


@pytest.mark.parametrize('text', [
    'Just the OP.\n',
    'OP.\n\n+++\n\nR1.\n',
    'OP.\n\n+++ @rafal\n\nTheir reply.\n\n+++\n\nOurs again.\n',
    'Para one.\n\nPara two.\n\n+++\n\nReply.\n',
])
def test_parse_serialize_round_trip(text):
    parsed = parse_thread(text, slug='a')
    assert serialize_thread(parsed.thread, parsed.frontmatter) == text


def test_round_trip_with_frontmatter():
    text = '---\nchannel: C123\nsession_id: abc\n---\n\nBody.\n\n+++\n\nReply.\n'
    parsed = parse_thread(text, slug='a')
    assert serialize_thread(parsed.thread, parsed.frontmatter) == text


def test_serialize_parse_round_trip_from_object():
    t = DocThread(
        messages=[DocMessage(content='OP.'), DocMessage(content='R.', author='x')],
        slug='a',
    )
    assert parse_thread(serialize_thread(t), slug='a').thread == t
