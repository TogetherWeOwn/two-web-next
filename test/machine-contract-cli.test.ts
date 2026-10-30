// The advertised CLI must not certify a missing or empty guide. Execute the
// real scanner/SDK in an isolated repository fixture, never truncate the guide.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url).href);

describe("standalone machine-contract CLI", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "machine-contract-"),
    );
    mkdirSync(join(root, "ci"));
    mkdirSync(join(root, "docs"));
    copyFileSync(
      join(repo, "ci/check-machine-contract.mjs"),
      join(root, "ci/check-machine-contract.mjs"),
    );
    copyFileSync(
      join(repo, "ci/machine-guide-prose.mjs"),
      join(root, "ci/machine-guide-prose.mjs"),
    );
    copyFileSync(join(repo, "package.json"), join(root, "package.json"));
    copyFileSync(join(repo, "tsconfig.json"), join(root, "tsconfig.json"));
    cpSync(join(repo, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const run = (guide: string | null) => {
    const path = join(root, "docs/machine-interface.md");
    if (guide === null) rmSync(path, { force: true });
    else writeFileSync(path, guide);
    return spawnSync(process.execPath, ["--import", "tsx", "ci/check-machine-contract.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
  };

  it("accepts the checked-in guide with the real schemas and SDK", () => {
    const result = run(readFileSync(join(repo, "docs/machine-interface.md"), "utf8"));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("machine-contract check passed:");
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t\n"],
    ["missing", null],
  ] as const)("rejects a %s guide with a failing CLI verdict", (_label, guide) => {
    const result = run(guide);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("machine-contract check FAILED:");
    expect(result.stdout).toContain("guide");
    expect(result.stdout).not.toContain("machine-contract check passed:");
  });
});
