import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Actual runner, but synthetic provider/preview responses and no spawned process.
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), net: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:net", () => ({ default: { createServer: mocks.net } }));
import { main } from "../spike/hyperdrive-semantics/remote-runner";
import { REMOTE_TARGET } from "../spike/hyperdrive-semantics/remote-target";

const revision = "c".repeat(40);
const schema = "w1_staging_" + "c".repeat(32);
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(payload: unknown, status = 500, invalidJson = false) {
  const dir = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.tmpdir(), "w1-response-"));
  dirs.push(dir);
  const root = path.join(dir, "source");
  mkdirSync(path.join(root, "node_modules/wrangler"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/wrangler/package.json"), JSON.stringify({ version: "4.143.1" }));
  writeFileSync(path.join(root, ".w1-source-revision"), revision + "\n");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("W1_REMOTE_RUN_DIR", dir); vi.stubEnv("W1_SOURCE_REVISION", revision);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic-not-a-grant"); vi.stubEnv("PAPERCLIP_AGENT_ID", "synthetic-executor");
  mocks.net.mockImplementation(() => ({ once() {}, listen(_port: number, _host: string, ready: () => void) { ready(); },
    address: () => ({ port: 12345 }), close(done: () => void) { done(); } }));
  mocks.spawn.mockImplementation((_command, _args, options) => {
    writeSync(options.stdio[1], "private synthetic-token-not-evidence\nW1_SCHEMA " + JSON.stringify({ schema, created: true, cleanup: "not_verified" }) + "\n");
    const child = new EventEmitter();
    return Object.assign(child, { kill() { child.emit("exit", 0); } });
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/ready")) return new Response("ready");
    if (url.endsWith("/run")) return invalidJson ? new Response("synthetic-token-not-evidence", { status }) : Response.json(payload, { status });
    let result;
    if (url.includes("hyperdrive/configs")) result = { id: REMOTE_TARGET.hyperdriveId, name: REMOTE_TARGET.hyperdriveName,
      caching: { disabled: false }, origin: { host: REMOTE_TARGET.host, port: 5432, database: REMOTE_TARGET.database, user: REMOTE_TARGET.user } };
    else if (url.endsWith("/settings")) result = { bindings: [{ name: "DB", type: "hyperdrive", id: REMOTE_TARGET.hyperdriveId },
      { name: "APP_URL", type: "plain_text", text: REMOTE_TARGET.appUrl }] };
    else if (url.endsWith("/deployments")) result = { deployments: [{ versions: [{ version_id: "synthetic-version", percentage: 100 }] }] };
    else throw new Error("unmocked_network_refused");
    return Response.json({ success: true, result });
  }));
  return dir;
}
function completed() {
  return { ok: true, schema, created: true, cleanup: true, version: "PostgreSQL 17.11",
    passed: 3, total: 3, teardownFailures: [], path: "wrangler-remote-hyperdrive-neon-staging",
    checks: [
      { name: "(a) FOR UPDATE", pass: true, status: "passed", detail: "blocked_55P03=true second_seat_refused=true going=1" },
      { name: "(b) advisory xact lock", pass: true, status: "passed", detail: "concurrent_refused=true reacquired=true" },
      { name: "(c) jsonb+GIN", pass: true, status: "passed", detail: "uses_gin=true rows=2001 hits=1" },
    ] };
}

describe("remote runner evidence persistence (offline)", () => {
  it.each([null, [], "synthetic-token-not-evidence", 1, {}, { error: "synthetic-token-not-evidence" },
    { ok: true, cleanup: true }, { ...completed(), cleanup: undefined },
    { ...completed(), checks: [] }, { ...completed(), passed: 1 }])("rejects unexpected JSON %# without losing schema recovery", async (payload) => {
    const dir = fixture(payload);
    expect(await main()).toBe(1);
    const evidence = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
    expect(evidence).toMatchObject({ revision, result: { ok: false, cleanup: "not_verified", schema } });
    expect(JSON.stringify(evidence)).not.toContain("synthetic-token-not-evidence");
  });
  it("persists unknown-cleanup evidence even for a non-JSON proxy response", async () => {
    const dir = fixture(null, 502, true);
    expect(await main()).toBe(1);
    expect(JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")).result).toMatchObject({ ok: false, cleanup: "not_verified", schema });
  });
  it("preserves complete checks and cleanup but never copies arbitrary response fields", async () => {
    const result = completed();
    const dir = fixture({ ...result, password: "synthetic-token-not-evidence", preflight: { token: "synthetic-token-not-evidence" } }, 200);
    expect(await main()).toBe(0);
    const evidence = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
    expect(evidence.result).toEqual(result);
    expect(JSON.stringify(evidence)).not.toContain("synthetic-token-not-evidence");
  });
  it("retains supported partial failures and verified cleanup, not HTTP success", async () => {
    const result = { ...completed(), ok: false, failedStage: "close", teardownFailures: ["close"], error: "remote_staging_probe_failed" };
    delete (result as Partial<typeof result>).path;
    const dir = fixture(result);
    expect(await main()).toBe(1);
    expect(JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")).result).toEqual(result);
  });
  it("accepts explicit preflight refusal without a schema or SQL success", async () => {
    const result = { ok: false, error: "remote_staging_preflight_refused", cleanup: true };
    const dir = fixture(result, 412);
    expect(await main()).toBe(1);
    expect(JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")).result).toEqual(result);
  });
});
