import { fitsUtf8ByteLimit } from "../http/length-limit";
import { type ArchiveContext, archiveEventHref, attendeePageHref } from "./attendee-paths";

/**
 * Builds a sign-in or join return destination from normalized route context.
 * If the encoded archive search exceeds the auth byte cap, drop the entire
 * archive context. Keep the attendee page if it fits, or use the bare path.
 */
export function authReturnHref(
  eventKey: string,
  archive: ArchiveContext | null | undefined,
  attendeePage: number,
  maxBytes: number,
): string {
  const withArchive = archiveEventHref(eventKey, archive, attendeePage);
  if (fitsUtf8ByteLimit(withArchive, maxBytes)) return withArchive;
  const pageOnly = archiveEventHref(eventKey, null, attendeePage);
  return fitsUtf8ByteLimit(pageOnly, maxBytes) ? pageOnly : attendeePageHref(eventKey, 1);
}
