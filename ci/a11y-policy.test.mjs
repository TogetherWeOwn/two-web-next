import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { auditCases, auditDatabaseUrl, assertNoViolations, redactAuditLog, WCAG_AA_TAGS } from "./a11y-policy.mjs";
import { coverage as appCoverage } from "./a11y-cases.mjs";

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

test("legacy aliases are non-documents while canonical admin destinations remain audited", () => {
  const aliases = [
    "/auth/discord/redirect", "/admin/events/create", "/admin/events/:key/edit",
    "/admin/featured-contents", "/admin/featured-contents/create", "/admin/featured-contents/:id/edit",
  ];
  const destinations = ["/admin/events/new", "/admin/events/:key", "/admin/featured", "/admin/featured/new", "/admin/featured/:id"];
  // Match the app's static-before-parameter registration order for canonical admin pages.
  const registered = [...new Set([...destinations, ...Object.keys(appCoverage)])].map((path) => ({ method: "GET", path }));
  const cases = auditCases(registered, appCoverage);
  for (const alias of aliases) {
    assert.equal(appCoverage[alias]?.skip, true, alias);
    assert.match(appCoverage[alias].reason, /alias redirects/, alias);
    assert(!cases.some((entry) => entry.route === alias), alias);
  }
  for (const destination of destinations) assert(cases.some((entry) => entry.route === destination), destination);
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

test("every audit client pins authorized port/password despite runner PGPORT/PGPASSWORD", () => {
  const execution = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import postgres from "postgres";
    import { auditDatabaseOptions, auditDatabaseUrl } from "./ci/a11y-policy.mjs";
    for (const [raw, ci] of [
      ["postgres://agent_test@agent-testdb/two_web_next", false],
      ["postgres://agent_test@agent-testdb:5432/two_web_next", false],
      ["postgres://postgres:ci@localhost/postgres", true],
    ]) {
      const url = auditDatabaseUrl(raw, ci);
      assert.equal(url.port, "5432");
      for (const schema of ["fixture-session", "worker-db", "worker-session"]) {
        const client = postgres(url.href, auditDatabaseOptions(url, schema));
        assert.deepEqual(client.options.port, [5432]);
        assert.equal(client.options.pass(), ci ? "ci" : "");
        assert.equal(client.options.connection.search_path, schema);
        await client.end(); // Constructor-only: no database connection.
      }
    }
  `], { env: { ...process.env, PGPORT: "5433", PGPASSWORD: "unauthorized-fixture-value" }, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
});

test("audit artifacts omit Wrangler's synthetic session and DB configuration values", () => {
  const log = 'env.SESSION_SECRET ("synthetic-value")\nenv.A11Y_DATABASE_URL ("fixture-url")\nenv.APP_URL ("https://127.0.0.1:1234")\nGET /up 200';
  assert.equal(redactAuditLog(log), 'env.SESSION_SECRET: [redacted]\nenv.A11Y_DATABASE_URL: [redacted]\nenv.APP_URL ("https://127.0.0.1:1234")\nGET /up 200');
  assert.equal(redactAuditLog("startup failed"), "startup failed");
});

test("the required CI job runs after a non-green audit and rejects every non-success result", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const check = workflow.slice(workflow.indexOf("\n  check:\n"));
  assert.match(check, /\n    needs: a11y\n/);
  assert.match(check, /\n    if: always\(\)\n/);
  assert.match(check, /A11Y_RESULT: \$\{\{ needs\.a11y\.result \}\}/);
  const guard = check.match(/steps:\n      - name: Require successful accessibility audit\n        env:\n          A11Y_RESULT: [^\n]+\n        run: ([^\n]+)/);
  assert(guard, "Audit guard must be the required job's first step");
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const execution = spawnSync("bash", ["-c", guard[1]], { env: { A11Y_RESULT: result } });
    assert.equal(execution.status, result === "success" ? 0 : 1, `Audit result ${result || "missing"}`);
  }
});

test("WCAG 2.0, 2.1 and 2.2 A/AA are included, and even minor violations fail", () => {
  assert.deepEqual(WCAG_AA_TAGS, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]);
  assert.doesNotThrow(() => assertNoViolations({ violations: [] }, "clean"));
  assert.throws(() => assertNoViolations({ violations: [{ id: "image-alt", impact: "minor", nodes: [{}] }] }, "sentinel"), /sentinel: image-alt/);
});
