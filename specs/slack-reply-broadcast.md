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
