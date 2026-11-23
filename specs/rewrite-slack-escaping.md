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
