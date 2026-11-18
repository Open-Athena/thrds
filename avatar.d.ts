/** A badge: a color, and a 24-unit glyph path drawn white (stroked unless `fill`) or a raster `image` (data URI). */
interface Badge {
    color: string;
    glyph?: string;
    fill?: boolean;
    image?: string;
}
type BadgeStyle = "fold" | "ring";
/** Stock 24-unit glyph paths. `bin`…`undo` are disky's; `robot` / `gear` / `hourglass` / `chat` are generic. */
declare const GLYPHS: {
    readonly bin: "M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13M10.5 11v6M13.5 11v6";
    readonly flask: "M9 3h6M10 3v6.5L5.2 18a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 9.5V3M7.5 15h9";
    readonly bolt: "M13.5 2.5L5.5 13.5h6l-1 8 8-11h-6z";
    readonly check: "M5 12.5l4.5 4.5L19 7";
    readonly x: "M7 7l10 10M17 7L7 17";
    readonly undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3";
    readonly robot: "M12 3v3M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9.5 11v1.5M14.5 11v1.5M9 15.5h6M3 11v3M21 11v3";
    readonly gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8";
    readonly hourglass: "M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9";
    readonly chat: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z";
};
/** Ready-made badges. Each app maps its own events onto these (or its own `Badge`s). */
declare const BADGES: {
    automated: {
        color: string;
        glyph: "M12 3v3M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9.5 11v1.5M14.5 11v1.5M9 15.5h6M3 11v3M21 11v3";
    };
    staged: {
        color: string;
        glyph: "M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13M10.5 11v6M13.5 11v6";
    };
    dry: {
        color: string;
        glyph: "M9 3h6M10 3v6.5L5.2 18a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 9.5V3M7.5 15h9";
    };
    running: {
        color: string;
        glyph: "M13.5 2.5L5.5 13.5h6l-1 8 8-11h-6z";
        fill: true;
    };
    succeeded: {
        color: string;
        glyph: "M5 12.5l4.5 4.5L19 7";
    };
    failed: {
        color: string;
        glyph: "M7 7l10 10M17 7L7 17";
    };
    undone: {
        color: string;
        glyph: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3";
    };
    waiting: {
        color: string;
        glyph: "M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9";
    };
    update: {
        color: string;
        glyph: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z";
    };
};
/**
 * The badged face as SVG: `face` (a raster data URI, or any URL the rasterizer can load) on a 100-unit square, drawn
 * at `px`. `fold`: the lower-right corner folded down in the badge's color, the glyph on it. `ring`: the face framed in
 * the badge's color, the glyph on a corner chip.
 */
declare function badgedSvg(face: string, badge: Badge, style?: BadgeStyle, px?: number): string;
/** A short stable key for a (face, badge, style) render: changes when the person's photo URL does. */
declare const avatarKey: (faceUrl: string, badge: Badge, style?: BadgeStyle) => string;
interface Image {
    type: string;
    bytes: Uint8Array;
}
/** The image type from magic bytes (png / jpeg / gif / webp), or null. */
declare function sniffImage(bytes: Uint8Array): string | null;
declare function base64(bytes: Uint8Array): string;
declare const unbase64: (b64: string) => Uint8Array;
declare const dataUri: (img: Image) => string;
/** A face from a URL, if it's an image no larger than `maxBytes`; null on any failure (a post never waits on it). */
declare function fetchFace(url: string, options?: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    types?: string[];
}): Promise<Image | null>;
/** An identicon seed for `actor`: HMAC-SHA256 under `secret`, separated by `label` from the secret's other uses. */
declare function identiconSeed(secret: string, actor: string, label?: string): Promise<Uint8Array>;
/** A 5×5 left-right mirrored identicon from `seed` (≥ 4 bytes), `px` square. */
declare function identiconPng(seed: Uint8Array, px?: number): Uint8Array;
/** A fixed slate robot head: the face for a service (a job, not a person), the same bytes everywhere. */
declare const SERVICE_ICON: string[];
declare function serviceIconPng(px?: number): Uint8Array;
/** Content-addressed image storage: `put` is idempotent (same sha, same bytes). */
interface AvatarStore {
    put(sha256: string, img: Image, nowS: number): Promise<void>;
    get(sha256: string): Promise<Image | null>;
}
declare function memoryAvatarStore(): AvatarStore & {
    size(): number;
};
/** The route's one URL shape: `/a/<64 hex>`, optionally with an image extension. `prefix` re-roots it. */
declare const avatarPath: (prefix?: string) => RegExp;
declare const AVATAR_PATH: RegExp;
declare const sha256Hex: (bytes: Uint8Array) => Promise<string>;
/** Store `img` (once) and return its public URL: `<origin><prefix>/<sha256>.<ext>`. */
declare function publishAvatar(store: AvatarStore, origin: string, img: Image, options?: {
    nowS?: number;
    prefix?: string;
}): Promise<string>;
/** The stored image a route path names, or null for any other path. */
declare function readAvatar(store: AvatarStore, pathname: string, prefix?: string): Promise<Image | null>;
/**
 * A complete handler for the avatar route (GET/HEAD): the stored image, immutable (the name is the content), else 404.
 * Only an exact stored hash resolves; nothing lists what's stored.
 */
declare function avatarResponse(store: AvatarStore, request: Request, prefix?: string): Promise<Response>;
/** Rasterize an SVG to PNG bytes: resvg-wasm on Workers, `sharp` in Node. */
type Rasterize = (svg: string) => Uint8Array | Promise<Uint8Array>;
interface BadgedAvatarOptions {
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
    /** The memo key for a bytes face (an identicon), which has no URL to key on: e.g. `id:<email>`. */
    memoKey?: string;
    onError?: (e: unknown) => void;
}
/**
 * The public URL of `face` (a URL to fetch, or bytes) with `badge`, rendered and published once. Null when it can't
 * be made (no face, an undecodable one, a non-https origin, a render failure): the caller posts with the plain face.
 */
declare function badgedAvatarUrl(face: string | Image | null, badge: Badge, options: BadgedAvatarOptions): Promise<string | null>;
/**
 * A badged-avatar URL that needs no storage: `<origin><prefix>/<id>/<key>.png`, where `key` = `avatarKey(faceUrl, …)`.
 * Serve it with `derivedAvatarHandler`, which re-renders from the person's *current* face and 404s a stale or forged
 * key. For stateless hosts (Cloud Run, a fresh isolate) where a content-addressed `publishAvatar` store can't persist.
 */
declare function derivedAvatarUrl(origin: string, id: string, faceUrl: string, badge: Badge, options?: {
    style?: BadgeStyle;
    prefix?: string;
}): string;
interface DerivedAvatarOptions {
    /** The current face URL for an id (e.g. the Slack user's `image_192`), or null if unknown. */
    resolveFace: (id: string) => Promise<string | null>;
    badge: Badge;
    rasterize: Rasterize;
    style?: BadgeStyle;
    px?: number;
    prefix?: string;
    fetch?: typeof fetch;
    /** Rendered PNGs kept in memory (by key). Default 256. */
    cacheSize?: number;
    onError?: (e: unknown) => void;
}
/** A GET/HEAD handler for `derivedAvatarUrl`s; returns null for paths outside `prefix` so it composes with a router. */
declare function derivedAvatarHandler(options: DerivedAvatarOptions): (request: Request) => Promise<Response | null>;

export { AVATAR_PATH, type AvatarStore, BADGES, type Badge, type BadgeStyle, type BadgedAvatarOptions, type DerivedAvatarOptions, GLYPHS, type Image, type Rasterize, SERVICE_ICON, avatarKey, avatarPath, avatarResponse, badgedAvatarUrl, badgedSvg, base64, dataUri, derivedAvatarHandler, derivedAvatarUrl, fetchFace, identiconPng, identiconSeed, memoryAvatarStore, publishAvatar, readAvatar, serviceIconPng, sha256Hex, sniffImage, unbase64 };
