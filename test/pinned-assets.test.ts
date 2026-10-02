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
const FONT_PINS = {
  "display-latin-500.woff2": "23afdb9b5b89b878fab04d80cc30bf41bb4f3f7e8be88e5f16a7cc7671cdb2dc",
  "display-latin-700.woff2": "5b7e4a6f97163c2636724d4de90304fc895653dcfe64c67a7a22f26331ca5c5f",
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
    expect(isPinnedAssetPath("/fonts/display-latin-500.woff2")).toBe(true);
    expect(isPinnedAssetPath("/fonts/display-latin-700.woff2")).toBe(true);
    for (const notPinned of [
      "/favicon.ico",
      "/styles.css",
      "/theme.css",
      "/site.webmanifest",
      "/icons/icon-192.png",
      "/islands/rsvp-button.js",
      "/fonts/LICENSE.txt",
      "/fonts/display-latin-500.woff2.bak",
      "/fonts/nested/display-latin-500.woff2",
      "/fonts/display-latin-500.WOFF2",
      "/fonts/display-latin-500.woff",
      "/fontsx/display-latin-500.woff2",
      "/fonts/",
    ]) {
      expect(isPinnedAssetPath(notPinned), notPinned).toBe(false);
    }
  });

  it("font responses carry the immutable header, other assets pass through unchanged", async () => {
    const url = (path: string) => `https://next.example.test${path}`;
    const font = withPinnedAssetCache(
      url("/fonts/display-latin-500.woff2"),
      new Response(fontBytes("display-latin-500.woff2"), {
        headers: { "content-type": "font/woff2" },
      }),
    );
    expect(font.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(font.headers.get("content-type")).toContain("font/woff2");
    expect(await font.arrayBuffer()).toEqual(
      fontBytes("display-latin-500.woff2").buffer.slice(
        fontBytes("display-latin-500.woff2").byteOffset,
        fontBytes("display-latin-500.woff2").byteOffset +
          fontBytes("display-latin-500.woff2").byteLength,
      ),
    );

    const css = new Response("body {}", { headers: { "content-type": "text/css" } });
    expect(withPinnedAssetCache(url("/styles.css"), css)).toBe(css);

    const ico = new Response(readFileSync(resolve(root, "public/favicon.ico")));
    expect(withPinnedAssetCache(url("/favicon.ico"), ico)).toBe(ico);
  });

  it("end to end: font hits get the header through the ASSETS branch, CSS does not", async () => {
    const fontEnv = assetEnv(fontBytes("display-latin-700.woff2"), {
      headers: { "content-type": "font/woff2" },
    });
    const font = await app.request(`${baseEnv.APP_URL}/fonts/display-latin-700.woff2`, {}, fontEnv);
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
