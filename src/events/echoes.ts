import type { AttendanceResult, AttendanceRoom } from "../bot/attendance-read";

type EchoEvent = { id: number; eventKey: string; status: string };

export type FrozenEchoSnapshot = {
  echo: {
    eventId: number;
    eventKey: string;
    windowStartsAt: Date;
    windowEndsAt: Date;
    thresholdMinutes: number;
    peakConcurrent: number;
    attendedCount: number;
    rooms: AttendanceRoom[];
  };
  members: { userId: string; minutes: number; sessions: number; firstJoinedAt: Date | null }[];
};

/** Build an internal snapshot from the settled reader result, never a public payload. */
export function buildFrozenEcho(
  event: EchoEvent,
  result: AttendanceResult,
): FrozenEchoSnapshot | null {
  if (!result.ok || (event.status !== "published" && event.status !== "past")) return null;
  const { attendance } = result;
  if (!attendance.final || attendance.event_key !== event.eventKey) return null;

  return {
    echo: {
      eventId: event.id,
      eventKey: event.eventKey,
      windowStartsAt: new Date(attendance.window.starts_at),
      windowEndsAt: new Date(attendance.window.ends_at),
      thresholdMinutes: attendance.threshold_minutes,
      peakConcurrent: attendance.peak_concurrent,
      attendedCount: attendance.members.filter((m) => m.minutes >= attendance.threshold_minutes)
        .length,
      rooms: attendance.rooms.map(({ channel_id, name_at_close }) => ({
        channel_id,
        name_at_close,
      })),
    },
    members: attendance.members.map((member) => ({
      userId: member.discord_id,
      minutes: member.minutes,
      sessions: member.sessions,
      firstJoinedAt: member.first_joined_at === null ? null : new Date(member.first_joined_at),
    })),
  };
}
