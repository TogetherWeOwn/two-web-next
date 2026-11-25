import type { AttendanceReader } from "../bot/attendance-read";
import { projectPublicEcho } from "./echo-public";
import { buildFrozenEcho } from "./echoes";
import type { PublicEvent } from "./reads";

/** Read an ended event's Echo for the dormant detail preview. */
export async function readEventDetailEcho(
  event: Pick<PublicEvent, "id" | "eventKey" | "status" | "endsAt">,
  read: AttendanceReader,
  observedAt: number,
) {
  if (
    (event.status !== "past" && event.status !== "published") ||
    !Number.isFinite(observedAt) ||
    !(event.endsAt.getTime() <= observedAt)
  ) {
    return undefined;
  }

  const snapshot = buildFrozenEcho(event, await read(event.eventKey));
  if (!snapshot || snapshot.echo.windowEndsAt.getTime() > observedAt) return undefined;

  const { eventKey, attendedCount, peakConcurrent } = projectPublicEcho({
    ...snapshot.echo,
    headline: null,
  });
  // The response has a counting window, but no timestamp for the freeze itself.
  return { eventKey, at: observedAt, attendance: { attendedCount, peakConcurrent } };
}
