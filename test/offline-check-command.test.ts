import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(".");
const entry = join(root, "ci/offline-check.mjs");
const dbTargets = {
  DATABASE_URL: "postgres://fixture.invalid/never-connect",
  AUDIT_IMPORT_TEST_DATABASE_URL: "postgres://fixture.invalid/never-connect",
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB: "postgres://fixture.invalid/never-connect",
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_OTHER: "postgres://fixture.invalid/never-connect",
  PGHOST: "fixture.invalid",
  PGHOSTADDR: "192.0.2.1",
  PGSERVICE: "fixture",
  PGSERVICEFILE: "/fixture/never-read",
  PGPASSFILE: "/fixture/never-read",
};
type Call = { command: string; args: string[]; dbKeys: string[]; cwd: string; marker: string };

// Preload replaces the runner's child-process boundary before its named imports
// bind. No nested command executes, even with synthetic DB targets inherited.
function offline(args: string[] = [], failAt = "", failure = "status") {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "offline-check-"));
  try {
    const trace = join(scratch, "trace.jsonl");
    const preload = join(scratch, "stub-children.mjs");
    writeFileSync(trace, "");
    writeFileSync(preload, `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawnSync = (command, args, options) => {
  const dbKeys = Object.keys(options.env).filter(key => key === "DATABASE_URL" || key === "AUDIT_IMPORT_TEST_DATABASE_URL" || key.startsWith("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_") || key.startsWith("PG"));
  appendFileSync(process.env.OFFLINE_TRACE, JSON.stringify({ command, args, dbKeys, cwd: options.cwd, marker: options.env.OFFLINE_MARKER }) + "\\n");
  if (args.includes(process.env.OFFLINE_FAIL_AT)) {
    if (process.env.OFFLINE_FAILURE === "error") return { error: new Error("fixture child unavailable"), status: null, signal: null };
    if (process.env.OFFLINE_FAILURE === "signal") return { status: null, signal: "SIGTERM" };
    return { status: 7, signal: null };
  }
  return { status: 0, signal: null };
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ["--import", preload, entry, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ...dbTargets, OFFLINE_TRACE: trace, OFFLINE_MARKER: "preserved", OFFLINE_FAIL_AT: failAt, OFFLINE_FAILURE: failure },
    });
    expect(result.error).toBeUndefined();
    const rows = readFileSync(trace, "utf8").trim();
    return { status: result.status, output: result.stdout + result.stderr, calls: (rows ? rows.split("\n").map(line => JSON.parse(line)) : []) as Call[] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("fixture-only check command (stub children, no SQL/network)", () => {
  it("routes its fixed exclusion only to Vitest and preserves all five check stages", () => {
    const result = offline();
    expect(result.status, result.output).toBe(0);
    expect(result.calls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "npm", args: ["run", "typecheck"] },
      { command: "npm", args: ["run", "config:check"] },
      { command: "npm", args: ["run", "test", "--", "--exclude", "test/review-p1-verify.test.ts"] },
      { command: process.execPath, args: ["--test", ...readdirSync("ci").filter(file => file.startsWith("a11y-") && file.endsWith(".test.mjs")).sort().map(file => `ci/${file}`)] },
      { command: "npm", args: ["run", "test:cutover"] },
    ]);
  });

  it("unsets inherited SQL targets for every child but keeps unrelated environment", () => {
    const result = offline();
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toHaveLength(5);
    for (const call of result.calls) {
      expect(call.dbKeys).toEqual([]);
      expect(call.marker).toBe("preserved");
      expect(resolve(call.cwd)).toBe(root);
    }
  });

  it.each([["--exclude", "test/admin.test.ts"], ["--coverage"], ["--", "--exclude", "test/review-p1-verify.test.ts"]])("rejects extra arguments rather than exposing a skip facility: %j", (...args) => {
    const result = offline(args);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain("does not accept arguments");
  });

  it.each(["typecheck", "config:check", "test", "--test", "test:cutover"])("stops at a failed %s stage and preserves its exit status", (stage) => {
    const result = offline([], stage);
    expect(result.status, result.output).toBe(7);
    expect(result.calls.at(-1)?.args).toContain(stage);
    expect(result.output).not.toContain("Fixture-only checks passed");
  });

  it.each(["error", "signal"])("fails closed on a child %s", (failure) => {
    const result = offline([], "typecheck", failure);
    expect(result.status, result.output).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.output).not.toContain("Fixture-only checks passed");
  });

  it("labels success as limited evidence, not database acceptance", () => {
    const result = offline();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Fixture-only checks passed");
    expect(result.output).toContain("limited evidence");
    expect(result.output).toContain("not a substitute for exact-head CI with service-container DB coverage");
  });

  it("documents the tested package entry point without changing the full check", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(scripts["check:offline"]).toBe("node ci/offline-check.mjs");
    expect(scripts.check).toBe("npm run typecheck && npm run config:check && npm run test && node --test ci/a11y-*.test.mjs && npm run test:cutover");
    const runbook = readFileSync("docs/runbook.md", "utf8");
    expect(runbook).toContain("npm run check:offline");
    expect(runbook).not.toContain("npm run check -- -- --exclude");
  });
});
