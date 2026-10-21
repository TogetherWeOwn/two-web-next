import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { checkSessionRecoveryEvidence } from "../ci/require-session-recovery-evidence.mjs";

// The session-recovery upload must never go back to silently shipping nothing:
// test:auth-browser always runs (no opt-out), so an empty
// artifacts/session-recovery/ on the green path means the run executed
// nothing. These pins keep the existence assertion ahead of the upload and
// the upload itself failing on missing files; the negative controls prove the
// assertion rejects every empty-or-incomplete evidence shape.
//
// J6 acceptance (reject incomplete browser receipts before upload) extends the
// guard: a one-field {"result":"PASS"} report currently passes (reproduced at
// c84bbef9), but must be rejected for exact stable check IDs plus numeric
// unauthorizedWrites=0. Valid fixtures below share the ID/version definitions
// from the shared schema module the builder creates; they never prefill
// production success.
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const a11y = ci.split("\n  a11y:\n")[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

const RECOVERY_SUITE = "test:auth-browser";

async function loadAuthEvidenceSchema(): Promise<any> {
  try {
    // @ts-expect-error Standalone CI tooling has no declaration file.
    return await import("../ci/auth-evidence-schema.mjs");
  } catch (error) {
    throw new Error(
      "Missing shared schema ci/auth-evidence-schema.mjs: builder must create it with " +
        "AUTH_EVIDENCE_SCHEMA_VERSION (number), AUTH_BROWSER_CHECK_IDS (6 unique strings), " +
        "SESSION_RECOVERY_CHECK_IDS (10 unique strings). Import failed: " +
        (error as Error).message,
    );
  }
}

function expectMachineReadableError(fn: () => void, suite: string, context: string): any {
  let err: any;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, `${context}: validator must throw`).toBeDefined();
  expect(err.code, `${context}: error.code must be a stable machine-readable code`).toMatch(
    /^[A-Z][A-Z0-9_]+$/,
  );
  expect(err.message, `${context}: message must name the fixture suite`).toContain(suite);
  expect(err.message, `${context}: message must tell the operator to rerun`).toMatch(/rerun/i);
  expect(err.message, `${context}: message must forbid hand-editing a receipt`).toMatch(
    /do not hand-edit|never hand-edit|don't hand-edit/i,
  );
  expect(err.nextAction, `${context}: error.nextAction must name the suite`).toContain(suite);
  let again: any;
  try {
    fn();
  } catch (e) {
    again = e;
  }
  expect(again?.code, `${context}: validator must be idempotent`).toBe(err.code);
  return err;
}

describe("session-recovery evidence guard", () => {
  it("runs the suite, then the existence assertion, then the upload, in that order", () => {
    const suite = a11y.indexOf("npm run test:auth-browser");
    const assertion = a11y.indexOf("node ci/require-session-recovery-evidence.mjs");
    const upload = a11y.indexOf("name: session-recovery-evidence");
    expect(suite).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(suite);
    expect(upload).toBeGreaterThan(assertion);
  });

  it("uploads the same artifact the same way, but fails when files are missing", () => {
    const upload = a11y.split("- name: Session recovery evidence\n")[1]?.split("- name:")[0] ?? "";
    expect(upload).toContain("if: always()");
    expect(upload).toContain("name: session-recovery-evidence");
    expect(upload).toContain("path: artifacts/session-recovery/");
    expect(upload).toContain("retention-days: 14");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).not.toContain("if-no-files-found: warn");
  });

  it("rejects a missing evidence directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    rmSync(dir, { recursive: true, force: true });
    expect(() => checkSessionRecoveryEvidence(dir)).toThrow(
      /no session-recovery evidence directory/,
    );
  });

  it("rejects an empty evidence directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      expect(() => checkSessionRecoveryEvidence(dir)).toThrow(/evidence directory is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects evidence without result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(join(dir, "expired-draft.png"), "fake-png");
      expect(() => checkSessionRecoveryEvidence(dir)).toThrow(/result\.json is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty, unreadable, or non-PASS result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      const attempt = (body: string) => {
        writeFileSync(join(dir, "result.json"), body);
        return () => checkSessionRecoveryEvidence(dir);
      };
      expect(attempt("")).toThrow(/result\.json is empty/);
      expect(attempt("{nope")).toThrow(/not valid JSON/);
      expect(attempt('{"result":"FAIL"}')).toThrow(/instead of "PASS"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a normal run's evidence", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(join(dir, "expired-draft.png"), "fake-png");
      const report = {
        schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
        result: "PASS",
        checks: [...schema.SESSION_RECOVERY_CHECK_IDS],
        unauthorizedWrites: 0,
      };
      writeFileSync(join(dir, "result.json"), `${JSON.stringify(report)}\n`);
      const beforeFiles = readdirSync(dir).sort();
      const beforeRaw = readFileSync(join(dir, "result.json"), "utf8");
      const first = checkSessionRecoveryEvidence(dir);
      expect(first).toMatch(/result PASS/);
      expect(checkSessionRecoveryEvidence(dir)).toBe(first);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
      expect(readFileSync(join(dir, "result.json"), "utf8")).toBe(beforeRaw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session-recovery receipt schema (reject incomplete receipts)", () => {
  it("shares a versioned schema with ten unique stable recovery IDs and six OAuth IDs", async () => {
    const schema = await loadAuthEvidenceSchema();
    expect(typeof schema.AUTH_EVIDENCE_SCHEMA_VERSION).toBe("number");
    expect(schema.SESSION_RECOVERY_CHECK_IDS).toHaveLength(10);
    expect(new Set(schema.SESSION_RECOVERY_CHECK_IDS).size).toBe(10);
    for (const id of schema.SESSION_RECOVERY_CHECK_IDS) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(String(Number(id))).not.toBe(id);
    }
    expect(schema.AUTH_BROWSER_CHECK_IDS).toHaveLength(6);
    expect(new Set(schema.AUTH_BROWSER_CHECK_IDS).size).toBe(6);
    // @ts-expect-error Standalone CI tooling has no declaration file.
    const again = await import("../ci/auth-evidence-schema.mjs");
    expect(again.SESSION_RECOVERY_CHECK_IDS).toEqual(schema.SESSION_RECOVERY_CHECK_IDS);
    expect(again.AUTH_BROWSER_CHECK_IDS).toEqual(schema.AUTH_BROWSER_CHECK_IDS);
    expect(again.AUTH_EVIDENCE_SCHEMA_VERSION).toBe(schema.AUTH_EVIDENCE_SCHEMA_VERSION);
  });

  it("rejects a one-field PASS report without checks or unauthorizedWrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(join(dir, "expired-draft.png"), "fake-png");
      writeFileSync(join(dir, "result.json"), '{"result":"PASS"}\n');
      const beforeRaw = readFileSync(join(dir, "result.json"), "utf8");
      expectMachineReadableError(
        () => checkSessionRecoveryEvidence(dir),
        RECOVERY_SUITE,
        "one-field PASS",
      );
      expect(readFileSync(join(dir, "result.json"), "utf8")).toBe(beforeRaw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects numeric placeholder checks even with PASS and zero writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          result: "PASS",
          checks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          unauthorizedWrites: 0,
        }),
      );
      const err = expectMachineReadableError(
        () => checkSessionRecoveryEvidence(dir),
        RECOVERY_SUITE,
        "numeric placeholders",
      );
      expect(err.offending, "numeric placeholders must be reported as offending").toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate, non-string, and substituted check entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      for (const checks of [
        [1, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "__bogus-id__"],
        [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
        [null, null, null, null, null, null, null, null, null, null],
      ]) {
        writeFileSync(
          join(dir, "result.json"),
          JSON.stringify({ result: "PASS", checks, unauthorizedWrites: 0 }),
        );
        expectMachineReadableError(
          () => checkSessionRecoveryEvidence(dir),
          RECOVERY_SUITE,
          `substituted checks ${JSON.stringify(checks).slice(0, 48)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects nine valid IDs plus one substituted stable ID", async () => {
    const schema = await loadAuthEvidenceSchema();
    const valid = [...schema.SESSION_RECOVERY_CHECK_IDS];
    const missingId = valid[9];
    const bogus = "__bogus-substituted-check-id__";
    expect(valid).not.toContain(bogus);
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          result: "PASS",
          checks: [...valid.slice(0, 9), bogus],
          unauthorizedWrites: 0,
        }),
      );
      const err = expectMachineReadableError(
        () => checkSessionRecoveryEvidence(dir),
        RECOVERY_SUITE,
        "substituted stable ID",
      );
      expect(err.missing, "missing stable ID must be reported").toContain(missingId);
      expect(err.offending, "substituted ID must be reported as offending").toContain(bogus);
      expect(err.message).toContain(missingId);
      expect(err.message).toContain(bogus);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects nine valid IDs plus a duplicate (one missing)", async () => {
    const schema = await loadAuthEvidenceSchema();
    const valid = [...schema.SESSION_RECOVERY_CHECK_IDS];
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          result: "PASS",
          checks: [valid[0], valid[0], ...valid.slice(1, 9)],
          unauthorizedWrites: 0,
        }),
      );
      const err = expectMachineReadableError(
        () => checkSessionRecoveryEvidence(dir),
        RECOVERY_SUITE,
        "duplicate stable ID",
      );
      expect(err.missing, "missing stable ID must be reported").toContain(valid[9]);
      expect(err.message).toContain(valid[9]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects nine valid IDs with the missing ID reported", async () => {
    const schema = await loadAuthEvidenceSchema();
    const valid = [...schema.SESSION_RECOVERY_CHECK_IDS];
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          result: "PASS",
          checks: valid.slice(0, 9),
          unauthorizedWrites: 0,
        }),
      );
      const err = expectMachineReadableError(
        () => checkSessionRecoveryEvidence(dir),
        RECOVERY_SUITE,
        "missing stable ID",
      );
      expect(err.missing, "missing stable ID must be reported").toContain(valid[9]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing, string, positive, or null unauthorizedWrites", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      const base = {
        schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
        result: "PASS",
        checks: [...schema.SESSION_RECOVERY_CHECK_IDS],
      };
      for (const report of [
        { ...base },
        { ...base, unauthorizedWrites: "0" },
        { ...base, unauthorizedWrites: 1 },
        { ...base, unauthorizedWrites: null },
        { ...base, unauthorizedWrites: -1 },
      ]) {
        writeFileSync(join(dir, "result.json"), JSON.stringify(report));
        const err = expectMachineReadableError(
          () => checkSessionRecoveryEvidence(dir),
          RECOVERY_SUITE,
          `unauthorizedWrites ${JSON.stringify((report as any).unauthorizedWrites)}`,
        );
        expect(err.message).toContain("unauthorizedWrites");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects valid checks without a schema version or with a wrong version/type", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      const base = {
        result: "PASS",
        checks: [...schema.SESSION_RECOVERY_CHECK_IDS],
        unauthorizedWrites: 0,
      };
      for (const report of [
        { ...base },
        { ...base, schemaVersion: 999999 },
        { ...base, schemaVersion: String(schema.AUTH_EVIDENCE_SCHEMA_VERSION) },
        { ...base, schemaVersion: null },
      ]) {
        writeFileSync(join(dir, "result.json"), JSON.stringify(report));
        expectMachineReadableError(
          () => checkSessionRecoveryEvidence(dir),
          RECOVERY_SUITE,
          `schema version ${JSON.stringify((report as any).schemaVersion)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports machine-readable codes for missing-directory failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    rmSync(dir, { recursive: true, force: true });
    expectMachineReadableError(
      () => checkSessionRecoveryEvidence(dir),
      RECOVERY_SUITE,
      "missing dir",
    );
  });

  it("session-recovery producer consumes shared IDs without prepopulating success", async () => {
    await loadAuthEvidenceSchema();
    const producer = readFileSync("ci/session-recovery-browser.mjs", "utf8");
    expect(producer).toContain("auth-evidence-schema");
    expect(producer).toContain("SESSION_RECOVERY_CHECK_IDS");
    expect(producer.match(/SESSION_RECOVERY_CHECK_IDS/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(producer).not.toMatch(/\.\.\.\s*SESSION_RECOVERY_CHECK_IDS/);
    expect(producer).not.toMatch(/=\s*SESSION_RECOVERY_CHECK_IDS(?!\s*\[)/);
    expect(producer).not.toMatch(/:\s*SESSION_RECOVERY_CHECK_IDS(?!\s*\[)/);
    expect(producer).toContain("result.json");
  });
});
