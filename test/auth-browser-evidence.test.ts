import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { checkAuthBrowserEvidence } from "../ci/require-auth-browser-evidence.mjs";

// The auth-browser upload must never silently ship nothing:
// test:auth-signin-browser always runs (no opt-out), so an empty
// artifacts/auth-browser/ on the green path means the run executed
// nothing. These pins keep the existence assertion ahead of the upload and
// the upload itself failing on missing files; the negative controls prove the
// assertion rejects every empty-or-incomplete evidence shape.
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const a11y = ci.split("\n  a11y:\n")[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

describe("auth-browser evidence guard", () => {
  it("runs the suite, then the existence assertion, then the upload, in that order", () => {
    const suite = a11y.indexOf("npm run test:auth-signin-browser");
    const assertion = a11y.indexOf("node ci/require-auth-browser-evidence.mjs");
    const upload = a11y.indexOf("name: auth-browser-evidence");
    expect(suite).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(suite);
    expect(upload).toBeGreaterThan(assertion);
  });

  it("uploads the same artifact the same way, but fails when files are missing", () => {
    const upload = a11y.split("- name: OAuth sign-in CTA evidence\n")[1]?.split("- name:")[0] ?? "";
    expect(upload).toContain("if: always()");
    expect(upload).toContain("name: auth-browser-evidence");
    expect(upload).toContain("path: artifacts/auth-browser/");
    expect(upload).toContain("retention-days: 14");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).not.toContain("if-no-files-found: warn");
  });

  it("rejects a missing evidence directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    rmSync(dir, { recursive: true, force: true });
    expect(() => checkAuthBrowserEvidence(dir)).toThrow(/no auth-browser evidence directory/);
  });

  it("rejects an empty evidence directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/evidence directory is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects evidence without result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeFileSync(join(dir, "auth-success.png"), "fake-png");
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/result\.json is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty, unreadable, incomplete, or leaky result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      const attempt = (body: string) => {
        writeFileSync(join(dir, "result.json"), body);
        return () => checkAuthBrowserEvidence(dir);
      };
      expect(attempt("")).toThrow(/result\.json is empty/);
      expect(attempt("{nope")).toThrow(/not valid JSON/);
      expect(attempt('{"checks":["only"],"unexpectedRequests":0}')).toThrow(/instead of 6/);
      expect(attempt('{"checks":[1,2,3,4,5,6],"unexpectedRequests":2,"screenshots":[]}')).toThrow(
        /instead of 0/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a six-check report with no screenshots field", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({ checks: [1, 2, 3, 4, 5, 6], unexpectedRequests: 0 }),
      );
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/must list all four screenshots/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a six-check report with an empty, partial, padded, duplicate, or wrong-name screenshot list", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      for (const screenshots of [
        [],
        ["auth-success.png"],
        ["auth-success.png", "auth-replay.png", "join-success.png", "join-replay.png", "extra.png"],
        ["auth-success.png", "auth-success.png", "join-success.png", "join-replay.png"],
        ["auth-success.png", "auth-replay.png", "join-success.png", "other.png"],
      ]) {
        for (const shot of screenshots) writeFileSync(join(dir, shot), "fake-png");
        writeFileSync(
          join(dir, "result.json"),
          JSON.stringify({ checks: [1, 2, 3, 4, 5, 6], unexpectedRequests: 0, screenshots }),
        );
        expect(() => checkAuthBrowserEvidence(dir)).toThrow(/must list all four screenshots/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects evidence with a missing screenshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      for (const shot of ["auth-success.png", "auth-replay.png", "join-success.png"])
        writeFileSync(join(dir, shot), "fake-png");
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          checks: [1, 2, 3, 4, 5, 6],
          unexpectedRequests: 0,
          screenshots: [
            "auth-success.png",
            "auth-replay.png",
            "join-success.png",
            "join-replay.png",
          ],
        }),
      );
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/screenshot .* is missing or empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["empty file", "directory"])("rejects a screenshot path containing: %s", (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      const screenshots = [
        "auth-success.png",
        "auth-replay.png",
        "join-success.png",
        "join-replay.png",
      ];
      for (const shot of screenshots) writeFileSync(join(dir, shot), "fake-png");
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({ checks: [1, 2, 3, 4, 5, 6], unexpectedRequests: 0, screenshots }),
      );
      const shotPath = join(dir, "join-replay.png");
      if (kind === "directory") {
        rmSync(shotPath);
        mkdirSync(shotPath);
      } else {
        writeFileSync(shotPath, "");
      }
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/screenshot .* is missing or empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a normal run's evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      for (const shot of [
        "auth-success.png",
        "auth-replay.png",
        "join-success.png",
        "join-replay.png",
      ])
        writeFileSync(join(dir, shot), "fake-png");
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          checks: [1, 2, 3, 4, 5, 6],
          unexpectedRequests: 0,
          screenshots: [
            "auth-success.png",
            "auth-replay.png",
            "join-success.png",
            "join-replay.png",
          ],
        }),
      );
      expect(checkAuthBrowserEvidence(dir)).toMatch(/6 checks, 0 unexpected requests/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
