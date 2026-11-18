import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BADGES,
  GLYPHS,
  avatarKey,
  avatarResponse,
  badgedAvatarUrl,
  badgedSvg,
  derivedAvatarHandler,
  derivedAvatarUrl,
  identiconPng,
  identiconSeed,
  memoryAvatarStore,
  publishAvatar,
  serviceIconPng,
  sha256Hex,
  sniffImage,
} from "../src/avatar";

/** A PNG's width, height and RGB pixel at (x, y), decoded with node's zlib (the encoder doesn't use it). */
function pixel(png: Uint8Array, x: number, y: number): { w: number; h: number; rgb: number[] } {
  const v = new DataView(png.buffer, png.byteOffset);
  const w = v.getUint32(16);
  const h = v.getUint32(20);
  const idatLen = v.getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  const o = y * (1 + w * 3) + 1 + x * 3;
  return { w, h, rgb: [raw[o]!, raw[o + 1]!, raw[o + 2]!] };
}

describe("badgedSvg", () => {
  // The same strings disky's golden tests pin (site/functions/_lib/badgedAvatar.test.ts), via generic badges.
  it("fold: the face, a corner folded down in the badge's color, its glyph (white) on it", () => {
    expect(badgedSvg("data:image/png;base64,AA", { color: "#2e9e62", glyph: GLYPHS.check })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100">' +
        '<image href="data:image/png;base64,AA" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>' +
        '<path d="M100 44V100H44z" fill="#2e9e62"/><path d="M100 44L44 100" stroke="#000" stroke-opacity="0.18" stroke-width="2"/>' +
        '<g transform="translate(70 70) scale(1)"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="#fff" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></g></svg>',
    );
  });

  it("ring: the face framed in the badge's color, a filled glyph on a corner chip", () => {
    expect(badgedSvg("data:image/png;base64,AA", BADGES.running, "ring", 128)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100">' +
        '<image href="data:image/png;base64,AA" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>' +
        '<rect x="3.5" y="3.5" width="93" height="93" rx="19" fill="none" stroke="#ec6a1f" stroke-width="7"/><circle cx="79" cy="79" r="18" fill="#ec6a1f"/>' +
        '<g transform="translate(69 69) scale(0.8333333333333334)"><path d="M13.5 2.5L5.5 13.5h6l-1 8 8-11h-6z" fill="#fff" stroke="none"/></g></svg>',
    );
  });

  it("an image badge (a bot's own logo) sits where the glyph would; attributes are escaped", () => {
    expect(badgedSvg('https://x/a.png?b="1"', { color: "#000", image: "data:image/png;base64,BB" }, "fold", 64)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 100 100">' +
        '<image href="https://x/a.png?b=&quot;1&quot;" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>' +
        '<path d="M100 44V100H44z" fill="#000"/><path d="M100 44L44 100" stroke="#000" stroke-opacity="0.18" stroke-width="2"/>' +
        '<image href="data:image/png;base64,BB" x="70" y="70" width="24" height="24"/></svg>',
    );
  });

  it("avatarKey changes with the face, badge or style", () => {
    const k = avatarKey("https://img/a.png", BADGES.automated);
    expect([
      k === avatarKey("https://img/a.png", BADGES.automated),
      k === avatarKey("https://img/b.png", BADGES.automated),
      k === avatarKey("https://img/a.png", BADGES.failed),
      k === avatarKey("https://img/a.png", BADGES.automated, "ring"),
    ]).toEqual([true, false, false, false]);
  });
});

describe("identicons", () => {
  it("are deterministic PNGs: an HMAC-seeded mirrored grid, and a fixed service robot", async () => {
    const seed = await identiconSeed("secret", "ann@example.org");
    const a = identiconPng(seed, 60);
    const again = identiconPng(await identiconSeed("secret", "ann@example.org"), 60);
    const other = identiconPng(await identiconSeed("secret", "bob@example.org"), 60);
    const relabeled = identiconPng(await identiconSeed("secret", "ann@example.org", "disky-identicon"), 60);
    const svc = serviceIconPng(60);
    // Margin 5px, 10px cells: (0,0) is ground; the robot's top-center cell (2,0) is on, its corner (0,0) off.
    expect([
      sniffImage(a),
      await sha256Hex(a) === (await sha256Hex(again)),
      new Set([await sha256Hex(a), await sha256Hex(other), await sha256Hex(relabeled)]).size,
      pixel(svc, 0, 0),
      pixel(svc, 5 + 2 * 10 + 5, 5 + 5).rgb,
      pixel(svc, 5 + 5, 5 + 5).rgb,
    ]).toEqual(["image/png", true, 3, { w: 60, h: 60, rgb: [240, 240, 240] }, [71, 85, 105], [240, 240, 240]]);
  });
});

describe("hosting", () => {
  const ORIGIN = "https://bot.example.org";
  const png = serviceIconPng(24);

  it("publishes by sha256 and serves it immutably; everything else 404s", async () => {
    const store = memoryAvatarStore();
    const url = await publishAvatar(store, `${ORIGIN}/`, { type: "image/png", bytes: png });
    const sha = await sha256Hex(png);
    const get = async (path: string, method = "GET") => {
      const r = await avatarResponse(store, new Request(`${ORIGIN}${path}`, { method }));
      return [r.status, r.headers.get("content-type"), r.headers.get("cache-control")];
    };
    const ok = await avatarResponse(store, new Request(`${ORIGIN}/a/${sha}.png`));
    const gone = [404, "text/plain; charset=utf-8", "no-store"];
    expect([
      url,
      ok.status,
      [...ok.headers].sort(),
      new Uint8Array(await ok.arrayBuffer()),
      await get(`/a/${sha}`),
      await get(`/a/${sha}.png`, "HEAD"),
      await get(`/a/${"0".repeat(64)}.png`),
      await get(`/a/${sha.toUpperCase()}`),
      await get(`/a/${sha}.svg`),
      await get(`/a/${sha}/x`),
      (await avatarResponse(store, new Request(`${ORIGIN}/a/${sha}`, { method: "POST" }))).status,
    ]).toEqual([
      `${ORIGIN}/a/${sha}.png`,
      200,
      [
        ["cache-control", "public, max-age=31536000, immutable"],
        ["content-security-policy", "default-src 'none'"],
        ["content-type", "image/png"],
        ["x-content-type-options", "nosniff"],
      ],
      png,
      [200, "image/png", "public, max-age=31536000, immutable"],
      [200, "image/png", "public, max-age=31536000, immutable"],
      gone,
      gone,
      gone,
      gone,
      405,
    ]);
  });

  it("badgedAvatarUrl fetches, renders and publishes once per face+badge; null when it can't", async () => {
    const store = memoryAvatarStore();
    const gets: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      gets.push(String(input));
      return String(input) === "https://img/ann.png" ? new Response(png) : new Response("", { status: 404 });
    }) as typeof fetch;
    const svgs: string[] = [];
    const rasterize = (svg: string) => (svgs.push(svg), serviceIconPng(32));
    const memo = new Map<string, string>();
    const opts = { store, origin: ORIGIN, rasterize, fetch: fetchImpl, memo };
    const url = await badgedAvatarUrl("https://img/ann.png", BADGES.automated, opts);
    const again = await badgedAvatarUrl("https://img/ann.png", BADGES.automated, opts);
    const missing = await badgedAvatarUrl("https://img/nobody.png", BADGES.automated, opts);
    const insecure = await badgedAvatarUrl("https://img/ann.png", BADGES.automated, { ...opts, origin: "http://localhost:8787" });
    expect([
      url,
      again,
      missing,
      insecure,
      gets,
      svgs.length,
      svgs[0]!.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100"><image href="data:image/png;base64,'),
      store.size(),
    ]).toEqual([`${ORIGIN}/a/${await sha256Hex(serviceIconPng(32))}.png`, url, null, null, ["https://img/ann.png", "https://img/nobody.png"], 1, true, 1]);
  });
});

describe("derived (stateless) avatars", () => {
  it("serve a URL whose key matches the person's current face, re-rendering on a cold cache; 404 a stale or forged key", async () => {
    const png = serviceIconPng(24);
    let face = "https://img/ann-v1.png";
    let renders = 0;
    const fetchImpl = (async () => new Response(png)) as unknown as typeof fetch;
    const make = () =>
      derivedAvatarHandler({
        resolveFace: async (id) => (id === "U_ANN" ? face : null),
        badge: BADGES.automated,
        rasterize: () => (renders++, serviceIconPng(32)),
        fetch: fetchImpl,
      });
    const handler = make();
    const url = derivedAvatarUrl("https://bot.run.app/", "U_ANN", face, BADGES.automated);
    const status = async (h: ReturnType<typeof make>, u: string) => (await h(new Request(u)))?.status ?? null;
    const first = await status(handler, url);
    const cached = await status(handler, url);
    const coldInstance = await status(make(), url);
    face = "https://img/ann-v2.png"; // a new photo: the old key no longer resolves
    const stale = await status(make(), url);
    expect([
      url,
      first,
      cached,
      coldInstance,
      renders,
      stale,
      await status(handler, "https://bot.run.app/avatars/U_NOBODY/0123456789abcd.png"),
      await status(handler, "https://bot.run.app/elsewhere"),
    ]).toEqual([`https://bot.run.app/avatars/U_ANN/${avatarKey("https://img/ann-v1.png", BADGES.automated)}.png`, 200, 200, 200, 2, 404, 404, null]);
  });
});
