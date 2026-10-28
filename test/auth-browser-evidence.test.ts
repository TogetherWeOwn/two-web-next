import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
//
// J6 acceptance (reject incomplete browser receipts before upload) extends the
// guard: numeric placeholders [1..6] plus four screenshots currently pass
// (reproduced at c84bbef9), but must be rejected for exact stable check IDs.
// Valid fixtures below share the ID/version definitions from the shared
// schema module the builder creates; they never prefill production success.
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const a11y = ci.split("\n  a11y:\n")[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

const OAUTH_SCREENSHOTS = [
  "auth-success.png",
  "auth-replay.png",
  "join-success.png",
  "join-replay.png",
];
const OAUTH_SUITE = "test:auth-signin-browser";

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

function writeOAuthScreenshots(dir: string) {
  for (const shot of OAUTH_SCREENSHOTS) writeFileSync(join(dir, shot), "fake-png");
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

  it("rejects an empty, unreadable, or incomplete result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      const attempt = (body: string) => {
        writeFileSync(join(dir, "result.json"), body);
        return () => checkAuthBrowserEvidence(dir);
      };
      expect(attempt("")).toThrow(/result\.json is empty/);
      expect(attempt("{nope")).toThrow(/not valid JSON/);
      expect(attempt('{"checks":["only"],"unexpectedRequests":0}')).toThrow(/instead of 6/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a nonzero unexpectedRequests count with shared IDs", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 2,
          screenshots: [...OAUTH_SCREENSHOTS],
        }),
      );
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/instead of 0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a six-check report with no screenshots field", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 0,
        }),
      );
      expect(() => checkAuthBrowserEvidence(dir)).toThrow(/must list all four screenshots/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a six-check report with an empty, partial, padded, duplicate, or wrong-name screenshot list", async () => {
    const schema = await loadAuthEvidenceSchema();
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
          JSON.stringify({
            schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
            checks: [...schema.AUTH_BROWSER_CHECK_IDS],
            unexpectedRequests: 0,
            screenshots,
          }),
        );
        expect(() => checkAuthBrowserEvidence(dir)).toThrow(/must list all four screenshots/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects evidence with a missing screenshot", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      for (const shot of ["auth-success.png", "auth-replay.png", "join-success.png"])
        writeFileSync(join(dir, shot), "fake-png");
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
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

  it.each(["empty file", "directory"])("rejects a screenshot path containing: %s", async (kind) => {
    const schema = await loadAuthEvidenceSchema();
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
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 0,
          screenshots,
        }),
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

  it("accepts a normal run's evidence", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      const report = {
        schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
        checks: [...schema.AUTH_BROWSER_CHECK_IDS],
        unexpectedRequests: 0,
        screenshots: [...OAUTH_SCREENSHOTS],
      };
      writeFileSync(join(dir, "result.json"), JSON.stringify(report));
      const beforeFiles = readdirSync(dir).sort();
      const beforeRaw = readFileSync(join(dir, "result.json"), "utf8");
      const first = checkAuthBrowserEvidence(dir);
      expect(first).toMatch(/6 checks, 0 unexpected requests/);
      expect(checkAuthBrowserEvidence(dir)).toBe(first);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
      expect(readFileSync(join(dir, "result.json"), "utf8")).toBe(beforeRaw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auth-browser receipt schema (reject incomplete receipts)", () => {
  it("shares a versioned schema with six unique stable OAuth IDs and ten recovery IDs", async () => {
    const schema = await loadAuthEvidenceSchema();
    expect(typeof schema.AUTH_EVIDENCE_SCHEMA_VERSION).toBe("number");
    expect(schema.AUTH_BROWSER_CHECK_IDS).toHaveLength(6);
    expect(new Set(schema.AUTH_BROWSER_CHECK_IDS).size).toBe(6);
    for (const id of schema.AUTH_BROWSER_CHECK_IDS) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(String(Number(id))).not.toBe(id);
    }
    expect(schema.SESSION_RECOVERY_CHECK_IDS).toHaveLength(10);
    expect(new Set(schema.SESSION_RECOVERY_CHECK_IDS).size).toBe(10);
    for (const id of schema.SESSION_RECOVERY_CHECK_IDS) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    // @ts-expect-error Standalone CI tooling has no declaration file.
    const again = await import("../ci/auth-evidence-schema.mjs");
    expect(again.AUTH_BROWSER_CHECK_IDS).toEqual(schema.AUTH_BROWSER_CHECK_IDS);
    expect(again.SESSION_RECOVERY_CHECK_IDS).toEqual(schema.SESSION_RECOVERY_CHECK_IDS);
    expect(again.AUTH_EVIDENCE_SCHEMA_VERSION).toBe(schema.AUTH_EVIDENCE_SCHEMA_VERSION);
  });

  it("rejects numeric placeholder checks even with four screenshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          checks: [1, 2, 3, 4, 5, 6],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        }),
      );
      const beforeRaw = readFileSync(join(dir, "result.json"), "utf8");
      const err = expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
        "numeric placeholders",
      );
      expect(err.offending, "numeric placeholders must be reported as offending").toBeDefined();
      expect(readFileSync(join(dir, "result.json"), "utf8")).toBe(beforeRaw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate check entries even at length six", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          checks: [1, 1, 2, 3, 4, 5],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        }),
      );
      expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
        "duplicate checks",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-string and substituted check entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      for (const checks of [
        [1, 2, 3, 4, 5, "__bogus-substituted-check-id__"],
        ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
        [{}, {}, {}, {}, {}, {}],
        [null, null, null, null, null, null],
      ]) {
        writeOAuthScreenshots(dir);
        writeFileSync(
          join(dir, "result.json"),
          JSON.stringify({ checks, unexpectedRequests: 0, screenshots: [...OAUTH_SCREENSHOTS] }),
        );
        expectMachineReadableError(
          () => checkAuthBrowserEvidence(dir),
          OAUTH_SUITE,
          `substituted checks ${JSON.stringify(checks).slice(0, 48)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects five valid IDs plus one substituted stable ID", async () => {
    const schema = await loadAuthEvidenceSchema();
    const valid = [...schema.AUTH_BROWSER_CHECK_IDS];
    const missingId = valid[5];
    const bogus = "__bogus-substituted-check-id__";
    expect(valid).not.toContain(bogus);
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: [...valid.slice(0, 5), bogus],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        }),
      );
      const err = expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
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

  it("rejects five valid IDs plus a duplicate (one missing)", async () => {
    const schema = await loadAuthEvidenceSchema();
    const valid = [...schema.AUTH_BROWSER_CHECK_IDS];
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: [valid[0], valid[0], valid[1], valid[2], valid[3], valid[4]],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        }),
      );
      const err = expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
        "duplicate stable ID",
      );
      expect(err.missing, "missing stable ID must be reported").toContain(valid[5]);
      expect(err.message).toContain(valid[5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects five valid IDs with the missing ID reported", async () => {
    const schema = await loadAuthEvidenceSchema();
    const valid = [...schema.AUTH_BROWSER_CHECK_IDS];
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      writeOAuthScreenshots(dir);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
          checks: valid.slice(0, 5),
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        }),
      );
      const err = expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
        "missing stable ID",
      );
      expect(err.missing, "missing stable ID must be reported").toContain(valid[5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects valid IDs without a schema version or with a wrong version/type", async () => {
    const schema = await loadAuthEvidenceSchema();
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    try {
      for (const report of [
        {
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        },
        {
          schemaVersion: 999999,
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        },
        {
          schemaVersion: String(schema.AUTH_EVIDENCE_SCHEMA_VERSION),
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        },
        {
          schemaVersion: null,
          checks: [...schema.AUTH_BROWSER_CHECK_IDS],
          unexpectedRequests: 0,
          screenshots: [...OAUTH_SCREENSHOTS],
        },
      ]) {
        writeOAuthScreenshots(dir);
        writeFileSync(join(dir, "result.json"), JSON.stringify(report));
        expectMachineReadableError(
          () => checkAuthBrowserEvidence(dir),
          OAUTH_SUITE,
          `schema version ${JSON.stringify((report as any).schemaVersion)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports machine-readable codes for missing-directory failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
    rmSync(dir, { recursive: true, force: true });
    expectMachineReadableError(() => checkAuthBrowserEvidence(dir), OAUTH_SUITE, "missing dir");
  });

  it("auth-browser producer consumes shared IDs without prepopulating success", async () => {
    await loadAuthEvidenceSchema();
    const producer = readFileSync("ci/auth-browser.mjs", "utf8");
    expect(producer).toContain("auth-evidence-schema");
    expect(producer).toContain("AUTH_BROWSER_CHECK_IDS");
    expect(producer.match(/AUTH_BROWSER_CHECK_IDS/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(producer).not.toMatch(/\.\.\.\s*AUTH_BROWSER_CHECK_IDS/);
    expect(producer).not.toMatch(/=\s*AUTH_BROWSER_CHECK_IDS(?!\s*\[)/);
    expect(producer).not.toMatch(/:\s*AUTH_BROWSER_CHECK_IDS(?!\s*\[)/);
    expect(producer.match(/\.push\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(producer).toContain("result.json");
  });
});

// Filesystem faults other than a missing path must report the evidence as
// unreadable, never as missing, and never leak the raw errno text. Symlink
// loops (ELOOP) fault even for root, so they run in-process. Mode-bit faults
// (EACCES) run the validator in a child: CI's check job runs as root in a
// container, where CAP_DAC_OVERRIDE ignores mode bits, so the child drops to
// an unprivileged uid there to make the chmod fault real.
const UNPRIVILEGED = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
const UNREADABLE_DIR = "AUTH_BROWSER_DIR_UNREADABLE";
const OAUTH_NEXT_ACTION = `rerun npm run ${OAUTH_SUITE}`;

async function writeValidEvidence(dir: string) {
  const schema = await loadAuthEvidenceSchema();
  writeOAuthScreenshots(dir);
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({
      schemaVersion: schema.AUTH_EVIDENCE_SCHEMA_VERSION,
      checks: [...schema.AUTH_BROWSER_CHECK_IDS],
      unexpectedRequests: 0,
      screenshots: [...OAUTH_SCREENSHOTS],
    }),
  );
}

function caught(fn: () => unknown): any {
  try {
    return { ok: fn() };
  } catch (error) {
    return error;
  }
}

// Copies the validator and its schema into a world-readable fixture root so an
// unprivileged child can import the exact bytes under test.
function faultRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "auth-fault-"));
  chmodSync(root, 0o755);
  for (const file of ["require-auth-browser-evidence.mjs", "auth-evidence-schema.mjs"])
    copyFileSync(join("ci", file), join(root, file));
  return root;
}

function validateInChild(root: string, dir: string): any {
  const script = `import { checkAuthBrowserEvidence } from "./require-auth-browser-evidence.mjs";
try { process.stdout.write(JSON.stringify({ ok: checkAuthBrowserEvidence(process.argv[1]) })); }
catch (e) { process.stdout.write(JSON.stringify({ code: e?.code, nextAction: e?.nextAction, message: String(e?.message) })); }`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script, dir], {
      cwd: root,
      encoding: "utf8",
      ...UNPRIVILEGED,
    }),
  );
}

function expectUnreadable(err: any, dir: string, code: string, detail: RegExp, context: string) {
  expect(err?.code, `${context}: code`).toBe(code);
  expect(err?.nextAction, `${context}: nextAction`).toBe(OAUTH_NEXT_ACTION);
  expect(err?.message, `${context}: message names the suite`).toContain(`npm run ${OAUTH_SUITE}`);
  expect(err?.message, `${context}: message`).toMatch(detail);
  expect(err?.message, `${context}: not reported as missing`).not.toMatch(
    /missing|wrote nothing|empty/,
  );
  expect(
    String(err?.message).replaceAll(dir, "<dir>"),
    `${context}: no raw exception text`,
  ).not.toMatch(/EACCES|ELOOP|ENOENT|errno|permission denied|symbolic links|scandir|stat /i);
}

describe("auth-browser evidence filesystem faults", () => {
  it("rejects an evidence directory behind a symlink loop (ELOOP) as unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "auth-fault-"));
    try {
      const dir = join(root, "evidence");
      symlinkSync("evidence", dir);
      const err = expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
        "ELOOP dir",
      );
      expectUnreadable(err, dir, UNREADABLE_DIR, /evidence directory is unreadable/, "ELOOP dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an evidence directory behind a traversal-denied parent (EACCES stat) as unreadable", async () => {
    const root = faultRoot();
    const locked = join(root, "locked");
    try {
      const dir = join(locked, "evidence");
      mkdirSync(dir, { recursive: true });
      await writeValidEvidence(dir);
      chmodSync(locked, 0o000);
      const err = validateInChild(root, dir);
      expectUnreadable(err, dir, UNREADABLE_DIR, /evidence directory is unreadable/, "EACCES stat");
    } finally {
      chmodSync(locked, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a listable-denied evidence directory (EACCES readdir) as unreadable", async () => {
    const root = faultRoot();
    const dir = join(root, "evidence");
    try {
      mkdirSync(dir);
      await writeValidEvidence(dir);
      chmodSync(dir, 0o100);
      const err = validateInChild(root, dir);
      expectUnreadable(
        err,
        dir,
        UNREADABLE_DIR,
        /evidence directory is unreadable/,
        "EACCES readdir",
      );
    } finally {
      chmodSync(dir, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a screenshot behind a symlink loop (ELOOP) as unreadable, not missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-fault-"));
    try {
      await writeValidEvidence(dir);
      rmSync(join(dir, "join-replay.png"));
      symlinkSync("join-replay.png", join(dir, "join-replay.png"));
      const err = expectMachineReadableError(
        () => checkAuthBrowserEvidence(dir),
        OAUTH_SUITE,
        "ELOOP screenshot",
      );
      expectUnreadable(
        err,
        dir,
        "AUTH_BROWSER_SCREENSHOT_FILE_MISSING",
        /screenshot join-replay\.png is unreadable/,
        "ELOOP screenshot",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a genuinely missing path distinct from a faulted one (stat-swallowing control)", async () => {
    const root = mkdtempSync(join(tmpdir(), "auth-fault-"));
    try {
      const missingDir = join(root, "absent");
      const loopedDir = join(root, "looped");
      symlinkSync("looped", loopedDir);
      const missing = caught(() => checkAuthBrowserEvidence(missingDir));
      const looped = caught(() => checkAuthBrowserEvidence(loopedDir));
      expect(missing.code).toBe("AUTH_BROWSER_NO_EVIDENCE_DIR");
      expect(looped.code).toBe(UNREADABLE_DIR);
      expect(looped.code).not.toBe(missing.code);

      const evidence = join(root, "evidence");
      mkdirSync(evidence);
      await writeValidEvidence(evidence);
      rmSync(join(evidence, "auth-replay.png"));
      expect(() => checkAuthBrowserEvidence(evidence)).toThrow(
        /screenshot auth-replay\.png is missing or empty/,
      );
      symlinkSync("auth-replay.png", join(evidence, "auth-replay.png"));
      expect(() => checkAuthBrowserEvidence(evidence)).toThrow(
        /screenshot auth-replay\.png is unreadable/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts valid evidence through the unprivileged child path (fault-harness control)", async () => {
    const root = faultRoot();
    try {
      const dir = join(root, "evidence");
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      await writeValidEvidence(dir);
      expect(validateInChild(root, dir).ok).toMatch(/6 checks, 0 unexpected requests/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
