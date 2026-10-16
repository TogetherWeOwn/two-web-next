import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const a11y = ci.split("\n  a11y:\n")[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

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

  it("accepts a normal run's evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-guard-"));
    try {
      writeFileSync(join(dir, "expired-draft.png"), "fake-png");
      writeFileSync(join(dir, "result.json"), '{"result":"PASS"}\n');
      expect(checkSessionRecoveryEvidence(dir)).toMatch(/result PASS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
