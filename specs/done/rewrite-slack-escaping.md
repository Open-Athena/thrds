# Bulk rewrite: compare content as Slack stores it (entity escaping, fallback text)

From disky (2026-11-23). r2's first live digest re-apply plan (`/admin/slack` → `dt-cloud digest -n -j`, plan at `gs://oa-r2-usage-data/digest/reapply/quota-digest-20261123-003753z.plan.json`; the r2 session can fetch it) planned **1 edit** for the November OP (ts `1793497003.518319`) whose rendered Now and Planned panels are identical. The diff is encoding only:

- the live message's text has `&amp;` where the desired text has `&` (in the October thread link), and
- the live text is one line where the desired text has real newlines.

## Cause

`same_content` (`thrds/rewrite.py`; `sameContent` in `src/rewrite.ts`) compares `live.text != want.text` byte for byte. Slack stores and returns message text with `&`, `<`, `>` escaped as `&amp;`, `&lt;`, `&gt;` (its control-character rule), while `Desired` carries the text as the app sends it. So any message whose text contains one of those three characters never plans as `noop` or applies as `already`. The digest's texts always contain `&` (query strings in links).

The one-line vs. newlines difference needs a look at the real message: for a message with blocks, the top-level `text` is only the notification / fallback text, and Slack may store it differently from what `edit` sent (or the digest's `edit_desired` may send a different fallback than the original post did).

## Ask

1. `same_content` / `sameContent` compare under Slack's storage form: unescape `&amp;` `&lt;` `&gt;` in the live text and in every mrkdwn / plain_text string of the live blocks (or escape the desired side the same way; pick one and keep the content hash consistent between Python and TS, with parity fixtures).
2. For a message with blocks, decide what counts: the blocks are what renders, so a difference only in the fallback `text`'s whitespace should not by itself make an `edit`. If the fallback text matters for notifications, compare it after normalizing whitespace; say which in the README.
3. `apply`'s `already` check uses the same comparison, so a re-run after a real apply reports `already`, not another edit.
4. A test with the r2 plan's shapes: live text with `&amp;` and a one-line fallback, desired with `&` and newlines, identical blocks → `noop`.

Then a new `py` sha and `ts` dist for disky to pin (cloud `pyproject.toml`, `site/package.json`); send them to the disky root session.

## Implemented

py (`same_content`, `thrds/rewrite.py`) and ts (`sameContent`, `src/rewrite.ts`, dist `0.2.0-dist.6de9bd8`) compare the same way; `tests/fixtures/rewrite-same.json` (ts) is written by py's `scripts/rewrite_ts_fixtures.py` from `SAME_CASES` in `tests/test_rewrite.py`.

- **Escaping:** both sides are unescaped (`&lt;` `&gt;`, then `&amp;`) in the text and in every string in the blocks. An entity the app sends means its character, so live `&amp;lt;` (a literal "&lt;") differs from a sent `&lt;`.
- **Fallback text:** with (non-empty) desired blocks, the text is compared with runs of ASCII whitespace collapsed (ASCII only, so py and ts agree exactly); its words still count. Without blocks the text is what renders and must match exactly (after unescaping).
- **More of Slack's storage form**, found in the r2 plan: the stored section had `verbatim: false`, and the stored image block `image_width` / `image_height` / `image_bytes` / `fallback` / `is_animated`. Ignored: top-level `block_id`, those five fields on an image block, mrkdwn `verbatim: false`, plain_text `emoji: true`.
- **`already`** uses the same comparison, so a re-run after a real apply reports `already`. The content hash (`stale` check) is unchanged: it hashes the live message as read, on both sides, so no plan written before this is invalidated.
- **Test:** `test_compares_content_as_slack_stores_it` (py) and "content as Slack stores it" (ts), with the r2 OP's shapes: `noop`; with a moved image URL, `edit`, then `already` after Slack stores the edit escaped. The fake channel (py) now stores `chat.update`s as Slack does (`&amp;`, `verbatim: false`).

**Still an `edit` for the r2 OP:** its image URL differs between live and desired (deploy host `c5fbca09` vs. `78c8fa4d`, and `?v=`), a real change thrds can't see through. For the OP to plan as `noop`, the digest needs a stable plot URL (the production alias, and a `v` that changes only with the content; it differs between the two renders now).
