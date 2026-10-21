import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Acceptance: the bootstrap installer answers --help/-h with usage and zero
// side effects, and refuses any other argument before sudo, network or temp
// work. Every external the script can reach is a PATH stub logging to a call
// file, so an empty log proves no work happened. Offline only: no apt, no
// keyring writes, no network, no credentials.

const REAL_MKTEMP = "/usr/bin/mktemp";
const STUBBED = ["sudo", "apt-get", "curl", "gpg", "install", "mv", "rm", "lsb_release", "pg_dump"];

function setup() {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "bootstrap-help-"),
  );
  const fakebin = join(root, "fakebin");
  const callLog = join(root, "calls.log");
  writeFileSync(callLog, "");
  mkdirSync(fakebin, { recursive: true });
  // Logging stubs: record argv, then succeed without doing work. mktemp and rm
  // forward to the real binaries so a no-arg control run can proceed through
  // its temp-dir setup and trap cleanup safely inside scratch.
  for (const name of STUBBED) {
    const body =
      name === "rm"
        ? `#!/usr/bin/env bash\necho "${name} $*" >> "$CALL_LOG"\nexec "${REAL_MKTEMP.replace("mktemp", "rm")}" "$@"\n`
        : `#!/usr/bin/env bash\necho "${name} $*" >> "$CALL_LOG"\nexit 0\n`;
    const path = join(fakebin, name);
    writeFileSync(path, body, { mode: 0o755 });
  }
  const mktempStub = `#!/usr/bin/env bash\necho "mktemp $*" >> "$CALL_LOG"\nexec "${REAL_MKTEMP}" "$@"\n`;
  writeFileSync(join(fakebin, "mktemp"), mktempStub, { mode: 0o755 });
  return { root, fakebin, callLog };
}

function run(fakebin: string, callLog: string, root: string, args: string[]) {
  return spawnSync("bash", ["bin/backup-bootstrap.sh", ...args], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      PATH: `${fakebin}:${process.env.PATH}`,
      CALL_LOG: callLog,
      PGDG_KEYRING: join(root, "pgdg.gpg"),
      PGDG_SOURCE_LIST: join(root, "pgdg.list"),
      PGDG_CLIENT_BIN: join(root, "client18"),
    },
  });
}

function calls(callLog: string) {
  return existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
}

describe("backup-bootstrap help and argv acceptance", () => {
  it.each([["--help"], ["-h"]])(
    "%s exits 0 with usage and zero side effects",
    (...args: string[]) => {
      const { root, fakebin, callLog } = setup();
      try {
        const result = run(fakebin, callLog, root, args);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/usage/i);
        expect(calls(callLog)).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([["bogus-arg"], ["--dry-run"], ["-x"], ["backup"]])(
    "refuses %s before sudo, network or temp work",
    (...args: string[]) => {
      const { root, fakebin, callLog } = setup();
      try {
        const result = run(fakebin, callLog, root, args);
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/usage|refus|unknown|invalid/i);
        expect(calls(callLog)).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("control: a no-arg run reaches temp and privilege setup (spies are wired)", () => {
    const { root, fakebin, callLog } = setup();
    try {
      const result = run(fakebin, callLog, root, []);
      expect(result.error).toBeUndefined();
      const log = calls(callLog);
      expect(log).toContain("mktemp");
      expect(log).toContain("sudo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
