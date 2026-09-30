// Mounted guest pages must not depend on session DDL. All persistence is mocked.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { getPublicEvent, listGoingAttendees, type PublicEvent } from "../src/events/reads";
import { env, EVENT_KEY, SUBJECT } from "./helpers/member-data";

const { connect, ddl } = vi.hoisted(() => ({ connect: vi.fn(), ddl: vi.fn() }));
vi.mock("postgres", () => ({ default: connect }));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/events/reads")>(),
  getPublicEvent: vi.fn(),
  listGoingAttendees: vi.fn(),
}));

const event: PublicEvent = {
  id: 1, eventKey: EVENT_KEY, title: "Friday night games", description: null, game: null,
  startsAt: new Date("2099-11-04T20:00:00Z"), endsAt: new Date("2099-11-04T22:00:00Z"),
  timezone: "UTC", location: null, capacity: null, status: "published", discordEventId: null,
  discordSyncFailedAt: null, discordSyncFailureCode: null,
  createdBy: null, rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null,
  recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), goingCount: 1,
};
const signedCookie = async (token: string) => (await serializeSigned(
  "__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true },
)).split(";")[0]!;
const request = (cookie?: string) => app.request(`/e/${EVENT_KEY}`, {
  headers: cookie ? { cookie } : {},
}, { ...env, ADMIN_DB: {}, DB: { connectionString: "postgres://unused.invalid/session-fixture" } });

beforeEach(() => {
  vi.clearAllMocks();
  ddl.mockRejectedValue(new Error("session DDL unavailable"));
  connect.mockReturnValue({ unsafe: ddl });
  vi.mocked(getPublicEvent).mockResolvedValue(event);
  vi.mocked(listGoingAttendees).mockResolvedValue([{ id: SUBJECT.userId, name: SUBJECT.username }]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("guest event pages with unavailable session storage", () => {
  it.each(["absent", "invalid signature", "wrong token prefix"])("%s cookie preserves aggregate-only published 200 and draft denial", async (kind) => {
    const cookie = kind === "absent" ? undefined : kind === "invalid signature"
      ? "__Host-two_session=two_forged.invalid" : await signedCookie("not-a-session-token");
    const res = await request(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Friday night games");
    expect(html).toContain("1 going");
    for (const value of [SUBJECT.username, SUBJECT.userId, "event-attendees", "Who's going"])
      expect(html).not.toContain(value);
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("set-cookie")).toBeNull();

    vi.mocked(getPublicEvent).mockResolvedValue({ ...event, status: "draft" });
    const draft = await request(cookie);
    expect(draft.status).toBe(403);
    expect(await draft.text()).toBe("Forbidden");
    expect(listGoingAttendees).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(ddl).not.toHaveBeenCalled();
  });

  it("a usable signed token still resolves storage and fails closed on session DDL failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(await signedCookie("two_test-token"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(SUBJECT.username);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ddl).toHaveBeenCalledTimes(1);
    expect(listGoingAttendees).not.toHaveBeenCalled();
  });
});
