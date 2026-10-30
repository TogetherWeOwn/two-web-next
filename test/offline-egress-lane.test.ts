import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps hermetic egress proofs while excluding the PostgreSQL groups only offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "offline-egress-lane-"));
  try {
    const receipt = join(dir, "receipt.json");
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      `#!${process.execPath}\n` +
        `const fs = require('node:fs');\n` +
        `if (process.argv[2] === 'run' && process.argv[3] === 'test') {\n` +
        `  fs.writeFileSync(process.env.RECEIPT, JSON.stringify({args: process.argv.slice(4), db: process.env.DATABASE_URL ?? null}));\n` +
        `  process.exit(7);\n` +
        `}\n`,
    );
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, ["ci/offline-check.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RECEIPT: receipt },
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    const invocation = JSON.parse(readFileSync(receipt, "utf8")) as {
      args: string[];
      db: string | null;
    };
    expect(invocation.db).toBeNull();
    const index = invocation.args.indexOf("--testNamePattern");
    expect(index).toBeGreaterThanOrEqual(0);
    const pattern = new RegExp(invocation.args[index + 1]!);
    expect(pattern.test("stored-text SQL boundary (hermetic) EGRESS-TEXT-01")).toBe(true);
    expect(pattern.test("stored-text admission through real PostgreSQL EGRESS-TEXT-04")).toBe(
      false,
    );
    expect(
      pattern.test(
        "documented stored-text byte boundaries through PostgreSQL EGRESS-BOUNDARY-feed",
      ),
    ).toBe(false);
    expect(pattern.test("another unrelated suite remains runnable")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
