import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps the offline Vitest stage unfiltered, including hermetic egress proofs", () => {
  const dir = mkdtempSync(join(tmpdir(), "offline-egress-lane-"));
  try {
    const receipt = join(dir, "receipt.json");
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      `#!${process.execPath}\n` +
        `const fs = require('node:fs');\n` +
        `if (process.argv[2] === 'run' && process.argv[3] === 'test') {\n` +
        `  fs.writeFileSync(process.env.RECEIPT, JSON.stringify({args: process.argv.slice(4), db: process.env.DATABASE_URL ?? null, auditDb: process.env.AUDIT_IMPORT_TEST_DATABASE_URL ?? null, legacyDb: process.env.LEGACY_DATABASE_URL ?? null, w1: process.env.W1_AGENT_TESTDB ?? null, pgPassword: process.env.PGPASSWORD ?? null}));\n` +
        `  process.exit(7);\n` +
        `}\n`,
    );
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, ["ci/offline-check.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RECEIPT: receipt,
        DATABASE_URL: "offline-egress-fixture",
        AUDIT_IMPORT_TEST_DATABASE_URL: "offline-egress-fixture",
        LEGACY_DATABASE_URL: "offline-egress-fixture",
        W1_AGENT_TESTDB: "offline-egress-fixture",
        PGPASSWORD: "offline-egress-fixture",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    const invocation = JSON.parse(readFileSync(receipt, "utf8")) as {
      args: string[];
      db: string | null;
      auditDb: string | null;
      legacyDb: string | null;
      w1: string | null;
      pgPassword: string | null;
    };
    expect(invocation.args).toEqual([]);
    expect(invocation.db).toBeNull();
    expect(invocation.auditDb).toBeNull();
    expect(invocation.legacyDb).toBeNull();
    expect(invocation.w1).toBeNull();
    expect(invocation.pgPassword).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
