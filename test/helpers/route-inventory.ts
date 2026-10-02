export type RouteInventoryEntry = {
  method: string;
  path: string;
  auth: string;
};

const key = (route: Pick<RouteInventoryEntry, "method" | "path">) => `${route.method} ${route.path}`;

type Router = { routes: { method: string; path: string }[] };

// Reviewed policy labels, not an auth-enforcement detector. The existing role,
// owner, bearer and QA tests prove enforcement. Scoped ALL registrations are
// included: they are middleware on some paths and the RSVP 405 handler on another.
export function routeInventory(router: Router): RouteInventoryEntry[] {
  const registrations = new Map(router.routes.map((route) => [key(route), route]));
  return [...registrations.keys()].sort().map((name) => {
    const { method, path } = registrations.get(name)!;
    let auth = "public";
    if (path === "/*") auth = "middleware";
    else if ((path === "/admin" || path.startsWith("/admin/")) && registrations.has("ALL /admin/*")) auth = "moderator";
    else if (path === "/profile" && registrations.has("ALL /profile")) auth = "member";
    else if (path.startsWith("/members/") && registrations.has("ALL /members/*")) {
      auth = method === "PATCH" || method === "POST" ? "member-owner" : "member";
    } else if (path === "/events.json" || (method === "GET" && path === "/events/:key")) auth = "session";
    else if (path === "/e/:key" || path === "/events/:file{.+\\.ics}") auth = "public-draft-moderator";
    else if (path === "/events/:key/rsvp" && (method === "PUT" || method === "DELETE")) auth = "member-decoy";
    else if ((path === "/events" && method === "POST") || (path === "/events/:key" && method === "PATCH") ||
      (method === "POST" && (path === "/events/:key/publish" || path === "/events/:key/cancel" ||
        path === "/events/:key/rsvp-pause" || path === "/events/:key/rsvp-reopen"))) auth = "moderator";
    else if (path === "/api/agent-events") auth = "machine-bearer";
    else if (path === "/auth/qa/:identity" || path === "/__probe/alert") auth = "staging-token";
    else if (path === "/auth/discord/callback" || path === "/join/callback") auth = "oauth-state";
    return { method, path, auth };
  });
}

export function assertRouteReferences(
  inventory: RouteInventoryEntry[],
  tests: Record<string, string>,
  docs: Record<string, string>,
) {
  // Hono uppercases method tokens; patterns can contain spaces inside regexes.
  const referenced = new Set(Object.values(tests).flatMap((source) =>
    [...source.matchAll(/^\/\/ route-inventory: ([!#$%&'*+.^_`|~0-9A-Z-]+ \/[^\r\n]*)\r?$/gm)].map((match) => match[1]!)));
  const documented = new Set(Object.values(docs).flatMap((source) =>
    [...source.matchAll(/`([!#$%&'*+.^_`|~0-9A-Z-]+ \/[^`\r\n]*)`/g)].map((match) => match[1]!)));
  const problems: string[] = [];
  for (const route of inventory) {
    const name = key(route);
    if (!referenced.has(name)) problems.push(`Missing test reference: ${name}`);
    if (!documented.has(name)) problems.push(`Missing parity/URL entry: ${name}`);
  }
  const names = new Set(inventory.map(key));
  for (const name of referenced) {
    if (!names.has(name)) problems.push(`Stale test reference: ${name}`);
  }
  if (problems.length) throw new Error([
    "Route inventory references:", ...problems.sort(),
    "Add // route-inventory: METHOD /pattern to an existing endpoint test (not the inventory guard).",
    "Add an exact `METHOD /pattern` entry to docs/parity.md or docs/url-freeze.md.",
    "If no test exists, file a follow-up; do not claim behavioral coverage from this reference check.",
  ].join("\n"));
}

export function assertRouteInventory(actual: RouteInventoryEntry[], expected: RouteInventoryEntry[]) {
  const problems: string[] = [];
  const actualByKey = new Map(actual.map((route) => [key(route), route]));
  const expectedByKey = new Map(expected.map((route) => [key(route), route]));
  if (actualByKey.size !== actual.length) problems.push("Duplicate method/path in app.routes");
  if (expectedByKey.size !== expected.length) problems.push("Duplicate method/path in route-inventory.json");

  for (const [name, route] of actualByKey) {
    const saved = expectedByKey.get(name);
    if (!saved) problems.push(`Added route: ${name} (auth: ${route.auth})`);
    else if (saved.auth !== route.auth) {
      problems.push(`Auth changed: ${name}: ${saved.auth} -> ${route.auth}`);
    }
  }
  for (const name of expectedByKey.keys()) {
    if (!actualByKey.has(name)) problems.push(`Removed route: ${name}`);
  }

  if (problems.length) {
    throw new Error([
      "Route inventory drift:",
      ...problems.sort(),
      "Update test/fixtures/route-inventory.json after checking the route and auth change.",
      "Reference each method/path in an endpoint test and docs/parity.md or docs/url-freeze.md.",
      "Run npm run check. Do not add untested routes to the inventory to silence this guard.",
    ].join("\n"));
  }
}
