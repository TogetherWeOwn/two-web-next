import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const inputs = [
  "public/styles.css",
  "public/theme-tokens.css",
  "public/theme.css",
  "web/src/lib/site-header.css",
];

describe("Kit header leaf stylesheet input", () => {
  it("scopes sticky positioning to Kit headers at compact widths", () => {
    const css = readFileSync(join(root, "web/src/lib/site-header.css"), "utf8");
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)/);
    expect(css).toMatch(/\[data-kit-site-header\]\s*\{\s*position:\s*sticky;\s*top:\s*0;/);
  });

  it.each(["valid", "missing", "unsafe"])("handles %s fourth input", (state) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-header-css-"));
    try {
      mkdirSync(join(dir, "ci"), { recursive: true });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "ci/build-leaf-css.mjs"), readFileSync(join(root, "ci/build-leaf-css.mjs")));
      const contents = ["a {}", "b {}", "c {}", state === "unsafe" ? "</StYlE>" : "d {}"];
      inputs.forEach((input, index) => {
        if (index === 3 && state === "missing") return;
        mkdirSync(join(dir, input, ".."), { recursive: true });
        writeFileSync(join(dir, input), contents[index]!);
      });
      const result = spawnSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (state !== "valid") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(state === "missing" ? "ENOENT" : "refusing to inline CSS");
      } else {
        expect(result.status, result.stderr).toBe(0);
        const generated = readFileSync(join(dir, "src/leaf-critical-css.ts"), "utf8");
        const css = contents.join("\n");
        expect(generated).toContain(JSON.stringify(css));
        expect(generated).toContain(createHash("sha256").update(css).digest("base64"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
