# Slack: swap a message's attached file in place (from disky)

disky's fleet bot posts one Slack message and `chat.update`s it hourly. Its card is a Block Kit `image` block (`image_url` = a signed PNG URL). On Slack's phone apps that image offers no Download. Ryan asked whether an uploaded file can replace it while the message stays edited in place. Root disky ran the test on 2026-11-20 (your `tmp/slack_file_experiment.py`, plus two follow-ups). The Disky Admin Bot (`files:write`, `files:read`, `im:history`) posted into its DM with Ryan, `D0CFNTSEJTY`.

## Results

Every case below kept the message where it was: same `ts`, marked `(edited)`, nothing re-posted and no new notification.

| # | How | API | Android: Download / Save |
|---|---|---|---|
| 1 | Attached file. Upload A shared into the channel (a file message), upload B unshared, then `chat.update` with `file_ids: [B]`. | B replaced A. `files.delete` of A afterwards left B showing. | **Yes** |
| 2 | Image block on an uploaded, unshared file (`slack_file: {id}`), edited from C to D. | Works, but only once the upload has been processed. `files.info` `mimetype` must be `image/png`; it is `""` right after `completeUploadExternal`. Before that, `chat.postMessage` fails with `invalid_blocks` (`invalid slack file`). The update warns `ignored_extra_attributes_for_image_block`. | No |
| 2b | The same block by URL (`slack_file: {url: url_private}`). | Works. | No |
| 3 | A plain `chat.postMessage` with `section` + `context` blocks (the fleet post's shape), then `chat.update` with the same blocks plus `file_ids: [E]`, then again with `file_ids: [F]`, then `files.delete` E. | The file attached below the blocks, which stayed. F replaced E. Deleting E left F. | (the same as 1: an attached file) |

So the only way to give phone users Download on an edited-in-place message is an attached file swapped by `chat.update` `file_ids`. An image block, even one pointing at a Slack-hosted file, doesn't offer it.

## Asked of thrds (TS toolkit first, Python parity after)

1. **`upload(name, bytes, opts?)` → file id.** This is `files.getUploadURLExternal`, the POST to `upload_url`, then `files.completeUploadExternal`. It's unshared by default (no `channel_id`); `opts.channel` / `opts.initialComment` share it. Optionally, `opts.processed: true` polls `files.info` until `mimetype` is set (bounded; an error on timeout), for callers that reference the file from a block.
2. **`edit(ts, m)` passes `file_ids`.** It comes from a `MsgLike` field (e.g. `files: string[]`). Omitting it leaves the message's files as they were. Test whether Slack treats an empty array as "remove the attachment" before documenting it, and say whatever it does.
3. **`deleteFile(id)`** (`files.delete`), tolerating `file_not_found`, so a caller can drop the file it replaced.
4. Document the results above in the toolkit's Slack notes: which way gives Download, and the processing wait for `slack_file`.

disky's fleet post (`fleet/functions/_lib/slack.ts`, a Worker) calls the Web API directly today. If Ryan approves switching the card to an attached file, it will do upload, edit with `file_ids`, then delete the previous file each hour. It can move onto these helpers once they're published.

## Leftovers in the test DM

Files from the runs: A (deleted), B, C and D (two of each: the first scenario-2 run failed), E (deleted) and F. Delete them when convenient, or leave them; they're small solid-colour PNGs.
