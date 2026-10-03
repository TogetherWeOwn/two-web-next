import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_TARGET,
  requireRemoteReceipt,
  type RemoteReceipt,
} from "../spike/hyperdrive-semantics/remote-target";
import {
  buildPreviewConfig,
  collectRemoteReceipt,
} from "../spike/hyperdrive-semantics/remote-runner";

const driver = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("password=do-not-serialize");
  }),
);
vi.mock("postgres", () => ({ default: driver }));
import { createRemoteProbe } from "../spike/hyperdrive-semantics/remote-worker";
const runKey = "a".repeat(64);
const receipt = (): RemoteReceipt => ({
  observedAt: new Date().toISOString(),
  executorAgentId: "fixture-executor",
  worker: REMOTE_TARGET.worker,
  sourceVersionId: "fixture-deployed-version",
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
});
const environment = () => ({
  PREFLIGHT: JSON.stringify(receipt()),
  RUN_KEY: runKey,
  DB: {
    connect: vi.fn(),
    host: "fixture-hyperdrive",
    port: 5432,
    database: REMOTE_TARGET.database,
    user: REMOTE_TARGET.user,
    password: "fixture-password",
  } as unknown as Hyperdrive,
});
const request = (method = "POST", route = "/run", body?: string) =>
  new Request("http://localhost" + route, {
    method,
    headers: { "X-W1-Run-Key": runKey },
    body,
  });

beforeEach(() => vi.clearAllMocks());
describe("remote preflight and preview configuration", () => {
  it("collects current settings without retaining the provider password", async () => {
    const get = vi.fn(async (resource: string) => {
      if (resource.includes("hyperdrive"))
        return {
          id: REMOTE_TARGET.hyperdriveId,
          name: REMOTE_TARGET.hyperdriveName,
          caching: { disabled: false },
          origin: { ...receipt().origin, password: "provider-secret" },
        };
      if (resource.endsWith("settings"))
        return {
          bindings: [
            { name: "DB", type: "hyperdrive", id: REMOTE_TARGET.hyperdriveId },
            { name: "APP_URL", type: "plain_text", text: REMOTE_TARGET.appUrl },
          ],
        };
      return {
        deployments: [{ versions: [{ version_id: "fixture-deployed-version", percentage: 100 }] }],
      };
    });
    const result = await collectRemoteReceipt("fixture-assigned-token", "fixture-executor", get);
    expect(() => requireRemoteReceipt(result)).not.toThrow();
    expect(get).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("fixture-assigned-token");
  });
  it("does not retry provider denials or construct a driver", async () => {
    const get = vi.fn(async () => {
      throw new Error("cloudflare_read_denied_http_403_code_10000");
    });
    await expect(collectRemoteReceipt("fixture-token", "executor", get)).rejects.toThrow("403");
    expect(get).toHaveBeenCalledOnce();
    expect(driver).not.toHaveBeenCalled();
  });
  it.each(["host", "database", "user", "port", "expired", "future", "binding", "worker", "source"])(
    "refuses changed %s",
    (kind) => {
      const r = receipt();
      if (kind === "host") r.origin.host = "production.neon.tech";
      if (kind === "database") r.origin.database = "production";
      if (kind === "user") r.origin.user = "production";
      if (kind === "port") r.origin.port = 5433;
      if (kind === "expired") r.observedAt = new Date(Date.now() - 300_001).toISOString();
      if (kind === "future") r.observedAt = new Date(Date.now() + 60_000).toISOString();
      if (kind === "binding") r.hyperdriveId = "production";
      if (kind === "worker") r.worker = "production";
      if (kind === "source") r.sourceVersionId = "";
      expect(() => requireRemoteReceipt(r)).toThrow("remote_staging_target_not_verified");
    },
  );
  it("builds only an unrouted, pinned ephemeral preview", () => {
    const config = buildPreviewConfig(receipt(), "/fixture/repo", runKey);
    expect(config).toMatchObject({
      workers_dev: false,
      preview_urls: false,
      routes: [],
      hyperdrive: [{ binding: "DB", id: REMOTE_TARGET.hyperdriveId }],
    });
    expect(config).not.toHaveProperty("assets");
    expect(config).not.toHaveProperty("triggers");
    expect(config.main).toBe("/fixture/repo/spike/hyperdrive-semantics/remote-worker.ts");
  });
});

describe("private fixed-probe entrypoint", () => {
  it("returns 404 without the per-run invocation nonce, including readiness", async () => {
    for (const route of ["/ready", "/run"]) {
      expect(
        (await createRemoteProbe().fetch(new Request("http://localhost" + route), environment()))
          .status,
      ).toBe(404);
    }
    expect(driver).not.toHaveBeenCalled();
  });
  it("readiness never opens a database", async () => {
    expect(
      await (await createRemoteProbe().fetch(request("GET", "/ready"), environment())).text(),
    ).toBe("ready");
    expect(driver).not.toHaveBeenCalled();
  });
  it.each([
    request("GET"),
    request("POST", "/run?sql=drop"),
    request("POST", "/run", "{}"),
    request("POST", "/other"),
  ])("refuses caller-selected input", async (r) => {
    expect((await createRemoteProbe().fetch(r, environment())).status).toBe(404);
    expect(driver).not.toHaveBeenCalled();
  });
  it.each(["receipt", "direct", "missing", "role", "database", "password", "port"])(
    "refuses invalid %s before SQL",
    async (kind) => {
      const env = environment();
      if (kind === "receipt") env.PREFLIGHT = "not JSON";
      if (kind === "direct") env.DB = { ...env.DB, host: REMOTE_TARGET.host };
      if (kind === "missing") env.DB = undefined as unknown as Hyperdrive;
      if (kind === "role") env.DB = { ...env.DB, user: "" };
      if (kind === "database") env.DB = { ...env.DB, database: "" };
      if (kind === "password") env.DB = { ...env.DB, password: "" };
      if (kind === "port") env.DB = { ...env.DB, port: 0 };
      expect((await createRemoteProbe().fetch(request(), env)).status).toBe(412);
      expect(driver).not.toHaveBeenCalled();
    },
  );
  it("redacts driver failures and replays the result without another SQL attempt", async () => {
    const probe = createRemoteProbe();
    const env = environment();
    const [one, two] = await Promise.all([
      probe.fetch(request(), env),
      probe.fetch(request(), env),
    ]);
    const result = await one.json();
    expect(result).toMatchObject({
      ok: false,
      error: "remote_staging_probe_failed",
      created: false,
      cleanup: true,
    });
    expect(await two.json()).toEqual(result);
    expect(driver).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("do-not-serialize");
  });
});

describe("preflight refusal diagnosis", () => {
  it("names failed predicates without leaking values", async () => {
    const { refusalReasons } = await import("../spike/hyperdrive-semantics/remote-worker");
    const env = environment();
    expect(refusalReasons(env)).toEqual([]);
    expect(refusalReasons(env, Date.now() + 301_000)).toEqual([
      "receipt_stale_or_unparseable_time",
    ]);
    const bad = { ...env, DB: { ...env.DB, user: "", password: "" } } as unknown as ReturnType<
      typeof environment
    >;
    expect(refusalReasons(bad)).toEqual(["binding_user_mismatch", "binding_password_missing"]);
    expect(refusalReasons({ ...env, PREFLIGHT: "{" })).toContain("receipt_unparseable");
  });
  it.each(["null", "false", "0", '""', "[]"])(
    "refuses non-object receipt %s without throwing",
    async (raw) => {
      const { refusalReasons } = await import("../spike/hyperdrive-semantics/remote-worker");
      expect(refusalReasons({ ...environment(), PREFLIGHT: raw })).toContain("receipt_not_object");
    },
  );
  it("returns structured refusal for malformed timestamp and non-string host", async () => {
    const { refusalReasons } = await import("../spike/hyperdrive-semantics/remote-worker");
    const env = environment();
    const r = { ...receipt(), observedAt: 5 as unknown as string };
    expect(refusalReasons({ ...env, PREFLIGHT: JSON.stringify(r) })).toEqual([
      "receipt_stale_or_unparseable_time",
    ]);
    const db = { ...env.DB, host: 5 } as unknown as Hyperdrive;
    expect(refusalReasons({ ...env, DB: db })).toEqual(["binding_host_missing"]);
  });
});
