// Browser CI database admission for the saved-event review acceptance.
// The browser-smoke workflow (e2e.yml) uses a disposable postgres:17 service:
// user agent_test, empty password, database two_web_next, served at
// 127.0.0.1:5432. The shared guard previously admitted only the unit
// workflow tuple (localhost/postgres/ci/postgres) under CI flags, so the
// native Playwright spec refused before connecting. This pins the exact
// legitimate browser tuple plus negative neighbors, hermetically: pure
// URL validation and refusal-before-driver-construction, no live
// CI/production/staging connections.
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

// Refusal must precede even constructing a driver, not just its first query.
vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("unexpected DB connection");
  }),
}));
beforeEach(() => vi.clearAllMocks());

const BROWSER_URL = "postgres://agent_test@127.0.0.1:5432/two_web_next";
const BROWSER_RUNNER = { CI: "true", GITHUB_ACTIONS: "true" };
const UNIT_URL = "postgres://postgres:ci@localhost:5432/postgres";
const LOCAL_URL = "postgres://agent_test@agent-testdb/two_web_next";

describe("saved-event browser CI database admission", () => {
  it("admits the exact browser workflow tuple only with both CI flags", () => {
    const url = testDatabaseUrl(BROWSER_URL, BROWSER_RUNNER);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.username).toBe("agent_test");
    expect(url.password).toBe("");
    expect(url.pathname).toBe("/two_web_next");
    expect(postgres).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { CI: "true" },
    { GITHUB_ACTIONS: "true" },
    { CI: "false", GITHUB_ACTIONS: "true" },
  ])(
    "refuses the browser tuple from partial runner flags %j before driver construction",
    async (runner) => {
      vi.stubEnv("CI", (runner as Record<string, string>).CI ?? "");
      vi.stubEnv("GITHUB_ACTIONS", (runner as Record<string, string>).GITHUB_ACTIONS ?? "");
      try {
        expect(() => testDatabaseUrl(BROWSER_URL, runner)).toThrow("refusing before connecting");
        await expect(createMemberDataFixture(BROWSER_URL)).rejects.toThrow(
          "refusing before connecting",
        );
        expect(postgres).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    [
      "localhost with browser user and unit database",
      "postgres://agent_test@localhost:5432/postgres",
    ],
    ["browser host with unit credentials", "postgres://postgres:ci@127.0.0.1:5432/two_web_next"],
    ["browser host with unit database", "postgres://agent_test@127.0.0.1:5432/postgres"],
    ["browser tuple with password", "postgres://agent_test:ci@127.0.0.1:5432/two_web_next"],
    ["browser tuple on wrong port", "postgres://agent_test@127.0.0.1:5433/two_web_next"],
    ["browser host with staging database", "postgres://agent_test@127.0.0.1:5432/staging"],
    ["browser host localhost alias", "postgres://agent_test@localhost:5432/two_web_next"],
    [
      "browser tuple with query override",
      "postgres://agent_test@127.0.0.1:5432/two_web_next?host=production.example.test",
    ],
    ["browser tuple with fragment", "postgres://agent_test@127.0.0.1:5432/two_web_next#public"],
    ["browser tuple wrong protocol", "https://agent_test@127.0.0.1:5432/two_web_next"],
  ])("refuses neighboring %s even inside CI before driver construction", async (_label, raw) => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    try {
      expect(() => testDatabaseUrl(raw, BROWSER_RUNNER)).toThrow("refusing before connecting");
      await expect(createMemberDataFixture(raw)).rejects.toThrow("refusing before connecting");
      expect(postgres).not.toHaveBeenCalled();
      try {
        testDatabaseUrl(raw, BROWSER_RUNNER);
      } catch (error) {
        expect(String(error)).not.toContain(raw);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the existing unit tuple and local test host admitted", () => {
    expect(testDatabaseUrl(UNIT_URL, BROWSER_RUNNER).hostname).toBe("localhost");
    expect(testDatabaseUrl(LOCAL_URL, {}).hostname).toBe("agent-testdb");
    expect(postgres).not.toHaveBeenCalled();
  });
});
