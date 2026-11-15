import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("assets/theme.css", "utf8");
const served = readFileSync("public/theme.css", "utf8");
const latinRange =
  "U+0-FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

function contentFace(css: string) {
  return (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).filter((face) =>
    /font-family\s*:\s*['"]?Mona Sans Content['"]?\s*;/.test(face),
  );
}

describe("optional content font registration", () => {
  it("registers the same unused optional face in source and served CSS", () => {
    for (const css of [source, served]) {
      const faces = contentFace(css);
      expect(faces).toHaveLength(1);
      const face = faces[0] ?? "";
      expect(face).toMatch(/font-weight\s*:\s*200\s+900\s*;/);
      expect(face).toMatch(/font-display\s*:\s*optional\s*;/);
      expect(face).toMatch(
        /src\s*:\s*url\(['"]?\/fonts\/mona-sans-latin-wght\.woff2['"]?\)\s*format\(['"]?woff2['"]?\)\s*;/,
      );
      const range = face.match(/unicode-range\s*:\s*([^;}]+)/)?.[1];
      expect(range?.replace(/\s/g, "").toUpperCase()).toBe(
        latinRange.replace(/\s/g, "").toUpperCase(),
      );
      expect(css.replace(face, "")).not.toContain("Mona Sans Content");
    }
  });

  it("uses only the existing font files", () => {
    expect(
      readdirSync("public/fonts")
        .filter((file) => file.endsWith(".woff2"))
        .sort(),
    ).toEqual([
      "fragment-mono-latin-400.woff2",
      "instrument-serif-latin-400-italic.woff2",
      "mona-sans-latin-var.woff2",
      "mona-sans-latin-wght.woff2",
    ]);
    expect(readFileSync("public/fonts/mona-sans-latin-wght.woff2").length).toBeGreaterThan(0);
  });
});
