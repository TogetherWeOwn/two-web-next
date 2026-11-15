import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceRules, SOURCE_GLOB } from "../web/scripts/tailwind-projection-directives.mjs";

const sourceDir = resolve("fixture-source");
const mirror = "../.svelte-kit/tailwind-projection/";

describe("Kit projection source directives", () => {
  it("maps literal exclusions to source paths and leaves inline exclusions alone", () => {
    const css = `${SOURCE_GLOB}\n@source not "${mirror}excluded";\n@source not "${mirror}one/Card.svelte";\n@source not inline("foo");`;
    expect(readSourceRules(css, sourceDir)).toEqual([
      resolve(sourceDir, "excluded"),
      resolve(sourceDir, "one/Card.svelte"),
    ]);
  });

  it("ignores directives inside comments and quoted strings", () => {
    const css = `${SOURCE_GLOB}\n/* @source not "../outside"; */\n.a { content: '@source not "../outside";'; }`;
    expect(readSourceRules(css, sourceDir)).toEqual([]);
    expect(() => readSourceRules(`/* ${SOURCE_GLOB} */`, sourceDir)).toThrow(/exactly one/);
    expect(() => readSourceRules(`.a { content: '${SOURCE_GLOB}'; }`, sourceDir)).toThrow(
      /exactly one/,
    );
  });

  it("requires exactly one real projection glob", () => {
    expect(() => readSourceRules("", sourceDir)).toThrow(/exactly one/);
    expect(() => readSourceRules(`${SOURCE_GLOB}\n${SOURCE_GLOB}`, sourceDir)).toThrow(
      /exactly one/,
    );
  });

  it("rejects incomplete or comment-separated exclusions", () => {
    for (const directive of [
      `@source not "${mirror}excluded"`,
      `@source /* reason */ not "${mirror}excluded";`,
    ]) {
      expect(() => readSourceRules(`${SOURCE_GLOB}\n${directive}`, sourceDir)).toThrow(
        /unsupported @source not/,
      );
    }
  });

  it("rejects unsupported, outside and escaping exclusions", () => {
    for (const arg of [
      `'${mirror}excluded'`,
      `"${mirror}*.svelte"`,
      `"${mirror}{one,two}"`,
      '"../outside"',
      `"${mirror}../outside"`,
      `"${mirror}"`,
    ]) {
      expect(() => readSourceRules(`${SOURCE_GLOB}\n@source not ${arg};`, sourceDir)).toThrow(
        /tailwind-projection:/,
      );
    }
  });
});
