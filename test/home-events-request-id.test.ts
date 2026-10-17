// Homepage event-read fallback correlation: the warn must join to the
// request log by request_id while staying inside the runbook-logs contract
// (bounded exception class only — no driver text, SQL or identities).
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOME_EVENTS_DEADLINE_MS, loadHomeUpcomingMerged } from "../src/events/reads";

const NOW = new Date("2030-07-04T18:00:00Z");
// Allowlisted synthetic ULID (see .gitleaks.toml).
const RID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const noDiscord = () => ({ upcoming: async () => [], lastReadFailed: () => false });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("homepage event-read fallback request_id", () => {
  it("carries request_id on a failing read without leaking driver text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const merged = await loadHomeUpcomingMerged(
      async () => {
        throw new Error("postgres://user:secret@host/db select private-member");
      },
      noDiscord,
      NOW,
      RID,
    );
    expect(merged).toEqual({ items: [], unavailable: true, discordFailed: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", {
      request_id: RID,
      exception: "ReadFailure",
    });
    for (const secret of ["postgres://", "secret", "select", "private-member"]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    }
  });

  it("carries request_id on a deadline read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = loadHomeUpcomingMerged(() => new Promise(() => {}), noDiscord, NOW, RID);
    await vi.advanceTimersByTimeAsync(HOME_EVENTS_DEADLINE_MS + 100);
    expect(await pending).toEqual({ items: [], unavailable: true, discordFailed: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", {
      request_id: RID,
      exception: "HomeEventsDeadline",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a malformed request id instead of logging raw caller text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadHomeUpcomingMerged(
      async () => {
        throw new Error("boom");
      },
      noDiscord,
      NOW,
      "private-member cookie-secret",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]?.[1] as { request_id?: unknown; exception?: unknown };
    expect(fields.request_id).toBeUndefined();
    expect(fields.exception).toBe("ReadFailure");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-member");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("cookie-secret");
  });
});
