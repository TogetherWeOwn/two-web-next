import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../src/pages";
import { HOME_CRITICAL_CSS, HOME_CRITICAL_CSS_SHA256 } from "../src/home-critical-css";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import type { Env } from "../src/env";
import app from "./app";

const cssPath = (entry: string) =>
  readFileSync(new URL(`../public/${entry}`, import.meta.url), "utf8");
// Shared sources feed both bundles; the leaf-only seam source (outside
// public/, never served) feeds the full leaf bundle only. The homepage bundle
// is exactly the three shared sources, so leaf-only rules can never grow "/"
// against its byte caps. Both modules regenerate with
// `node ci/build-leaf-css.mjs`; the full split contract lives in
// test/leaf-css-delivery-acceptance.test.ts.
const SHARED_SOURCES = ["styles.css", "theme-tokens.css", "theme.css"];
const leafOnlyCss = readFileSync(new URL("../assets/leaf-only.css", import.meta.url), "utf8");

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
  RULES_LAST_UPDATED: "2026-09-01",
};

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("leaf CSS tests must remain offline");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("content-leaf inlined CSS", () => {
  it("matches the shared sources plus the leaf-only seam byte for byte", () => {
    const concatenated = [...SHARED_SOURCES.map(cssPath), leafOnlyCss].join("\n");
    expect(LEAF_CRITICAL_CSS).toBe(concatenated);
  });

  it("carries the sha256 of exactly those bytes", () => {
    expect(LEAF_CRITICAL_CSS_SHA256).toBe(
      createHash("sha256").update(LEAF_CRITICAL_CSS, "utf8").digest("base64"),
    );
  });

  it("cannot break out of its style element", () => {
    expect(LEAF_CRITICAL_CSS).not.toMatch(/<\/style/i);
  });

  it("keeps the homepage bundle on the shared sources only", () => {
    expect(HOME_CRITICAL_CSS).toBe(SHARED_SOURCES.map(cssPath).join("\n"));
    expect(HOME_CRITICAL_CSS_SHA256).toBe(
      createHash("sha256").update(HOME_CRITICAL_CSS, "utf8").digest("base64"),
    );
    expect(HOME_CRITICAL_CSS_SHA256).not.toBe(LEAF_CRITICAL_CSS_SHA256);
    expect(HOME_CRITICAL_CSS).not.toMatch(/<\/style/i);
  });

  it("renders in the content shell instead of render-blocking links", () => {
    const html = Layout({ title: "Fixture", theme: "content" })!.toString();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toMatch(/<link(?=[^>]*rel="preload")(?=[^>]*as="style")/);
    // Content leaves render no Display text, so the font is
    // neither used nor preloaded there (its late swap became mobile LCP).
    expect(html).not.toContain('.woff2" as="font"');
  });

  it("leaves every other shell on external stylesheets", () => {
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = Layout({ title: "Fixture", theme })!.toString();
      expect(html).toContain('rel="stylesheet" href="/styles.css"');
      expect(html).not.toContain("<style>");
    }
    const plain = Layout({ title: "Fixture" })!.toString();
    expect(plain).toContain('rel="stylesheet" href="/styles.css"');
    expect(plain).not.toContain("<style>");
  });

  it.each(["/about", "/faq", "/rules", "/privacy"])(
    "%s serves the inlined block under a hash-allowlisted CSP",
    async (path) => {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
      expect(html).not.toContain('rel="stylesheet"');
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
      expect(csp).not.toContain("unsafe-inline");
    },
  );
});
