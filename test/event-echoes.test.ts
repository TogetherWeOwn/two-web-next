import { describe, expect, it } from "vitest";
import type { AttendancePayload, AttendanceResult } from "../src/bot/attendance-read";
import { buildFrozenEcho } from "../src/events/echoes";

const FINAL: AttendancePayload = {
  v: 1,
  event_key: "01KTESTEVENTKEY000000000001",
  window: { starts_at: "2026-10-20T18:00:00Z", ends_at: "2026-10-20T21:00:00Z" },
  threshold_minutes: 10,
  peak_concurrent: 24,
  rooms: [{ channel_id: "111111111111111111", name_at_close: "Tavern" }],
  members: [
    {
      discord_id: "900000000000000001",
      minutes: 95,
      sessions: 2,
      first_joined_at: "2026-10-20T18:05:00Z",
    },
    { discord_id: "900000000000000002", minutes: 10, sessions: 1, first_joined_at: null },
    { discord_id: "900000000000000003", minutes: 9, sessions: 1, first_joined_at: null },
  ],
  final: true,
};
const EVENT = { id: 7, eventKey: FINAL.event_key, status: "published" };

const success = (overrides: Partial<AttendancePayload> = {}): AttendanceResult => ({
  ok: true,
  attendance: { ...FINAL, ...overrides },
});

describe("buildFrozenEcho", () => {
  it("freezes the supplied threshold, counts inclusively, and preserves internal rows", () => {
    expect(buildFrozenEcho(EVENT, success())).toEqual({
      echo: {
        eventId: 7,
        eventKey: EVENT.eventKey,
        windowStartsAt: new Date("2026-10-20T18:00:00Z"),
        windowEndsAt: new Date("2026-10-20T21:00:00Z"),
        thresholdMinutes: 10,
        peakConcurrent: 24,
        attendedCount: 2,
        rooms: [{ channel_id: "111111111111111111", name_at_close: "Tavern" }],
      },
      members: [
        {
          userId: "900000000000000001",
          minutes: 95,
          sessions: 2,
          firstJoinedAt: new Date("2026-10-20T18:05:00Z"),
        },
        { userId: "900000000000000002", minutes: 10, sessions: 1, firstJoinedAt: null },
        { userId: "900000000000000003", minutes: 9, sessions: 1, firstJoinedAt: null },
      ],
    });
    expect(buildFrozenEcho(EVENT, success({ threshold_minutes: 11 }))?.echo.attendedCount).toBe(1);
  });

  it("records zero attendance for a final empty payload on a past event", () => {
    expect(
      buildFrozenEcho(
        { ...EVENT, status: "past" },
        success({ members: [], rooms: [], peak_concurrent: 0 }),
      ),
    ).toMatchObject({ echo: { attendedCount: 0, peakConcurrent: 0, rooms: [] }, members: [] });
  });

  it("produces no snapshot for a refusal, an unfinished reply, or a different event key", () => {
    expect(buildFrozenEcho(EVENT, { ok: false, code: "not_found" })).toBeNull();
    expect(buildFrozenEcho(EVENT, success({ final: false }))).toBeNull();
    expect(
      buildFrozenEcho(EVENT, success({ event_key: "01KOTHERKEY0000000000000000" })),
    ).toBeNull();
  });

  it.each(["draft", "cancelled", "unknown"])("produces no snapshot for status %s", (status) => {
    expect(buildFrozenEcho({ ...EVENT, status }, success())).toBeNull();
  });
});
