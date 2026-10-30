/** Snapshot "happening now" verdict, from the row alone at the render instant.
 * Imports nothing, so static leaves can share it without the database layer.
 * Server-rendered only: there is no polling, so the label is as fresh as the
 * response. Only published nights qualify (drafts, cancelled and explicitly
 * past rows never carry it), the start is inclusive and the end exclusive,
 * so the end instant reads Ended, never ongoing. An unrenderable instant
 * compares false and the row stays unlabelled. */
export const ONGOING_COPY = "Happening now";

export function isOngoing(e: { status: string; startsAt: Date; endsAt: Date }, now: Date): boolean {
  return (
    e.status === "published" &&
    e.startsAt.getTime() <= now.getTime() &&
    now.getTime() < e.endsAt.getTime()
  );
}
