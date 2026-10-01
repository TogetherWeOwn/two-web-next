import { beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { PREFLIGHT_MAX_AGE_MS, REQUIRED_READS, requireStagingPreflight, STAGING_TARGET, type StagingPreflight } from "../spike/hyperdrive-semantics/staging-preflight";
import { runFixedStagingChecks } from "../spike/hyperdrive-semantics/staging-checks";

const connect = vi.hoisted(() => vi.fn((..._args: unknown[]): never => { throw new Error("secret database error"); }));
vi.mock("postgres", () => ({ default: (...args: unknown[]) => connect(...args) }));
import { runStagingProbe } from "../spike/hyperdrive-semantics/staging-probe";

const executor = "test-executor";
const now = Date.now();
function receipt(): StagingPreflight {
  // Synthetic fixtures ONLY: deliberately not an asserted live Worker name.
  return {
    observedAt: new Date(now).toISOString(),
    principal: { agentId: executor, subject: "fixture-principal", transport: "fixture-read-route", permittedVerbs: [...REQUIRED_READS] },
    worker: { name: "fixture-worker-discovered-from-settings", versionId: "fixture-version", bindings: [{ name: "DB", type: "hyperdrive", id: STAGING_TARGET.hyperdriveId }] },
    hyperdrive: { id: STAGING_TARGET.hyperdriveId, name: STAGING_TARGET.hyperdriveName, cachingDisabled: true,
      origin: { host: "fixture-staging.neon.tech", database: "fixture", user: "fixture-role" } },
    neon: { projectId: "fixture-project-id", projectName: STAGING_TARGET.project, branchId: "fixture-branch-id", branchName: STAGING_TARGET.branch,
      defaultBranch: false, endpoint: { branchId: "fixture-branch-id", host: "fixture-staging.neon.tech" }, database: "fixture", user: "fixture-role" },
  };
}
function environment() {
  return {
    CF_VERSION_METADATA: { id: "fixture-version" },
    DB: { connect: vi.fn(), host: "fixture-runtime-pooler", port: 5432, user: "fixture-role", password: "fixture-password", database: "fixture" } as unknown as Hyperdrive,
  };
}

describe("staging harness pre-SQL refusal", () => {
  beforeEach(() => vi.clearAllMocks());
  it("accepts matching non-secret metadata without opening a database", () => {
    expect(() => requireStagingPreflight(receipt(), executor, now)).not.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  const changes: [string, (r: StagingPreflight) => void][] = [
    ["expired metadata", (r) => { r.observedAt = new Date(now - PREFLIGHT_MAX_AGE_MS - 1).toISOString(); }],
    ["future metadata", (r) => { r.observedAt = new Date(now + 60_000).toISOString(); }],
    ["missing date", (r) => { r.observedAt = ""; }],
    ["borrowed principal", (r) => { r.principal.agentId = "another-executor"; }],
    ["missing subject", (r) => { r.principal.subject = ""; }],
    ["missing route", (r) => { r.principal.transport = ""; }],
    ["missing verb", (r) => { r.principal.permittedVerbs.pop(); }],
    ["missing Worker name", (r) => { r.worker.name = ""; }],
    ["missing version", (r) => { r.worker.versionId = ""; }],
    ["wrong binding ID", (r) => { r.worker.bindings[0]!.id = "production-id"; }],
    ["wrong binding type", (r) => { r.worker.bindings[0]!.type = "plain_text"; }],
    ["missing binding", (r) => { r.worker.bindings = []; }],
    ["duplicate binding", (r) => { r.worker.bindings.push(r.worker.bindings[0]!); }],
    ["wrong Hyperdrive ID", (r) => { r.hyperdrive.id = "other-id"; }],
    ["wrong Hyperdrive name", (r) => { r.hyperdrive.name = "production"; }],
    ["cached queries", (r) => { r.hyperdrive.cachingDisabled = false; }],
    ["wrong project", (r) => { r.neon.projectName = "other-project"; }],
    ["production branch", (r) => { r.neon.branchName = "production"; }],
    ["default branch", (r) => { r.neon.defaultBranch = true; }],
    ["missing project ID", (r) => { r.neon.projectId = ""; }],
    ["missing branch ID", (r) => { r.neon.branchId = ""; }],
    ["endpoint of another branch", (r) => { r.neon.endpoint.branchId = "other-branch"; }],
    ["origin mismatch", (r) => { r.hyperdrive.origin.host = "production.neon.tech"; }],
    ["database mismatch", (r) => { r.hyperdrive.origin.database = "other-db"; }],
    ["role mismatch", (r) => { r.hyperdrive.origin.user = "other-role"; }],
  ];
  it.each(changes)("refuses %s before driver construction", async (_name, change) => {
    const evidence = receipt(); change(evidence);
    await expect(runStagingProbe(environment(), evidence, executor)).rejects.toThrow("staging_preflight_not_verified");
    expect(connect).not.toHaveBeenCalled();
  });
  it("refuses absent evidence", async () => {
    await expect(runStagingProbe(environment(), undefined as unknown as StagingPreflight, executor)).rejects.toThrow("staging_preflight_not_verified");
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(["missing", "version", "direct-origin", "direct-neon", "local", "port", "empty-password", "fake-binding", "database", "user"])("refuses invalid runtime %s", async (kind) => {
    const env = environment();
    if (kind === "missing") env.DB = undefined as unknown as Hyperdrive;
    if (kind === "version") env.CF_VERSION_METADATA.id = "other-version";
    if (kind === "direct-origin") env.DB = { ...env.DB, host: receipt().hyperdrive.origin.host };
    if (kind === "direct-neon") env.DB = { ...env.DB, host: "other.neon.tech" };
    if (kind === "local") env.DB = { ...env.DB, host: "agent-testdb" };
    if (kind === "port") env.DB = { ...env.DB, port: 0 };
    if (kind === "empty-password") env.DB = { ...env.DB, password: "" };
    if (kind === "fake-binding") env.DB = { ...env.DB, connect: undefined as unknown as Hyperdrive["connect"] };
    if (kind === "database") env.DB = { ...env.DB, database: "other" };
    if (kind === "user") env.DB = { ...env.DB, user: "other" };
    await expect(runStagingProbe(env, receipt(), executor)).rejects.toThrow("actual_worker_hyperdrive_binding_required");
    expect(connect).not.toHaveBeenCalled();
  });
  it("pins the driver exclusively to runtime fields and redacts failures", async () => {
    await expect(runStagingProbe(environment(), receipt(), executor)).rejects.toThrow("staging_probe_failed_cleanup_not_verified");
    expect(connect).toHaveBeenCalledOnce();
    const options = connect.mock.calls[0]![0] as { password: () => string };
    expect(options).toMatchObject({ host: "fixture-runtime-pooler", port: 5432, username: "fixture-role", database: "fixture", max: 1,
      fetch_types: false, prepare: true, connect_timeout: 5, connection: { statement_timeout: 5000, lock_timeout: 2000 } });
    expect(options.password()).toBe("fixture-password");
  });
});

function fixture(failAt?: string, closeFailure = false, gin = true, lockCode = "55P03") {
  const statements: string[] = [];
  const clients: { end: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }[] = [];
  let eventReads = 0; let advisoryReads = 0;
  const open = () => {
    const execute = async (statement: string) => {
      statements.push(statement);
      if (failAt && statement.includes(failAt)) throw new Error("fixture_failure");
      if (statement.includes("version()")) return [{ version: "fixture-version" }];
      if (statement.includes("SELECT id,") && statement.includes("FOR UPDATE")) {
        if (++eventReads === 2) throw Object.assign(new Error("contention"), { code: lockCode });
        return [{ id: 1 }];
      }
      if (statement.includes("SELECT capacity")) return [{ capacity: 1 }];
      if (statement.includes("pg_namespace")) return [{ n: 0 }];
      if (statement.includes("count(*)")) return [{ n: 1 }];
      if (statement.includes("pg_backend_pid")) return [{ id: 123 }];
      if (statement.includes("pg_try_advisory_xact_lock")) return [{ ok: ++advisoryReads === 2 }];
      if (statement.includes("EXPLAIN")) return [{ "QUERY PLAN": gin ? "Bitmap Index Scan on spike_access_logs_subject_user_ids_gin" : "Seq Scan" }];
      return [];
    };
    const sql = Object.assign((parts: TemplateStringsArray) => execute(parts.join("?")), {
      unsafe: vi.fn((statement: string, _params: unknown, options: unknown) => {
        expect(options).toEqual({ prepare: true, simple: false }); return execute(statement);
      }),
      reserve: vi.fn(async () => sql), release: vi.fn(),
      end: vi.fn(async () => { if (closeFailure && clients.indexOf(sql) === 0) throw new Error("close_failure"); }),
    });
    clients.push(sql);
    return sql as unknown as ReturnType<typeof postgres>;
  };
  return { open, statements, clients };
}

describe("fixed staging check cleanup (offline fixtures)", () => {
  it("returns all three fixed results only after cleanup", async () => {
    const f = fixture(); const result = await runFixedStagingChecks(f.open);
    expect(result).toMatchObject({ ok: true, passed: 3, total: 3, cleanup: true });
    expect(result.schema).toMatch(/^w1_staging_[a-f0-9]{32}$/);
    expect(f.statements.filter((s) => s.includes("DROP SCHEMA"))).toEqual([`DROP SCHEMA ${result.schema} CASCADE`]);
    expect(f.clients).toHaveLength(3);
    for (const client of f.clients) expect(client.end).toHaveBeenCalledWith({ timeout: 2 });
    expect(f.clients[1]!.release).toHaveBeenCalledOnce(); expect(f.clients[2]!.release).toHaveBeenCalledOnce();
  });
  it("does not claim a partial GIN failure as success", async () => {
    const f = fixture(undefined, false, false);
    expect(await runFixedStagingChecks(f.open)).toMatchObject({ ok: false, passed: 2, cleanup: true });
  });
  it.each(["CREATE TABLE", "INSERT INTO", "SELECT capacity", "pg_advisory_xact_lock", "EXPLAIN", "DROP SCHEMA"])("cleans up and closes after %s failure", async (statement) => {
    const f = fixture(statement);
    await expect(runFixedStagingChecks(f.open)).rejects.toThrow();
    expect(f.statements.filter((s) => s.includes("DROP SCHEMA"))).toHaveLength(1);
    for (const client of f.clients) expect(client.end).toHaveBeenCalledOnce();
    for (const client of f.clients.slice(1)) expect(client.release).toHaveBeenCalledOnce();
  });
  it("does not drop a schema when creation failed", async () => {
    const f = fixture("CREATE SCHEMA");
    await expect(runFixedStagingChecks(f.open)).rejects.toThrow("staging_probe_failed");
    expect(f.statements.some((s) => s.includes("DROP SCHEMA"))).toBe(false);
    expect(f.clients[0]!.end).toHaveBeenCalledOnce();
  });
  it("does not turn an unrelated lock failure into contention success", async () => {
    const f = fixture(undefined, false, true, "08006");
    await expect(runFixedStagingChecks(f.open)).rejects.toThrow("staging_probe_failed");
    expect(f.statements.some((s) => s.includes("DROP SCHEMA"))).toBe(true);
    for (const client of f.clients) expect(client.end).toHaveBeenCalledOnce();
  });
  it("attempts every close and fails closed on termination failure", async () => {
    const f = fixture(undefined, true);
    await expect(runFixedStagingChecks(f.open)).rejects.toThrow("staging_probe_failed");
    for (const client of f.clients) expect(client.end).toHaveBeenCalledOnce();
  });
  it("uses a different owned schema on each invocation", async () => {
    const one = await runFixedStagingChecks(fixture().open); const two = await runFixedStagingChecks(fixture().open);
    expect(one.schema).not.toBe(two.schema);
  });
});
