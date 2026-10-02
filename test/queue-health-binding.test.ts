import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env, JobsEnv } from "../src/env";
import { handleQueue } from "../src/jobs/worker";
import { healthSql } from "./helpers/up";

// Constructor/route proof only: neither sentinel backend ever connects.
vi.mock("postgres", () => ({ default: vi.fn() }));

const explicit = "postgres://explicit.invalid/db";
const bound = "postgres://bound.invalid/db";
const environment = (sources: Record<string, unknown>) => ({
  APP_URL: "https://next.example.test",
  ...sources,
  SYNC_EVENT_QUEUE: { send: vi.fn(async () => {}) },
  INTERNAL_ACTION_QUEUE: { send: vi.fn(async () => {}) },
}) as unknown as Env & JobsEnv;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(postgres).mockImplementation((url) => Object.assign(healthSql({ queue: [{
    pending: url === explicit ? 25 : 0,
    delayed: 0, reserved: 0, total: url === explicit ? 25 : 0,
    failed: 0, oldest_pending_age_seconds: 0,
  }] }), { end: vi.fn(async () => {}) }) as unknown as ReturnType<typeof postgres>);
});

for (const [name, sources, expected, pending] of [
  ["explicit configuration wins distinct bindings", { DATABASE_URL: explicit, DB: { connectionString: bound } }, explicit, 25],
  ["binding-only control", { DB: { connectionString: bound } }, bound, 0],
  ["empty override uses binding", { DATABASE_URL: "", DB: { connectionString: bound } }, bound, 0],
] as const) {
  describe(name, () => {
    it("health measures the same backend as every worker pool", async () => {
      const env = environment(sources);
      await handleQueue({ messages: [] } as unknown as MessageBatch<unknown>, env);
      const workerCalls = vi.mocked(postgres).mock.calls;
      expect(workerCalls).toHaveLength(3);
      expect(workerCalls.map(([url]) => url)).toEqual([expected, expected, expected]);

      const response = await app.request("/up", {}, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect((await response.json()) as { queue: { pending: number; status: string } }).toMatchObject({
        queue: { pending, status: pending ? "degraded" : "healthy" },
      });
      expect(vi.mocked(postgres).mock.calls.map(([url]) => url)).toEqual([expected, expected, expected, expected]);
      for (const result of vi.mocked(postgres).mock.results) {
        expect(result.value.end).toHaveBeenCalledOnce();
      }
    });
  });
}

it("a selected backend queue read failure stays unknown without trying the other binding", async () => {
  vi.mocked(postgres).mockImplementation(() => Object.assign(
    healthSql({ queue: new Error("selected backend unavailable") }),
    { end: vi.fn(async () => {}) },
  ) as unknown as ReturnType<typeof postgres>);
  const response = await app.request("/up", {}, environment({ DATABASE_URL: explicit, DB: { connectionString: bound } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ db: "ok", queue: { status: "unknown", pending: null } });
  expect(vi.mocked(postgres).mock.calls.map(([url]) => url)).toEqual([explicit]);
});

it("selected client construction failure never falls back to the other binding", async () => {
  vi.mocked(postgres).mockImplementation(() => { throw new Error("selected client refused"); });
  const response = await app.request("/up", {}, environment({ DATABASE_URL: explicit, DB: { connectionString: bound } }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ db: "error", queue: { status: "unknown", pending: null } });
  expect(vi.mocked(postgres).mock.calls.map(([url]) => url)).toEqual([explicit]);
});
