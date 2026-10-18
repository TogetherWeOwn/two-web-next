// Join attempt write-failure warn carries the validated request_id.
//
// The admin viewer queries by exact request_id; the failing INSERT drops it.
// The warn is the only join left, so it must carry request_id to join the row
// to request logs — validated only, never raw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAttempt } from "../src/join/service";
import type { Sql } from "../src/sessions";

// Allowlisted synthetic ULID (see .gitleaks.toml).
const RID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Probes: if any log line quotes the thrown message or statement text, these show up.
const INSERT_PROBE = "attempt-insert-probe-must-never-surface-30870";

function throwingSql(): Sql {
  const sql = (async () => {
    throw new Error(`join_attempts insert failed: ${INSERT_PROBE}`);
  }) as unknown as Sql;
  return sql;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("join attempt write-failure warn request_id", () => {
  it("carries the validated request_id with outcome and exception class only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordAttempt(throwingSql(), {
        outcome: "added",
        source: "web-homepage",
        requestId: RID,
        discordId: "42",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("join attempt write failed");
    const payload = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ exception: "Error", outcome: "added", request_id: RID });
    // No identities, no source, no message/statement text.
    expect(payload).not.toHaveProperty("discordId");
    expect(payload).not.toHaveProperty("discord_id");
    expect(payload).not.toHaveProperty("source");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(INSERT_PROBE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("42");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("web-homepage");
  });

  it("omits request_id when absent and never crashes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordAttempt(throwingSql(), {
        outcome: "error",
        source: null,
        requestId: null,
        discordId: null,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ exception: "Error", outcome: "error" });
    expect(payload).not.toHaveProperty("request_id");
  });

  it("drops a malformed request id instead of logging raw caller text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = "private-member cookie-secret-30870";
    await expect(
      recordAttempt(throwingSql(), {
        outcome: "degraded",
        source: null,
        requestId: raw,
        discordId: null,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ exception: "Error", outcome: "degraded" });
    expect(payload).not.toHaveProperty("request_id");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-member");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("cookie-secret-30870");
  });
});
