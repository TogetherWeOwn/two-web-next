import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn((..._args: unknown[]) => { throw new Error("unexpected database connection"); });
vi.mock("postgres", () => ({ default: (...args: unknown[]) => connect(...args) }));
import app, { isTestDatabase } from "../spike/hyperdrive-semantics/probe-worker";

describe("W1 test-only probe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins driver options and redacts connection failures", async () => {
    const response = await app.request("/spike-run", { method: "POST" }, {
      DB: { connectionString: "postgresql://agent_test@agent-testdb/agent_test" },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "probe_error" });
    expect(connect).toHaveBeenCalledOnce();
    const options = connect.mock.calls[0]![0] as { password: () => string };
    expect(options).toMatchObject({
      host: "agent-testdb", port: 5432, username: "agent_test", database: "agent_test",
      ssl: false, prepare: false,
      connection: { statement_timeout: 5000, lock_timeout: 2000 },
    });
    expect(options.password()).toBe("");
  });

  it.each([
    "postgres://agent_test@agent-testdb:5432/agent_test",
    "postgresql://agent_test@agent-testdb/agent_test",
  ])("permits the explicit test container: %s", (url) => {
    expect(isTestDatabase(url)).toBe(true);
  });

  it.each([
    "postgres://agent_test@staging.example.com:5432/agent_test",
    "postgres://agent_test@production.example.com:5432/agent_test",
    "postgres://agent_test@agent-testdb:5433/agent_test",
    "postgres://other@agent-testdb:5432/agent_test",
    "postgres://agent_test:secret@agent-testdb:5432/agent_test",
    "postgres://agent_test@agent-testdb:5432/other",
    "postgres://agent_test@agent-testdb:5432/agent_test?host=staging.example.com",
    "postgres://agent_test@agent-testdb:5432/agent_test#fragment",
    "not-a-url",
    "",
  ])("refuses non-test targets before connecting: %s", async (url) => {
    const response = await app.request("/spike-run", { method: "POST" }, { DB: { connectionString: url } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "test_database_required" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses a missing binding before connecting", async () => {
    const response = await app.request("/spike-run", { method: "POST" }, {});
    expect(response.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["schema=public", "keep=1", "only=c"])("refuses caller-selected setup: %s", async (query) => {
    const response = await app.request(`/spike-run?${query}`, { method: "POST" }, {
      DB: { connectionString: "postgres://agent_test@agent-testdb:5432/agent_test" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "query_options_not_supported" });
    expect(connect).not.toHaveBeenCalled();
  });
});
