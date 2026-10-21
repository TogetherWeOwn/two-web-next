import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Acceptance: the connection helper refuses flag-shaped output paths with a
// usage error and exit 2, never invoking pg_dump and never creating a file.
// Valid paths, missing argv and invalid URLs keep their existing behavior.
// Offline only: stubbed pg_dump, synthetic URLs, scratch cwd, no credentials.

const SYNTHETIC_URL = "postgres://tester@fake-host:5432/testdb";
const HELPER = join(process.cwd(), "bin/backup/connection-helper");

function setup() {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "conn-helper-argv-"),
  );
  const fakebin = join(root, "fakebin");
  const workdir = join(root, "work");
  const callLog = join(root, "calls.log");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(callLog, "");
  const pgDump = `#!/usr/bin/env bash\necho "pg_dump $*" >> "$CALL_LOG"\nout=""; prev=""; for a in "$@"; do if [ "$prev" = "-f" ]; then out="$a"; fi; prev="$a"; done\n[ -n "$out" ] || { echo "fake pg_dump: no -f" >&2; exit 2; }\nprintf 'FAKEDUMP-payload\\n' > "$out"\n`;
  writeFileSync(join(fakebin, "pg_dump"), pgDump, { mode: 0o755 });
  return { root, fakebin, workdir, callLog };
}

function run(
  setupPaths: { fakebin: string; workdir: string; callLog: string },
  args: string[],
  databaseUrl: string | null = SYNTHETIC_URL,
) {
  return spawnSync("python3", [HELPER, ...args], {
    encoding: "utf8",
    timeout: 10000,
    cwd: setupPaths.workdir,
    env: {
      PATH: `${setupPaths.fakebin}:${process.env.PATH}`,
      CALL_LOG: setupPaths.callLog,
      ...(databaseUrl === null ? {} : { DATABASE_URL: databaseUrl }),
    },
  });
}

function calls(callLog: string) {
  return existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
}

describe("connection-helper argv acceptance", () => {
  it.each([["--help"], ["-h"], ["--output"], ["-f"], ["--foo"], ["-"]])(
    "refuses flag-shaped output path %s with exit 2 and no pg_dump",
    (...args: string[]) => {
      const { root, workdir, callLog, ...paths } = setup();
      try {
        const result = run({ ...paths, workdir, callLog }, args);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/usage|output file|refus|flag/i);
        expect(result.stdout).toBe("");
        expect(calls(callLog)).toBe("");
        for (const name of args) {
          expect(existsSync(join(workdir, name))).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([["not-a-url"], [null]])(
    "refuses flag-shaped path before credential validation (DATABASE_URL=%s)",
    (databaseUrl: string | null) => {
      const { root, workdir, callLog, ...paths } = setup();
      try {
        const result = run({ ...paths, workdir, callLog }, ["--help"], databaseUrl);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(2);
        expect(result.stderr).toContain("flag-shaped path");
        expect(result.stdout).toBe("");
        expect(calls(callLog)).toBe("");
        expect(existsSync(join(workdir, "--help"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("control: a valid output path still dumps through pg_dump", () => {
    const { root, workdir, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, workdir, callLog }, ["out.dump"]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(calls(callLog)).toContain("pg_dump");
      expect(readFileSync(join(workdir, "out.dump"), "utf8")).toContain("FAKEDUMP-payload");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: missing argv still exits 2 without pg_dump", () => {
    const { root, workdir, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, workdir, callLog }, []);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("output file");
      expect(calls(callLog)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control: invalid DATABASE_URL still exits 1 without pg_dump", () => {
    const { root, workdir, callLog, ...paths } = setup();
    try {
      const result = run({ ...paths, workdir, callLog }, ["out.dump"], "not-a-url");
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing");
      expect(result.stdout).toBe("");
      expect(calls(callLog)).toBe("");
      expect(existsSync(join(workdir, "out.dump"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
