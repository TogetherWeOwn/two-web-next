import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../src/pages";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import type { Env } from "../src/env";
import app from "./app";

const cssPath = (entry: string) =>
  readFileSync(new URL(`../public/${entry}`, import.meta.url), "utf8");
const SOURCES = ["styles.css", "theme-tokens.css", "theme.css"];

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
  it.each([
    [
      "repeated tokens and escaped text",
      ['.base-theme .base-theme { content: "雪\\\\path"; }\n', "a {}", "b {}\n"],
      true,
    ],
    ["no tokens", ["a {}", "b {}", "c {}"], true],
    ["sentinel collision", [".base-theme ~ p {}", "b {}", "c {}"], false],
  ])("executes generated initializer for %s", (_name, sources, packed) => {
    const dir = mkdtempSync(join(tmpdir(), "leaf-css-generator-"));
    try {
      for (const sub of ["ci", "public", "src"]) mkdirSync(join(dir, sub));
      writeFileSync(
        join(dir, "ci/build-leaf-css.mjs"),
        readFileSync(new URL("../ci/build-leaf-css.mjs", import.meta.url)),
      );
      SOURCES.forEach((entry, i) => writeFileSync(join(dir, "public", entry), sources[i]!));
      execFileSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")], { timeout: 10000 });
      const generated = readFileSync(join(dir, "src/leaf-critical-css.ts"), "utf8");
      expect(generated.includes('.split("~").join(".base-theme")')).toBe(packed);
      // This fixture runs only generator-produced code; security readers never evaluate it.
      const js = generated.replaceAll(": string =", " =");
      const modulePath = join(dir, "src/fixture.mjs");
      writeFileSync(modulePath, js);
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from ${JSON.stringify(new URL(`file://${modulePath}`).href)}; console.log(JSON.stringify([LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256]));`,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      const css = sources.join("\n");
      expect(JSON.parse(output)).toEqual([
        css,
        createHash("sha256").update(css, "utf8").digest("base64"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a closing style tag in generator input", () => {
    const dir = mkdtempSync(join(tmpdir(), "leaf-css-generator-"));
    try {
      for (const sub of ["ci", "public", "src"]) mkdirSync(join(dir, sub));
      writeFileSync(
        join(dir, "ci/build-leaf-css.mjs"),
        readFileSync(new URL("../ci/build-leaf-css.mjs", import.meta.url)),
      );
      SOURCES.forEach((entry, i) =>
        writeFileSync(join(dir, "public", entry), i === 1 ? "</StYlE>" : "a {}"),
      );
      const result = spawnSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")], {
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to inline CSS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches the three concatenated stylesheets byte for byte", () => {
    const concatenated = SOURCES.map(cssPath).join("\n");
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
