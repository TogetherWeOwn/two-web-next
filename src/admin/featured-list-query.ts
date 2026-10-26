import type { ListParams, SortOrder } from "./table-list";

export type FeaturedSort = "position" | "updated_at";
/** Effective-state inventory facet: "" reads as All. Orthogonal to saved publication. */
export type FeaturedState = "" | "live" | "scheduled" | "expired" | "unpublished" | "unavailable";
export const FEATURED_STATES: { value: FeaturedState; label: string }[] = [
  { value: "", label: "All" },
  { value: "live", label: "Eligible now" },
  { value: "scheduled", label: "Scheduled" },
  { value: "expired", label: "Expired" },
  { value: "unpublished", label: "Unpublished" },
  { value: "unavailable", label: "Unavailable" },
];
export type FeaturedListQuery = {
  published: "" | "1" | "0";
  q: string;
  state: FeaturedState;
  sort: FeaturedSort;
  order: SortOrder;
  page: number;
};
/** One extra row is fetched as the next-page lookahead, like events. */
export const FEATURED_PAGE_SIZE = 25;

// Free-text search is bounded before the leading-wildcard ILIKE scan and
// before reflection into navigation links. Measured on the normalized value
// (NULs stripped, then trimmed); overlong falls back to absent, never truncated.
const FEATURED_FREE_TEXT_MAX_LENGTH = 128;
const boundFeaturedFreeText = (value: string): string =>
  value.length > FEATURED_FREE_TEXT_MAX_LENGTH ? "" : value;

/**
 * The state facet is an exact allowlist match on the raw value, like the
 * roster answer facet: no trim/NUL/length normalization, so padded,
 * cased or overlong values read as All rather than as a nearby state.
 */
export function parseFeaturedState(raw: string | undefined): FeaturedState {
  switch (raw) {
    case "live":
    case "scheduled":
    case "expired":
    case "unpublished":
    case "unavailable":
      return raw;
    default:
      return "";
  }
}

export function parseFeaturedListQuery(params: ListParams): FeaturedListQuery {
  const page = Number(params.page);
  return {
    published: params.published === "1" || params.published === "0" ? params.published : "",
    // PostgreSQL text cannot contain NUL; keep this leaf independent of other tables.
    q: boundFeaturedFreeText((params.q ?? "").replaceAll(String.fromCharCode(0), "").trim()),
    state: parseFeaturedState(params.state),
    sort: params.sort === "updated_at" ? "updated_at" : "position",
    order: params.order === "desc" ? "desc" : "asc",
    // Keep the offset within a safe integer, even for adversarial page values.
    page:
      /^\d+$/.test(params.page ?? "") &&
      Number.isSafeInteger(page) &&
      page > 0 &&
      Number.isSafeInteger(page * FEATURED_PAGE_SIZE)
        ? page
        : 1,
  };
}

export function featuredListUrl(
  query: FeaturedListQuery,
  patch: Partial<FeaturedListQuery> = {},
): string {
  const q = { ...query, ...patch };
  const params = new URLSearchParams({ sort: q.sort, order: q.order });
  if (q.published) params.set("published", q.published);
  if (q.q) params.set("q", q.q);
  if (q.state) params.set("state", q.state);
  if (q.page > 1) params.set("page", String(q.page));
  return `/admin/featured?${params}`;
}

/** Query is normalized by parseFeaturedListQuery before reaching the page. */
export function featuredListHasFilters(query: FeaturedListQuery): boolean {
  return Boolean(query.q || query.published || query.state);
}

export function featuredListClearUrl(query: FeaturedListQuery): string {
  return featuredListUrl(query, { q: "", published: "", state: "", page: 1 });
}

/** A successful empty later page says nothing about the inventory as a whole. */
export function featuredEmptyText(query: FeaturedListQuery): string {
  if (query.page > 1) return "No results on this page.";
  return featuredListHasFilters(query)
    ? "No featured content matches these filters."
    : "No featured content yet.";
}
