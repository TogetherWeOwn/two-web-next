import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as alertCli from "../bin/alert-probe.mjs";
import * as queueCli from "../bin/queue-authwall-probe.mjs";

// Acceptance fixtures: staging probe CLI contract parity
// (bin/queue-authwall-probe.mjs, bin/alert-probe.mjs, bin/revision-check.mjs).
// Owned by the Test Author: the Builder builds on this branch and never edits
// this file; corrections go back through the acceptance handoff, not a local fix.
//
// Contract (failing-first at ec5e7745, see K3 evidence):
// - `node bin/<each> --help` exits 0 to stdout with zero side effects (no token
//   read, no login, no fetch, no driver import, no file write), matching the
//   admin-authwall-probe pattern. `--help` wins in any argv position.
// - Wrong argv exits 2 with a static usage string on the queue and alert probes
//   (moved from exit 1); revision-check keeps its exit-2 usage behavior.
// - Each CLI emits one JSON verdict with stable check IDs, static UPPER_SNAKE
//   codes and a `next` safe-action string (internal-action-output precedent);
//   no tokens/cookies/bodies/URLs/secrets in output. Existing result fields and
//   pinned alert-probe vocabulary/exception messages are preserved (additive).
// - Targets stay pinned to staging constants; non-staging argv/env is refused
//   before any effect. Revision allows loopback origins for offline fixtures;
//   staging + loopback pass, production/evil hosts refuse with exit 2.
// - One shared docs/probe-cli-contract.md (60 lines or fewer) names the three
//   CLIs, exit codes and JSON schema, linked from each --help.
//
// Agent-runnable table-driven command (offline only):
//   npx vitest run test/staging-probe-cli-contract-acceptance.test.mjs
// Every case runs offline in a subprocess or with fixture transports: scrubbed
// env (PATH-only plus synthetic fixtures), scratch cwd, fetch/driver traps, and
// loopback-only HTTP for revision JSON. No staging/production contact.

const syntheticToken = "synthetic-contract-qa-token-9f27deadbeef";
const syntheticCookie = "synthetic-contract-session-8e13";
const syntheticReceiptSecret = "synthetic-contract-receipt-7c42";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const CONTRACT_DOC = "docs/probe-cli-contract.md";

function scratch() {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "probe-contract-"));
}

// A --import setup module that turns any network attempt into a loud,
// recorded failure. A clean receipt proves the CLI never probed.
function fetchTrap(directory, receipt) {
  const setup = join(directory, "fetch-trap.mjs");
  writeFileSync(
    setup,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  appendFileSync(${JSON.stringify(receipt)}, "fetch " + String(input?.url ?? input) + "\\n");
  throw new Error("network disabled in contract acceptance fixture");
};
`,
  );
  return setup;
}

// A --import loader that redirects the "postgres" specifier to a fake driver
// recording import/construction. A clean receipt proves zero DB effects.
function dbTrap(directory, receipt) {
  const driver = join(directory, "driver.mjs");
  writeFileSync(
    driver,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(receipt)}, "imported\\n");
export default function postgres() {
  appendFileSync(${JSON.stringify(receipt)}, "constructed\\n");
  throw new Error("database disabled in contract acceptance fixture");
}
`,
  );
  const hooks = join(directory, "hooks.mjs");
  writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
  if (specifier === "postgres")
    return { url: ${JSON.stringify(pathToFileURL(driver).href)}, shortCircuit: true };
  return next(specifier, context);
};`,
  );
  const register = join(directory, "register.mjs");
  writeFileSync(
    register,
    `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(hooks).href)});`,
  );
  return register;
}

function run(script, args, { env = {}, cwd = undefined, setup = null } = {}) {
  const entry = join(repoRoot, script);
  const nodeArgs = setup ? ["--import", setup, entry, ...args] : [entry, ...args];
  return spawnSync(process.execPath, nodeArgs, {
    env,
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
}

function receiptOf(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Async subprocess for loopback tests: spawnSync blocks the event loop, which
// deadlocks an in-process HTTP server (child waits for server, parent waits
// for child). Async spawn keeps the loop free to serve /up.
function runAsync(script, args, { env = {}, cwd = undefined } = {}) {
  const entry = join(repoRoot, script);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, error: undefined }));
    child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
  });
}

function expectHelpContract(result, cliName) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain(cliName);
  expect(result.stdout).toContain("QA_AUTH_TOKEN");
  expect(result.stdout).toMatch(/exit 0/i);
  expect(result.stdout).toMatch(/exit 1/i);
  expect(result.stdout).toMatch(/exit 2/i);
  expect(result.stdout).toContain(CONTRACT_DOC);
  expect(result.stdout).not.toContain(syntheticToken);
  expect(result.stdout).not.toContain(syntheticCookie);
}

function expectUsageRefusal(result, cliName, argv, allowTokens = []) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Usage:");
  expect(result.stderr).toContain(cliName);
  for (const token of argv) {
    if (token.length <= 2) continue;
    if (allowTokens.includes(token)) continue;
    expect(result.stderr).not.toContain(token);
  }
  expect(result.stderr).not.toContain(syntheticToken);
  expect(result.stdout).not.toContain(syntheticToken);
}

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]{1,64}$/;
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function expectVerdictShape(doc, tool) {
  expect(doc.version).toBe(1);
  expect(doc.tool).toBe(tool);
  expect(doc.mode).toBe("report");
  expect(typeof doc.ok).toBe("boolean");
  expect(doc.code).toMatch(UPPER_SNAKE);
  expect(typeof doc.next).toBe("string");
  expect(doc.next.length).toBeGreaterThan(0);
  expect(doc.next.length).toBeLessThan(500);
  expect(Array.isArray(doc.checks)).toBe(true);
  expect(doc.checks.length).toBeGreaterThan(0);
  const ids = new Set();
  for (const check of doc.checks) {
    expect(check.id).toMatch(CHECK_ID);
    expect(typeof check.label).toBe("string");
    expect(check.label.length).toBeGreaterThan(0);
    expect(typeof check.ok).toBe("boolean");
    expect(ids.has(check.id)).toBe(false);
    ids.add(check.id);
  }
  const text = JSON.stringify(doc);
  expect(text).not.toContain(syntheticToken);
  expect(text).not.toContain(syntheticCookie);
  expect(text).not.toContain(syntheticReceiptSecret);
  expect(text).not.toContain("fixture-qa-token");
  expect(text).not.toContain("fixture-member-session");
  expect(text).not.toContain("fixture-moderator-session");
  return ids;
}

describe("queue-authwall-probe --help", () => {
  it("exits 0 with usage on stdout and no token read", () => {
    const directory = scratch();
    try {
      const result = run("bin/queue-authwall-probe.mjs", ["--help"], { env: {}, cwd: directory });
      expectHelpContract(result, "bin/queue-authwall-probe.mjs");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never fetches or touches the driver, even with a token present", () => {
    const directory = scratch();
    try {
      const fetchReceipt = join(directory, "fetch-receipt");
      const fetchSetup = fetchTrap(directory, fetchReceipt);
      const fetched = run("bin/queue-authwall-probe.mjs", ["--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: fetchReceipt },
        cwd: directory,
        setup: fetchSetup,
      });
      expectHelpContract(fetched, "bin/queue-authwall-probe.mjs");
      expect(receiptOf(fetchReceipt)).toBe("");
      const dbReceipt = join(directory, "db-receipt");
      const dbSetup = dbTrap(directory, dbReceipt);
      const probed = run("bin/queue-authwall-probe.mjs", ["--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: dbReceipt },
        cwd: directory,
        setup: dbSetup,
      });
      expectHelpContract(probed, "bin/queue-authwall-probe.mjs");
      expect(receiptOf(dbReceipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("wins in any argv position without probing or echoing", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      for (const args of [
        ["--help", "extra-arg"],
        ["extra-arg", "--help"],
        ["https://evil.test", "--help"],
      ]) {
        const result = run("bin/queue-authwall-probe.mjs", args, {
          env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
          cwd: directory,
          setup,
        });
        expectHelpContract(result, "bin/queue-authwall-probe.mjs");
        expect(result.stdout).not.toContain("extra-arg");
        expect(result.stdout).not.toContain("evil.test");
      }
      expect(receiptOf(receipt)).toBe("");
      expect(readdirSync(directory).filter((n) => n !== "receipt" && !n.endsWith(".mjs"))).toEqual(
        [],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("alert-probe --help", () => {
  it("exits 0 with usage on stdout and no token read", () => {
    const directory = scratch();
    try {
      const result = run("bin/alert-probe.mjs", ["--help"], { env: {}, cwd: directory });
      expectHelpContract(result, "bin/alert-probe.mjs");
      expect(result.stdout).toContain("--receipt-file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never fetches, reads a receipt file, or touches the driver", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const missing = join(directory, "missing-tail.json");
      const result = run("bin/alert-probe.mjs", ["--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      expectHelpContract(result, "bin/alert-probe.mjs");
      expect(receiptOf(receipt)).toBe("");
      // A --help that required the receipt file would fail here; it must win
      // before any file read, so a missing file plus --help still exits 0.
      const withFile = run("bin/alert-probe.mjs", ["--receipt-file", missing, "--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      expectHelpContract(withFile, "bin/alert-probe.mjs");
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("wins in any argv position without probing or echoing", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      for (const args of [
        ["--help", "--receipt-file", "x"],
        ["--receipt-file", "x", "--help"],
        ["https://evil.test", "--help"],
      ]) {
        const result = run("bin/alert-probe.mjs", args, {
          env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
          cwd: directory,
          setup,
        });
        expectHelpContract(result, "bin/alert-probe.mjs");
      }
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("revision-check --help", () => {
  it("exits 0 with usage on stdout instead of probing --help as an origin", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/revision-check.mjs", ["--help"], {
        env: {},
        cwd: directory,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("bin/revision-check.mjs");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toMatch(/exit 0/i);
      expect(result.stdout).toMatch(/exit 1/i);
      expect(result.stdout).toMatch(/exit 2/i);
      expect(result.stdout).toContain(CONTRACT_DOC);
      expect(result.stdout).not.toContain("Live before deploy");
      expect(result.stdout).not.toContain("revision attempt");
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes no step summary and wins in any argv position", () => {
    const directory = scratch();
    try {
      const work = join(directory, "work");
      mkdirSync(work);
      const summary = join(work, "summary.md");
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      for (const args of [
        ["--help"],
        ["--help", "https://evil.test"],
        ["https://evil.test", "--help"],
      ]) {
        const result = run("bin/revision-check.mjs", args, {
          env: { GITHUB_STEP_SUMMARY: summary, RECEIPT: receipt },
          cwd: work,
          setup,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Usage:");
      }
      expect(receiptOf(receipt)).toBe("");
      expect(receiptOf(summary)).toBe("");
      expect(readdirSync(work)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("queue wrong argv exits 2 with static usage", () => {
  it.each([
    { name: "extra positional", argv: ["extra-arg"] },
    { name: "non-staging origin", argv: ["https://evil.test"] },
    { name: "production origin", argv: ["https://togetherweown.com"] },
    { name: "unknown flag", argv: ["--unknown-flag"] },
    { name: "alert-only flag", argv: ["--receipt-file", "tail.json"] },
  ])("refuses $name before any effect", ({ argv }) => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/queue-authwall-probe.mjs", argv, {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      expectUsageRefusal(result, "bin/queue-authwall-probe.mjs", argv);
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("usage is static across different wrong argv", () => {
    const directory = scratch();
    try {
      const first = run("bin/queue-authwall-probe.mjs", ["alpha-private"], {
        env: {},
        cwd: directory,
      });
      const second = run("bin/queue-authwall-probe.mjs", ["beta-private"], {
        env: {},
        cwd: directory,
      });
      expect(first.status).toBe(2);
      expect(second.status).toBe(2);
      expect(first.stderr).toBe(second.stderr);
      expect(first.stderr).not.toContain("alpha-private");
      expect(first.stderr).not.toContain("beta-private");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("alert wrong argv exits 2 with static usage", () => {
  it.each([
    { name: "missing receipt file", argv: [] },
    { name: "flag without value", argv: ["--receipt-file"] },
    { name: "extra positional", argv: ["--receipt-file", "tail.json", "extra"] },
    { name: "non-staging origin", argv: ["https://evil.test"] },
    { name: "unknown flag", argv: ["--unknown-flag"] },
  ])("refuses $name before any effect", ({ argv }) => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const tailFile = join(directory, "tail.json");
      writeFileSync(tailFile, `{}\n${syntheticReceiptSecret}\n`);
      const resolved = argv.map((a) => (a === "tail.json" ? tailFile : a));
      const result = run("bin/alert-probe.mjs", resolved, {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      // "--receipt-file" is part of the usage template, not an echo.
      expectUsageRefusal(result, "bin/alert-probe.mjs", resolved, ["--receipt-file"]);
      expect(result.stderr).toContain("--receipt-file");
      expect(result.stderr).not.toContain("Alert probe failed");
      expect(result.stderr).not.toContain(syntheticReceiptSecret);
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("usage is static across different wrong argv", () => {
    const directory = scratch();
    try {
      const first = run("bin/alert-probe.mjs", ["alpha-private"], { env: {}, cwd: directory });
      const second = run("bin/alert-probe.mjs", ["beta-private"], { env: {}, cwd: directory });
      expect(first.status).toBe(2);
      expect(second.status).toBe(2);
      expect(first.stderr).toBe(second.stderr);
      expect(first.stderr).not.toContain("alpha-private");
      expect(first.stderr).not.toContain("beta-private");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("revision usage stays exit 2", () => {
  it.each([
    { name: "missing origin", argv: [] },
    { name: "non-SHA commit", argv: ["http://127.0.0.1:1", "main"] },
    { name: "extra argument", argv: ["http://127.0.0.1:1", "0".repeat(40), "x"] },
  ])("pins $name", ({ argv }) => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/revision-check.mjs", argv, {
        env: {},
        cwd: directory,
        setup,
      });
      expectUsageRefusal(result, "bin/revision-check.mjs", argv);
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("non-staging targets refused before any effect", () => {
  it("revision record refuses production and evil origins with exit 2 and no fetch", () => {
    const directory = scratch();
    try {
      for (const origin of ["https://togetherweown.com", "https://evil.test"]) {
        const receipt = join(directory, `receipt-${encodeURIComponent(origin)}`);
        const setup = fetchTrap(directory, receipt);
        const result = run("bin/revision-check.mjs", [origin], {
          env: {},
          cwd: directory,
          setup,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Usage:");
        expect(result.stderr).not.toContain(origin);
        expect(receiptOf(receipt)).toBe("");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("staging constants stay pinned and library guards refuse before network", async () => {
    expect(queueCli.STAGING_URL).toBe("https://next.togetherweown.com");
    expect(queueCli.QA_HEADER).toBe("X-TWO-QA-Auth");
    expect(alertCli.STAGING_URL).toBe("https://next.togetherweown.com");
    const queueSend = vi.fn();
    await expect(
      queueCli.runProbe({ token: syntheticToken, fetch: queueSend, baseUrl: "https://evil.test" }),
    ).rejects.toThrow("Refusing non-staging");
    expect(queueSend).not.toHaveBeenCalled();
    const alertSend = vi.fn();
    await expect(
      alertCli.runProbe({
        token: syntheticToken,
        receiptFile: "tail.json",
        fetch: alertSend,
        baseUrl: "https://evil.test",
      }),
    ).rejects.toThrow("Refusing non-staging");
    expect(alertSend).not.toHaveBeenCalled();
  });

  it("staging env overrides never retarget queue or alert help/usage paths", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const env = {
        QA_AUTH_TOKEN: syntheticToken,
        RECEIPT: receipt,
        STAGING_URL: "https://evil.test",
        APP_URL: "https://evil.test",
      };
      for (const [script, args] of [
        ["bin/queue-authwall-probe.mjs", ["--help"]],
        ["bin/queue-authwall-probe.mjs", ["extra"]],
        ["bin/alert-probe.mjs", ["--help"]],
        ["bin/alert-probe.mjs", ["extra"]],
      ]) {
        const result = run(script, args, { env, cwd: directory, setup });
        expect(result.error).toBeUndefined();
        expect(result.stdout).not.toContain("evil.test");
        expect(result.stderr).not.toContain("evil.test");
      }
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// --- Queue JSON verdicts (library, offline fixtures) ---

function headers(init = {}, cookies = []) {
  const h = new Headers(init);
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

function response(status, init = {}, cookies = []) {
  return new Response(null, { status, headers: headers(init, cookies) });
}

const MEMBER_SESSION = `__Host-two_session=${syntheticCookie}-member; Path=/; Secure`;
const MODERATOR_SESSION = `__Host-two_session=${syntheticCookie}-moderator; Path=/; Secure`;

function greenFetch(admission = { preview: true, redispatch: true, evidence: true }) {
  return vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const origin = init?.headers?.origin ?? init?.headers?.Origin;
    const cookie = init?.headers?.Cookie ?? init?.headers?.cookie ?? "";
    const presented = init?.headers?.[queueCli.QA_HEADER] ?? "";
    if (path.startsWith("/auth/qa/")) {
      if (presented !== syntheticToken) return response(404);
      return response(204, {}, [
        path.endsWith("qa-moderator") ? MODERATOR_SESSION : MEMBER_SESSION,
      ]);
    }
    if (method === "POST" && origin !== queueCli.STAGING_URL) return response(403);
    if (path === queueCli.PREVIEW_PATH) {
      if (!admission.preview) return response(404);
      if (method !== "GET") return response(405, { allow: "GET" });
      if (origin !== queueCli.STAGING_URL) return response(403);
      if (!cookie) return response(302, { location: "/auth/discord" });
      return response(403);
    }
    if (path === queueCli.REDISPATCH_PATH) {
      if (!admission.redispatch) return response(404);
      if (method !== "POST") return response(405, { allow: "POST" });
      if (!cookie)
        return response(303, { location: `/auth/recover?next=${encodeURIComponent(path)}` });
      return response(403);
    }
    if (path === queueCli.SOURCE_EVIDENCE_PATH) {
      if (method !== "GET") return response(405, { allow: "GET" });
      if (!admission.evidence) return response(404);
      return response(403);
    }
    return response(404);
  });
}

describe("queue JSON verdicts", () => {
  it("walled drill returns a versioned report with stable check IDs, code and next", async () => {
    const send = greenFetch();
    const result = await queueCli.runProbe({ token: syntheticToken, fetch: send });
    const ids = expectVerdictShape(result, "queue-authwall-probe");
    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/OK$/);
    expect(result.checks).toHaveLength(18);
    expect(result).toMatchObject({
      target: queueCli.STAGING_URL,
      passed: 18,
      failed: 0,
    });
    expect(result.admission).toEqual({
      preview: "enabled",
      redispatch: "enabled",
      sourceEvidence: "enabled",
    });
    expect(result.legs.guest).toContain("wall");
    expect(result.hits).toEqual({ qaLogin: 2, preview: 3, redispatch: 4, sourceEvidence: 4 });
    // Labels preserve the pinned operator vocabulary.
    const labels = result.checks.map((c) => c.label);
    expect(labels).toContain("guest GET preview status");
    expect(labels).toContain("member GET preview status");
    expect(labels).toContain("moderator POST redispatch status");
    expect(labels).toContain("preview/redispatch admission agreement");
    expect(result.checks.every((c) => c.ok)).toBe(true);
    // Stable: a second run with a different token yields identical IDs in order.
    const other = await queueCli.runProbe({
      token: `${syntheticToken}-other`,
      fetch: greenFetch(),
    });
    expect(other.checks.map((c) => c.id)).toEqual(result.checks.map((c) => c.id));
    expect(other.code).toBe(result.code);
    expect(other.next).toBe(result.next);
    expect(ids.size).toBe(18);
  });

  it("disabled drill keeps the same IDs with a passing OK verdict", async () => {
    const send = greenFetch({ preview: false, redispatch: false, evidence: false });
    const result = await queueCli.runProbe({ token: syntheticToken, fetch: send });
    expectVerdictShape(result, "queue-authwall-probe");
    expect(result.ok).toBe(true);
    expect(result.admission).toEqual({
      preview: "disabled",
      redispatch: "disabled",
      sourceEvidence: "disabled",
    });
  });

  it("broken wall returns ok:false with a failure code, next action and failing check", async () => {
    const send = greenFetch();
    const inner = send.getMockImplementation();
    send.mockImplementation(async (url, init) => {
      const h = init?.headers ?? {};
      if (
        new URL(url).pathname === queueCli.PREVIEW_PATH &&
        (init?.method ?? "GET") === "GET" &&
        (h.Cookie ?? h.cookie ?? "").includes("member")
      )
        return response(200);
      return inner(url, init);
    });
    const result = await queueCli.runProbe({ token: syntheticToken, fetch: send });
    expectVerdictShape(result, "queue-authwall-probe");
    expect(result.ok).toBe(false);
    expect(result.code).not.toMatch(/OK$/);
    expect(result.failed).toBeGreaterThan(0);
    const failing = result.checks.find((c) => c.label === "member GET preview status");
    expect(failing?.ok).toBe(false);
    expect(result.failures.map((f) => f.label)).toContain("member GET preview status");
  });
});

describe("queue CLI JSON verdicts (offline subprocess)", () => {
  function runCli(mode, token = syntheticToken, args = []) {
    const preload = `
      const mode = ${JSON.stringify(mode)};
      let sends = 0;
      const specs = [
        [302, "/auth/discord"], [303, "/auth/recover?next=/admin"], [403],
        [204, null, "member"], [mode === "broken" ? 200 : 403], [403], [403],
        [204, null, "moderator"], [403], [403], [403], [403], [405]
      ];
      globalThis.fetch = async (url, init) => {
        sends += 1;
        if (new URL(url).origin !== "https://next.togetherweown.com") throw new Error("wrong target");
        if (new URL(url).pathname.startsWith("/auth/qa/") && init.headers["X-TWO-QA-Auth"] !== ${JSON.stringify(token)})
          throw new Error("wrong QA header");
        const [status, location, identity] = specs[sends - 1];
        const headers = new Headers();
        if (location) headers.set("location", location);
        if (identity) headers.append("set-cookie", "__Host-two_session=${syntheticCookie}-" + identity + "; Path=/; Secure");
        return new Response(null, { status, headers });
      };
    `;
    return spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        join(repoRoot, "bin/queue-authwall-probe.mjs"),
        ...args,
      ],
      { env: { QA_AUTH_TOKEN: token }, encoding: "utf8", timeout: 5000 },
    );
  }

  it("green run prints one JSON verdict with IDs, code and next", () => {
    const child = runCli("green");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const doc = JSON.parse(child.stdout);
    expectVerdictShape(doc, "queue-authwall-probe");
    expect(doc.ok).toBe(true);
    expect(doc.passed + doc.failed).toBe(18);
  });

  it("broken run prints ok:false JSON with a failure code and no secrets", () => {
    const child = runCli("broken");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    const doc = JSON.parse(child.stdout);
    expectVerdictShape(doc, "queue-authwall-probe");
    expect(doc.ok).toBe(false);
    expect(child.stdout).not.toContain(syntheticToken);
    expect(child.stdout).not.toContain(syntheticCookie);
  });
});

// --- Alert JSON verdicts (library, offline fixtures) ---

const at = Date.parse("2026-10-01T00:00:00Z");
const probeId = "11111111-1111-4111-8111-111111111111";
const alertReceipt = (event, extra = {}) => ({
  delivery: "ops.alert.delivered",
  event,
  probeId,
  timestamp: new Date(at).toISOString(),
  ...(event === "error.alert"
    ? { route: "/__probe/alert", fingerprint: alertCli.PROBE_FINGERPRINT }
    : { job: "AlertProbe", fingerprint: "queue.failing@AlertProbe", attempts: 1 }),
  ...extra,
});
const alertTrace = (lines, scriptName = "two-web-next-alerts") =>
  JSON.stringify(
    { scriptName, logs: [{ message: lines.map((line) => JSON.stringify(line)) }] },
    null,
    2,
  );
const alertPair = (extra = {}) =>
  alertTrace([alertReceipt("error.alert", extra), alertReceipt("queue.failing", extra)]);

function fixtureRead(snapshots) {
  let reads = 0;
  return vi.fn(async () => snapshots[Math.min(reads++, snapshots.length - 1)]);
}

function clock() {
  let time = at;
  return {
    now: () => time,
    pause: vi.fn(async () => {
      time += 1000;
    }),
  };
}

describe("alert JSON verdicts", () => {
  it("delivered run returns a versioned report with receipt checks, code and next", async () => {
    const baseline = alertPair({ probeId: "22222222-2222-4222-8222-222222222222" });
    const inputs = { token: syntheticToken, receiptFile: "fixture.json", probeId };
    const result = await alertCli.runProbe({
      ...inputs,
      fetch: async () => new Response(null, { status: 500 }),
      read: fixtureRead([baseline, `${baseline}\n${alertPair()}`]),
      ...clock(),
    });
    const ids = expectVerdictShape(result, "alert-probe");
    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/OK$/);
    expect(result).toMatchObject({ target: alertCli.STAGING_URL, probeId });
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.map((r) => r.event).sort()).toEqual(["error.alert", "queue.failing"]);
    // Checks pin the existing delivered vocabulary; receipts stay authoritative.
    expect(result.checks).toHaveLength(2);
    const labels = result.checks.map((c) => c.label).join("\n");
    expect(labels).toContain("error.alert");
    expect(labels).toContain("queue.failing");
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(ids.size).toBe(2);
    // Stable across runs.
    const second = await alertCli.runProbe({
      ...inputs,
      fetch: async () => new Response(null, { status: 500 }),
      read: fixtureRead([baseline, `${baseline}\n${alertPair()}`]),
      ...clock(),
    });
    expect(second.checks.map((c) => c.id)).toEqual(result.checks.map((c) => c.id));
    expect(second.code).toBe(result.code);
    expect(second.next).toBe(result.next);
  });

  it("preserves pinned exception vocabulary and header constants", async () => {
    expect(alertCli.ALERT_PROBE_HEADER).toBe("X-TWO-Alert-Probe");
    expect(typeof alertCli.PROBE_FINGERPRINT).toBe("string");
    expect(alertCli.PROBE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    const send = vi.fn();
    await expect(
      alertCli.runProbe({ token: "", receiptFile: "tail.json", fetch: send, probeId }),
    ).rejects.toThrow("QA_AUTH_TOKEN is required; do not pass it as a CLI argument");
    await expect(
      alertCli.runProbe({ token: syntheticToken, receiptFile: "", fetch: send, probeId }),
    ).rejects.toThrow("--receipt-file is required; connect wrangler tail before running the probe");
    await expect(
      alertCli.runProbe({
        token: syntheticToken,
        receiptFile: "tail.json",
        probeId,
        fetch: async () => new Response(null, { status: 503 }),
        read: async () => "",
      }),
    ).rejects.toThrow("Probe refused or unavailable (HTTP 503); no delivery claimed");
    await expect(
      alertCli.runProbe({
        token: syntheticToken,
        receiptFile: "tail.json",
        probeId,
        timeoutMs: 2000,
        fetch: async () => new Response(null, { status: 500 }),
        read: fixtureRead([""]),
        ...clock(),
      }),
    ).rejects.toThrow("No confirmed delivery for BOTH probe alerts before timeout");
  });
});

// --- Revision JSON verdicts (loopback, offline) ---

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "81da0f67-1e2c-4b6e-9a53-0c7c1d2e3f40";

async function withServer(body, runFn) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/up" ? JSON.stringify(body) : "{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await runFn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("revision --json verdicts", () => {
  it("record mode prints one JSON verdict with IDs, code and next", async () => {
    await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin) => {
      const directory = scratch();
      try {
        const result = await runAsync("bin/revision-check.mjs", ["--json", origin], {
          env: {},
          cwd: directory,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const doc = JSON.parse(result.stdout);
        expectVerdictShape(doc, "revision-check");
        expect(doc.ok).toBe(true);
        expect(doc.revision).toEqual({ version_id: VERSION, commit: COMMIT });
        expect(result.stdout).not.toContain("Live before deploy");
        expect(result.stdout).not.toContain("revision attempt");
        expect(result.stdout).not.toContain("```");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("record mode with no marker still exits 0 with a JSON verdict", async () => {
    await withServer({ status: "healthy" }, async (origin) => {
      const directory = scratch();
      try {
        const result = await runAsync("bin/revision-check.mjs", [origin, "--json"], {
          env: {},
          cwd: directory,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const doc = JSON.parse(result.stdout);
        expectVerdictShape(doc, "revision-check");
        expect(doc.ok).toBe(true);
        expect(doc.revision).toBeNull();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("verify mode prints a passing JSON verdict on the deployed commit", async () => {
    await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin) => {
      const directory = scratch();
      try {
        const result = await runAsync("bin/revision-check.mjs", ["--json", origin, COMMIT], {
          env: {},
          cwd: directory,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const doc = JSON.parse(result.stdout);
        expectVerdictShape(doc, "revision-check");
        expect(doc.ok).toBe(true);
        expect(doc.revision).toEqual({ version_id: VERSION, commit: COMMIT });
        expect(result.stdout).not.toContain("Deployed revision verified");
        expect(result.stdout).not.toContain("revision attempt");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("preserves non-JSON record and verify behavior", async () => {
    await withServer({ revision: { version_id: VERSION, commit: COMMIT } }, async (origin) => {
      const directory = scratch();
      try {
        const record = await runAsync("bin/revision-check.mjs", [origin], {
          env: {},
          cwd: directory,
        });
        expect(record.status).toBe(0);
        expect(record.stdout).toContain("Live before deploy");
        const verify = await runAsync("bin/revision-check.mjs", [origin, COMMIT], {
          env: {},
          cwd: directory,
        });
        expect(verify.status).toBe(0);
        expect(verify.stdout).toContain("Deployed revision verified");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

describe("probe CLI contract doc", () => {
  it("exists, stays short, and names the three CLIs, exit codes and JSON schema", () => {
    const body = readFileSync(join(repoRoot, CONTRACT_DOC), "utf8");
    const lines = body.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(body).toContain("bin/queue-authwall-probe.mjs");
    expect(body).toContain("bin/alert-probe.mjs");
    expect(body).toContain("bin/revision-check.mjs");
    expect(body).toContain("exit 0");
    expect(body).toContain("exit 1");
    expect(body).toContain("exit 2");
    for (const key of ["version", "checks", "code", "next"]) {
      expect(body).toContain(key);
    }
    expect(body).not.toContain(syntheticToken);
  });
});
