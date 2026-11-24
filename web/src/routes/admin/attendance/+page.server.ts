import { error } from "@sveltejs/kit";
import { formatAdminTime } from "../../../../../src/admin/chronology";
import { buildFrozenEcho } from "../../../../../src/events/echoes";
import type { PageServerLoad } from "./$types";

// Fixed example of a finalized Echo. There is no reader or event lookup on this route.
const fixtureEvent = { id: 7, eventKey: "test-raid-night-1", status: "past" };

export const load: PageServerLoad = async ({ parent }) => {
  await parent();
  const snapshot = buildFrozenEcho(fixtureEvent, {
    ok: true,
    attendance: {
      v: 1,
      event_key: fixtureEvent.eventKey,
      final: true,
      window: { starts_at: "2026-11-07T18:45:00Z", ends_at: "2026-11-07T21:15:00Z" },
      threshold_minutes: 10,
      peak_concurrent: 5,
      rooms: [],
      members: [
        { discord_id: "100000000000000001", minutes: 42, sessions: 2, first_joined_at: null },
        { discord_id: "100000000000000002", minutes: 11, sessions: 1, first_joined_at: null },
        { discord_id: "100000000000000003", minutes: 9, sessions: 1, first_joined_at: null },
      ],
    },
  });
  if (!snapshot) error(503, "Admin temporarily unavailable");

  const { echo, members } = snapshot;
  return {
    eventTitle: "Sample raid night",
    windowStart: formatAdminTime(echo.windowStartsAt),
    windowEnd: formatAdminTime(echo.windowEndsAt),
    thresholdMinutes: echo.thresholdMinutes,
    attendedCount: echo.attendedCount,
    rows: members.map(({ minutes, sessions }, index) => ({
      participant: `Sample participant ${index + 1}`,
      minutes,
      sessions,
    })),
  };
};
