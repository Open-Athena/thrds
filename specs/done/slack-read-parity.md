# Python `SlackClient`: metadata writes and paginated reads (TS parity)

## Why

The TS toolkit (`ts` branch, [`slack-toolkit-reuse`][toolkit]) posts and edits with Slack message metadata, and its history/thread reads paginate, ask for `include_all_metadata`, and can descend into threads. Python `SlackClient` had none of that, so consumers reached for its private `_request`: watchy's `post_event`, `fetch_posted` and `retag` (`src/watchy/slack.py:185-227`, `cli/slack.py:124-131`). watchy's migration spec lists this as gap G14. watchy's CLI also misses every thread reply because history reads are top-level only (its gap 9).

## What landed

- `post(..., metadata=)` / `edit(..., metadata=)`: sent as Slack `metadata`. An explicit argument wins over the per-content map `sync` sets.
- `_paginate(endpoint, params)`: follows `response_metadata.next_cursor`, sending `limit` (page size, `HISTORY_PAGE_SIZE` = 200) and `include_all_metadata: true` on every page.
- `iter_channel_history(channel=None, *, oldest, latest, include_replies, page_size)`: a lazy generator, newest first. With `include_replies`, each threaded message is followed by its replies (oldest first, parent excluded), like TS `messages({includeReplies})`.
- `list_channel_history(channel, limit=20, *, oldest, latest, include_replies)`: now paginates. `limit=None` reads everything, replies count toward `limit`, and paging stops once `limit` is reached.
- `iter_thread_raw` / `list_thread_raw` and the typed `list_messages` paginate `conversations.replies`, so a thread longer than one page comes back whole.
- `find_by_metadata(event_type, match=..., *, channel, thread_ts, oldest, include_replies)`: the first raw message with that `event_type` whose payload satisfies `match`, like TS `findByMetadata`.
- CLI: `thrds slack history -n 0` reads all of history; `-r/--replies` includes thread replies.

Tests: `tests/test_slack_reads.py`, plus updated `tests/test_slack_cli.py`.

## For watchy

- `post_event` → `client.post(m.content, raw=True, metadata=event_metadata(m))`. Pass `channel` by constructing the client for it; it posts to `client.channel`.
- `fetch_posted` → `client.iter_channel_history(channel, include_replies=True)`, keeping the bot-id and `event_type` filters. That also fixes the CLI not seeing thread replies.
- `retag`'s `chat.update` → `client.edit(p.ts, new, raw=True, metadata=...)`.

## Not done

`scan_thrds_metadata` keeps its own loop: it needs `max_pages` and a resumable cursor, which the generator doesn't expose. The transport itself (429-only retries over `urllib`) is unchanged; that's the separate transport-factoring audit (`specs/transport-factoring-audit.md`, from the mgu session).

[toolkit]: https://github.com/Open-Athena/thrds/blob/ts/specs/done/slack-toolkit-reuse.md
