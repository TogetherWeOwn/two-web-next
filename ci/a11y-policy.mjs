import { Hono } from "hono";

// Keep route discovery separate from browser execution so coverage drift is unit-testable.
export const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

export function auditCases(routes, coverage) {
  const registered = [
    ...new Set(routes.filter((route) => route.method === "GET").map((route) => route.path)),
  ].sort();
  const unknown = registered.filter((path) => /[:*{]/.test(path) && !Object.hasOwn(coverage, path));
  const stale = Object.keys(coverage).filter((path) => !registered.includes(path));
  if (unknown.length || stale.length) {
    throw new Error(
      `GET route coverage drift: missing=${unknown.join(", ")}; stale=${stale.join(", ")}`,
    );
  }
  const matcher = new Hono();
  for (const route of routes) matcher.router.add(route.method, route.path, route);
  return registered.flatMap((route) => {
    const entry = coverage[route] ?? {
      cases: [{ path: route, identity: route.startsWith("/admin") ? "moderator" : "guest" }],
    };
    if (entry.skip) {
      if (!entry.reason) throw new Error(`Missing exclusion reason for ${route}`);
      return [];
    }
    if (!entry.cases?.length) throw new Error(`No audit cases for ${route}`);
    return entry.cases.map((scenario) => {
      const path = concreteAuditPath(scenario.path, route, matcher);
      const matches = matcher.router.match("GET", path)[0];
      const firstGet = matches.find(([matched]) => matched.method === "GET")?.[0];
      if (firstGet?.path !== route) {
        throw new Error(
          `Invalid audit path for ${route}: ${scenario.path} does not match the registered GET`,
        );
      }
      return { identity: "guest", status: 200, ...scenario, route };
    });
  });
}

function concreteAuditPath(raw, route, matcher) {
  const refuse = () => {
    throw new Error(`Invalid audit path for ${route}: ${String(raw)}`);
  };
  if (typeof raw !== "string" || !raw.startsWith("/") || /[\\#\s\u0000-\u001f\u007f]/.test(raw))
    return refuse();
  const origin = "https://a11y.invalid";
  let url;
  let decoded;
  try {
    url = new URL(raw, origin);
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return refuse();
  }
  // Refuse URL normalization, encoded separators, placeholders and second decoding.
  if (
    url.origin !== origin ||
    url.pathname !== raw.split("?")[0] ||
    url.pathname.includes("//") ||
    /%2f/i.test(url.pathname) ||
    /[:*{}%\\?#\s\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  )
    return refuse();
  return matcher.getPath(new Request(url));
}

export function auditDatabaseUrl(raw, githubActions = false) {
  const refuse = () => {
    throw new Error(
      "Accessibility fixtures require agent-testdb/two_web_next or the GitHub CI service; refusing before connecting",
    );
  };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return refuse();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "5432")
  )
    return refuse();
  const local =
    url.hostname === "agent-testdb" &&
    url.username === "agent_test" &&
    url.password === "" &&
    url.pathname === "/two_web_next";
  const ci =
    githubActions &&
    url.hostname === "localhost" &&
    url.username === "postgres" &&
    url.password === "ci" &&
    url.pathname === "/postgres";
  if (!local && !ci) return refuse();
  // An omitted URL port must never inherit PGPORT from the runner.
  url.port = "5432";
  return url;
}

export function auditDatabaseOptions(url, schemaName) {
  return {
    max: 1,
    port: 5432,
    password: () => url.password,
    connect_timeout: 5,
    connection: { search_path: schemaName },
    onnotice: () => {},
  };
}

export function redactAuditLog(log) {
  return log.replace(/(env\.(?:SESSION_SECRET|A11Y_DATABASE_URL))[^\r\n]*/g, "$1: [redacted]");
}

// No broad rule exclusions: every WCAG AA violation fails, including minor impacts.
export function assertNoViolations(results, label) {
  if (results.violations.length) {
    throw new Error(
      `${label}: ${results.violations.map((rule) => `${rule.id} (${rule.nodes.length} nodes)`).join(", ")}`,
    );
  }
}
