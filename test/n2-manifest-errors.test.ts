import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import {
  internalErrorHandler,
  maintenanceHandler,
  notFoundHandler,
  rateLimitExceeded,
} from "../src/errors";
import type { Env } from "../src/env";

// N2 acceptance (TOG-9906): webmanifest + install icons + theme-color +
// branded error pages. Ports legacy two-web's WebManifestTest assertions
// (tests/Unit/WebManifestTest.php, TOG-7677).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("site.webmanifest", () => {
  it("is valid JSON with the exact legacy fields", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "public/site.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({
      id: "/",
      name: "Together We Own",
      short_name: "TWO",
      lang: "en",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f1eadb",
      theme_color: "#0b0714",
    });
    expect(manifest.icons).toEqual([
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });
});

describe("install icons", () => {
  it.each([["icon-192.png"], ["icon-512.png"], ["maskable-512.png"], ["apple-touch-icon.png"]])(
    "%s exists on disk with PNG magic bytes",
    (name) => {
      const bytes = readFileSync(resolve(root, "public/icons", name));
      expect(Buffer.from(bytes.subarray(0, 8)).equals(PNG_MAGIC)).toBe(true);
      expect(bytes.length).toBeGreaterThan(1000);
    },
  );
});

describe("shell head", () => {
  it("GET / carries theme-color meta + manifest/icon/apple-touch-icon links", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain('<meta name="theme-color" content="#0b0714"');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(html).toContain('<link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180"');
  });

  it("leaves carry the same head links", async () => {
    const html = await (await app.request("/about", {}, env)).text();
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(html).toContain('<meta name="theme-color" content="#0b0714"');
  });
});

describe("branded error handlers on a scratch app", () => {
  afterEach(() => vi.unstubAllGlobals());

  function scratch() {
    const scratchApp = new Hono();
    scratchApp.notFound((c) => notFoundHandler(c));
    scratchApp.onError((err, c) => internalErrorHandler(err, c));
    scratchApp.get("/throttled", (c) => rateLimitExceeded(c, Number(c.req.query("retry_after") ?? 60)));
    scratchApp.get("/down", maintenanceHandler("https://discord.gg/invite"));
    scratchApp.get("/boom", () => {
      throw new Error("kaboom with secret internals");
    });
    return scratchApp;
  }

  it("404: branded copy, join CTA + home link, event search recovery", async () => {
    const res = await scratch().request("/nope");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("We cannot find that page");
    expect(html).toContain("come in and say hello");
    expect(html).toContain('href="/auth/discord"');
    expect(html).toContain("Back to the homepage");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('href="/events"');
    expect(html).toContain('action="/events" method="get"');
    expect(html).toContain('name="q" type="search"');
  });

  it("500: branded copy, logged, never echoes the failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await scratch().request("/boom");
    expect(res.status).toBe(500);
    expect(err).toHaveBeenCalled();
    const html = await res.text();
    expect(html).toContain("Something broke on our side");
    expect(html).toContain("We have logged the failure");
    expect(html).not.toContain("kaboom");
    expect(html).not.toContain("secret internals");
    expect(html).not.toMatch(/trace|exception|stack/i);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("429: browsers get the branded page with Retry-After", async () => {
    const res = await scratch().request("/throttled?retry_after=42");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const html = await res.text();
    expect(html).toContain("Slow down a little");
    expect(html).toContain("the lobby is not going anywhere");
  });

  it("429: JSON callers get the rate_limited envelope with Retry-After", async () => {
    const res = await scratch().request("/throttled?retry_after=7", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(await res.json()).toEqual({
      reason: "rate_limited",
      message: "Too many requests. Try again in 7 seconds.",
      retry_after: 7,
    });
  });

  it("429: default 60, min 1", async () => {
    const json = await scratch().request("/throttled", { headers: { accept: "application/json" } });
    expect(await json.json()).toMatchObject({ retry_after: 60 });
    const zero = await scratch().request("/throttled?retry_after=0", {
      headers: { accept: "application/json" },
    });
    expect(zero.headers.get("Retry-After")).toBe("1");
    expect(await zero.json()).toMatchObject({ retry_after: 1 });
  });

  it("503: invite CTA points at the invite URL directly, never /auth/discord", async () => {
    const res = await scratch().request("/down");
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("We will be right back");
    expect(html).toContain("The Discord server never closes");
    expect(html).toContain('href="https://discord.gg/invite"');
    expect(html).toContain("Use the Discord invite instead");
    expect(html).not.toContain('href="/auth/discord"');
    expect(html).toContain("Try again");
  });
});

describe("production app error wiring", () => {
  it("unknown routes answer the branded 404", async () => {
    const res = await app.request("/definitely-not-here", {}, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("We cannot find that page");
  });
});
