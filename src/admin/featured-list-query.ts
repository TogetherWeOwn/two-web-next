import type { ListParams, SortOrder } from "./table-list";

export type FeaturedSort = "position" | "updated_at";
export type FeaturedListQuery = {
  published: "" | "1" | "0";
  q: string;
  sort: FeaturedSort;
  order: SortOrder;
  page: number;
  /** Set only when an overlong search was dropped, so the page can say so. */
  searchDropped?: true;
};
/** One extra row is fetched as the next-page lookahead, like events. */
export const FEATURED_PAGE_SIZE = 25;

// Free-text search is bounded before the leading-wildcard ILIKE scan and
// before reflection into navigation links. Measured on the normalized value
// (NULs stripped, then trimmed); overlong falls back to absent, never truncated.
const FEATURED_FREE_TEXT_MAX_LENGTH = 128;
const boundFeaturedFreeText = (value: string): string =>
  value.length > FEATURED_FREE_TEXT_MAX_LENGTH ? "" : value;

export function parseFeaturedListQuery(params: ListParams): FeaturedListQuery {
  const page = Number(params.page);
  // PostgreSQL text cannot contain NUL; keep this leaf independent of other tables.
  const q = (params.q ?? "").replaceAll(String.fromCharCode(0), "").trim();
  return {
    published: params.published === "1" || params.published === "0" ? params.published : "",
    q: boundFeaturedFreeText(q),
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
    ...(q !== "" && boundFeaturedFreeText(q) === "" ? { searchDropped: true as const } : {}),
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
  if (q.page > 1) params.set("page", String(q.page));
  return `/admin/featured?${params}`;
}

/** Zero-row copy: filtered empties name the filters, genuine empties invite creation. */
export function featuredEmptyText(query: FeaturedListQuery): string {
  return query.q || query.published
    ? "No featured content matches these filters."
    : "No featured content yet.";
}
