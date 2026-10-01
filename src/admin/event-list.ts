export const EVENT_PAGE_SIZE = 25;

export type EventSort = "title" | "starts_at" | "status";
export type EventListQuery = {
  q: string;
  status: "" | "draft" | "published" | "cancelled" | "past";
  series: "" | "parent" | "child" | "standalone";
  fill: "" | "full" | "has_seats" | "unlimited";
  rsvp_open: "" | "1" | "0";
  sort: EventSort;
  order: "asc" | "desc";
  page: number;
};
export type EventListParams = Partial<Record<keyof EventListQuery, string>>;

/** Only known query values reach the store or the navigation links. */
export function parseEventListQuery(params: EventListParams): EventListQuery {
  const status = params.status;
  const series = params.series;
  const fill = params.fill;
  const sort = params.sort;
  const page = Number(params.page);
  return {
    q: (params.q ?? "").trim(),
    status: status === "draft" || status === "published" || status === "cancelled" || status === "past" ? status : "",
    series: series === "parent" || series === "child" || series === "standalone" ? series : "",
    fill: fill === "full" || fill === "has_seats" || fill === "unlimited" ? fill : "",
    rsvp_open: params.rsvp_open === "1" || params.rsvp_open === "0" ? params.rsvp_open : "",
    sort: sort === "title" || sort === "status" || sort === "starts_at" ? sort : "starts_at",
    order: params.order === "asc" ? "asc" : "desc",
    // Keep the offset within a safe integer, even for adversarial page values.
    page: /^\d+$/.test(params.page ?? "") && Number.isSafeInteger(page) && page > 0
      && Number.isSafeInteger(page * EVENT_PAGE_SIZE) ? page : 1,
  };
}

export function eventListUrl(query: EventListQuery, changes: Partial<EventListQuery> = {}): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams();
  for (const key of ["q", "status", "series", "fill", "rsvp_open"] as const) {
    if (next[key]) params.set(key, next[key]);
  }
  params.set("sort", next.sort);
  params.set("order", next.order);
  if (next.page > 1) params.set("page", String(next.page));
  return `/admin/events?${params}`;
}
