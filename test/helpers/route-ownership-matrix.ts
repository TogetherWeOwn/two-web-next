import type { RouteOwner } from "../../src/route-ownership";

type EndpointMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type RoutePair = { method: EndpointMethod; path: string };
type MapRow = { method: string; path: string; kind: string; family: string | null };

type Family =
  | "ops"
  | "assets"
  | "feeds"
  | "public-api"
  | "admin"
  | "auth"
  | "event-writes"
  | "member-writes"
  | "machine";

export function routeKey({ method, path }: Pick<MapRow, "method" | "path">): string {
  return `${method} ${path}`;
}

// Planning fixture only. A registration key is not a concrete URL matcher.
export function familyEndpointKeys(rows: readonly MapRow[], family: Family): ReadonlySet<string> {
  return new Set(
    rows.filter((row) => row.kind === "endpoint" && row.family === family).map(routeKey),
  );
}

// The matrix names HEAD separately when a case expects it to follow GET.
// No parsing, env flags, wildcards, or path normalization belong in this projection.
export function projectFixtureOwner(
  pair: RoutePair,
  selection: ReadonlySet<string>,
  baseline: (pair: RoutePair) => RouteOwner,
): RouteOwner {
  return selection.has(routeKey(pair)) ? "kit" : baseline(pair);
}
