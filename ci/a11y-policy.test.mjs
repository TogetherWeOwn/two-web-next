import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCases, auditDatabaseUrl, assertNoViolations, WCAG_AA_TAGS } from "./a11y-policy.mjs";

const coverage = {
  "/": { cases: [{ path: "/" }] },
  "/e/:key": { cases: [{ path: "/e/fixture" }, { path: "/e/missing", status: 404 }] },
  "/health": { skip: true, reason: "JSON, not a document" },
};
const routes = Object.keys(coverage).map((path) => ({ path, method: "GET" }));

test("derive cases from registered GETs, deduplicate middleware and omit non-GET routes", () => {
  const cases = auditCases([...routes, routes[0], { method: "POST", path: "/write" }], coverage);
  assert.equal(cases.length, 3);
  assert.equal(cases[0].identity, "guest");
  assert.equal(cases[2].status, 404);
  assert.equal(cases[1].route, "/e/:key");
});

test("new static GETs are audited automatically; new parameterized GETs require fixtures", () => {
  assert(auditCases([...routes, { method: "GET", path: "/new-page" }], coverage).some((entry) => entry.path === "/new-page"));
  assert.throws(() => auditCases([...routes, { method: "GET", path: "/new-page/:id" }], coverage), /missing=\/new-page/);
});

test("removed routes and unexplained exclusions fail", () => {
  assert.throws(() => auditCases(routes.slice(1), coverage), /stale=\//);
  assert.throws(() => auditCases([{ method: "GET", path: "/" }], { "/": { skip: true } }), /exclusion reason/);
  assert.throws(() => auditCases([{ method: "GET", path: "/" }], { "/": { cases: [] } }), /No audit cases/);
});

test("refuse staging, production and ambiguous database configuration before connecting", () => {
  assert.equal(auditDatabaseUrl("postgres://agent_test@agent-testdb:5432/two_web_next").hostname, "agent-testdb");
  assert.equal(auditDatabaseUrl("postgres://postgres:ci@localhost:5432/postgres", true).hostname, "localhost");
  for (const raw of [
    "postgres://agent_test@staging.example/two_web_next",
    "postgres://agent_test@production.example/two_web_next",
    "postgres://agent_test@agent-testdb/other_database",
    "postgres://agent_test:unexpected@agent-testdb/two_web_next",
    "postgres://agent_test@agent-testdb:5433/two_web_next",
    "postgres://agent_test@agent-testdb/two_web_next?host=production.example",
    "postgres://postgres:ci@localhost/postgres",
    "invalid",
  ]) assert.throws(() => auditDatabaseUrl(raw), /refusing before connecting/);
});

test("WCAG 2.0, 2.1 and 2.2 A/AA are included, and even minor violations fail", () => {
  assert.deepEqual(WCAG_AA_TAGS, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]);
  assert.doesNotThrow(() => assertNoViolations({ violations: [] }, "clean"));
  assert.throws(() => assertNoViolations({ violations: [{ id: "image-alt", impact: "minor", nodes: [{}] }] }, "sentinel"), /sentinel: image-alt/);
});
