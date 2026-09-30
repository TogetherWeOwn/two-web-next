// Keep route discovery separate from browser execution so coverage drift is unit-testable.
export const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

export function auditCases(routes, coverage) {
  const registered = [...new Set(routes.filter((route) => route.method === "GET").map((route) => route.path))].sort();
  const unknown = registered.filter((path) => /[:*{]/.test(path) && !Object.hasOwn(coverage, path));
  const stale = Object.keys(coverage).filter((path) => !registered.includes(path));
  if (unknown.length || stale.length) {
    throw new Error(`GET route coverage drift: missing=${unknown.join(", ")}; stale=${stale.join(", ")}`);
  }
  return registered.flatMap((route) => {
    const entry = coverage[route] ?? { cases: [{ path: route, identity: route.startsWith("/admin") ? "moderator" : "guest" }] };
    if (entry.skip) {
      if (!entry.reason) throw new Error(`Missing exclusion reason for ${route}`);
      return [];
    }
    if (!entry.cases?.length) throw new Error(`No audit cases for ${route}`);
    return entry.cases.map((scenario) => ({ route, identity: "guest", status: 200, ...scenario }));
  });
}

export function auditDatabaseUrl(raw, githubActions = false) {
  const refuse = () => { throw new Error("Accessibility fixtures require agent-testdb/two_web_next or the GitHub CI service; refusing before connecting"); };
  let url;
  try { url = new URL(raw); } catch { return refuse(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash || (url.port && url.port !== "5432")) return refuse();
  const local = url.hostname === "agent-testdb" && url.username === "agent_test" && url.password === "" && url.pathname === "/two_web_next";
  const ci = githubActions && url.hostname === "localhost" && url.username === "postgres" && url.password === "ci" && url.pathname === "/postgres";
  if (!local && !ci) return refuse();
  return url;
}

// No broad rule exclusions: every WCAG AA violation fails, including minor impacts.
export function assertNoViolations(results, label) {
  if (results.violations.length) {
    throw new Error(`${label}: ${results.violations.map((rule) => `${rule.id} (${rule.nodes.length} nodes)`).join(", ")}`);
  }
}
