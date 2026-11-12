import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import * as adminDb from "../src/admin/db";
import { isPinnedAssetPath, withPinnedAssetCache } from "../src/pinned-assets";

// TOG-12550: /favicon.ico must serve (not fall through to the branded 404,
// which costs a Postgres transaction per new visitor), and pinned fonts get
// the year-long immutable header while every other asset is untouched.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const baseEnv = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as const;

const IMMUTABLE = "public, max-age=31536000, immutable";

// Pinned binaries: a byte change without a filename change serves stale
// glyphs under `immutable`, so the pin fails CI until renamed (TOG-6785).
// Ember Hours families (two-design-kit v0.2.0, tokens §2): one variable
// Mona Sans plus subset Instrument Serif Italic and Fragment Mono.
// Provenance, subset ranges and reproduction live in
// public/fonts/OFL-SOURCES.txt; full license texts in public/fonts/LICENSE.txt.
const FONT_PINS = {
  "mona-sans-latin-var.woff2": "5ea3740633e5ac7af56c13d7e8ec32bcae12e7723e53d34284469a8947ccb2f3",
  "instrument-serif-latin-400-italic.woff2":
    "2ea8887dec935b5a45ba939c463d9733fc3f6c465c30ae6881b8c331a9a1dece",
  "fragment-mono-latin-400.woff2":
    "d1c6a317e267c5db61bf1744a774d65ffe5258bdd6ffcc678db482ef50b490b4",
} as const;

const fontBytes = (name: string) => readFileSync(resolve(root, "public/fonts", name));

const assetEnv = (body: BodyInit | null, init?: ResponseInit) => ({
  ...baseEnv,
  ASSETS: { fetch: vi.fn(async () => new Response(body, init)) },
});

describe("favicon.ico", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exists on disk as a multi-entry ICO container, not an empty placeholder", () => {
    const ico = readFileSync(resolve(root, "public/favicon.ico"));
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect(ico.length).toBeGreaterThan(100);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    const count = view.getUint16(4, true);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(ico.length).toBe(6 + 16 * count + sizesOf(view, count));
  });

  it("GET /favicon.ico returns 200 with an image content type and never touches the DB", async () => {
    const ico = readFileSync(resolve(root, "public/favicon.ico"));
    const acquire = vi.spyOn(adminDb, "dbFor").mockRejectedValue(new Error("DB must not be read"));
    const env = assetEnv(ico, { headers: { "content-type": "image/x-icon" } });
    try {
      const res = await app.request(`${baseEnv.APP_URL}/favicon.ico`, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/");
      expect(res.headers.get("cache-control")).not.toBe("no-store, private");
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      acquire.mockRestore();
    }
  });
});

function sizesOf(view: DataView, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += view.getUint32(6 + 16 * i + 8, true);
  return total;
}

describe("pinned font cache", () => {
  it("stamps the immutable header on /fonts/*.woff2 only", () => {
    expect(isPinnedAssetPath("/fonts/mona-sans-latin-var.woff2")).toBe(true);
    expect(isPinnedAssetPath("/fonts/instrument-serif-latin-400-italic.woff2")).toBe(true);
    expect(isPinnedAssetPath("/fonts/fragment-mono-latin-400.woff2")).toBe(true);
    for (const notPinned of [
      "/favicon.ico",
      "/styles.css",
      "/theme.css",
      "/site.webmanifest",
      "/icons/icon-192.png",
      "/islands/rsvp-button.js",
      "/fonts/LICENSE.txt",
      "/fonts/OFL-SOURCES.txt",
      "/fonts/mona-sans-latin-var.woff2.bak",
      "/fonts/nested/mona-sans-latin-var.woff2",
      "/fonts/mona-sans-latin-var.WOFF2",
      "/fonts/mona-sans-latin-var.woff",
      "/fontsx/mona-sans-latin-var.woff2",
      "/fonts/",
    ]) {
      expect(isPinnedAssetPath(notPinned), notPinned).toBe(false);
    }
  });

  it("font responses carry the immutable header, other assets pass through unchanged", async () => {
    const url = (path: string) => `https://next.example.test${path}`;
    const font = withPinnedAssetCache(
      url("/fonts/mona-sans-latin-var.woff2"),
      new Response(fontBytes("mona-sans-latin-var.woff2"), {
        headers: { "content-type": "font/woff2" },
      }),
    );
    expect(font.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(font.headers.get("content-type")).toContain("font/woff2");
    expect(await font.arrayBuffer()).toEqual(
      fontBytes("mona-sans-latin-var.woff2").buffer.slice(
        fontBytes("mona-sans-latin-var.woff2").byteOffset,
        fontBytes("mona-sans-latin-var.woff2").byteOffset +
          fontBytes("mona-sans-latin-var.woff2").byteLength,
      ),
    );

    const css = new Response("body {}", { headers: { "content-type": "text/css" } });
    expect(withPinnedAssetCache(url("/styles.css"), css)).toBe(css);

    const ico = new Response(readFileSync(resolve(root, "public/favicon.ico")));
    expect(withPinnedAssetCache(url("/favicon.ico"), ico)).toBe(ico);
  });

  it("end to end: font hits get the header through the ASSETS branch, CSS does not", async () => {
    const fontEnv = assetEnv(fontBytes("instrument-serif-latin-400-italic.woff2"), {
      headers: { "content-type": "font/woff2" },
    });
    const font = await app.request(
      `${baseEnv.APP_URL}/fonts/instrument-serif-latin-400-italic.woff2`,
      {},
      fontEnv,
    );
    expect(font.status).toBe(200);
    expect(font.headers.get("cache-control")).toBe(IMMUTABLE);

    const cssEnv = assetEnv("body {}", { headers: { "content-type": "text/css" } });
    const css = await app.request(`${baseEnv.APP_URL}/styles.css`, {}, cssEnv);
    expect(css.status).toBe(200);
    expect(css.headers.get("cache-control")).not.toBe(IMMUTABLE);

    const icoEnv = assetEnv(readFileSync(resolve(root, "public/favicon.ico")), {
      headers: { "content-type": "image/x-icon" },
    });
    const ico = await app.request(`${baseEnv.APP_URL}/favicon.ico`, {}, icoEnv);
    expect(ico.status).toBe(200);
    expect(ico.headers.get("cache-control")).not.toBe(IMMUTABLE);
  });
});

describe("font byte pins", () => {
  it.each(Object.entries(FONT_PINS))("%s matches its pinned sha256", (name, pinned) => {
    const actual = createHash("sha256").update(fontBytes(name)).digest("hex");
    expect(actual).toBe(pinned);
  });
});

describe("font provenance", () => {
  it("ships OFL sources and license texts alongside the pinned families", () => {
    const sources = readFileSync(resolve(root, "public/fonts/OFL-SOURCES.txt"), "utf8");
    const license = readFileSync(resolve(root, "public/fonts/LICENSE.txt"), "utf8");
    for (const name of Object.keys(FONT_PINS)) {
      expect(sources, `OFL-SOURCES.txt names ${name}`).toContain(name);
    }
    for (const marker of ["Mona Sans", "Instrument Serif", "Fragment Mono"]) {
      expect(sources, `OFL-SOURCES.txt credits ${marker}`).toContain(marker);
      expect(license, `LICENSE.txt carries the ${marker} OFL text`).toContain(marker);
    }
  });
});
