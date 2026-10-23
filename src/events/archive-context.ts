// Browse context is navigation only: no redirect, auth grant or persistent state.
import type { ArchiveContext } from "./attendee-paths";
import { normalizePastPage } from "./past-page";
import { MAX_QUERY_LENGTH, matchQuery } from "./search-log";

export function archiveContext(search: string): ArchiveContext | null {
  // URLSearchParams repairs malformed percent/UTF-8 input. Refuse it instead
  // of returning the viewer to a silently different search.
  try {
    // Consume the result so production tree-shaking retains the throwing check.
    if (!decodeURIComponent(search)) return null;
  } catch {
    return null;
  }
  const params = new URLSearchParams(search);
  const pages = params.getAll("archivePage");
  const queries = params.getAll("archiveQuery");
  if (pages.length !== 1 || queries.length > 1) return null;
  const rawPage = pages[0]!;
  if (!/^[1-9]\d{0,15}$/.test(rawPage)) return null;
  const page = Number(rawPage);
  if (normalizePastPage(page) !== page) return null;
  const rawQuery = queries[0] ?? "";
  if ([...rawQuery].length > MAX_QUERY_LENGTH) return null;
  return { page, q: matchQuery(rawQuery) ?? "" };
}
