import { describe, expect, it, vi } from "vitest";
// Standalone operator scripts intentionally run directly under Node, not the TS app.
// @ts-expect-error standalone mjs has no type declarations
import { connectDatabase, main, parentFirst, parseArgs, reportExitCode } from "../bin/import/events-rsvps.mjs";

const event = (id: string, parent: string | null = null) => ({ id, event_key: `key-${id}`, parent_event_id: parent });

describe("legacy events import controls", () => {
  it("defaults to dry-run and only accepts one explicit mode, never argv URLs", () => {
    expect(parseArgs([])).toEqual({ dryRun: true });
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseArgs(["--apply"])).toEqual({ dryRun: false });
    for (const args of [["--apply", "--dry-run"], ["--apply", "--apply"], ["postgres://synthetic.invalid/db"], ["--help"]]) {
      expect(() => parseArgs(args)).toThrow();
    }
  });

  it("orders parents first regardless of IDs, including nested links", () => {
    expect(parentFirst([event("1", "2"), event("2", "30"), event("30"), event("4")])
      .map((row: { id: string }) => row.id)).toEqual(["30", "2", "1", "4"]);
  });

  it("refuses missing parents, cycles, and duplicate natural keys before writes", () => {
    for (const rows of [[event("1", "404")], [event("1", "1")], [event("1", "2"), event("2", "1")],
      [event("1"), event("1")], [event("1"), { ...event("2"), event_key: "key-1" }]]) {
      expect(() => parentFirst(rows)).toThrow();
    }
  });

  it("makes orphan reports a nonzero result", () => {
    expect(reportExitCode({ unresolved: { creators: 0, rsvpEvents: 0, rsvpUsers: 0 } })).toBe(0);
    expect(reportExitCode({ unresolved: { creators: 0, rsvpEvents: 0, rsvpUsers: 1 } })).toBe(2);
    expect(reportExitCode({ unresolved: { creators: 1, rsvpEvents: 0, rsvpUsers: 0 } })).toBe(2);
  });

  it.each([
    ["postgres://agent_test@agent-testdb/two_web_next", 5432],
    ["postgres://agent_test@agent-testdb:5432/two_web_next", 5432],
    ["postgres://agent_test@agent-testdb:15432/two_web_next", 15432],
  ])("pins URL/default port without connecting: %s", async (url, port) => {
    vi.stubEnv("PGPORT", "6432");
    let client;
    try {
      // postgres.js is lazy: inspect the real CLI factory without querying any port.
      client = connectDatabase(url);
      expect(client.options.port).toEqual([port]);
    } finally {
      await client?.end({ timeout: 2 });
      vi.unstubAllEnvs();
    }
  });

  it("rejects port zero rather than falling back to inherited connection settings", () => {
    expect(() => connectDatabase("postgres://agent_test@agent-testdb:0/two_web_next")).toThrow();
  });

  it("does not disclose argv/env secrets on failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["postgres://synthetic:do-not-print@invalid/db"], {
        LEGACY_DATABASE_URL: "synthetic-source-secret", DATABASE_URL: "synthetic-target-secret",
      })).toBe(1);
      expect(await main([], {})).toBe(1);
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain("do-not-print");
      expect(output).not.toContain("synthetic-source-secret");
      expect(output).not.toContain("synthetic-target-secret");
    } finally { log.mockRestore(); }
  });
});
