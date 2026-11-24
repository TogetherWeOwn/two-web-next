const ECHO_RECORD_LABEL = "attendance record";

type PublicEchoInput = {
  eventId: number;
  eventKey: string;
  headline: string | null;
  attendedCount: number;
  peakConcurrent: number;
  rooms: readonly { name_at_close: string }[];
  windowEndsAt: Date;
  thresholdMinutes: number;
};

export type PublicEcho = {
  eventId: number;
  eventKey: string;
  label: typeof ECHO_RECORD_LABEL;
  headline: string | null;
  attendedCount: number;
  peakConcurrent: number;
  rooms: { name: string }[];
  windowEndsAt: string;
  thresholdMinutes: number;
};

/** Allowlist public fields, including inside rooms; never serialize member rows or absence. */
export function projectPublicEcho(echo: PublicEchoInput): PublicEcho {
  return {
    eventId: echo.eventId,
    eventKey: echo.eventKey,
    label: ECHO_RECORD_LABEL,
    headline: echo.headline,
    attendedCount: echo.attendedCount,
    peakConcurrent: echo.peakConcurrent,
    rooms: echo.rooms.map((room) => ({ name: room.name_at_close })),
    windowEndsAt: echo.windowEndsAt.toISOString(),
    thresholdMinutes: echo.thresholdMinutes,
  };
}
