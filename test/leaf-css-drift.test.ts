import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLeafModule } from "../ci/leaf-css-parser.mjs";
import { decodeCssDictionary } from "../src/css-dictionary";
import { Layout } from "../src/pages";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import type { Env } from "../src/env";
import app from "./app";

const cssPath = (entry: string) =>
  readFileSync(new URL(`../public/${entry}`, import.meta.url), "utf8");
const SOURCES = ["styles.css", "theme-tokens.css", "theme.css"];
const REPEATED = ".card-title { margin: 0 auto; }\n".repeat(12);
const SHA = "A".repeat(43) + "=";

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
    ["repeated rules", [REPEATED, REPEATED, REPEATED], true],
    ["former sentinel", [".base-theme ~ p {}", "b {}", "c {}"], true],
    ["reserved marker character", ["a {}", "b \u0080 {}", "c {}"], false],
    ["last reserved marker boundary", ["a {}", "b \u00cf {}", "c {}"], false],
    ["oversized input", ["a {}\n".repeat(20_001), "b {}", "c {}"], false],
  ])("executes generated initializer for %s", (_name, sources, packed) => {
    const dir = mkdtempSync(join(tmpdir(), "leaf-css-generator-"));
    try {
      for (const sub of ["ci", "public", "src"]) mkdirSync(join(dir, sub));
      for (const file of ["build-leaf-css.mjs", "css-dictionary.mjs"]) {
        writeFileSync(
          join(dir, "ci", file),
          readFileSync(new URL(`../ci/${file}`, import.meta.url)),
        );
      }
      SOURCES.forEach((entry, i) => writeFileSync(join(dir, "public", entry), sources[i]!));
      execFileSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")], { timeout: 10000 });
      const generated = readFileSync(join(dir, "src/leaf-critical-css.ts"), "utf8");
      expect(generated.includes("decodeCssDictionary(")).toBe(packed);
      expect(generated).not.toContain('.split("~")');
      const css = sources.join("\n");
      const sha256 = createHash("sha256").update(css, "utf8").digest("base64");
      // The CI reader and the generator must agree without evaluating generated code.
      expect(parseLeafModule(generated)).toEqual({ css, sha256 });
      if (packed) {
        // Runtime decoder run over the generator's literal arguments.
        const call = /decodeCssDictionary\(("(?:[^"\\]|\\.)*"), (\[.*\])\);\n/.exec(generated);
        expect(call).not.toBeNull();
        const dictionary = JSON.parse(call![2]!) as string[];
        expect(decodeCssDictionary(JSON.parse(call![1]!), dictionary)).toBe(css);
        if (_name === "repeated rules") expect(dictionary.length).toBeGreaterThan(0);
        return;
      }
      // This fixture runs only generator-produced literal code; security readers never evaluate it.
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
      expect(JSON.parse(output)).toEqual([css, sha256]);
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

  describe("dictionary-packed module parser", () => {
    const quote = (value: string) => JSON.stringify(value);
    const module = (
      packed: string,
      dictionary: string[],
      { header = "", sha = SHA, tail = "" } = {},
    ) =>
      `${header}import { decodeCssDictionary } from "./css-dictionary";\n` +
      `export const LEAF_CRITICAL_CSS: string =\n  decodeCssDictionary(${quote(packed)}, ${JSON.stringify(dictionary)});\n` +
      `export const LEAF_CRITICAL_CSS_SHA256: string = ${quote(sha)};\n${tail}`;

    it("expands dictionary markers and leaves ordinary text alone", () => {
      expect(parseLeafModule(module("\u0080雪😀\u0081\u0080", ["a { b", " c }"]))).toEqual({
        css: "a { b雪😀 c }a { b",
        sha256: SHA,
      });
      expect(parseLeafModule(module("", []))).toEqual({ css: "", sha256: SHA });
      expect(parseLeafModule(module("\u00d0\u007f", []))).toEqual({
        css: "\u00d0\u007f",
        sha256: SHA,
      });
    });

    it("accepts comment headers and the exact dictionary limits", () => {
      const dictionary = Array.from({ length: 80 }, (_, i) => `e${String(i).padStart(3, "0")}`);
      const packed = Array.from({ length: 80 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
      expect(
        parseLeafModule(module(packed, dictionary, { header: "// GENERATED x\n// y\n" }))?.css,
      ).toBe(dictionary.join(""));
      expect(parseLeafModule(module("x", ["a".repeat(24)]))?.css).toBe("x");
      expect(parseLeafModule(module("x".repeat(100_000), []))?.css).toHaveLength(100_000);
    });

    it.each([
      ["entry shorter than four characters", module("\u0080", ["abc"])],
      ["entry longer than 24 characters", module("\u0080", ["a".repeat(25)])],
      ["non-ASCII entry", module("\u0080", ["abc雪"])],
      ["control character entry", module("\u0080", ["abc\u0007"])],
      ["entry containing a marker", module("\u0080", ["abc\u0081"])],
      [
        "more than 80 entries",
        module(
          "x",
          Array.from({ length: 81 }, () => "abcd"),
        ),
      ],
      ["marker without an entry", module("\u0080", [])],
      ["marker past the last entry", module("\u0081", ["abcd"])],
      ["packed text over 100000 characters", module("x".repeat(100_001), [])],
      ["expansion over 100000 characters", module("\u0080".repeat(4_200), ["a".repeat(24)])],
      ["short hash", module("x", [], { sha: "A".repeat(42) + "=" })],
      ["unpadded hash", module("x", [], { sha: "A".repeat(44) })],
      ["hash with a newline", module("x", [], { sha: `${"A".repeat(42)}\n=` })],
      ["trailing code", module("x", [], { tail: "globalThis.pwned = 1;\n" })],
      ["missing trailing newline", module("x", []).slice(0, -1)],
      ["CRLF line endings", module("x", []).replaceAll("\n", "\r\n")],
      ["extra leading statement", module("x", [], { header: "globalThis.pwned = 1;\n" })],
      ["comment header with CR", module("x", [], { header: "// a\rglobalThis.pwned = 1;\n" })],
      [
        "comment header with U+2028",
        module("x", [], { header: "// a\u2028globalThis.pwned = 1;\n" }),
      ],
      [
        "comment header with U+2029",
        module("x", [], { header: "// a\u2029globalThis.pwned = 1;\n" }),
      ],
      ["different import path", module("x", []).replace("./css-dictionary", "./other")],
      ["different decoder", module("x", []).replace("decodeCssDictionary(", "evil(")],
      ["extra decoder argument", module("x", []).replace("[]);", "[], 1);")],
      ["expression after the call", module("x", []).replace("[]);", "[]) + evil;")],
      ["template literal packed text", module("x", []).replace('"x"', "`x`")],
      ["invalid JSON escape", module("x", []).replace('"x"', '"\\x41"')],
      ["raw newline in packed text", module("x", []).replace('"x"', '"x\ny"')],
      ["unterminated packed text", module("x", []).replace('"x"', '"x')],
      ["non-array dictionary", module("x", []).replace("[]", '"abcd"')],
      ["dictionary with a non-string", module("x", []).replace("[]", "[1]")],
      ["dictionary with spaced commas", module("x", [], {}).replace("[]", '["abcd", "efgh"]')],
      ["both literal and dictionary forms", module("x", []).replace(");\n", ').split("~");\n')],
    ])("rejects %s", (_name, source) => {
      expect(parseLeafModule(source)).toBeNull();
    });

    it("still reads the literal form and rejects a mismatched decoder suffix", () => {
      const literal = (initializer: string) =>
        `export const LEAF_CRITICAL_CSS: string =\n  ${initializer};\nexport const LEAF_CRITICAL_CSS_SHA256: string = ${quote(SHA)};\n`;
      expect(parseLeafModule(literal(quote("a ~ b")))?.css).toBe("a ~ b");
      expect(parseLeafModule(literal(`${quote("a~b")}.split("~").join(".base-theme")`))?.css).toBe(
        "a.base-themeb",
      );
      expect(parseLeafModule(literal(`${quote("a~b")}.split("~").join(".other")`))).toBeNull();
    });
  });

  describe("committed snapshot", () => {
    const generated = () =>
      readFileSync(new URL("../src/leaf-critical-css.ts", import.meta.url), "utf8");

    it("parses without evaluation to the exported bytes and hash", () => {
      expect(parseLeafModule(generated())).toEqual({
        css: LEAF_CRITICAL_CSS,
        sha256: LEAF_CRITICAL_CSS_SHA256,
      });
    });

    it("is the dictionary-packed form decoded by the shipped decoder", () => {
      const source = generated();
      expect(source).toContain('import { decodeCssDictionary } from "./css-dictionary";');
      expect(source).not.toContain('.split("~")');
      const call = /decodeCssDictionary\(("(?:[^"\\]|\\.)*"), (\[.*\])\);\n/.exec(source);
      expect(call).not.toBeNull();
      const dictionary = JSON.parse(call![2]!) as string[];
      expect(dictionary.length).toBeGreaterThan(0);
      expect(decodeCssDictionary(JSON.parse(call![1]!), dictionary)).toBe(LEAF_CRITICAL_CSS);
    });

    it("is reproduced byte for byte by the generator", { timeout: 60000 }, () => {
      const dir = mkdtempSync(join(tmpdir(), "leaf-css-snapshot-"));
      try {
        for (const sub of ["ci", "public", "src"]) mkdirSync(join(dir, sub));
        for (const file of ["build-leaf-css.mjs", "css-dictionary.mjs"]) {
          writeFileSync(
            join(dir, "ci", file),
            readFileSync(new URL(`../ci/${file}`, import.meta.url)),
          );
        }
        for (const entry of SOURCES) writeFileSync(join(dir, "public", entry), cssPath(entry));
        execFileSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")], { timeout: 55000 });
        expect(readFileSync(join(dir, "src/leaf-critical-css.ts"), "utf8")).toBe(generated());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
