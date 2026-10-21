import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JSON_SMOKE_CHECKS,
  STAGING_ORIGIN,
  jsonSmoke,
  skippedLedgerEntries,
} from "../bin/json-smoke.mjs";

// Fixture admission: IPv6 loopback acceptance.
//
// Three fixture consumers admit only loopback targets, but compare the parsed
// URL hostname against unbracketed "::1" while Node URL keeps the brackets on
// IPv6 hostnames ("[::1]"). Compact and expanded IPv6 loopback both normalize
// to "[::1]", so all three refuse a legitimate loopback target today.
//
// This suite is the failing-first acceptance for recognizing IPv6 loopback
// without widening target access. It is table-driven and covers all three
// consumers in one agent-runnable command:
//
//   npx vitest run test/fixture-admission-ipv6-loopback-acceptance.test.mjs
//
// Offline only: no real socket, database, or staging network. Database
// admission is exercised by spawning the fixture scripts as subprocesses with
// a scrubbed environment and a controlled scratch directory; JSON-smoke
// admission is exercised by calling the exported probe with a fetch trap that
// records every attempt. Invalid admission must fail before fetch, spawn,
// config write, or database construction, and refusal diagnostics must never
// echo credential-bearing URLs.
//
// Protected test paths (Test Author owns; builders never edit):
// - test/fixture-admission-ipv6-loopback-acceptance.test.mjs
//
// Builder command (exact): build on the acceptance branch SHA and run the
// single command above. Corrections return to the Test Author.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_SCRIPT = "ci/kit-worker-e2e.mjs";
const DEV_SCRIPT = "ci/kit-worker-dev.mjs";
const SMOKE_SCRIPT = "bin/json-smoke.mjs";
const SYNTHETIC_TOKEN = "fixture-qa-token";
const SECRET_MARKER = "secret-never-log-this";

// Admission markers: every refusal from the fixture scripts names the
// admission contract. A later-stage failure (missing built worker, wrangler
// spawn, generation timeout) never contains these strings.
const ADMISSION_MARKERS = ["accepts only", "must point to", "must be a valid"];

function scratch(prefix) {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), prefix));
}

function runFixtureScript(script, databaseUrl, { timeoutMs = 8000 } = {}) {
  const directory = scratch("fixture-ipv6-");
  const work = join(directory, "work");
  mkdirSync(work);
  const result = spawnSync(process.execPath, [join(repoRoot, script)], {
    env: {
      // Scrubbed: no inherited DATABASE_URL, QA token, or PG* settings.
      PATH: process.env.PATH ?? "",
      KIT_WORKER_TEST_DATABASE_URL: databaseUrl,
      PAPERCLIP_RUN_SCRATCH_DIR: directory,
    },
    cwd: work,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const stderr = `${result.stderr ?? ""}`;
  const stdout = `${result.stdout ?? ""}`;
  const combined = `${stdout}\n${stderr}`;
  const hasAdmissionError = ADMISSION_MARKERS.some((marker) => combined.includes(marker));
  let scratchEntries = [];
  try {
    scratchEntries = readdirSync(directory).filter((name) => name !== "work");
  } catch {
    scratchEntries = [];
  }
  let workEntries = [];
  try {
    workEntries = readdirSync(work);
  } catch {
    workEntries = [];
  }
  const timedOut = result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT";
  const output = { combined, hasAdmissionError, scratchEntries, workEntries, timedOut, result };
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  return { output, cleanup };
}

async function jsonAdmission(baseUrl, token = SYNTHETIC_TOKEN) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input?.url ?? input));
    throw new Error("offline fetch trap");
  };
  try {
    const logs = [];
    const returned = await jsonSmoke(baseUrl, {
      token,
      log: (line) => logs.push(line),
      warn: () => {},
      timeoutMs: 500,
    });
    return { threw: null, returned, fetchCalls: calls.length, logs };
  } catch (error) {
    return { threw: error, returned: null, fetchCalls: calls.length, logs: [] };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function relativeImports(source) {
  const imports = new Set();
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) imports.add(match[1]);
  for (const match of source.matchAll(/import\s*\(\s*["'](\.[^"']+)["']/g)) imports.add(match[1]);
  return imports;
}

describe("fixture admission IPv6 loopback acceptance", () => {
  describe("IPv6 loopback is admitted in all three consumers", () => {
    const ipv6Databases = [
      "postgres://[::1]/disposable",
      "postgres://[0:0:0:0:0:0:0:1]/disposable",
      "postgresql://[::1]/disposable",
      "postgres://[::1]:5432/disposable",
    ];
    for (const script of [E2E_SCRIPT, DEV_SCRIPT]) {
      for (const databaseUrl of ipv6Databases) {
        it(`admits ${databaseUrl} via ${script}`, () => {
          const { output, cleanup } = runFixtureScript(script, databaseUrl, { timeoutMs: 6000 });
          try {
            expect(
              output.hasAdmissionError,
              `${script} refused ${databaseUrl}: ${output.combined.slice(0, 800)}`,
            ).toBe(false);
          } finally {
            cleanup();
          }
        });
      }
    }

    const ipv6Origins = ["http://[::1]:9/", "http://[0:0:0:0:0:0:0:1]:9/"];
    for (const origin of ipv6Origins) {
      it(`admits ${origin} via json-smoke without throwing`, async () => {
        const admission = await jsonAdmission(origin);
        expect(admission.threw, `json-smoke refused ${origin}: ${admission.threw}`).toBeNull();
        expect(admission.fetchCalls).toBeGreaterThan(0);
      });
    }
  });

  describe("existing loopback admission is preserved", () => {
    const loopbackDatabases = [
      "postgres://localhost/disposable",
      "postgres://127.0.0.1/disposable",
      "postgresql://localhost/disposable",
      "postgres://fixture:fixture-secret@localhost/disposable",
    ];
    for (const script of [E2E_SCRIPT, DEV_SCRIPT]) {
      for (const databaseUrl of loopbackDatabases) {
        it(`keeps admitting ${databaseUrl} via ${script}`, () => {
          const { output, cleanup } = runFixtureScript(script, databaseUrl, { timeoutMs: 6000 });
          try {
            expect(
              output.hasAdmissionError,
              `${script} refused ${databaseUrl}: ${output.combined.slice(0, 800)}`,
            ).toBe(false);
          } finally {
            cleanup();
          }
        });
      }
    }

    for (const origin of ["http://127.0.0.1:9/", "http://localhost:9/"]) {
      it(`keeps admitting ${origin} via json-smoke`, async () => {
        const admission = await jsonAdmission(origin);
        expect(admission.threw).toBeNull();
        expect(admission.fetchCalls).toBeGreaterThan(0);
      });
    }
  });

  describe("database Postgres-only admission is preserved", () => {
    const wrongProtocol = [
      "mysql://localhost/disposable",
      "https://localhost/disposable",
      "http://localhost/disposable",
      "file:///tmp/disposable",
    ];
    for (const script of [E2E_SCRIPT, DEV_SCRIPT]) {
      for (const databaseUrl of wrongProtocol) {
        it(`refuses ${databaseUrl} via ${script} before side effects`, () => {
          const { output, cleanup } = runFixtureScript(script, databaseUrl);
          try {
            expect(output.hasAdmissionError).toBe(true);
            expect(output.scratchEntries).toEqual([]);
            expect(output.workEntries).toEqual([]);
            expect(output.timedOut).toBe(false);
          } finally {
            cleanup();
          }
        });
      }
    }
  });

  describe("no widening: 127/8, private, remote, mapped, and suffix hosts stay refused", () => {
    const refusedDatabases = [
      "postgres://127.0.0.2/disposable",
      "postgres://127.1.2.3/disposable",
      "postgres://10.0.0.1/disposable",
      "postgres://192.168.1.10/disposable",
      "postgres://172.16.0.1/disposable",
      "postgres://8.8.8.8/disposable",
      "postgres://localhost.evil/disposable",
      "postgres://evil.localhost/disposable",
      "postgres://[::ffff:127.0.0.1]/disposable",
      "postgres://[::2]/disposable",
      "postgres://[::]/disposable",
      "postgres://0.0.0.0/disposable",
      "",
      "not-a-url",
      "postgres://[::1/disposable",
    ];
    for (const script of [E2E_SCRIPT, DEV_SCRIPT]) {
      for (const databaseUrl of refusedDatabases) {
        it(`refuses ${databaseUrl || "<empty>"} via ${script} with zero effects`, () => {
          const { output, cleanup } = runFixtureScript(script, databaseUrl);
          try {
            expect(
              output.hasAdmissionError,
              `${script} admitted ${databaseUrl || "<empty>"}: ${output.combined.slice(0, 800)}`,
            ).toBe(true);
            expect(output.scratchEntries).toEqual([]);
            expect(output.workEntries).toEqual([]);
            expect(output.timedOut).toBe(false);
          } finally {
            cleanup();
          }
        });
      }
    }

    const refusedOrigins = [
      "http://127.0.0.2:9/",
      "http://10.0.0.1:9/",
      "http://192.168.1.10:9/",
      "http://8.8.8.8:9/",
      "http://localhost.evil:9/",
      "http://[::ffff:127.0.0.1]:9/",
      "http://[::2]:9/",
      "https://127.0.0.1:9/",
      "https://localhost:9/",
      "https://[::1]:9/",
      "http://example.com/",
      "https://togetherweown.com/",
      "postgres://127.0.0.1/disposable",
      "file:///etc/passwd",
      "not-a-url",
    ];
    for (const origin of refusedOrigins) {
      it(`refuses ${origin} via json-smoke before fetch`, async () => {
        const admission = await jsonAdmission(origin);
        expect(admission.threw, `json-smoke admitted ${origin}`).not.toBeNull();
        expect(admission.fetchCalls).toBe(0);
      });
    }
  });

  describe("json-smoke staging-origin and HTTP-loopback exceptions are exact", () => {
    it("keeps admitting the staging origin", async () => {
      expect(STAGING_ORIGIN).toBe("https://next.togetherweown.com");
      const admission = await jsonAdmission(STAGING_ORIGIN);
      expect(admission.threw).toBeNull();
      expect(admission.fetchCalls).toBeGreaterThan(0);
    });

    it("refuses staging-origin with path, query, or fragment", async () => {
      for (const target of [
        `${STAGING_ORIGIN}/events.json`,
        `${STAGING_ORIGIN}/?page=2`,
        `${STAGING_ORIGIN}/#top`,
      ]) {
        const admission = await jsonAdmission(target);
        expect(admission.threw, `json-smoke admitted ${target}`).not.toBeNull();
        expect(admission.fetchCalls).toBe(0);
      }
    });

    it("refuses HTTPS loopback while HTTP loopback stays admitted", async () => {
      for (const refused of ["https://127.0.0.1:9/", "https://localhost:9/", "https://[::1]:9/"]) {
        const admission = await jsonAdmission(refused);
        expect(admission.threw, `json-smoke admitted ${refused}`).not.toBeNull();
        expect(admission.fetchCalls).toBe(0);
      }
      for (const admitted of ["http://127.0.0.1:9/", "http://localhost:9/"]) {
        const admission = await jsonAdmission(admitted);
        expect(admission.threw).toBeNull();
        expect(admission.fetchCalls).toBeGreaterThan(0);
      }
    });
  });

  describe("json-smoke refuses credentials, path, query, and fragment", () => {
    const refused = [
      "http://user:pass@127.0.0.1:9/",
      `http://user:${SECRET_MARKER}@127.0.0.1:9/`,
      `http://user:${SECRET_MARKER}@[::1]:9/`,
      "http://127.0.0.1:9/events.json",
      "http://[::1]:9/events.json",
      "http://127.0.0.1:9/?page=2",
      "http://127.0.0.1:9/#top",
      "http://127.0.0.1:9/events.json?page=2#top",
    ];
    for (const target of refused) {
      it(`refuses ${target.replace(SECRET_MARKER, "<secret>")} before fetch`, async () => {
        const admission = await jsonAdmission(target);
        expect(admission.threw, `json-smoke admitted ${target}`).not.toBeNull();
        expect(admission.fetchCalls).toBe(0);
      });
    }
  });

  describe("refusal is deterministic with stable diagnostics and safe next action", () => {
    it("repeats the same refusal for the same database URL with zero effects", () => {
      for (const script of [E2E_SCRIPT, DEV_SCRIPT]) {
        const first = runFixtureScript(script, "postgres://192.168.1.10/disposable");
        const second = runFixtureScript(script, "postgres://192.168.1.10/disposable");
        try {
          expect(first.output.hasAdmissionError).toBe(true);
          expect(second.output.hasAdmissionError).toBe(true);
          expect(second.output.combined).toBe(first.output.combined);
          expect(first.output.scratchEntries).toEqual([]);
          expect(second.output.scratchEntries).toEqual([]);
        } finally {
          first.cleanup();
          second.cleanup();
        }
      }
    });

    it("repeats the same json-smoke refusal without fetching", async () => {
      const first = await jsonAdmission("http://192.168.1.10:9/");
      const second = await jsonAdmission("http://192.168.1.10:9/");
      expect(first.threw).not.toBeNull();
      expect(second.threw).not.toBeNull();
      expect(second.threw.message).toBe(first.threw.message);
      expect(first.fetchCalls).toBe(0);
      expect(second.fetchCalls).toBe(0);
    });

    it("names the admission contract in every refusal", async () => {
      const { output, cleanup } = runFixtureScript(E2E_SCRIPT, "postgres://8.8.8.8/disposable");
      try {
        expect(output.combined).toMatch(/loopback|Postgres/i);
      } finally {
        cleanup();
      }
      const jsonRefusal = await jsonAdmission("http://8.8.8.8:9/");
      expect(jsonRefusal.threw.message).toMatch(/staging-only|base-url must be/i);
    });
  });

  describe("refusal diagnostics never echo credential-bearing URLs", () => {
    it("never echoes database userinfo on refusal", () => {
      for (const script of [E2E_SCRIPT, DEV_SCRIPT]) {
        const { output, cleanup } = runFixtureScript(
          script,
          `postgres://user:${SECRET_MARKER}@evil.example/disposable`,
        );
        try {
          expect(output.hasAdmissionError).toBe(true);
          expect(output.combined).not.toContain(SECRET_MARKER);
          expect(output.combined).not.toContain("user:");
          expect(output.scratchEntries).toEqual([]);
        } finally {
          cleanup();
        }
      }
    });

    it("never echoes json-smoke userinfo, path, or query on refusal", async () => {
      for (const target of [
        `http://user:${SECRET_MARKER}@127.0.0.1:9/`,
        `http://user:${SECRET_MARKER}@[::1]:9/`,
        `http://127.0.0.1:9/events.json?token=${SECRET_MARKER}`,
      ]) {
        const admission = await jsonAdmission(target);
        expect(admission.threw).not.toBeNull();
        expect(admission.threw.message).not.toContain(SECRET_MARKER);
        expect(admission.threw.message).not.toContain("user:");
        expect(admission.fetchCalls).toBe(0);
      }
    });
  });

  describe("one shared loopback helper, no copied literals", () => {
    it("shares one relative helper import across all three consumers", () => {
      const sources = [E2E_SCRIPT, DEV_SCRIPT, SMOKE_SCRIPT].map((script) =>
        readFileSync(join(repoRoot, script), "utf8"),
      );
      const [e2eImports, devImports, smokeImports] = sources.map(relativeImports);
      const shared = [...e2eImports].filter(
        (spec) => devImports.has(spec) && smokeImports.has(spec),
      );
      expect(
        shared,
        `expected one shared helper import across ${E2E_SCRIPT}, ${DEV_SCRIPT}, ${SMOKE_SCRIPT}`,
      ).not.toHaveLength(0);
    });

    it("keeps loopback literals out of the three consumers", () => {
      for (const script of [E2E_SCRIPT, DEV_SCRIPT, SMOKE_SCRIPT]) {
        const source = readFileSync(join(repoRoot, script), "utf8");
        expect(source, `${script} still carries an IPv6 loopback literal`).not.toContain("::1");
        expect(source, `${script} still carries a bracketed IPv6 literal`).not.toContain("[::1]");
      }
    });

    it("keeps the shared helper pure: no fetch, spawn, config write, or database construction", () => {
      const sources = [E2E_SCRIPT, DEV_SCRIPT, SMOKE_SCRIPT].map((script) =>
        readFileSync(join(repoRoot, script), "utf8"),
      );
      const [e2eImports, devImports, smokeImports] = sources.map(relativeImports);
      const shared = [...e2eImports].filter(
        (spec) => devImports.has(spec) && smokeImports.has(spec),
      );
      expect(shared.length).toBeGreaterThan(0);
      for (const spec of shared) {
        // Resolve relative to the consumer that declares it; all three must
        // resolve to the same helper file.
        const candidates = [E2E_SCRIPT, DEV_SCRIPT, SMOKE_SCRIPT].map((script) =>
          join(repoRoot, dirname(script), spec),
        );
        const helperPath = candidates[0];
        const helper = readFileSync(helperPath, "utf8");
        expect(helper).toContain("127.0.0.1");
        expect(helper).toContain("localhost");
        expect(helper).toMatch(/\[::1\]|::1/);
        for (const effect of [
          "fetch(",
          "spawn(",
          "spawnSync(",
          "writeFile",
          "mkdtemp",
          "postgres(",
        ]) {
          expect(helper, `shared helper ${spec} must stay pure`).not.toContain(effect);
        }
      }
    });
  });

  describe("CLI help, exit-code, and ledger contracts are preserved", () => {
    it("keeps --help exit 0 with usage and zero effects", () => {
      const directory = scratch("fixture-help-");
      try {
        const work = join(directory, "work");
        mkdirSync(work);
        const result = spawnSync(process.execPath, [join(repoRoot, SMOKE_SCRIPT), "--help"], {
          env: { PATH: process.env.PATH ?? "" },
          cwd: work,
          encoding: "utf8",
          timeout: 8000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Usage:");
        expect(result.stdout).not.toContain("checks,");
        expect(readdirSync(work)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("keeps exit 2 for refused CLI targets", () => {
      for (const target of ["https://example.invalid", "file:///etc/passwd"]) {
        const result = spawnSync(process.execPath, [join(repoRoot, SMOKE_SCRIPT), target], {
          env: { PATH: process.env.PATH ?? "", QA_AUTH_TOKEN: SYNTHETIC_TOKEN },
          encoding: "utf8",
          timeout: 8000,
        });
        expect(result.status, target).toBe(2);
        expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).toMatch(
          /staging-only|base-url must be/,
        );
      }
    });

    it("keeps the 14-check ledger contract", () => {
      expect(JSON_SMOKE_CHECKS).toHaveLength(14);
      expect(JSON_SMOKE_CHECKS[0]).toBe("guest collection refusal");
      const entries = skippedLedgerEntries("acceptance pin");
      expect(entries).toHaveLength(14);
      expect(entries.every((entry) => entry.status === "skip")).toBe(true);
    });
  });

  describe("seed and operator-database guards are unchanged", () => {
    it("keeps the seed-staging refusals", () => {
      const seed = readFileSync(join(repoRoot, "bin/seed-staging.mjs"), "utf8");
      expect(seed).toContain("Refusing seed: SEED_CONFIRM must be staging.");
      expect(seed).toContain("Refusing seed: APP_URL must be an explicit staging or local URL.");
    });

    it("keeps the operator-database TLS floor", () => {
      const core = readFileSync(join(repoRoot, "bin/operator-db-core.mjs"), "utf8");
      expect(core).toContain("Refusing: remote database must use sslmode=verify-full");
      expect(core).toContain("Refusing: remote client requires verify-full TLS.");
    });
  });
});
