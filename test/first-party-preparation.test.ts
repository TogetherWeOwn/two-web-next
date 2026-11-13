// Exercise the named preparation commands in a disposable source tree. The
// working checkout's generated CSS and tracked adapters must never be modified.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
      "ci/build-events-css.mjs",
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

describe("production target preparation", () => {
  it("supports old targets and fails closed when preparation fails", () => {
    const workflow = readFileSync(join(root, ".github/workflows/deploy-production.yml"), "utf8");
    const step = workflow.match(
      /- name: Prepare first-party generated inputs\n(?:        #.*\n)*        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(step).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "production-preparation-"));
    try {
      const marker = (value: string) =>
        `node -e "require('fs').writeFileSync('prepared', '${value}')"`;
      for (const [scripts, expected, status] of [
        [{ "generate:first-party": marker("modern"), postinstall: marker("legacy") }, "modern", 0],
        [{ postinstall: marker("legacy") }, "legacy", 0],
        [
          { "generate:first-party": "node -e 'process.exit(1)'", postinstall: marker("legacy") },
          "",
          1,
        ],
        [{ postinstall: "node -e 'process.exit(1)'" }, "", 1],
        [{}, "", 0],
      ] as const) {
        rmSync(join(dir, "prepared"), { force: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }));
        const result = spawnSync("bash", ["-e", "-c", step ?? ""], { cwd: dir, encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(status);
        expect(
          existsSync(join(dir, "prepared")) ? readFileSync(join(dir, "prepared"), "utf8") : "",
        ).toBe(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("first-party preparation in a fresh source tree", () => {
  for (const workspace of [".", "web"]) {
    it(`generates missing critical CSS from ${workspace} and refuses token drift`, () => {
      withSourceTree((dir) => {
        const generated = join(dir, "src/leaf-critical-css.ts");
        const eventsGenerated = join(dir, "src/events-critical-css.ts");
        expect(existsSync(generated)).toBe(false);
        expect(existsSync(eventsGenerated)).toBe(false);
        const cwd = join(dir, workspace);
        execFileSync("npm", ["run", "generate:first-party"], { cwd, stdio: "pipe" });
        expect(existsSync(generated)).toBe(true);
        expect(existsSync(eventsGenerated)).toBe(true);

        rmSync(generated);
        rmSync(eventsGenerated);
        writeFileSync(join(dir, "public/theme-tokens.css"), "/* deliberate drift */\n");
        const failed = spawnSync("npm", ["run", "generate:first-party"], {
          cwd,
          encoding: "utf8",
        });
        expect(failed.error).toBeUndefined();
        expect(failed.status).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toMatch(/drift|out.of.date|generated/i);
        expect(existsSync(generated)).toBe(false);
        expect(existsSync(eventsGenerated)).toBe(false);
      });
    });
  }
});
