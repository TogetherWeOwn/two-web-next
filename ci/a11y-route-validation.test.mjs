import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadAuditWorkerRoutes } from "./a11y-test-worker.mjs";
import { Hono } from "hono";
import { coverage } from "./a11y-cases.mjs";
import { auditCases } from "./a11y-policy.mjs";

const route = "/e/:key";
const registered = [
  { method: "GET", path: route },
  { method: "GET", path: "/about" },
];
const casesFor = (path, extra = {}) => ({ [route]: { cases: [{ path, ...extra }] } });

test("refuse a different clean page as dynamic route coverage", () => {
  assert.throws(() => auditCases(registered, casesFor("/about")), /Invalid audit path.*\/e\/:key/);
  assert.throws(() => auditCases(registered, casesFor("/members/fixture")), /Invalid audit path/);
  assert.throws(() => auditCases(registered, casesFor("/e/fixture/extra")), /Invalid audit path/);
  assert.equal(auditCases(registered, casesFor("/e/fixture"))[1].path, "/e/fixture");
});

test("static routes and queries retain their registered route identity", () => {
  for (const path of [
    "/e/fixture",
    "/e/fixture?n=joined",
    "/e/%66ixture?q=Friday%20night&next=https%3A%2F%2Fexample.com",
  ]) {
    const scenarios = auditCases(
      registered,
      casesFor(path, { route: "/about", identity: "member", status: 404 }),
    );
    assert.deepEqual(scenarios[1], { route, identity: "member", status: 404, path });
  }
  assert.equal(
    auditCases([{ method: "GET", path: "/about" }], {
      "/about": { cases: [{ path: "/about?from=events" }] },
    })[0].path,
    "/about?from=events",
  );
  assert.throws(
    () =>
      auditCases([{ method: "GET", path: "/about" }], {
        "/about": { cases: [{ path: "/rules" }] },
      }),
    /Invalid audit path/,
  );
});

test("Hono constrained parameters enforce the actual registered calendar pattern", () => {
  const calendar = "/events/:file{.+\\.ics}";
  const routes = [{ method: "GET", path: calendar }];
  for (const path of [
    "/events/fixture.ics",
    "/events/fixture.ics?download=1",
    "/events/nested/fixture.ics",
  ]) {
    assert.equal(auditCases(routes, { [calendar]: { cases: [{ path }] } })[0].path, path);
  }
  for (const path of [
    "/events/fixture",
    "/events/fixtureXics",
    "/events/.ics",
    "/events/fixture.ics/extra",
  ]) {
    assert.throws(
      () => auditCases(routes, { [calendar]: { cases: [{ path }] } }),
      /Invalid audit path/,
      path,
    );
  }
});

test("refuse unresolved, off-origin, normalized and ambiguous fixture paths", () => {
  for (const path of [
    undefined,
    null,
    123,
    "",
    "e/fixture",
    "https://example.com/e/fixture",
    "//example.com/e/fixture",
    "/e/:key",
    "/e/%3Akey",
    "/e/{key}",
    "/e/%7Bkey%7D",
    "/e/*",
    "/e/%2A",
    "/e/fixture#section",
    "/e/fixture?x=1#section",
    "/e/fixture\\extra",
    "/e/%5cfixture",
    "/e//fixture",
    "/e/%2ffixture",
    "/e/%252ffixture",
    "/e/./fixture",
    "/e/../e/fixture",
    "/e/%2e/fixture",
    "/e/%2e%2e/e/fixture",
    "/e/fixture\n",
    "/e/fixture\t?x=1",
    "/e/%00",
    "/e/%0a",
    "/e/fixture ",
    "/e/%3fkey",
    "/e/%23key",
    "/e/%",
    "/e/%FF",
    "/e/fixture/",
  ])
    assert.throws(() => auditCases(registered, casesFor(path)), /Invalid audit path/, String(path));
});

test("matching uses the whole registration table without executing handlers", () => {
  const app = new Hono();
  app.use("*", () => {
    throw new Error("Middleware must not execute");
  });
  app.get(route, () => {
    throw new Error("GET must not execute");
  });
  app.post("/e/:key", () => {
    throw new Error("POST must not execute");
  });
  assert.equal(auditCases(app.routes, casesFor("/e/fixture"))[0].route, route);
});

test("an earlier static GET cannot stand in for an overlapping dynamic route", () => {
  const routes = [
    { method: "GET", path: "/e/new" },
    { method: "GET", path: route },
  ];
  assert.throws(() => auditCases(routes, casesFor("/e/new")), /Invalid audit path/);
  assert(
    auditCases(routes, casesFor("/e/fixture")).some(
      (scenario) => scenario.path === "/e/new" && scenario.route === "/e/new",
    ),
  );
});

test("an earlier dynamic GET cannot stand in for an overlapping static route", () => {
  const routes = [
    { method: "GET", path: route },
    { method: "GET", path: "/e/new" },
  ];
  assert.throws(
    () => auditCases(routes, casesFor("/e/fixture")),
    /Invalid audit path for \/e\/new/,
  );
});

test("checked-in cases and test-only errors stay valid with explicit exclusions", () => {
  const routes = Object.keys(coverage).map((path) => ({ method: "GET", path }));
  const scenarios = auditCases(routes, coverage);
  assert.equal(
    scenarios.length,
    Object.values(coverage).reduce((count, entry) => count + (entry.cases?.length || 0), 0),
  );
  for (const status of [404, 429, 500, 503])
    assert(
      scenarios.some((entry) => entry.route === `/__a11y/${status}` && entry.status === status),
    );
  assert(!scenarios.some((entry) => entry.route === "/events/:file{.+\\.ics}"));
});

test("all real audit-worker GET registrations accept their checked-in cases offline", async () => {
  const worker = await loadAuditWorkerRoutes();
  const scenarios = auditCases(worker.routes, worker.coverage);
  assert(scenarios.length > 0);
  const audited = new Set(scenarios.map((scenario) => scenario.route));
  for (const { method, path } of worker.routes) {
    if (method === "GET") assert(worker.coverage[path]?.skip || audited.has(path), path);
  }
});

test("runner validates coverage before acquiring fixtures or launching a browser", async () => {
  const runner = await readFile(new URL("./a11y.mjs", import.meta.url), "utf8");
  const validation = runner.indexOf("auditCases(routes, coverage)");
  assert(validation >= 0);
  for (const step of ["fixtures(database)", "chromium.launch(", "spawn(process.execPath"]) {
    assert(validation < runner.indexOf(step), `${step} must follow coverage validation`);
  }
});
