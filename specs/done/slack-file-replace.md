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

## Follow-up run (scenario 3, 2026-11-20)

disky ran `tmp/slack_file_experiment.py 3` for the two behaviors the helpers rely on:
- An edit of text and blocks **without** `file_ids` keeps the attached file.
- `file_ids: []` detaches it. The file itself survives (`files.info` ok) until `files.delete`.

## What landed (TS, `ts`)

- `upload(name, data, opts)` → file id (`src/slack.ts`). It's unshared unless `opts.channel` (`initialComment`, `threadTs`) is given. `opts.processed` polls `files.info` until `mimetype` is set (default every 1 s for up to 30 s) and throws a `timeout` `SlackApiError` past that. The upload POST uses the client's `fetch` and `timeoutMs`; errors name the method `upload_url`.
- `Msg.files: string[]` goes out as `chat.update` `file_ids`. Omitted leaves the files alone; `[]` detaches. Files count toward `msgHash` and make a message rich.
- `post` with files: `chat.postMessage` takes no `file_ids`, so it posts stamped *without* the files, then `edit`s them on. If that edit fails it throws `FilesNotAttachedError` (`ts`, `cause`). It isn't a `SlackApiError`, so `syncSlots` keeps `pending`.
- `syncSlots` adoption now records the hash stamped on the live message rather than the pending one. Without that, a post whose attach failed would be adopted as up to date and never get its files.
- `deleteFile(id)` tolerates `file_not_found` / `file_deleted`; `fileInfo(id)`.
- `/testing`:
  - `fakeSlack` decodes form-encoded bodies, and treats a request to any non-`/api/` path as method `upload_url` (with `bytes`).
  - `fakeChannel` handles the upload flow, sharing (a file message), `files.info` (`processedAfter` reads before `mimetype` is set), `files.delete`, and `chat.update` `file_ids`. It returns `files`.
- README: a "Files" section with the results above.
- Tests: `tests/files.test.ts`.

Not covered: what Slack shows when a file that's still attached gets deleted (the fake leaves the message's file entry alone).

## Python parity

Landed on `py` in `ab8c97b`:
- `upload(name, data, *, channel, initial_comment, thread_ts, title, alt_text, processed)` and `file_info`.
- `edit(..., files=)` sends `file_ids` (`None` leaves the files alone, `[]` detaches).
- `delete_file` tolerates `file_not_found` / `file_deleted`.
- `SlackApiError(RuntimeError)` carries `.code`.
- `_upload_file`, which backs the lazy `slack_file` image blocks, now waits for processing, which fixes the `invalid_blocks` race above.
- `post(files=)` isn't there yet; it waits on the rendering question below.

## Open: inline image vs. file icon

On Ryan's Android, scenario 3's file rendered as a generic file icon with Download. That was a blocks post with the file attached by edit, before processing finished. Scenario 1's file rendered inline: that message was created by `files.completeUploadExternal` into the channel, then swapped by `file_ids`. disky posted three variants for Ryan to check:
- (a) a blocks post, then a processed file;
- (b) a text-only post, then a processed file;
- (c) a message created by the upload (with blocks), then swapped.

If only (c) renders inline, `post` with files should create the message through `completeUploadExternal`, which takes bytes rather than ids. Either way, attaching by edit should probably wait for processing. TS `post` with files (post, then attach by edit) stays as it is until the answer comes back.

## Leftovers in the test DM

Files from the runs: A (deleted), B, C and D (two of each: the first scenario-2 run failed), E (deleted) and F. Delete them when convenient, or leave them; they're small solid-colour PNGs.
