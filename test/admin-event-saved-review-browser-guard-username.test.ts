// Builder-owned pin for the browser-CI database guard's username conjunct.
// The acceptance-owned browser-guard suite pins the exact browser tuple and
// its neighbors, but every wrong-user neighbor there also carries a non-empty
// password, so deleting `url.username === "agent_test"` from the
// ciBrowserService tuple kept that suite green. This case varies ONLY the
// username (empty password, exact host/database/flags) and must refuse.
// Hermetic: pure URL validation and refusal-before-driver-construction, no
// live CI/production/staging connections. Do not merge into the
// acceptance-owned test/admin-event-saved-review-browser-guard.test.ts.
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

const BROWSER_RUNNER = { CI: "true", GITHUB_ACTIONS: "true" };

describe("saved-event browser CI database username conjunct", () => {
  it("refuses a wrong username with an empty password even inside CI", async () => {
    const raw = "postgres://other_user@127.0.0.1:5432/two_web_next";
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    try {
      expect(() => testDatabaseUrl(raw, BROWSER_RUNNER)).toThrow("refusing before connecting");
      await expect(createMemberDataFixture(raw)).rejects.toThrow("refusing before connecting");
      expect(postgres).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("control: the exact browser tuple still admits", () => {
    const url = testDatabaseUrl(
      "postgres://agent_test@127.0.0.1:5432/two_web_next",
      BROWSER_RUNNER,
    );
    expect(url.username).toBe("agent_test");
    expect(postgres).not.toHaveBeenCalled();
  });
});
