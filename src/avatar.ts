/**
 * `@open-athena/thrds/avatar`: sender faces for posts a bot makes on someone's behalf.
 *
 * - `badgedSvg`: the person's photo with a badge in the lower-right corner (a colored corner fold, or a ring plus a
 *   corner chip), marking the post as automated and, optionally, what happened. Self-contained SVG; the caller
 *   rasterizes it (resvg-wasm on Workers, `sharp` in Node) and hosts the PNG.
 * - Identicons and a fixed service icon, as deterministic PNGs with no codec dependency.
 * - Content-addressed hosting: `publishAvatar` stores bytes under their SHA-256 and returns `<origin>/a/<sha>.<ext>`;
 *   `avatarResponse` serves that route. Storage is an `AvatarStore` (memory here, D1 in `/d1`, KV in `/kv`).
 *
 * Ported from disky (`site/functions/_lib/badgedAvatar.ts`, `publicAvatar.ts`); output is byte-identical for the same
 * badge color and glyph.
 */
import { hash53, stableStringify } from "./hash";

/** A badge: a color, and a 24-unit glyph path drawn white (stroked unless `fill`) or a raster `image` (data URI). */
export interface Badge {
  color: string;
  glyph?: string;
  fill?: boolean;
  image?: string;
}

export type BadgeStyle = "fold" | "ring";

/** Stock 24-unit glyph paths. `bin`…`undo` are disky's; `robot` / `gear` / `hourglass` / `chat` are generic. */
export const GLYPHS = {
  bin: "M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13M10.5 11v6M13.5 11v6",
  flask: "M9 3h6M10 3v6.5L5.2 18a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 9.5V3M7.5 15h9",
  bolt: "M13.5 2.5L5.5 13.5h6l-1 8 8-11h-6z",
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M7 7l10 10M17 7L7 17",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  robot: "M12 3v3M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9.5 11v1.5M14.5 11v1.5M9 15.5h6M3 11v3M21 11v3",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  hourglass: "M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9",
  chat: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
} as const;

/** Ready-made badges. Each app maps its own events onto these (or its own `Badge`s). */
export const BADGES = {
  automated: { color: "#475569", glyph: GLYPHS.robot },
  staged: { color: "#d9922b", glyph: GLYPHS.bin },
  dry: { color: "#6b7a90", glyph: GLYPHS.flask },
  running: { color: "#ec6a1f", glyph: GLYPHS.bolt, fill: true },
  succeeded: { color: "#2e9e62", glyph: GLYPHS.check },
  failed: { color: "#d93844", glyph: GLYPHS.x },
  undone: { color: "#8a63e0", glyph: GLYPHS.undo },
  waiting: { color: "#3b82c4", glyph: GLYPHS.hourglass },
  update: { color: "#0f766e", glyph: GLYPHS.chat },
} satisfies Record<string, Badge>;

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The badged face as SVG: `face` (a raster data URI, or any URL the rasterizer can load) on a 100-unit square, drawn
 * at `px`. `fold`: the lower-right corner folded down in the badge's color, the glyph on it. `ring`: the face framed in
 * the badge's color, the glyph on a corner chip.
 */
export function badgedSvg(face: string, badge: Badge, style: BadgeStyle = "fold", px = 256): string {
  const mark = (cx: number, size: number): string => {
    if (badge.image !== undefined) {
      const o = cx - size / 2;
      return `<image href="${escapeAttr(badge.image)}" x="${o}" y="${o}" width="${size}" height="${size}"/>`;
    }
    if (badge.glyph === undefined) return "";
    const paint = badge.fill
      ? 'fill="#fff" stroke="none"'
      : 'fill="none" stroke="#fff" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"';
    return `<g transform="translate(${cx - size / 2} ${cx - size / 2}) scale(${size / 24})"><path d="${badge.glyph}" ${paint}/></g>`;
  };
  const corner =
    style === "fold"
      ? `<path d="M100 44V100H44z" fill="${badge.color}"/><path d="M100 44L44 100" stroke="#000" stroke-opacity="0.18" stroke-width="2"/>${mark(82, 24)}`
      : `<rect x="3.5" y="3.5" width="93" height="93" rx="19" fill="none" stroke="${badge.color}" stroke-width="7"/><circle cx="79" cy="79" r="18" fill="${badge.color}"/>${mark(79, 20)}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">` +
    `<image href="${escapeAttr(face)}" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>${corner}</svg>`
  );
}

/** A short stable key for a (face, badge, style) render: changes when the person's photo URL does. */
export const avatarKey = (faceUrl: string, badge: Badge, style: BadgeStyle = "fold"): string =>
  hash53(stableStringify({ faceUrl, badge, style }));

export interface Image {
  type: string;
  bytes: Uint8Array;
}

/** The image type from magic bytes (png / jpeg / gif / webp), or null. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const unbase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const dataUri = (img: Image): string => `data:${img.type};base64,${base64(img.bytes)}`;

/** A face from a URL, if it's an image no larger than `maxBytes`; null on any failure (a post never waits on it). */
export async function fetchFace(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number; types?: string[] } = {},
): Promise<Image | null> {
  const { fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, maxBytes = 2_000_000, types = ["image/png", "image/jpeg"] } = options;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > maxBytes) return null;
    const type = sniffImage(bytes);
    return type !== null && types.includes(type) ? { type, bytes } : null;
  } catch {
    return null;
  }
}

/* ---- identicons (deterministic PNGs, no codec) ---- */

/** An identicon seed for `actor`: HMAC-SHA256 under `secret`, separated by `label` from the secret's other uses. */
export async function identiconSeed(secret: string, actor: string, label = "thrds-identicon"): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}\0${actor}`)));
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
}

/** A 5×5 left-right mirrored identicon from `seed` (≥ 4 bytes), `px` square. */
export function identiconPng(seed: Uint8Array, px = 120): Uint8Array {
  const fg = hsl(((seed[0]! << 8) | seed[1]!) % 360, 0.6, 0.48);
  const bits = (seed[2]! << 8) | seed[3]!;
  return gridPng((col, row) => {
    const c = col < 3 ? col : 4 - col;
    return ((bits >> (c * 5 + row)) & 1) === 1;
  }, fg, px);
}

/** A fixed slate robot head: the face for a service (a job, not a person), the same bytes everywhere. */
export const SERVICE_ICON = ["..#..", "#####", "#.#.#", "#####", ".#.#."];

export function serviceIconPng(px = 120): Uint8Array {
  return gridPng((col, row) => SERVICE_ICON[row]![col] === "#", [71, 85, 105], px);
}

function gridPng(on: (col: number, row: number) => boolean, fg: readonly [number, number, number], px: number): Uint8Array {
  const bg: [number, number, number] = [240, 240, 240];
  const margin = Math.round(px / 12);
  const cell = (px - 2 * margin) / 5;
  const raw = new Uint8Array(px * (1 + px * 3));
  for (let y = 0; y < px; y++) {
    const o = y * (1 + px * 3);
    raw[o] = 0;
    for (let x = 0; x < px; x++) {
      const cx = Math.floor((x - margin) / cell);
      const cy = Math.floor((y - margin) / cell);
      const inside = x >= margin && y >= margin && cx < 5 && cy < 5;
      raw.set(inside && on(cx, cy) ? fg : bg, o + 1 + x * 3);
    }
  }
  return png(px, px, raw);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (const b of p) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number): Uint8Array => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new TextEncoder().encode(type);
  return [u32(data.length), t, data, u32(crc32([t, data]))];
}

/** zlib with stored (uncompressed) deflate blocks: deterministic, no codec needed in a Worker. */
function zlibStored(data: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let i = 0; i < data.length || i === 0; i += 65535) {
    const len = Math.min(65535, data.length - i);
    const last = i + len >= data.length ? 1 : 0;
    out.push(last, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255);
    for (let j = 0; j < len; j++) out.push(data[i + j]!);
    if (last) break;
  }
  let a = 1;
  let b = 0;
  for (const x of data) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  out.push(...u32(((b << 16) | a) >>> 0));
  return new Uint8Array(out);
}

/** An 8-bit RGB PNG from filter-prefixed scanlines. */
function png(w: number, h: number, raw: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array([...u32(w), ...u32(h), 8, 2, 0, 0, 0]);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", zlibStored(raw)),
    ...chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ---- content-addressed hosting ---- */

/** Content-addressed image storage: `put` is idempotent (same sha, same bytes). */
export interface AvatarStore {
  put(sha256: string, img: Image, nowS: number): Promise<void>;
  get(sha256: string): Promise<Image | null>;
}

export function memoryAvatarStore(): AvatarStore & { size(): number } {
  const m = new Map<string, Image>();
  return {
    async put(sha, img) {
      if (!m.has(sha)) m.set(sha, { type: img.type, bytes: new Uint8Array(img.bytes) });
    },
    async get(sha) {
      return m.get(sha) ?? null;
    },
    size: () => m.size,
  };
}

/** The route's one URL shape: `/a/<64 hex>`, optionally with an image extension. `prefix` re-roots it. */
export const avatarPath = (prefix = "/a"): RegExp =>
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([0-9a-f]{64})(?:\\.(?:png|jpe?g|gif|webp))?$`);

export const AVATAR_PATH = avatarPath();

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const hex = (b: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

/** Store `img` (once) and return its public URL: `<origin><prefix>/<sha256>.<ext>`. */
export async function publishAvatar(
  store: AvatarStore,
  origin: string,
  img: Image,
  options: { nowS?: number; prefix?: string } = {},
): Promise<string> {
  const sha = await sha256Hex(img.bytes);
  await store.put(sha, img, options.nowS ?? Math.floor(Date.now() / 1000));
  return `${origin.replace(/\/+$/, "")}${options.prefix ?? "/a"}/${sha}.${EXT[img.type] ?? "png"}`;
}

/** The stored image a route path names, or null for any other path. */
export async function readAvatar(store: AvatarStore, pathname: string, prefix = "/a"): Promise<Image | null> {
  const m = avatarPath(prefix).exec(pathname);
  return m ? store.get(m[1]!) : null;
}

const notFound = (): Response =>
  new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * A complete handler for the avatar route (GET/HEAD): the stored image, immutable (the name is the content), else 404.
 * Only an exact stored hash resolves; nothing lists what's stored.
 */
export async function avatarResponse(store: AvatarStore, request: Request, prefix = "/a"): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const img = await readAvatar(store, new URL(request.url).pathname, prefix);
  if (!img) return notFound();
  return new Response(method === "HEAD" ? null : new Uint8Array(img.bytes), {
    headers: {
      "content-type": img.type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

/** Rasterize an SVG to PNG bytes: resvg-wasm on Workers, `sharp` in Node. */
export type Rasterize = (svg: string) => Uint8Array | Promise<Uint8Array>;

export interface BadgedAvatarOptions {
  store: AvatarStore;
  /** The public origin Slack fetches `/a/...` from; must be https. */
  origin: string;
  rasterize: Rasterize;
  style?: BadgeStyle;
  px?: number;
  prefix?: string;
  fetch?: typeof fetch;
  /** Memo across calls (per isolate). Pass one Map per app; omit to always render. */
  memo?: Map<string, string>;
  onError?: (e: unknown) => void;
}

/**
 * The public URL of `face` (a URL to fetch, or bytes) with `badge`, rendered and published once. Null when it can't
 * be made (no face, an undecodable one, a non-https origin, a render failure): the caller posts with the plain face.
 */
export async function badgedAvatarUrl(
  face: string | Image | null,
  badge: Badge,
  options: BadgedAvatarOptions,
): Promise<string | null> {
  const { store, origin, rasterize, style = "fold", px = 256, prefix, fetch: fetchImpl, memo, onError } = options;
  if (!origin.startsWith("https://") || face === null) return null;
  const memoKey = typeof face === "string" ? avatarKey(face, badge, style) : null;
  const hit = memoKey !== null ? memo?.get(memoKey) : undefined;
  if (hit !== undefined) return hit;
  try {
    const img = typeof face === "string" ? await fetchFace(face, fetchImpl ? { fetch: fetchImpl } : {}) : face;
    if (img === null) return null;
    const bytes = await rasterize(badgedSvg(dataUri(img), badge, style, px));
    const url = await publishAvatar(store, origin, { type: "image/png", bytes }, prefix ? { prefix } : {});
    if (memoKey !== null) memo?.set(memoKey, url);
    return url;
  } catch (e) {
    onError?.(e);
    return null;
  }
}
