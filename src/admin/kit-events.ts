// Kit moderator events-list model. The events load
// (web/src/routes/admin/events/+page.server.ts) is a thin SvelteKit binding
// around this: cloudflare:workers + SvelteKit imports stay out of the root
// test process, so the serializable view decision lives here where unit
// tests can drive it.
//
// Framework-free by construction, like src/admin/kit-guard.ts and
// src/admin/kit-dashboard.ts: it shapes already-fetched rows, performs zero
// reads, and never touches cookies, the session, or the audit. The
// member-read boundary around resolve() still owns classification and the
// audit; this only tells the load which rows and page controls to render.
// The fetch stays bounded: listEvents over-fetches by exactly one row
// (EVENT_PAGE_SIZE + 1, no count query), and the view slices to the page.
import {
  EVENT_PAGE_SIZE,
  eventEmptyText,
  eventScopeRecoveryText,
  type EventListQuery,
} from "./event-list";
import type { EventListRow, EventListScope } from "./store-event-reads";

/** One events-table row with its timestamps pre-rendered, exactly as the
 * Hono page emits them (<time datetime=ISO>ISO</time>). */
export type KitEventListRow = {
  eventKey: string;
  title: string;
  status: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  rsvpOpen: boolean;
  goingCount: number;
};

export type KitEventListView = {
  query: EventListQuery;
  rows: KitEventListRow[];
  hasNext: boolean;
  emptyText: string;
  /** Exact-series scope from listSeriesEvents; null renders the unscoped inventory. */
  scope: EventListScope | null;
  /**
   * Pre-escaped scoped H1 inner HTML, or null when unscoped. Svelte escapes
   * `<` but not `>` in text, while the Hono twin escapes both; rendering the
   * fully escaped string keeps the twins byte-identical for titles carrying
   * markup characters. Complete escaping (no markup passthrough), so the
   * page's single `{@html}` of this field cannot inject elements.
   */
  scopeHeadingHtml: string | null;
  /**
   * Pre-rendered recovery copy for an unusable scope, or null when the scope
   * is absent or ok. Server-carried like scopeHeadingHtml so the client
   * bundle does not ship the recovery strings; same shared copy the Hono
   * twin renders via eventScopeRecoveryText.
   */
  scopeRecoveryText: string | null;
};

const escapeHtmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function serializeEventListRow(row: EventListRow): KitEventListRow {
  return {
    eventKey: row.eventKey,
    title: row.title,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    capacity: row.capacity,
    rsvpOpen: row.rsvpOpen,
    goingCount: row.goingCount,
  };
}

/** Slice the over-fetched page to the page size and shape rows for SSR. */
export function buildEventListView(
  query: EventListQuery,
  fetched: EventListRow[],
  scope: EventListScope | null = null,
): KitEventListView {
  return {
    query,
    rows: fetched.slice(0, EVENT_PAGE_SIZE).map(serializeEventListRow),
    hasNext: fetched.length > EVENT_PAGE_SIZE,
    emptyText: eventEmptyText(query),
    scope,
    scopeHeadingHtml:
      scope?.status === "ok" ? `Events in this series: ${escapeHtmlText(scope.parentTitle)}` : null,
    scopeRecoveryText: scope && scope.status !== "ok" ? eventScopeRecoveryText(scope.status) : null,
  };
}
