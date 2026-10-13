import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../src/pages";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import type { Env } from "../src/env";
import app from "./app";
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { DROP_SELECTORS, SUBSET_BUDGET_BYTES, build, canonSelector } from "../ci/build-leaf-css.mjs";

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

const LEAF_PATHS = ["/about", "/faq", "/rules", "/privacy"] as const;

// Every selector the builder drops must be provably dead on the rendered
// leaves: at least one of its required markers (class, id, or data-testid
// value) or tags (element name) is absent from all four pages. Absence is
// sound in this direction only: a missing component means the selector
// cannot match. Markers and tags live in separate namespaces (the `<link>`
// element must not satisfy the `.link` class). Entries without any such
// component are rejected outright.
function requiredMarkers(selector: string): string[] {
  const classes = [...selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((m) => m[1] ?? "");
  const ids = [...selector.matchAll(/#(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((m) => m[1] ?? "");
  const testids = [...selector.matchAll(/data-testid=(["'])([^"']+)\1/g)].map((m) => m[2] ?? "");
  return [...new Set([...classes, ...ids, ...testids].filter((marker) => marker !== ""))];
}

function requiredTags(selector: string): string[] {
  const tags = selector
    .split(/[\s,>+~]+/)
    .map((compound) => compound.match(/^([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase())
    .filter((tag): tag is string => tag !== undefined && tag !== "*");
  return [...new Set(tags)];
}

async function renderedLeafMarkerSets(): Promise<{ markers: Set<string>; tags: Set<string> }> {
  const markers = new Set<string>();
  const tags = new Set<string>();
  for (const path of LEAF_PATHS) {
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    // Markers must come from rendered elements: the inlined <style> block
    // itself mentions testids (e.g. [data-testid='faq-list']) that never
    // render on these pages, so strip style/script text before extracting.
    const markup = html
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<script>[\s\S]*?<\/script>/g, "");
    for (const m of markup.matchAll(/<([a-zA-Z][\w-]*)/g)) {
      const tag = m[1]?.toLowerCase();
      if (tag) tags.add(tag);
    }
    for (const m of markup.matchAll(/class="([^"]*)"/g)) {
      for (const cls of (m[1] ?? "").split(/\s+/)) if (cls) markers.add(cls);
    }
    for (const m of markup.matchAll(/id="([^"]*)"/g)) {
      if (m[1]) markers.add(m[1]);
    }
    for (const m of markup.matchAll(/data-testid=(["'])([^"']+)\1/g)) {
      if (m[2]) markers.add(m[2]);
    }
  }
  return { markers, tags };
}

describe("content-leaf inlined CSS", () => {
  it("matches the builder output byte for byte (regen: node ci/build-leaf-css.mjs)", () => {
    expect(LEAF_CRITICAL_CSS).toBe(build().css);
  });

  it("carries the sha256 of exactly those bytes", () => {
    expect(LEAF_CRITICAL_CSS_SHA256).toBe(
      createHash("sha256").update(LEAF_CRITICAL_CSS, "utf8").digest("base64"),
    );
  });

  it("stays small enough to keep style & layout cost near the pre-regression floor", () => {
    expect(LEAF_CRITICAL_CSS.length).toBeLessThanOrEqual(SUBSET_BUDGET_BYTES);
    expect(build().css.length).toBeLessThanOrEqual(SUBSET_BUDGET_BYTES);
  });

  it("cannot break out of its style element", () => {
    expect(LEAF_CRITICAL_CSS).not.toMatch(/<\/style/i);
  });

  it("renders in the content shell instead of render-blocking links", () => {
    const html = Layout({ title: "Fixture", theme: "content" })!.toString();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toMatch(/<link(?=[^>]*rel="preload")(?=[^>]*as="style")/);
    // The display font is still preloaded for headings and navigation.
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
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

  it.each(LEAF_PATHS)("%s serves the inlined block under a hash-allowlisted CSP", async (path) => {
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("drops only selectors proven dead on the rendered leaves", async () => {
    expect(DROP_SELECTORS.length).toBeGreaterThan(0);
    const { markers, tags } = await renderedLeafMarkerSets();
    for (const entry of DROP_SELECTORS) {
      const sep = entry.indexOf(" || ");
      const selector = sep === -1 ? entry : entry.slice(sep + 4);
      // The builder canonicalizes before matching; the guard must use the
      // same form so it protects exactly what is dropped.
      const canon = canonSelector(selector);
      const markerComponents = requiredMarkers(canon);
      const tagComponents = requiredTags(canon);
      expect(
        [...markerComponents, ...tagComponents],
        `DROP entry has no guardable component (class/id/testid/tag): ${entry}`,
      ).not.toHaveLength(0);
      const missingMarkers = markerComponents.filter((c) => !markers.has(c));
      const missingTags = tagComponents.filter((t) => !tags.has(t));
      expect(
        [...missingMarkers, ...missingTags],
        `DROP entry may match a rendered leaf (all components present): ${entry}`,
      ).not.toHaveLength(0);
    }
  });
});
