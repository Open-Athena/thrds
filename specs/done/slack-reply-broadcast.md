# Slack: `broadcast` on thread replies (`reply_broadcast`)

From disky's cw deployment (2026-10-29). Its monthly usage digest posts one Slack thread per month, a reply per day. When a storage zone nears its quota, the digest should put a short alert reply in the channel as well as the thread (Slack's "Also send to channel"), so people watching the channel see it without opening the thread. RNO2A filled its 100 TiB quota on 2026-10-29 and CoreWeave suspended writes, while the warning sat only inside the thread.

## Ask

`SlackClient.post` takes a keyword `broadcast: bool = False`:

- `post(content, thread_id=…, broadcast=True)` sends `reply_broadcast: true` on `chat.postMessage`.
- `broadcast=True` without a `thread_id` raises `ValueError`. Slack ignores the flag on a top-level message, so passing it there is a caller bug.
- `False` (the default) sends nothing extra: today's wire payload, byte for byte.

`edit` is unchanged. As far as we know, Slack can't un-broadcast a reply, so the consumer never edits the flag. To retract an alert, it deletes the reply (`delete`, which already exists), which removes both the channel copy and the thread copy.

Other transports (`DiscordClient`, the fakes) should accept the keyword too. They can ignore it, or raise if `True`, whichever matches the existing pattern for platform-specific options.

## Tests

Wire-payload tests in the existing style:

- the exact `data` dict for `post` with and without `broadcast`;
- `broadcast=True` with no `thread_id` raises `ValueError`.

## Consumer

disky's `cloud/src/dt_cloud/digest.py` `converge_slack` posts one broadcast "alert" reply while any zone is at or above the digest config's alert threshold (cw: 90%). It edits the reply in place as the numbers change and deletes it once every zone is back below the threshold. The daily replies are never broadcast; they mark over-threshold zones with ⚠️. disky pins thrds from the lock and bumps it after this lands.

## Implemented (2026-11-02)

- `SlackClient.post` gains `broadcast: bool = False` (`thrds/slack.py`). When `True` it sets `reply_broadcast: true` on the `chat.postMessage` payload, beside `thread_ts`. `broadcast=True` with `thread_id=None` raises `ValueError` before any wire call. `False` sends today's payload unchanged. `edit` is untouched (Slack can't un-broadcast; retract by `delete`, which removes both copies).
- `broadcast` is a platform-specific option, so it follows the established sender/`images` pattern: it's in the `ThreadClient` protocol (`thrds/protocol.py`), and every non-Slack transport **raises** `NotImplementedError` on `broadcast=True` before touching the wire — `DiscordClient` / `DiscordWebhookClient` / `DiscordHybridClient` (`thrds/discord.py`, three `post`s; the hybrid guards explicitly since its `via_webhook=False` fast paths don't forward kwargs), `BskyClient` (`thrds/bsky.py`), `MastodonClient` (`thrds/mastodon.py`). Message: ``"<Platform> has no `reply_broadcast` analogue (`broadcast=` is Slack-specific)."``
- Tests: `tests/test_reply_broadcast.py` — exact wire-payload dicts for `post` with/without `broadcast` (and a bare top-level post), the `ValueError` without `thread_id`, and the `NotImplementedError` from each non-Slack transport (Bluesky behind `importorskip("atproto")`, as the base/CI env lacks the `bsky` extra).
- Fakes: the test fakes already accepting `**kw` (`test_promote_cli`, `test_promote_foreign_thread`, `test_adopt_cli`) swallow the new kwarg; `sync()` never passes `broadcast` (it's a one-shot delivery concern, not reconciled desired state), so the explicit-signature Slack fakes needed no change.
