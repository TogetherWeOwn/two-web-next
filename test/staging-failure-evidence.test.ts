import { beforeEach, expect, it, vi } from "vitest";
import { REMOTE_TARGET } from "../spike/hyperdrive-semantics/remote-target";
import { parseRemoteResult } from "../spike/hyperdrive-semantics/remote-runner";
import type { StagingResult } from "../spike/hyperdrive-semantics/staging-checks";
const driver = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({ default: driver }));
import { createRemoteProbe } from "../spike/hyperdrive-semantics/remote-worker";

const nonce = "b".repeat(64);
function fixture(
  failAt: string,
  code = "08006",
  closeFailure = false,
  dropFailure = false,
  rollbackFailure = false,
) {
  const schemas = new Set<string>();
  const statements: string[] = [];
  let eventReads = 0;
  let advisoryReads = 0;
  let rollbacks = 0;
  driver.mockImplementation(() => {
    const execute = async (statement: string) => {
      statements.push(statement);
      if (statement.startsWith("CREATE SCHEMA")) {
        // A duplicate-schema refusal means the requested name already exists.
        if (code !== "42501" || failAt !== "CREATE SCHEMA") schemas.add(statement.split(" ")[2]!);
      }
      if (
        statement.includes(failAt) ||
        (dropFailure && statement.startsWith("DROP SCHEMA")) ||
        (rollbackFailure && statement === "ROLLBACK" && ++rollbacks >= 2)
      ) {
        throw Object.assign(new Error("password=fixture-secret arbitrary SQL"), { code });
      }
      if (statement.startsWith("DROP SCHEMA")) schemas.delete(statement.split(" ")[2]!);
      if (statement.includes("version()")) return [{ version: "PostgreSQL 17.11" }];
      if (statement.includes("SELECT id,") && statement.includes("FOR UPDATE")) {
        if (++eventReads === 2)
          throw Object.assign(new Error("fixture contention"), { code: "55P03" });
        return [{ id: 1 }];
      }
      if (statement.includes("SELECT capacity")) return [{ capacity: 1 }];
      if (statement.includes("pg_namespace")) return [{ n: schemas.size }];
      if (statement.includes("count(*)")) return [{ n: 1 }];
      if (statement.includes("pg_backend_pid")) return [{ id: 123 }];
      if (statement.includes("pg_try_advisory_xact_lock")) return [{ ok: ++advisoryReads === 2 }];
      if (statement.includes("EXPLAIN"))
        return [{ "QUERY PLAN": "Bitmap Index Scan on spike_access_logs_subject_user_ids_gin" }];
      return [];
    };
    const sql = Object.assign((parts: TemplateStringsArray) => execute(parts.join("?")), {
      unsafe: (statement: string) => execute(statement),
      reserve: async () => sql,
      release: vi.fn(),
      end: async () => {
        if (closeFailure) throw new Error("password=fixture-secret");
      },
    });
    return sql;
  });
  return { schemas, statements };
}
async function run() {
  const receipt = {
    observedAt: new Date().toISOString(),
    executorAgentId: "fixture-executor",
    worker: REMOTE_TARGET.worker,
    sourceVersionId: "fixture-version",
    hyperdriveId: REMOTE_TARGET.hyperdriveId,
    hyperdriveName: REMOTE_TARGET.hyperdriveName,
    origin: {
      host: REMOTE_TARGET.host,
      port: 5432,
      database: REMOTE_TARGET.database,
      user: REMOTE_TARGET.user,
    },
    cachingDisabled: false,
    mappingSource: "operator-TOG-9836-current-cloudflare-origin-match",
  };
  const env = {
    RUN_KEY: nonce,
    PREFLIGHT: JSON.stringify(receipt),
    DB: {
      connect: vi.fn(),
      host: "fixture-hyperdrive",
      port: 5432,
      database: REMOTE_TARGET.database,
      user: REMOTE_TARGET.user,
      password: "fixture-password",
    } as unknown as Hyperdrive,
  };
  const response = await createRemoteProbe().fetch(
    new Request("http://localhost/run", {
      method: "POST",
      headers: { "X-W1-Run-Key": nonce },
    }),
    env,
  );
  expect(response.status).toBe(500);
  const result = (await response.json()) as StagingResult;
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("arbitrary SQL");
  const { preflight, ...supported } = result as StagingResult & { preflight: unknown };
  expect(preflight).toBeDefined();
  expect(parseRemoteResult(result)).toEqual(supported);
  return result;
}
beforeEach(() => vi.clearAllMocks());

it("retains schema identity and uncertainty after a lost CREATE acknowledgement without unsafe DROP", async () => {
  const f = fixture("CREATE SCHEMA");
  const result = await run();
  expect(result).toMatchObject({
    created: "not_verified",
    cleanup: "not_verified",
    failedStage: "create_schema",
    passed: 0,
  });
  expect(result.schema).toMatch(/^w1_staging_[a-f0-9]{32}$/);
  expect(f.schemas).toEqual(new Set([result.schema]));
  expect(f.statements.some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
  expect(result.checks.map((c: { status: string }) => c.status)).toEqual([
    "not_attempted",
    "not_attempted",
    "not_attempted",
  ]);
});
it.each(["42P06", "42501"])(
  "distinguishes definite CREATE refusal %s from acknowledgement loss",
  async (code) => {
    const f = fixture("CREATE SCHEMA", code);
    const result = await run();
    expect(result).toMatchObject({ created: false, cleanup: true, failedStage: "create_schema" });
    expect(f.schemas.size).toBe(code === "42P06" ? 1 : 0);
    if (code === "42P06") expect(f.schemas.has(result.schema)).toBe(true);
    expect(f.statements.some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
  },
);
it.each([
  ["SELECT version", "connect", ["not_attempted", "not_attempted", "not_attempted"], 0],
  ["CREATE TABLE", "setup", ["not_attempted", "not_attempted", "not_attempted"], 0],
  ["SELECT capacity", "a", ["failed", "not_attempted", "not_attempted"], 0],
  ["pg_advisory_xact_lock", "b", ["passed", "failed", "not_attempted"], 1],
  ["EXPLAIN", "c", ["passed", "passed", "failed"], 2],
  ["DROP SCHEMA", "cleanup", ["passed", "passed", "passed"], 3],
] as const)(
  "preserves per-check evidence after %s throws",
  async (sql, stage, statuses, passed) => {
    const f = fixture(sql);
    const result = await run();
    expect(result).toMatchObject({
      ok: false,
      failedStage: stage,
      passed,
      cleanup: stage === "cleanup" ? "not_verified" : true,
    });
    expect(result.checks.map((c: { status: string }) => c.status)).toEqual(statuses);
    expect(f.schemas.size).toBe(stage === "cleanup" ? 1 : 0);
  },
);
it("retains the primary failed stage through DROP and close failures", async () => {
  const f = fixture("pg_advisory_xact_lock", "08006", true, true);
  const result = await run();
  expect(result).toMatchObject({
    failedStage: "b",
    passed: 1,
    cleanup: "not_verified",
    teardownFailures: ["cleanup", "close"],
  });
  expect(result.checks.map((c) => c.status)).toEqual(["passed", "failed", "not_attempted"]);
  expect(f.schemas.has(result.schema)).toBe(true);
});
it("retains completed advisory evidence when its following rollback throws", async () => {
  fixture("never-match", "08006", false, false, true);
  const result = await run();
  expect(result).toMatchObject({
    ok: false,
    passed: 2,
    cleanup: true,
    failedStage: "b",
    teardownFailures: [],
  });
  expect(result.checks.map((c) => c.status)).toEqual(["passed", "passed", "not_attempted"]);
});
it.each(["create_schema", "cleanup"])(
  "retains acknowledged state after the %s reporting callback throws",
  async (stage) => {
    fixture("never-match");
    const report = vi.spyOn(console, "info").mockImplementation((marker: string) => {
      const state = JSON.parse(marker.slice("W1_SCHEMA ".length));
      if (state.created === true && state.cleanup === (stage === "cleanup" ? true : "not_verified"))
        throw new Error("synthetic-report-error");
    });
    try {
      const result = await run();
      expect(result).toMatchObject({
        created: true,
        cleanup: true,
        failedStage: stage,
        teardownFailures: stage === "cleanup" ? ["cleanup"] : [],
      });
    } finally {
      report.mockRestore();
    }
  },
);
it("preserves all completed checks and verified schema cleanup after close throws", async () => {
  fixture("never-match", "08006", true);
  const result = await run();
  expect(result).toMatchObject({
    ok: false,
    passed: 3,
    cleanup: true,
    failedStage: "close",
    teardownFailures: ["close"],
  });
  expect(result.checks.map((c: { status: string }) => c.status)).toEqual([
    "passed",
    "passed",
    "passed",
  ]);
});
