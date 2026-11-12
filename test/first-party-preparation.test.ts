// Exercise the named preparation commands in a disposable source tree. The
// working checkout's generated CSS and tracked adapters must never be modified.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function withSourceTree(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "first-party-preparation-"));
  try {
    for (const path of [
      "assets",
      "public",
      "vendor/design-kit",
      "web/src",
      "ci/build-ember-tokens.mjs",
      "ci/build-leaf-css.mjs",
      "package.json",
      ".npmrc",
      "web/package.json",
      "web/.npmrc",
      "src/ember-fallback-style.ts",
    ]) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("first-party preparation in a fresh source tree", () => {
  for (const workspace of [".", "web"]) {
    it(`generates missing critical CSS from ${workspace} and refuses token drift`, () => {
      withSourceTree((dir) => {
        const generated = join(dir, "src/leaf-critical-css.ts");
        expect(existsSync(generated)).toBe(false);
        const cwd = join(dir, workspace);
        execFileSync("npm", ["run", "generate:first-party"], { cwd, stdio: "pipe" });
        expect(existsSync(generated)).toBe(true);

        rmSync(generated);
        writeFileSync(join(dir, "public/theme-tokens.css"), "/* deliberate drift */\n");
        const failed = spawnSync("npm", ["run", "generate:first-party"], {
          cwd,
          encoding: "utf8",
        });
        expect(failed.error).toBeUndefined();
        expect(failed.status).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toMatch(/drift|out.of.date|generated/i);
        expect(existsSync(generated)).toBe(false);
      });
    });
  }
});
