// Builder-owned: route-only shape of the null-store throttle warn (X3 leg B).
// The acceptance suite pins the IPv4 bucket; these pin the two shapes the
// first-colon parse exists for: a colon-bearing IPv6 client still logs the
// route name only, and a colon-less bucket logs whole (no client segment).
// Hermetic: null store, no database, no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkJoinThrottle } from "../src/join/service";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("null-store throttle warn names the route only", () => {
  it("logs the route name for an IPv6 client", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = "2001:db8::1";
    const verdict = await checkJoinThrottle(null, `probe:${client}`, 10);
    expect(verdict).toEqual({ limited: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Throttle store unavailable; allowing the request.", {
      throttle: "probe",
    });
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("bucket");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(client);
    expect(logged).not.toContain(`probe:${client}`);
  });

  it("logs a colon-less bucket whole", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await checkJoinThrottle(null, "probe", 10);
    expect(verdict).toEqual({ limited: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Throttle store unavailable; allowing the request.", {
      throttle: "probe",
    });
  });
});
