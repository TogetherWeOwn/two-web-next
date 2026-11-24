import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectRoutes,
  inspectSsrBundle,
  kitRetirementBuild,
  requireKitRetirementReport,
} from "../web/scripts/kit-retirement-build.mjs";

const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const ssr = ({
  modules = [source("src/release-tag.ts")],
  imports = [],
  dynamicImports = [],
} = {}) => ({
  "index.js": {
    type: "chunk",
    isEntry: true,
    modules: Object.fromEntries(modules.map((id) => [id, {}])),
    imports,
    dynamicImports,
  },
});

const mounted = (id, pattern, api = [], page = []) => ({
  id,
  pattern,
  api: { methods: api },
  page: { methods: page },
});
const registration = (method, path, target, kind = "endpoint") => ({
  method,
  path,
  target: `web/src/routes${target}`,
  kind,
});

test("finds bundled and external Hono modules, including lazy SSR chunks", () => {
  const bundle = {
    ...ssr({
      imports: ["hono/cookie", "chunks/lazy.js", "hono-like"],
      modules: [source("src/index.tsx"), source("src/route-ownership.ts")],
    }),
    "chunks/lazy.js": {
      type: "chunk",
      modules: {
        [source("node_modules/.pnpm/hono@1/node_modules/hono/dist/index.js?commonjs")]: {},
        [source("node_modules/hono/node_modules/other/index.js")]: {},
        [source("web/src/lib/server/hono.ts")]: {},
      },
      imports: ["node:crypto"],
      dynamicImports: ["hono/jsx"],
    },
  };
  assert.deepEqual(inspectSsrBundle(bundle), [
    "hono/cookie",
    "hono/dist/index.js",
    "hono/jsx",
    "src/index.tsx",
    "src/route-ownership.ts",
    "web/src/lib/server/hono.ts",
  ]);
  assert.deepEqual(inspectSsrBundle(ssr()), []);
  assert.throws(() => inspectSsrBundle({}), /missing Kit SSR entry/);
  assert.throws(() => inspectSsrBundle(ssr({ modules: [] })), /empty Kit SSR module graph/);
});

test("tracks exact handlers, actions, and explicit method refusals separately", () => {
  const rows = [
    registration("GET", "/events", "/events/+page.svelte"),
    registration("POST", "/events", "/events/+page.svelte"),
    registration("PATCH", "/events", "/events/+server.ts"),
    registration("ALL", "/events", "/events/+server.ts", "method-fallback"),
  ];
  assert.deepEqual(
    inspectRoutes([mounted("/events", /^\/events$/, ["PATCH", "*"], ["GET", "POST"])], rows, rows),
    { checked: 4, unowned: [] },
  );
  const { unowned } = inspectRoutes([mounted("/events", /^\/events$/, ["*"], ["GET"])], rows, rows);
  assert.deepEqual(
    unowned.map(({ route }) => route),
    ["POST /events", "PATCH /events"],
  );
});

test("a rest fallback or dynamic sibling cannot fill a missing mapped route", () => {
  const rows = [
    registration("GET", "/events/past", "/events/past/+page.svelte"),
    registration("GET", "/old", "/(legacy)/[...path]/+server.ts"),
    registration("GET", "/profile", "/profile/+page.svelte"),
  ];
  const { unowned } = inspectRoutes(
    [
      mounted("/events/[key]", /^\/events\/[^/]+$/, [], ["GET"]),
      mounted("/(legacy)/[...path]", /^\//, ["*", "GET"]),
    ],
    rows,
    rows,
  );
  assert.deepEqual(
    unowned.map(({ route }) => route),
    rows.map(({ path }) => `GET ${path}`),
  );
  assert.throws(() => inspectRoutes([], rows, rows), /empty Kit adapter route inventory/);
  assert.throws(
    () => inspectRoutes([mounted("/", /^\/$/)], rows, rows.slice(1)),
    /legacy route inventory drift/,
  );
});

test("the single-segment feed and a named matcher cannot prove broader legacy ownership", () => {
  const rows = [
    registration("GET", "/events/:file{.+\\.ics}", "/events/[key].ics/+server.ts"),
    registration("GET", "/e/:key", "/e/[key=event]/+page.svelte"),
  ];
  const { unowned } = inspectRoutes(
    [
      mounted("/events/[key].ics", /^\/events\/[^/]+\.ics$/, ["GET"]),
      mounted("/e/[key=event]", /^\/e\/[^/]+$/, [], ["GET"]),
    ],
    rows,
    rows,
  );
  assert.equal(unowned[0].path, "/events/a/b.ics");
  assert.match(unowned[1].reason, /unsupported ownership target/);
});

test("explicit strict mode blocks adapter output and report mode lets it proceed", (t) => {
  let adapted = 0;
  const cloudflare = {
    name: "fixture",
    adapt: () => {
      adapted++;
    },
  };
  const rows = [registration("GET", "/", "/+page.svelte")];
  const load = () => ({ rows, inventory: rows });
  const covered = { routes: [mounted("/", /^\/$/, [], ["GET"])] };
  const unowned = { routes: [mounted("/[...path]", /^\//, ["*", "GET"])] };
  assert.equal(kitRetirementBuild(cloudflare, undefined), undefined);
  assert.throws(() => kitRetirementBuild(cloudflare, "typo"), /invalid KIT_RETIREMENT_GUARD/);
  const strict = kitRetirementBuild(cloudflare, "strict", load);
  assert.throws(() => strict.adapter.adapt(covered), /missing Kit SSR dependency evidence/);
  assert.equal(strict.plugin.applyToEnvironment({ name: "client" }), false);
  assert.equal(strict.plugin.applyToEnvironment({ name: "ssr" }), true);
  const log = t.mock.method(console, "log", () => {});
  strict.plugin.generateBundle({}, ssr({ imports: ["hono"] }));
  assert.throws(() => strict.adapter.adapt(covered), /Kit retirement guard found blockers/);
  strict.plugin.generateBundle({}, ssr());
  assert.throws(() => strict.adapter.adapt(unowned), /Kit retirement guard found blockers/);
  assert.equal(adapted, 0);
  strict.adapter.adapt(covered);

  const report = kitRetirementBuild(cloudflare, "report", load);
  report.plugin.generateBundle({}, ssr({ imports: ["hono"] }));
  report.adapter.adapt(unowned);
  assert.equal(adapted, 2);

  const lines = log.mock.calls.map(({ arguments: [line] }) => line);
  const [dependencyOnly, routeOnly, clean] = lines
    .slice(0, 3)
    .map((line) => requireKitRetirementReport(line, "strict"));
  const reportOnly = requireKitRetirementReport(lines[3], "report");
  assert.throws(
    () => requireKitRetirementReport("npm build passed", "report"),
    /expected exactly one/,
  );
  assert.throws(
    () => requireKitRetirementReport(lines.join("\n"), "report"),
    /expected exactly one/,
  );
  assert.throws(() => requireKitRetirementReport(lines[2], "report"), /wrong.*mode/);
  assert.deepEqual(dependencyOnly.honoDependencies, ["hono"]);
  assert.deepEqual(dependencyOnly.unowned, []);
  assert.deepEqual(routeOnly.honoDependencies, []);
  assert.deepEqual(
    routeOnly.unowned.map(({ route }) => route),
    ["GET /"],
  );
  assert.equal(clean.ready, true);
  assert.equal(reportOnly.ready, false);
});
