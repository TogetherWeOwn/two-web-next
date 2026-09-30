import postgres from "postgres";
import { beforeEach, expect, it, vi } from "vitest";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";
import { createJobsFixture } from "./helpers/jobs-db";

// Refusal must precede even constructing a driver, not just its first query.
vi.mock("postgres", () => ({ default: vi.fn(() => { throw new Error("unexpected DB connection"); }) }));
beforeEach(() => vi.clearAllMocks());

it("permits only the test container, or the exact service URL inside GitHub CI", () => {
  expect(testDatabaseUrl("postgres://agent_test@agent-testdb:5432/postgres", {}).hostname).toBe("agent-testdb");
  expect(testDatabaseUrl("postgresql://agent_test@agent-testdb/w15_tests", {}).password).toBe("");
  expect(testDatabaseUrl("postgres://postgres:ci@localhost:5432/postgres", { CI: "true", GITHUB_ACTIONS: "true" }).hostname).toBe("localhost");
  expect(postgres).not.toHaveBeenCalled();
});

it.each([
  ["production host", "postgres://agent_test@production.example.test/postgres"],
  ["staging host", "postgres://agent_test@staging.example.test/postgres"],
  ["wrong principal", "postgres://postgres@agent-testdb/postgres"],
  ["unexpected password", "postgres://agent_test:sentinel-secret@agent-testdb/postgres"],
  ["wrong port", "postgres://agent_test@agent-testdb:5433/postgres"],
  ["driver override query", "postgres://agent_test@agent-testdb/postgres?host=production.example.test"],
  ["schema override query", "postgres://agent_test@agent-testdb/postgres?options=-csearch_path=public"],
  ["fragment", "postgres://agent_test@agent-testdb/postgres#public"],
  ["wrong protocol", "https://agent_test@agent-testdb/postgres"],
  ["malformed URL", "not-a-url"],
  ["missing database", "postgres://agent_test@agent-testdb"],
  ["CI URL outside CI", "postgres://postgres:ci@localhost:5432/postgres"],
])("refuses %s before driver construction without echoing the URL", async (_label, raw) => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  try {
    expect(() => testDatabaseUrl(raw, {})).toThrow("refusing before connecting");
    await expect(createMemberDataFixture(raw)).rejects.toThrow("refusing before connecting");
    await expect(createJobsFixture(raw)).rejects.toThrow("refusing before connecting");
    expect(postgres).not.toHaveBeenCalled();
    try { testDatabaseUrl(raw, {}); } catch (error) { expect(String(error)).not.toContain(raw); }
  } finally { vi.unstubAllEnvs(); }
});

it("pins the empty test password and port instead of inheriting libpq credentials/options", async () => {
  vi.stubEnv("PGPASSWORD", "sentinel-inherited-password");
  vi.stubEnv("PGPORT", "5433");
  try {
    await expect(createMemberDataFixture("postgres://agent_test@agent-testdb/postgres")).rejects.toThrow("unexpected DB connection");
    const options = vi.mocked(postgres).mock.calls[0]![1]!;
    expect(options.port).toBe(5432);
    expect(typeof options.password).toBe("function");
    expect((options.password as () => string)()).toBe("");
  } finally { vi.unstubAllEnvs(); }
});

it.each([
  {}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "false", GITHUB_ACTIONS: "true" },
])("does not enable the CI service from partial runner flags %j", (runner) => {
  expect(() => testDatabaseUrl("postgres://postgres:ci@localhost:5432/postgres", runner)).toThrow("refusing before connecting");
  expect(postgres).not.toHaveBeenCalled();
});
