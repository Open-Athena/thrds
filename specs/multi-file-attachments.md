# Several live attached images per message: `upsertFiles` (plan; from disky)

**Status: planned, not built.** It waits on Ryan's call on the layout: experiment 6, with 2 and 4 wide images on one message, in `D0CFNTSEJTY` (p1795139938050409, p1795139943305019). disky will say when.

## Why

Some messages carry several live images: the fleet card's 4 panels, or a digest OP's plot and treemap. Attached as separate files, each keeps phone Download, instead of one mosaic image. Experiment 5 showed `chat.update` `file_ids` is a full, ordered replacement list (`[P]` → `[P, Q]` → `[Q]` read back exactly), so the toolkit's single-file swap ([`editable-images`](done/editable-images.md)) generalizes.

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

## Limits and open questions

- **Maximum files per message:** untested. Slack's UI allows 10. Until disky checks what `chat.update` does past that, refuse more than 10 with a clear error, not a Slack one.
- **Layout:** files render in list order. How Slack lays out 2, 3 and 4 wide images (a grid or a stack, and whether there's "show more" past some count) is what experiment 6 is for. Record Ryan's verdict here.
- **Per-file titles:** `title` / `altText` per entry come through `UploadOptions`. Whether the phone app shows titles under multiple images is unknown.
- **Partial readiness:** a 4-panel card at ~0.5–1 s of processing per small PNG takes a few seconds sequentially. `concurrency` exists for that; default to 1 and measure before raising it.

## Tests (planned, `fakeChannel`)

- First run uploads all and posts; an identical rerun SKIPs with no uploads.
- One panel's bytes change: one upload, an EDIT with the order kept, one delete.
- Panels reordered: no uploads, and an EDIT with the new order.
- A panel removed: an EDIT, and its file deleted.
- The 3rd of 4 uploads fails: uploads 1–2 deleted, nothing written.
- The write is refused vs. times out: new uploads deleted vs. kept, and reused ones untouched either way.
- More than 10 files is refused.
- A record from `upsertFile` without `fileHashes` uploads everything once, then dedupes.
- Python: `replace_files` dedupes from the live message's `thrds_files` metadata.
