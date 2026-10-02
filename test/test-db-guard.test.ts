// TOG-12549: global test-database guard matrix (port of the legacy guard).
//
// Pure validator proofs: no driver, no network, no DATABASE_URL connection.
// The global setup file (test/global-test-db-guard.ts) runs testDatabaseUrl
// over every set import URL before any suite connects; this file pins the
// accept/refuse matrix it enforces.
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { GUARDED_TEST_DB_VARS } from "./global-test-db-guard";

describe("global test-database guard matrix", () => {
  it("guards DATABASE_URL and both import URLs", () => {
    expect([...GUARDED_TEST_DB_VARS]).toEqual([
      "DATABASE_URL",
      "AUDIT_IMPORT_TEST_DATABASE_URL",
      "LEGACY_DATABASE_URL",
    ]);
  });

  it.each([
    ["empty db name (no path)", "postgres://agent_test@agent-testdb"],
    ["empty db name (slash only)", "postgres://agent_test@agent-testdb/"],
    ["production db name", "postgres://agent_test@agent-testdb/production"],
    ["prod db name", "postgres://agent_test@agent-testdb/prod"],
    ["controller db name", "postgres://agent_test@agent-testdb/controller"],
    ["uppercase production db name", "postgres://agent_test@agent-testdb/PRODUCTION"],
    ["prefix-only worktree name", "postgres://agent_test@agent-testdb/two_web_next_tog"],
    ["wrong role", "postgres://postgres@agent-testdb/postgres"],
    ["other role", "postgres://other@agent-testdb/two_web_next"],
    ["non-empty password", "postgres://agent_test:x@agent-testdb/postgres"],
    ["production host", "postgres://agent_test@production.example.test/postgres"],
    ["staging host", "postgres://agent_test@staging.example.test/some_db"],
    ["unknown host", "postgres://agent_test@db.example.test/two_web_next"],
    ["localhost without CI flags", "postgres://agent_test@localhost:5432/postgres"],
    ["wrong port", "postgres://agent_test@agent-testdb:5433/postgres"],
    ["query override", "postgres://agent_test@agent-testdb/postgres?host=production.example.test"],
    ["fragment", "postgres://agent_test@agent-testdb/postgres#public"],
    ["wrong protocol", "https://agent_test@agent-testdb/postgres"],
    ["malformed URL", "not-a-url"],
  ])("refuses %s before connecting without echoing the URL", (_label, raw) => {
    expect(() => testDatabaseUrl(raw, {})).toThrow("refusing before connecting");
    try {
      testDatabaseUrl(raw, {});
    } catch (error) {
      expect(String(error)).not.toContain(raw);
    }
  });

  it.each([
    "postgres://agent_test@agent-testdb/postgres",
    "postgres://agent_test@agent-testdb:5432/postgres",
    "postgres://agent_test@agent-testdb/two_web_next",
    "postgres://agent_test@agent-testdb:5432/two_web_next",
    "postgres://agent_test@agent-testdb/two_web_next_tog12345",
    "postgres://agent_test@agent-testdb:5432/two_web_next_tog12345",
  ])("allows agent-testdb URL %s", (raw) => {
    expect(testDatabaseUrl(raw, {}).hostname).toBe("agent-testdb");
  });

  it("allows the CI service only with both CI flags", () => {
    const raw = "postgres://postgres:ci@localhost:5432/postgres";
    expect(testDatabaseUrl(raw, { CI: "true", GITHUB_ACTIONS: "true" }).hostname).toBe("localhost");
    expect(() => testDatabaseUrl(raw, {})).toThrow("refusing before connecting");
  });
});
