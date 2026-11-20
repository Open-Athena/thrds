# Several live attached images per message: `upsertFiles` (plan; from disky)

**Status: done** (TS `82396e9`, Python `py` `c0bccc5`). Ryan said "resume/continue" (2026-11-20) and sent phone screenshots of experiments 6–7 (see "Layout" below).

## Why

Some messages carry several live images: the fleet card's 4 panels, or a digest OP's plot and treemap. Attached as separate files, each keeps phone Download, instead of one mosaic image. Experiment 5 showed `chat.update` `file_ids` is a full, ordered replacement list (`[P]` → `[P, Q]` → `[Q]` read back exactly), so the toolkit's single-file swap ([`editable-images`](editable-images.md)) generalizes.

## API

TS:
```ts
upsertFiles(client, store, key, msg, files: Array<{ name: string; data: UploadData } & UploadOptions>, options?: UpsertOptions & { concurrency?: number })
  → UpsertResult & { fileIds: string[]; uploaded: string[]; deleted: string[]; undeleted: Array<{ id; error }> }
slack.replaceFiles(ts, files, msg, { previous?: Array<{ id: string; hash?: string }> }) → same swap fields
```
`upsertFile` / `replaceFile` stay as one-entry wrappers.

Python (no slots store): `replace_files(ts, files: Sequence[tuple[str, bytes | str]], content, *, previous=None, …) -> FilesSwap`.

## Algorithm

1. **Hash each desired file** (`hash53Bytes`) in the given order: `h[0..n)`.
2. **Find the previous attachments**, as ordered `(id, hash)` pairs:
   - `upsertFiles` reads them from the slot record: `files` plus a new parallel `fileHashes`.
   - `replaceFiles` / `replace_files` read them from the live message: its `files` plus the metadata's `thrds_files` hash list (history reads include metadata). That gives Python dedupe without a store.
   - A record or message without hashes (written by `upsertFile` at `bc10600`, or by hand) counts as unknown, so everything is uploaded once.
3. **Reuse by hash, not position:** each desired file takes a previous id with the same hash, each previous id used once. Reordering or inserting panels then uploads nothing that's already there, and the desired order is kept.
4. **Upload the rest.**
   - Sequential by default, or with `concurrency`. Each waits for processing, so the attach renders inline.
   - If an upload fails partway, the uploads already made in this run are deleted (they're certainly unattached), then the error is thrown.
5. **Write once:**
   - `upsert` with `files: ids` (in desired order) and `metadata.event_payload.thrds_files: h`. That replaces the single-file `thrds_file`, which `upsertFile` will also switch to.
   - `syncSlots` records `fileHashes` from that metadata when its length matches `files`.
   - When no hash and no message field changed, the upsert hash matches and it SKIPs, with no uploads.
6. **After the write succeeds,** delete each previous id not in the new list. Already gone is fine; other failures go in `undeleted`.
7. **If the write fails:**
   - When Slack definitely refused it (`definitelyNotAttached`), delete this run's new uploads. Reused ids are never touched.
   - Otherwise keep them.
   - Either way, throw `FileSwapError`, widened to carry `fileIds: string[]` (this run's uploads) and `deleted`.

## Findings

- **Experiment 7, how many files:** `chat.update` with 11 `file_ids` returned ok with no warning and read back all 11 in order. The API doesn't stop at the UI's 10, so there's no guard; a higher limit is untested.
- **Layout (Ryan's iPhone, experiments 6–7):**
  - Several attached files show under an "N attachments" line as one horizontal row you swipe through, in list order.
  - Wide images are about 60% of the screen wide (one plus the edge of the next); 11 square tiles show about 2.5 at a time.
  - It isn't a grid, and there's no "show more". A 4-panel card reads as a swipeable strip, not a 2×2 mosaic.
- **Per-file titles:** `title` / `altText` come through `UploadOptions` per entry. Whether the phone shows them is unknown (the screenshots show none).
- **`concurrency`:** default 1, measured nothing yet.

## What landed (TS)

- **`swapFiles(client, previous: AttachedFile[], desired: { hash, upload }[], write, { concurrency })`** implements the algorithm above.
  - It returns `{ fileIds, uploaded, deleted, undeleted, result }`.
  - A write that fails with nothing newly uploaded rethrows as-is.
  - `swapFile` is gone (forget BC: it was unpublished and unadopted).
- **`FileSwapError`** carries `fileIds`, with `fileId` as a getter for the first one.
- **Helpers:**
  - `FILE_HASHES` = `thrds_files` replaces the single-file `FILE_HASH`.
  - `attachedFiles(message)` returns ids plus hashes when the metadata lines up.
  - `withFiles(msg, ids, hashes)`.
- **`slack.replaceFiles(ts, files, msg, { previous?, concurrency? })`** is the stateless form. `replaceFile` is its one-file wrapper, and now dedupes as well.
- **`upsertFiles(client, store, key, msg, files, options & { concurrency })`** is the stored-state form. `upsertFile` is its one-file wrapper.
- **`SlotRecord.fileHashes`** is recorded from the sent message's `thrds_files` when its length matches `files`. An edit without `files` keeps both.
- **Tests:** `tests/files.test.ts`, with a `replaceFile(s)` block and an `upsertFile(s)` block, covering every planned case except the >10 refusal, which was dropped.

## Tests (as planned; all landed in TS except the >10 refusal)

- First run uploads all and posts; an identical rerun SKIPs with no uploads.
- One panel's bytes change: one upload, an EDIT with the order kept, one delete.
- Panels reordered: no uploads, and an EDIT with the new order.
- A panel removed: an EDIT, and its file deleted.
- The 3rd of 4 uploads fails: uploads 1–2 deleted, nothing written.
- The write is refused vs. times out: new uploads deleted vs. kept, and reused ones untouched either way.
- A record from `upsertFile` without `fileHashes` uploads everything once, then dedupes.
- Python: `replace_files` dedupes from the live message's `thrds_files` metadata.

## What landed (Python, `py` `c0bccc5`)

- `replace_files(ts, files: Sequence[FileSpec | (name, data)], content, *, raw, metadata, previous)` returns `FilesSwap(file_ids, uploaded, deleted, undeleted)`, with a `.file_id` property. `replace_file` is its one-file form, and `FileSwap` is gone.
- `attached_files(ts)` reads `(id, hash | None)` pairs from the message (`include_all_metadata`).
- `hash53_bytes` matches TS `hash53Bytes` bit for bit (a test pins TS reference values), so `thrds_files` written by either side dedupes in the other. It's pure Python, so expect ~1 s per few MB.
- `FileSwapError(file_ids, deleted)` has a `.file_id` property.
- README: `replace_files`, and the swipe-row layout.
