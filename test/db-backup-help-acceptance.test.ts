import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Acceptance: db-backup answers --help with stdout usage and exit 0, handled
// before branch, credential or storage checks, while every existing refusal
// and exit code stays unchanged. External commands are PATH stubs logging to
// a call file; an empty log plus an empty stub bucket proves no work. Offline
// only: stubbed pg_dump and wrangler, synthetic URLs, no R2, no network.

const REAL_MKTEMP = "/usr/bin/mktemp";

function setup() {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "dbbackup-help-"),
  );
  const fakebin = join(root, "fakebin");
  const bucket = join(root, "r2");
  const callLog = join(root, "calls.log");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(bucket, { recursive: true });
  writeFileSync(callLog, "");
  const pgDump = `#!/usr/bin/env bash\necho "pg_dump $*" >> "$CALL_LOG"\nout=""; prev=""; for a in "$@"; do if [ "$prev" = "-f" ]; then out="$a"; fi; prev="$a"; done\n[ -n "$out" ] || { echo "fake pg_dump: no -f" >&2; exit 2; }\nprintf 'FAKEDUMP-payload\\n' > "$out"\n`;
  writeFileSync(join(fakebin, "pg_dump"), pgDump, { mode: 0o755 });
  writeFileSync(
    join(fakebin, "psql"),
    `#!/usr/bin/env bash\necho "psql $*" >> "$CALL_LOG"\nexit 0\n`,
    {
      mode: 0o755,
    },
  );
  writeFileSync(
    join(fakebin, "mktemp"),
    `#!/usr/bin/env bash\necho "mktemp $*" >> "$CALL_LOG"\nexec "${REAL_MKTEMP}" "$@"\n`,
    { mode: 0o755 },
  );
  const wrangler = `#!/usr/bin/env bash\nset -euo pipefail\necho "wrangler $*" >> "$CALL_LOG"\nexit 0\n`;
  const wranglerBin = join(root, "wrangler-stub");
  writeFileSync(wranglerBin, wrangler, { mode: 0o755 });
  return { root, fakebin, bucket, callLog, wranglerBin };
}

function run(
  setupPaths: { fakebin: string; callLog: string; wranglerBin: string },
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", ["bin/db-backup.sh", ...args], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      PATH: `${setupPaths.fakebin}:${process.env.PATH}`,
      CALL_LOG: setupPaths.callLog,
      WRANGLER_BIN: setupPaths.wranglerBin,
      BACKUP_BUCKET: "test-bucket",
      BACKUP_PREFIX: "neon",
      ...extraEnv,
    },
  });
}

function calls(callLog: string) {
  return existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
}

function bucketHasFiles(bucket: string) {
  const found = spawnSync("find", [bucket, "-type", "f", "-print", "-quit"], { encoding: "utf8" });
  return (found.stdout || "").trim() !== "";
}

describe("db-backup help acceptance", () => {
  it("--help exits 0 with stdout usage and zero side effects", () => {
    const { root, bucket, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["--help"]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/usage:/);
      expect(result.stdout).toMatch(/backup/);
      expect(calls(callLog)).toBe("");
      expect(bucketHasFiles(bucket)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--help is handled before branch-target refusal", () => {
    const { root, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["--help"], { BACKUP_TARGET: "invalid" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/usage:/);
      expect(calls(callLog)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--help needs no DATABASE_URL", () => {
    const { root, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["--help"], { BACKUP_TARGET: "staging" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/usage:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: missing command still exits 2 with stderr usage", () => {
    const { root, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, []);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/usage:/);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: unknown command still exits 2 with stderr usage", () => {
    const { root, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["frobnicate"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/usage:/);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: unknown flag still exits 2 before any work", () => {
    const { root, bucket, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["backup", "staging", "--invalid-flag"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/unknown flag/);
      expect(result.stderr).toMatch(/usage:/);
      expect(result.stdout).toBe("");
      expect(calls(callLog)).toBe("");
      expect(bucketHasFiles(bucket)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: backup --dry-run still exits 2 with usage and zero side effects", () => {
    const { root, bucket, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["backup", "staging", "--dry-run"]);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(1);
      expect(result.stderr).toMatch(/--dry-run/);
      expect(result.stderr).toMatch(/usage:/);
      expect(calls(callLog)).toBe("");
      expect(bucketHasFiles(bucket)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: backup without DATABASE_URL still exits 1", () => {
    const { root, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, callLog }, ["backup", "staging"], {
        BACKUP_TARGET: "staging",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("DATABASE_URL is unset");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
