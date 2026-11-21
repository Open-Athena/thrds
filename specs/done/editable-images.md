# Editable images: attached files and image blocks, first-class (from disky)

## Ask

Ryan (via disky, 2026-11-20): "make sure thrds has a robust impl of both 'editable img' types (it should doc them too)". disky's fleet post then moves to the attached-PNG kind. Follows [`slack-file-replace.md`](slack-file-replace.md).

1. **Attached file** (Download on phones; inline below the message's blocks):
   - Upload unshared, wait for processing, attach by `post` / `edit` `files`, then delete the replaced file only once the edit has succeeded.
   - No orphans: a failed attach deletes its upload or reports its id, and a previous file that's already gone is fine.
   - The processing wait is bounded, with a clear error.
   - Measure and document processing time. Check whether `file_change` could replace polling.
   - Retries follow the toolkit's policy.
2. **Image block**, edited in place: `image_url` (Slack caches by URL, so each version needs a new URL) or `slack_file` `{id|url}` (the file must be processed; it can be unshared). Neither offers Download on phones.
3. **Docs**:
   - which kind to choose;
   - what viewers see;
   - the processing race;
   - `file_ids` omitted vs. `[]`;
   - where the image sits.

   Plus a one-call helper for the hourly pattern.

## Measurements (disky, Disky Admin Bot, `tmp/slack_file_timing.py`)

Time until `files.info` reports a `mimetype`, five uploads per size, unshared and deleted after:

| PNG | Bytes | min | median | max |
|---|---|---|---|---|
| 64 px | 12 KB | 0.44 s | 0.50 s | 0.64 s |
| 256 px | 197 KB | 0.52 s | 0.63 s | 0.81 s |
| 1024 px (noisy) | 3.1 MB | 4.58 s | 4.61 s | 4.75 s |

Other findings from those runs:
- **The POST to `upload_url` once returned HTTP 504** on the first file; the rerun was clean.
- **`mimetype` can appear before the thumbnails.** disky's inline test waited for `mimetype` and `thumb_360`, and those messages rendered inline from the first view.
- **Events:** the Disky Admin Bot has no Events API subscription (no `event_subscriptions`, socket mode off), so whether `file_change` fires on processing is unverified.
- **Slack's own docs** (`files.getUploadURLExternal`) say there's "no need to wait" for processing, which the `invalid_blocks` failures and file-icon renders contradict.

## Experiment 5: multiple files (disky)

Starting from a text-only message, three `chat.update`s with the same text: `file_ids` `[P]` → `[P, Q]` → `[Q]`. Each was ok and read back exactly that list, in that order. So `Msg.files` is a full replacement list. Every update set a new `edited.ts`, even when only the files changed. The `(edited)` badge shows after a plain-text / `rich_text` body, not under section blocks. Untested: the maximum files per message (Slack's UI allows 10).

## Experiment 4: sender overrides (disky, gcs; 2026-11-20)

cw's digest OP was edited by `replace_files`, and Slack returned ok, but the message showed no files. That OP was posted with `username=` (subtype `bot_message`) and had 21 thread replies. Experiment 5 had passed only because it started from a plain app message. disky ran `tmp/slack_file_experiment.py <dm> 4` (log: disky `tmp/slack-exp4.txt`):

| Case | `chat.update` | `files.info` shares | history / replies `files` |
|---|---|---|---|
| control (plain post) | ok | the ts | the file |
| i: `username` | ok | the ts | none |
| ii: no `username`, a thread reply | ok | the ts | the file |
| iii: `username` and a reply | ok | the ts | none |
| iv: `chat.postMessage` with `username` and `file_ids` | ok | none | none |
| v: `username` post; the file shared into its thread (`completeUploadExternal` `thread_ts`) | ok | none | parent none; replies `[]` even after 30 s, and the same for vi, the plain-post control. Inconclusive: the script completed the upload a second time, which is a no-op (fixed; not rerun) |

gcs's raw-API repro in #gcs-admin found that `icon_emoji` alone (no `username`) also makes a `bot_message`, and its files are dropped the same way. `chat.update`'s response already shows `message.files: []`.

So any sender override (`username`, `icon_emoji`, `icon_url`) plus files is unsupported, and thread replies don't matter. thrds now raises `CustomSenderFilesError`:
- **Up front, before uploading or writing**, when it knows of an override:
  - `post` / `edit` with files and an override on the msg or the client;
  - `replaceFiles` on a message read back as `bot_message`;
  - `upsertFiles` with an override.
- **After the write**, when only `chat.update`'s response reveals it: the echoed `message` is a `bot_message`, or its `files` lack the new ids. `definitelyNotAttached` counts this error as not attached, so the swap helpers delete this run's uploads.

**Layout for a custom-named OP (disky):** keep the OP's override, and put the files on a plain reply in its thread. A client without overrides posts that reply once, then keeps it current with `replaceFiles`. Experiment `4 vii` (disky, `tmp/slack-exp4-vii.txt`) confirmed it:
- A `username` OP got a plain reply, then `chat.update` `file_ids` on the reply. The update was ok, and its echo, the thread's replies and `files.info` shares all show the file on the reply.
- `conversations.replies` with the reply's ts returns the reply itself, both at `limit: 1` and bounded by `oldest` / `latest`. So `replaceFiles`' read-back (`message(ts)` / `attached_files`) works on a reply, and `previous` isn't needed.
- disky's fleet card has done this live (4 files on a thread reply, swapped hourly) since 2026-11-20.

Documented in the README.

## What landed (TS, `ts`)

- **Processing wait** (`upload`, on by default):
  - "Processed" is `isProcessed`: a `mimetype`, plus a `thumb_<n>` for `image/*`.
  - It polls every 0.5 s for up to 30 s, bounded by poll count as well as time (so a fake `sleep` can't spin).
  - Past the limit it throws `FileNotProcessedError` (`fileId`, `waitedMs`, `deleted`), deleting the file when it's unshared.
- **Upload POST retries**: on a 429 (`Retry-After`), 5xx, timeout or dropped connection, up to `retries`, exponential from 1 s, honoring `maxRetryWaitMs`, and reported through `onRetry` (`method: "upload_url"`, new reason `transport`). A 4xx isn't retried.
- **`swapFile(client, previous, upload, write)`**:
  - It uploads, writes, then deletes the `previous` files other than the new one. Already-gone ones are fine; other delete failures come back in `undeleted`.
  - A failed write throws `FileSwapError` (`fileId`, `deleted`). The upload is deleted only when `definitelyNotAttached(e)`: a definite `SlackApiError`, or a `FilesNotAttachedError` whose cause was definite.
- **`client.replaceFile(ts, file, msg, { previous? })`**: the stateless swap. It reads previous files from the message when `previous` isn't given.
- **`upsertFile(client, store, key, msg, file, options)`**: the stored-state swap.
  - `SlotRecord.files` now records attached file ids (from `Msg.files`; an edit without `files` keeps the recorded ones).
  - The file's content hash is stamped into the metadata (`FILE_HASH` = `thrds_file`), so an unchanged message + bytes pair skips without uploading.
  - With `create: false` and no record, it does nothing (`fileId: null`).
- **Image blocks**: `image({ slackFileUrl })` (`slack_file: {url}`), and `versionedUrl(url, version, param = "v")` for cache-busting.
- **`fakeChannel`** gives processed images a `thumb_64`.
- **README**: "Editable images", a comparison table, the hourly helper, the no-orphans rules, the measurements, and what viewers see.
- **Tests**: `tests/files.test.ts`.

## Python parity (`py`)

- `isProcessed` with thumbnails, the 0.5 s poll and `FileNotProcessedError`, plus upload-POST retries.
- `replace_file(ts, name, data, content, …)` and `FileSwapError`.
- A README section.

There's no slots store in Python, so the stateless `replace_file` is the hourly helper there. Landed in `py` `343c24e`.
