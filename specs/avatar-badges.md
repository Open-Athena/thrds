# Badged sender avatars: `@open-athena/thrds/avatar`

## Why

Several of Ryan's Slack bots post on a person's behalf: disky's staged-deletion posts (Open-Athena/disky #7, merged 2026-11-17), the OA weekly-update bot's thread echoes (Open-Athena/oa-internal-coordination, `specs/echo-as-author.md`), and probably others (Watchy, emoji-bot, applitrack, OA auth activity posts). The pattern each time:

- Post with a per-message `username` (the person) and `icon_url`.
- The icon is the person's photo with a small badge in the lower-right corner. The badge marks the post as automated and, optionally, says what happened (staged / finished / failed …) by color and glyph.

disky #7 built the drawing part as a self-contained SVG builder (`site/functions/_lib/badgedAvatar.ts`, `badgedSvg`). Its core is about 40 lines, too small for its own repo. `@open-athena/thrds` is already the OA-namespaced "how bots post to Slack" package, and its `SlackClient` already takes `username` / `iconEmoji`. So it lands here as a dependency-free subpath export.

## What to add

### 1. `src/avatar.ts`, exported as `@open-athena/thrds/avatar`

Port `badgedSvg` from disky (`git -C ~/c/disky show o/gcs:site/functions/_lib/badgedAvatar.ts`), generalized:

```ts
export interface Badge {
  color: string          // fold / ring / chip fill
  glyph?: string         // 24-unit SVG path, drawn white
  fill?: boolean         // glyph is filled, not stroked
  image?: string         // instead of a glyph: a data: URI drawn in the badge area (e.g. a bot's own logo)
}
export type BadgeStyle = 'fold' | 'ring'
export function badgedSvg(face: string, badge: Badge, opts?: { style?: BadgeStyle; px?: number }): string
export const GLYPHS: Record<'bin' | 'flask' | 'bolt' | 'hourglass' | 'check' | 'x' | 'undo' | 'robot', string>
```

- `face`: a raster data URI (PNG/JPEG). The output SVG is self-contained (no fonts, no external refs), so any rasterizer draws it.
- `fold` (disky's choice): a folded-down lower-right corner in `color`, with the glyph on it. `ring`: the face framed in `color`, with the glyph on a corner chip.
- Stock glyphs: the paths from disky's `BADGES` (bin, flask, bolt, check, x, undo), plus hourglass (it was in the artifact mock-up, not in #7) and a simple robot or gear for the generic "automated" badge.
- Action→badge mappings (disky's `badgeOf`) stay in each app.

**No runtime dependencies and no rasterizer.** disky renders with vendored resvg-wasm on Workers; the weekly bot would use `sharp` in Node. Document both in the README as short snippets:
- `sharp(Buffer.from(svg)).png()`
- `new Resvg(svg).render().asPng()`

Also not in scope: fetching or decoding the face, publishing the PNG, the URL scheme, and caching. Each app hosts images differently: disky uses D1 `/a/<sha256>.png`, the weekly bot its own Cloud Run route.

One small helper is worth including: `avatarKey(faceUrl, badge, style)`, a stable short hash for content-addressed URLs and caches. It busts the cache when the person's photo URL changes.

### 2. `SlackClient`: `iconUrl`

Add `iconUrl?: string` next to `iconEmoji` (`icon_url` in the payload; if both are set, `iconUrl` wins). It's also needed per post, because a sync posts messages from different people. The simplest version: an optional per-`Message` `{ username?, iconUrl? }` override on top of the client defaults.

Document in the README:
- The scope needed (`chat:write.customize`).
- Slack ignores `username` / `icon_url` on `chat.update`, so an edited message keeps the sender it was first posted with.

### 3. Packaging

- `package.json` `exports`: add `"./avatar"` (types + import), and add the entry to `tsup.config.ts`.
- Tests:
  - `badgedSvg` output for each style: exact string, or golden files.
  - Glyph and image badges.
  - The `icon_url` payload in a `SlackClient` post: exact payload equality, using the existing fake.
- Tidy the stale README while there: it still says "Not yet published to npm" and shows `pnpm add @rdub/thrds`. The package has been published as `@open-athena/thrds` 0.1.2.

## Consumers, after release

- **disky** (`site/functions/_lib/badgedAvatar.ts`): import `badgedSvg` and the glyphs from `@open-athena/thrds/avatar`, and keep its `BADGES` colors, `badgeOf`, resvg rendering and D1 publishing. The output should be byte-identical, so its existing golden test proves the swap.
- **oa-internal-coordination**: see its `specs/echo-as-author.md`.
- **ctbk** `gbfs/api` already uses thrds TS, but under the old name `@rdub/thrds` from `runsascoded/thrds#ts-dist`. Repoint it at `@open-athena/thrds` when convenient (not part of this spec).
