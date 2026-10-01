import postgres from "postgres";
import { beforeEach, expect, it, vi } from "vitest";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";
import { createJobsFixture } from "./helpers/jobs-db";
import { createUsersProfilesFixture } from "./helpers/import-users-profiles-db";

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
  ["wrong CI user", "postgres://arbitrary:ci@localhost:5432/postgres"],
  ["wrong CI password", "postgres://postgres:sentinel-secret@localhost:5432/postgres"],
  ["wrong CI port", "postgres://postgres:ci@localhost:5433/postgres"],
])("refuses %s even inside GitHub CI before driver construction", async (_label, raw) => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  try {
    await expect(createMemberDataFixture(raw)).rejects.toThrow("refusing before connecting");
    expect(postgres).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it.each([
  ["production host", "postgres://agent_test@production.example.test/postgres"],
  ["staging host", "postgres://agent_test@staging.example.test/postgres"],
  ["wrong principal", "postgres://postgres@agent-testdb/postgres"],
  ["unexpected password", "postgres://agent_test:sentinel-secret@agent-testdb/postgres"],
  ["wrong port", "postgres://agent_test@agent-testdb:5433/postgres"],
  ["homepage unexpected password", "postgres://agent_test:sentinel-secret@agent-testdb/two_web_next"],
  ["homepage wrong port", "postgres://agent_test@agent-testdb:5433/two_web_next"],
  ["driver override query", "postgres://agent_test@agent-testdb/postgres?host=production.example.test"],
  ["schema override query", "postgres://agent_test@agent-testdb/postgres?options=-csearch_path=public"],
  ["import schema override query", "postgres://agent_test@agent-testdb/two_web_next?search_path=public"],
  ["import startup options override", "postgres://agent_test@agent-testdb/two_web_next?options=-csearch_path=public"],
  ["import timezone override", "postgres://agent_test@agent-testdb/two_web_next?timezone=UTC"],
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
    await expect(createUsersProfilesFixture(raw)).rejects.toThrow("refusing before connecting");
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

it("refuses an import fixture in any other agent-testdb database before constructing a driver", async () => {
  await expect(createUsersProfilesFixture("postgres://agent_test@agent-testdb/postgres")).rejects.toThrow("refusing before connecting");
  expect(postgres).not.toHaveBeenCalled();
});

it("pins import fixture credentials and port instead of inheriting libpq settings", async () => {
  vi.stubEnv("PGPASSWORD", "sentinel-inherited-password");
  vi.stubEnv("PGPORT", "5433");
  try {
    await expect(createUsersProfilesFixture("postgres://agent_test@agent-testdb/two_web_next")).rejects.toThrow("unexpected DB connection");
    const options = vi.mocked(postgres).mock.calls[0]![1]!;
    expect(options.port).toBe(5432);
    expect(typeof options.password).toBe("function");
    expect((options.password as () => string)()).toBe("");
  } finally { vi.unstubAllEnvs(); }
});

it.each([
  {}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "false", GITHUB_ACTIONS: "true" },
])("does not enable the CI service from partial runner flags %j", async (runner) => {
  vi.stubEnv("CI", runner.CI ?? "");
  vi.stubEnv("GITHUB_ACTIONS", runner.GITHUB_ACTIONS ?? "");
  try {
    const raw = "postgres://postgres:ci@localhost:5432/postgres";
    expect(() => testDatabaseUrl(raw, runner)).toThrow("refusing before connecting");
    await expect(createMemberDataFixture(raw)).rejects.toThrow("refusing before connecting");
    expect(postgres).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});
