// Operator chase-pass forensics acceptance: the session chase loops report
// their work without changing their behavior. Sliced from the roadmap M192
// operator-hardening slice at pin d8fe53590. The loops stay uncapped by
// design (a cap rolls back all progress, so sustained rotation outlasts it);
// this file pins pass-count forensics only.
//
// Contract for the build:
// - eraseMember apply returns its eight table counts plus `passes` (number of
//   session-chase passes executed) and `deletesPerPass` (session rows deleted
//   in each pass, in order). Dry-run returns `passes: 0` and
//   `deletesPerPass: []` (no chase ran). passes === deletesPerPass.length and
//   web_sessions === sum(deletesPerPass) always hold.
// - revokeMemberSessions apply returns web_sessions plus `passes` and
//   `stampsPerPass` (sessions stamped per pass), with the same length/sum
//   invariants. Dry-run returns `passes: 0` and `stampsPerPass: []`.
// - Both CLIs surface the pass fields in their one JSON result object next to
//   `mode` and `counts` (counts keep one key per table).
// - A lock-timeout rollback (SQLSTATE 55P03) carries a distinct retry message,
//   separate from the generic failure text.
// - No chase-behavior change: no pass cap, no partial success (a mid-chase
//   failure rejects; nothing is reported as deleted/stamped), and the
//   console-silencing plus single-JSON-output contracts stay intact.
// - No new operator flags; no IDs beyond numbers in the new fields.
//
// These tests fail on current code (results carry no pass fields, the CLIs
// emit no pass JSON, nothing maps 55P03) and pass after the build. Hermetic:
// in-memory transaction doubles, CLI refusal subprocesses (exit before any
// connection), and source scans. No database.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eraseMember } from "../src/member-erasure";
import { revokeMemberSessions } from "../src/session-revocation";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { parseEraseArgs } from "../bin/erase-member.mjs";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { parseRevokeArgs } from "../bin/revoke-sessions.mjs";

const MEMBER = "100000000000000201";
const repoRoot = fileURLToPath(new URL("..", import.meta.url).href);
const eraseScript = fileURLToPath(new URL("../bin/erase-member.mjs", import.meta.url).href);
const revokeScript = fileURLToPath(new URL("../bin/revoke-sessions.mjs", import.meta.url).href);
const run = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", script, ...args], {
    env,
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
  });

type EraseResultWithPasses = {
  users: number;
  profiles: number;
  rsvps: number;
  web_sessions: number;
  web_session_grace: number;
  join_attempts: number;
  overlay_configs: number;
  overlay_tokens: number;
  passes: number;
  deletesPerPass: number[];
};

type RevokeResultWithPasses = {
  web_sessions: number;
  passes: number;
  stampsPerPass: number[];
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const rows = (count: number) => Array.from({ length: count }, () => ({ "1": 1 }));

// In-memory erasure double. Non-session tables return fixed deletes/counts;
// the web_sessions chase follows the script: pass i deletes
// sessionDeletes[i], then the recount reports sessionRemainings[i]. A
// remaining of 0 ends the chase, like the real loop's quiescence check.
// The overlay token chase follows the same shape with its own pass counter;
// overlay deletes cover all statuses and default to zero.
function makeEraseDouble(opts: {
  users?: number;
  profiles?: number;
  rsvps?: number;
  grace?: number;
  attempts?: number;
  configs?: number;
  sessionDeletes?: number[];
  sessionRemainings?: number[];
  tokenDeletes?: number[];
  tokenRemainings?: number[];
  failOnSessionPass?: number;
  failWith?: unknown;
}) {
  let pass = 0;
  let tokenPass = 0;
  const tag = async (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    const text = strings.join(" ");
    if (text.startsWith("delete from web_sessions")) {
      if (pass === opts.failOnSessionPass)
        throw opts.failWith ?? new Error("synthetic chase failure");
      return rows(opts.sessionDeletes?.[pass] ?? 0);
    }
    if (text.startsWith("delete from users")) return rows(opts.users ?? 0);
    if (text.startsWith("delete from profiles")) return rows(opts.profiles ?? 0);
    if (text.startsWith("delete from rsvps")) return rows(opts.rsvps ?? 0);
    if (text.startsWith("delete from web_session_grace")) return rows(opts.grace ?? 0);
    if (text.startsWith("delete from join_attempts")) return rows(opts.attempts ?? 0);
    if (text.startsWith("delete from overlay_tokens"))
      return rows(opts.tokenDeletes?.[tokenPass] ?? 0);
    if (text.startsWith("delete from overlay_configs")) return rows(opts.configs ?? 0);
    if (text.startsWith("select count") && text.includes("from web_sessions")) {
      const remaining = opts.sessionRemainings?.[pass] ?? 0;
      pass++;
      return [{ n: remaining }];
    }
    if (text.startsWith("select count") && text.includes("from users"))
      return [{ n: opts.users ?? 0 }];
    if (text.startsWith("select count") && text.includes("from profiles"))
      return [{ n: opts.profiles ?? 0 }];
    if (text.startsWith("select count") && text.includes("from rsvps"))
      return [{ n: opts.rsvps ?? 0 }];
    if (text.startsWith("select count") && text.includes("from web_session_grace"))
      return [{ n: opts.grace ?? 0 }];
    if (text.startsWith("select count") && text.includes("from join_attempts"))
      return [{ n: opts.attempts ?? 0 }];
    if (text.startsWith("select count") && text.includes("from overlay_tokens")) {
      const remaining = opts.tokenRemainings?.[tokenPass] ?? 0;
      tokenPass++;
      return [{ n: remaining }];
    }
    if (text.startsWith("select count") && text.includes("from overlay_configs"))
      return [{ n: opts.configs ?? 0 }];
    throw new Error(`unexpected statement: ${text.slice(0, 120)}`);
  };
  (tag as unknown as Record<string, unknown>).begin = (fn: (tx: unknown) => Promise<unknown>) =>
    fn(tag);
  return tag as unknown as Parameters<typeof eraseMember>[0];
}

// In-memory revocation double. Each update stamps stamps[updateIndex];
// each recount reports remainings[pass]. Dry-run (no updates scripted)
// answers the single count with dryCount.
function makeRevokeDouble(opts: {
  stamps?: number[];
  remainings?: number[];
  dryCount?: number;
  failOnUpdate?: number;
  failWith?: unknown;
}) {
  let pass = 0;
  let updates = 0;
  const tag = async (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    const text = strings.join(" ");
    if (text.includes("update web_sessions")) {
      if (updates === opts.failOnUpdate)
        throw opts.failWith ?? new Error("synthetic chase failure");
      const stamped = opts.stamps?.[updates] ?? 0;
      updates++;
      return rows(stamped);
    }
    if (text.startsWith("select count")) {
      if (updates === 0 && opts.stamps === undefined) return [{ n: opts.dryCount ?? 0 }];
      const remaining = opts.remainings?.[pass] ?? 0;
      pass++;
      return [{ n: remaining }];
    }
    throw new Error(`unexpected statement: ${text.slice(0, 120)}`);
  };
  (tag as unknown as Record<string, unknown>).begin = (fn: (tx: unknown) => Promise<unknown>) =>
    fn(tag);
  return tag as unknown as Parameters<typeof revokeMemberSessions>[0];
}

const lockTimeout = () =>
  Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

describe("chase-pass forensics: eraseMember reports passes (mock, no database)", () => {
  it("reports one quiescent pass with its per-pass deletes", async () => {
    const sql = makeEraseDouble({ users: 1, sessionDeletes: [2], sessionRemainings: [0] });
    const result = (await eraseMember(sql, MEMBER, {
      dryRun: false,
    })) as unknown as EraseResultWithPasses;
    expect(result.web_sessions).toBe(2);
    expect(result.passes).toBe(1);
    expect(result.deletesPerPass).toEqual([2]);
    expect(result.passes).toBe(result.deletesPerPass.length);
    expect(result.web_sessions).toBe(sum(result.deletesPerPass));
  });

  it("reports two passes when a successor lands after the first snapshot", async () => {
    const sql = makeEraseDouble({ users: 1, sessionDeletes: [1, 1], sessionRemainings: [1, 0] });
    const result = (await eraseMember(sql, MEMBER, {
      dryRun: false,
    })) as unknown as EraseResultWithPasses;
    expect(result.web_sessions).toBe(2);
    expect(result.passes).toBe(2);
    expect(result.deletesPerPass).toEqual([1, 1]);
    expect(result.web_sessions).toBe(sum(result.deletesPerPass));
  });

  it("reports three passes for a chained rotation", async () => {
    const sql = makeEraseDouble({
      users: 1,
      sessionDeletes: [1, 1, 1],
      sessionRemainings: [1, 1, 0],
    });
    const result = (await eraseMember(sql, MEMBER, {
      dryRun: false,
    })) as unknown as EraseResultWithPasses;
    expect(result.web_sessions).toBe(3);
    expect(result.passes).toBe(3);
    expect(result.deletesPerPass).toEqual([1, 1, 1]);
  });

  it("dry-run reports zero passes and an empty per-pass list", async () => {
    const sql = makeEraseDouble({ users: 1, profiles: 1 });
    const result = (await eraseMember(sql, MEMBER, {
      dryRun: true,
    })) as unknown as EraseResultWithPasses;
    expect(result.users).toBe(1);
    expect(result.profiles).toBe(1);
    expect(result.passes).toBe(0);
    expect(result.deletesPerPass).toEqual([]);
  });

  it("carries numbers only in the new pass fields, never member IDs", async () => {
    const sql = makeEraseDouble({ users: 1, sessionDeletes: [2], sessionRemainings: [0] });
    const result = (await eraseMember(sql, MEMBER, {
      dryRun: false,
    })) as unknown as EraseResultWithPasses;
    expect(typeof result.passes).toBe("number");
    expect(Array.isArray(result.deletesPerPass)).toBe(true);
    for (const count of result.deletesPerPass) expect(typeof count).toBe("number");
    expect(
      JSON.stringify({ passes: result.passes, deletesPerPass: result.deletesPerPass }),
    ).not.toContain(MEMBER);
  });
});

describe("chase-pass forensics: revokeMemberSessions reports passes (mock, no database)", () => {
  it("reports one quiescent pass with its per-pass stamps", async () => {
    const sql = makeRevokeDouble({ stamps: [2], remainings: [0] });
    const result = (await revokeMemberSessions(sql, MEMBER, {
      dryRun: false,
    })) as unknown as RevokeResultWithPasses;
    expect(result.web_sessions).toBe(2);
    expect(result.passes).toBe(1);
    expect(result.stampsPerPass).toEqual([2]);
    expect(result.passes).toBe(result.stampsPerPass.length);
    expect(result.web_sessions).toBe(sum(result.stampsPerPass));
  });

  it("reports two passes when a successor lands after the first snapshot", async () => {
    const sql = makeRevokeDouble({ stamps: [1, 1], remainings: [1, 0] });
    const result = (await revokeMemberSessions(sql, MEMBER, {
      dryRun: false,
    })) as unknown as RevokeResultWithPasses;
    expect(result.web_sessions).toBe(2);
    expect(result.passes).toBe(2);
    expect(result.stampsPerPass).toEqual([1, 1]);
  });

  it("dry-run reports zero passes and an empty per-pass list", async () => {
    const sql = makeRevokeDouble({ dryCount: 3 });
    const result = (await revokeMemberSessions(sql, MEMBER, {
      dryRun: true,
    })) as unknown as RevokeResultWithPasses;
    expect(result.web_sessions).toBe(3);
    expect(result.passes).toBe(0);
    expect(result.stampsPerPass).toEqual([]);
  });

  it("carries numbers only in the new pass fields, never member IDs", async () => {
    const sql = makeRevokeDouble({ stamps: [1], remainings: [0] });
    const result = (await revokeMemberSessions(sql, MEMBER, {
      dryRun: false,
    })) as unknown as RevokeResultWithPasses;
    expect(typeof result.passes).toBe("number");
    for (const count of result.stampsPerPass) expect(typeof count).toBe("number");
    expect(
      JSON.stringify({ passes: result.passes, stampsPerPass: result.stampsPerPass }),
    ).not.toContain(MEMBER);
  });
});

describe("chase behavior unchanged: no cap, no partial success (mock, no database)", () => {
  it("erasure converges over five successive successors without a cap", async () => {
    const sql = makeEraseDouble({
      users: 1,
      sessionDeletes: [1, 1, 1, 1, 2],
      sessionRemainings: [1, 1, 1, 1, 0],
    });
    const result = (await eraseMember(sql, MEMBER, {
      dryRun: false,
    })) as unknown as EraseResultWithPasses;
    expect(result.web_sessions).toBe(6);
    expect(result.passes).toBe(5);
    expect(result.deletesPerPass).toEqual([1, 1, 1, 1, 2]);
  });

  it("revocation converges over five successive successors without a cap", async () => {
    const sql = makeRevokeDouble({ stamps: [1, 1, 1, 1, 1], remainings: [1, 1, 1, 1, 0] });
    const result = (await revokeMemberSessions(sql, MEMBER, {
      dryRun: false,
    })) as unknown as RevokeResultWithPasses;
    expect(result.web_sessions).toBe(5);
    expect(result.passes).toBe(5);
    expect(result.stampsPerPass).toEqual([1, 1, 1, 1, 1]);
  });

  it("a mid-chase failure rejects without reporting partial success (control)", async () => {
    const eraseSql = makeEraseDouble({
      users: 1,
      sessionDeletes: [2, 0],
      sessionRemainings: [1, 0],
      failOnSessionPass: 1,
    });
    await expect(eraseMember(eraseSql, MEMBER, { dryRun: false })).rejects.toThrow(
      "synthetic chase failure",
    );
    const revokeSql = makeRevokeDouble({
      stamps: [2, 0],
      remainings: [1, 0],
      failOnUpdate: 1,
    });
    await expect(revokeMemberSessions(revokeSql, MEMBER, { dryRun: false })).rejects.toThrow(
      "synthetic chase failure",
    );
  });

  it("a lock timeout propagates from the chase for the CLI to map (control)", async () => {
    const eraseSql = makeEraseDouble({
      users: 1,
      sessionDeletes: [1, 0],
      sessionRemainings: [1, 0],
      failOnSessionPass: 1,
      failWith: lockTimeout(),
    });
    await expect(eraseMember(eraseSql, MEMBER, { dryRun: false })).rejects.toMatchObject({
      code: "55P03",
    });
    const revokeSql = makeRevokeDouble({
      stamps: [1, 0],
      remainings: [1, 0],
      failOnUpdate: 1,
      failWith: lockTimeout(),
    });
    await expect(revokeMemberSessions(revokeSql, MEMBER, { dryRun: false })).rejects.toMatchObject({
      code: "55P03",
    });
  });
});

describe("CLI JSON surfaces pass counts in the one JSON result", () => {
  it("erase-member forwards chase passes to its single JSON result", () => {
    const source = readFileSync(eraseScript, "utf8");
    expect(source, "JSON result must carry passes").toMatch(/JSON\.stringify\(\{[^}]*\bpasses\b/);
    expect(source, "JSON result must carry per-pass deletes").toMatch(/deletesPerPass/);
  });

  it("revoke-sessions forwards chase passes to its single JSON result", () => {
    const source = readFileSync(revokeScript, "utf8");
    expect(source, "JSON result must carry passes").toMatch(/JSON\.stringify\(\{[^}]*\bpasses\b/);
    expect(source, "JSON result must carry per-pass stamps").toMatch(/stampsPerPass/);
  });

  it("keeps exactly one stdout JSON write with console silencing (control)", () => {
    for (const script of [eraseScript, revokeScript]) {
      const source = readFileSync(script, "utf8");
      expect(source, `${script} must silence driver console output`).toMatch(
        /console\[method\] = \(\) => \{\}/,
      );
      expect(
        source.match(/process\.stdout\.write/g) ?? [],
        `${script} single JSON write`,
      ).toHaveLength(1);
    }
  });

  it("adds no new pass-related operator flags (control)", () => {
    for (const flag of ["--passes", "--pass-count", "--max-passes", "--report-passes"]) {
      expect(() => parseEraseArgs([`--discord-id=${MEMBER}`, flag]), `erase ${flag}`).toThrow();
      expect(() => parseRevokeArgs([`--discord-id=${MEMBER}`, flag]), `revoke ${flag}`).toThrow();
    }
  });

  it("refusals still emit no stdout and leak nothing (control)", () => {
    for (const script of [eraseScript, revokeScript]) {
      const refused = run(script, [`--discord-id=${MEMBER}`], {});
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("DATABASE_URL");
      expect(refused.stdout + refused.stderr).not.toContain("postgres://");
    }
  });
});

describe("lock-timeout rollback carries a distinct retry message", () => {
  it("maps SQLSTATE 55P03 to a retry hint in the operator CLI path", () => {
    let combined = "";
    for (const relative of [
      "../bin/operator-db-core.mjs",
      "../bin/erase-member.mjs",
      "../bin/revoke-sessions.mjs",
      "../src/member-erasure.ts",
      "../src/session-revocation.ts",
    ]) {
      try {
        combined += readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), "utf8");
      } catch {
        // The shared core does not exist before the build; the CLIs must carry the mapping then.
      }
    }
    expect(combined, "operator path must handle 55P03").toMatch(/55P03/);
    expect(combined, "55P03 handling must name a retry").toMatch(
      /55P03[\s\S]{0,500}retry|retry[\s\S]{0,500}55P03/i,
    );
  });
});

describe("operator forensics docs name the shared floor and pass fields", () => {
  it("documents the shared TLS core and pass-count fields in both runbooks", () => {
    const erasureDoc = readFileSync(
      fileURLToPath(new URL("../docs/member-erasure.md", import.meta.url).href),
      "utf8",
    );
    expect(erasureDoc, "member-erasure.md names the shared core").toContain("operator-db-core");
    expect(erasureDoc, "member-erasure.md names the pass count").toMatch(/\bpasses\b/);
    expect(erasureDoc, "member-erasure.md names per-pass deletes").toContain("deletesPerPass");
    const runbook = readFileSync(
      fileURLToPath(new URL("../docs/runbook.md", import.meta.url).href),
      "utf8",
    );
    expect(runbook, "runbook.md names the shared core").toContain("operator-db-core");
    expect(runbook, "runbook.md names the pass count").toMatch(/\bpasses\b/);
    expect(runbook, "runbook.md names per-pass stamps").toContain("stampsPerPass");
  });
});
