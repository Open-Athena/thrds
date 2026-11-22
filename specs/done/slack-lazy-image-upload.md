# Spec: lazy image upload on Slack (`Image(path=…)` → hosted, no public URL)

Closes the URL-first asymmetry from `specs/unified-image-attachments.md`: today a local-`path`-only `Image` uploads on Discord but **raises** on Slack. This lets Slack host the bytes itself so the same `Msg(images=[Image(path=…)])` works on both platforms.

## Good news: `slack_file`, not public URLs

The deferred note feared this needed `files.sharedPublicURL` (a user token + a workspace public-file-sharing setting + a genuinely public URL). It doesn't. Block Kit image blocks take a **`slack_file`** composition object — `{"type": "image", "slack_file": {"id": "F0123"}, "alt_text": "…"}` — that references an uploaded file **by id**, no public URL, on the **bot** token. ([image block](https://docs.slack.dev/reference/block-kit/blocks/image-block/), [slack_file object](https://docs.slack.dev/reference/block-kit/composition-objects/slack-file-object/))

Constraints: png/jpg/jpeg/gif only; the poster (our bot) must have access to the file; `slack_file` takes **either** `id` or `url`, never both.

## Upload flow (bot token, `files:write`)

1. `files.getUploadURLExternal(filename, length)` → `{upload_url, file_id}`.
2. `PUT`/`POST` the bytes to `upload_url`.
3. `files.completeUploadExternal(files=[{id: file_id}])` → finalizes; the file now exists in the workspace, owned by the bot, not yet in any channel (no `channel_id` → not posted anywhere on its own — exactly what we want; the image block does the surfacing).

Then build the block with `slack_file: {id: file_id}`.

## API surface

- `SlackClient` gains an internal `_upload_file(path) -> file_id` (the three calls above, via the existing `_request` + one raw `PUT`).
- `_fold_images_into_content` / `_images_to_refs` stop raising on `path`: a `path` `Image` resolves to a `file_id` and a `slack_file`-backed image block; a `url` `Image` stays the current URL-block path. An `Image` with both prefers… (decision below).
- `imageblock.ImageRef` grows a `file_id` alternative to `url` (mutually exclusive), and `to_block` emits `slack_file` when `file_id` is set. `image_line` / `from_block` (doc round-trip) — see idempotency.

## Reconcile idempotency: content-addressed, re-upload iff the bytes change

Goal (per review): a re-push **re-uploads only when the image bytes actually change** — not every time (naive), and not never (the Discord "text must change" trade). The lever is a **content hash**, mirroring how `{bust}` already works for URLs: a machine token that lives on the wire and is stripped on read-back.

A URL image round-trips through content (`![alt](url)` ⇄ `image_url` ⇄ reconstructed line), so a converge is a no-op. An uploaded image has no stable URL (a fresh `F…` per upload), so we make its **content marker carry the sha256** instead:

- **Desired side**: `Image(path=p)` → thrds hashes the bytes → folds a marker `![alt](slackfile:<sha16>)` into content (the sha is derived from the file, deterministic).
- **Wire**: an image block with `slack_file: {id: F…}` and the sha stamped so read-back can recover it — carried in the block's `alt_text` as a stripped suffix (`"<alt>⁣slackfile:<sha16>"`, using an invisible U+2063 separator so screen readers read only the real alt), exactly analogous to the `?thrds_bust=` URL param that `strip_bust` peels off. No `thrds.yml` state needed — the block is self-describing.
- **Read-back**: `from_block` reads the `slack_file` block, splits the sha out of `alt_text`, and reconstructs the **same** `![alt](slackfile:<sha16>)` marker.
- **Diff**: bytes unchanged → shas equal → marker equal → **SKIP** (no re-upload, no edit). Bytes changed → shas differ → marker differs → **EDIT** → upload the new file, swap the block. First push → no live block → POST → upload. Exactly re-upload-iff-necessary, and **stateless**.

**Upload de-dup within a push**: hash → file_id cached in-memory for the call, so the same image on the OP and a reply uploads once.

**Fallback (only if a host ever strips `alt_text`)**: keep a `sha16 → file_id` map in `thrds.yml`; a cache miss re-uploads and records, so it self-heals after one push. Not needed with the `alt_text` convention; documented as the safety net the review asked for.

## Decisions (resolved)

1. **Reconcile** — content-hash in the marker (above): re-upload iff bytes change, stateless via the `alt_text` sha suffix (state-map fallback documented).
2. **`Image` with both `url` and `path` on Slack** — prefer `url` (no upload; keeps the plain content round-trip). `path` is the fallback for when you have no URL.
3. **Format guard** — raise on a non-png/jpg/gif `path` (Slack rejects others) with a clear message.

## Implemented (2026-09-14)

Stateless content-hash convention (no `thrds.yml` store needed):

- **`imageblock`**: an uploaded image stays **renderable and human-readable** — the marker is `![alt](<path>#thrds_sha=<sha>)`, where the URL is the author's real file path (a Markdown viewer renders it; the `#…` fragment is client-only and stripped before the file is fetched, so it never breaks the request) and `sha` is the first 16 hex of the file's sha256. `slack_file_block(ref, file_id)` builds `{type: image, slack_file: {id}, alt_text: "<alt>⁣<path>#thrds_sha=<sha>"}`; `from_block` keys off the `alt_text` tag (robust to whether Slack hands back `slack_file` or a resolved `image_url`) to rebuild the exact `![alt](path#sha)` line with a clean alt. `upload_marker` / `is_upload_ref` / `upload_path` / `upload_sha` helpers. (The earlier draft used an opaque `slackfile:<sha>` URL that would render broken in a doc — fixed to the path form.)
- **`SlackClient`**: `_fold_images_into_content` hashes a `path` image and folds `![alt](path#sha)` (`\n\n`-joined to match read-back); `_upload_file` runs `getUploadURLExternal` → raw PUT → `completeUploadExternal`; `_upload_cached` de-dups per push (`_uploaded_file_ids`, keyed by sha); `_lift_image_blocks` uploads via `upload_path(ref)` and builds a `slack_file` block for an upload ref, a URL block otherwise. The path rides in the marker itself, so there is no separate staging map. A non-png/jpg/jpeg/gif `path` raises. The de-dup cache resets per `sync`.
- **Idempotency**: bytes unchanged → same sha → marker matches read-back → SKIP (no upload). Bytes changed → new sha → EDIT → upload. Tests in `test_slack_upload.py` (upload flow + block shape + round-trip, per-push de-dup, unchanged re-push is a SKIP with no upload, non-image suffix guard).
- **Gap (accepted)**: a **text-only** edit (image bytes unchanged) still re-uploads, since it re-enters `post`/`edit` and this build is stateless. The `sha → file_id` store (below) is the fix — unneeded for the daily-refresh consumer (text and plot both change), and a caller needing zero redundant uploads can host a `url` + `{bust}` instead.

## Not in scope / deferred

- **`sha → file_id` store in `thrds.yml`** — the optional optimization that would also skip re-upload on a *text-only* edit (see the accepted gap). Deferred; not needed by any current consumer.
- `files.sharedPublicURL` / public files (unneeded thanks to `slack_file`); animated/large-file tiers beyond Slack's defaults.
