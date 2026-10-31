import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMachineContractFixture } from "./machine-contract-fixture";

const repo = fileURLToPath(new URL("../", import.meta.url));
const guide = readFileSync(join(repo, "docs/machine-interface.md"), "utf8");
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.includes("DATABASE_URL") || name.startsWith("PG")) delete env[name];
}

describe("compiled machine contract fixture", () => {
  let root: string;
  let checker: string;
  let schema: string;
  let originalSchema: string;
  beforeAll(() => {
    root = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "machine-bundle-equivalence-"),
    );
    for (const dir of ["ci", "src"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
    mkdirSync(join(root, "docs"));
    for (const file of ["package.json", "tsconfig.json"])
      copyFileSync(join(repo, file), join(root, file));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
    checker = join(root, "ci/check-machine-contract.mjs");
    copyFileSync(checker, join(root, "ci/source-machine-contract.mjs"));
    schema = join(root, "src/mcp/output-schemas.ts");
    originalSchema = readFileSync(schema, "utf8");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function compare(expectedStatus: number) {
    const options = {
      cwd: root,
      env,
      encoding: "utf8" as const,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    };
    const source = spawnSync(
      process.execPath,
      ["--import", "tsx", "ci/source-machine-contract.mjs", "--format", "json"],
      options,
    );
    const bundle = spawnSync(
      process.execPath,
      ["ci/check-machine-contract.mjs", "--format", "json"],
      options,
    );
    expect(source.error).toBeUndefined();
    expect(bundle.error).toBeUndefined();
    expect(source.status).toBe(expectedStatus);
    expect({ status: bundle.status, stdout: bundle.stdout, stderr: bundle.stderr }).toEqual({
      status: source.status,
      stdout: source.stdout,
      stderr: source.stderr,
    });
  }

  it("preserves canonical, invalid and hidden Markdown guide results", () => {
    compileMachineContractFixture(root);
    for (const [text, status] of [
      [guide, 0],
      [`${guide}\nEvent collection responses contain 30 rows-per-response.\n`, 1],
      [`${guide}\n<!-- Event collection responses contain 30 rows-per-response. -->\n`, 0],
    ] as const) {
      writeFileSync(join(root, "docs/machine-interface.md"), text);
      compare(status);
    }
  });

  it("rebuilds actual changed schemas and preserves their failure receipt", () => {
    const marker = "  title: z.string(),";
    expect(originalSchema).toContain(marker);
    writeFileSync(schema, originalSchema.replace(marker, "  title: z.number(),"));
    copyFileSync(join(root, "ci/source-machine-contract.mjs"), checker);
    compileMachineContractFixture(root);
    writeFileSync(join(root, "docs/machine-interface.md"), guide);
    compare(1);
    writeFileSync(schema, originalSchema);
  });

  it("refuses new source location or cwd dependencies without overwriting the checker", () => {
    for (const probe of ["void import.meta.url;", "process.cwd();", "void __dirname;"]) {
      writeFileSync(schema, `${originalSchema}\n${probe}\n`);
      copyFileSync(join(root, "ci/source-machine-contract.mjs"), checker);
      const before = readFileSync(checker, "utf8");
      expect(() => compileMachineContractFixture(root)).toThrow(/Unsupported/);
      expect(readFileSync(checker, "utf8")).toBe(before);
    }
    writeFileSync(schema, originalSchema);
    const source = readFileSync(join(root, "ci/source-machine-contract.mjs"), "utf8");
    const changedRoot = source.replace(
      'new URL("../", import.meta.url)',
      'new URL("../../", import.meta.url)',
    );
    expect(changedRoot).not.toBe(source);
    writeFileSync(checker, changedRoot);
    expect(() => compileMachineContractFixture(root)).toThrow(/Unsupported/);
    expect(readFileSync(checker, "utf8")).toBe(changedRoot);
  });
});
