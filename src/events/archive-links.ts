import { pastEventsUrl } from "../islands/contracts-past-events";
import type { ArchiveContext } from "./attendee-paths";

export function archiveReturnHref(archive: ArchiveContext | null | undefined): string | null {
  return archive ? pastEventsUrl(archive.page, archive.q) : null;
}

export function archiveReturnLink(archive: ArchiveContext | null | undefined) {
  const href = archiveReturnHref(archive);
  return href
    ? { href, label: archive?.q ? "← Back to search results" : "← Back to past events" }
    : null;
}
