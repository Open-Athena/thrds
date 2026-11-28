# Slack: a block message's `text` fallback stays within 4,000 chars

From the disky cw session, 2026-11-28. Urgent-ish: cw's monthly digest OP has failed to update since 11-28 05:53Z.

## The bug

`ac9d235` ("the 4000-char cap applies to a text-only message; one with image blocks is bounded by its sections and 50 blocks") lifted the 4,000-char check for messages with image blocks, but `post`/`edit` still send the whole converted body as the top-level `text` beside the blocks. Slack rejects that: `chat.update` (and `chat.postMessage`) answer `msg_too_long` ("The `text` field cannot exceed 4,000 characters", docs.slack.dev `chat.update` errors) whatever the blocks.

Evidence: cw's digest OP (sections + one image block) edited fine at a 3.7k-char wire `text` (11-27 20:10Z), then failed twice with `thrds.slack.SlackApiError: Slack API error: msg_too_long` once its wire `text` reached 4,022 chars (each pool line gained a link). Its sections are each under 3,000.

## The fix

When a message renders from blocks (image blocks lifted, so its body is `section` blocks), the top-level `text` is only the notification / accessibility fallback: send it capped at `SLACK_MESSAGE_LIMIT` (4,000), cut at a line boundary with a trailing `…` (a line over the cap: cut within it). The blocks keep the whole body. Same in `post` and `edit` (and anywhere else `text` goes out beside `blocks`, e.g. the rewrite / converge paths). A text-only message keeps today's behavior (raise past 4,000).

`_finalized_content` / equality checks that compare the live message's text to the wire text should compare against what was sent (the capped fallback), or against the blocks, so a capped message doesn't look perpetually changed.

## Tests

- `edit` and `post` with an image line and a >4,000-char body: the request's `text` is ≤ 4,000 and ends in `…`; its section blocks hold the whole body (joined, they equal the uncapped wire text).
- A body at ≤ 4,000: `text` is the full wire, unchanged.
- A text-only body over 4,000 still raises.

## Then

Tell the disky cw session the sha (on `py`); it bumps disky's pin (`cloud/pyproject.toml`'s `thrds @ …/archive/<sha>.tar.gz`, and the lock), rebuilds cw's image and re-runs the digest. If the TS branch sends `text` beside blocks the same way, it needs the same cap.

## Implemented

`fallback_text(wire)` (`thrds/slack.py`): `wire` when it's within 4,000; else cut at the last line break that leaves room for `\n…`, or within a single over-long line (`wire[:3999] + '…'`). `_lift_image_blocks` applies it where it builds `[*section_blocks(text), *images]`, which is the only shape that can exceed 4,000, so `post` and `edit` both get it. The other block shapes already stay within the limit: finalized chrome puts a body of at most 3,000 chars in one section, and draft chrome folds its footer in only when the result fits within 4,000.

Read-back is unaffected: `_message_markdown` reads a message with section blocks from the blocks, never the flat `text`, so a capped message doesn't look changed.

Tests in `tests/test_image_blocks.py`, written first; post and edit failed with the full 4,260-char `text`:
- `fallback_text` cuts at a line, keeps an exact-limit wire whole, and cuts a single over-long line within it.
- `post` and `edit` with an image send a capped `text`, while their sections hold the whole body, which reads back as posted.
- A body within the limit sends the whole wire.
- A text-only body over the limit still raises.

The bulk rewrite path (`thrds.rewrite`) doesn't use this yet. A `Desired` with blocks and text over 4,000 plans as `blocked`, so it can't hit `msg_too_long`. Capping there too means comparing a live, capped fallback to the desired text, which touches `same_content` and its TS parity, so it's a follow-up.
