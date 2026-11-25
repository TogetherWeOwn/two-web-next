import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectRoutes,
  inspectSsrBundle,
  kitRetirementBuild,
  requireKitRetirementReport,
} from "../web/scripts/kit-retirement-build.mjs";
import { EVENT_KEY } from "./parity/vectors.mjs";

const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const chunk = (fileName, modules, options = {}) => ({
  fileName,
  type: "chunk",
  modules: Object.fromEntries(modules.map((id) => [id, {}])),
  imports: [],
  dynamicImports: [],
  ...options,
});
const ssr = ({
  modules = [source("src/release-tag.ts")],
  imports = [],
  dynamicImports = [],
} = {}) => ({
  "index.js": chunk("index.js", modules, { isEntry: true, imports, dynamicImports }),
});
const noModuleInfo = () => null;
const emptyRemoval = { chunks: [], entrypoints: [], lazyChunks: [], units: [] };

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
    "chunks/lazy.js": chunk(
      "chunks/lazy.js",
      [
        source("node_modules/.pnpm/hono@1/node_modules/hono/dist/index.js?commonjs"),
        source("node_modules/hono/node_modules/other/index.js"),
        source("web/src/lib/server/hono.ts"),
      ],
      { imports: ["node:crypto"], dynamicImports: ["hono/jsx"] },
    ),
  };
  assert.deepEqual(inspectSsrBundle(bundle, noModuleInfo, []).honoDependencies, [
    "hono/cookie",
    "hono/dist/index.js",
    "hono/jsx",
    "src/index.tsx",
    "src/route-ownership.ts",
    "web/src/lib/server/hono.ts",
  ]);
  assert.deepEqual(inspectSsrBundle(ssr(), noModuleInfo, []), {
    honoDependencies: [],
    honoRemoval: emptyRemoval,
  });
  assert.throws(() => inspectSsrBundle({}, noModuleInfo, []), /missing Kit SSR entry/);
  assert.throws(
    () => inspectSsrBundle(ssr({ modules: [] }), noModuleInfo, []),
    /empty Kit SSR module graph/,
  );
});

test("joins shared and lazy SSR imports to exact route and fallback removal units", () => {
  const ops = "web/src/routes/up/+server.ts";
  const page = "web/src/routes/profile/+page.svelte";
  const pageLoad = "web/src/routes/profile/+page.server.ts";
  const helper = "web/src/lib/server/shared.ts";
  const bridge = "web/src/lib/server/hono.ts";
  const fallback = "web/src/routes/[...path]/+server.ts";
  const legacyApp = source("src/index.tsx");
  const packageModule = source("node_modules/hono/dist/context.js");
  const graph = new Map([
    [
      source("web/src/hooks.server.ts"),
      { dynamicallyImportedIds: [source(ops), source(fallback)] },
    ],
    [source(ops), { importedIds: [source(helper)] }],
    [source(pageLoad), { importedIds: [source(helper)] }],
    [source(helper), { importedIds: [packageModule] }],
    [source(fallback), { importedIds: [source(bridge)] }],
    [source(bridge), { importedIds: [legacyApp] }],
    [legacyApp, { importedIds: [packageModule] }],
  ]);
  const bundle = {
    ...ssr({
      modules: [source("web/src/hooks.server.ts"), source(pageLoad)],
      imports: ["shared.js"],
      dynamicImports: ["up.js", "fallback.js"],
    }),
    "up.js": chunk("up.js", [source(ops)], { imports: ["shared.js"] }),
    "fallback.js": chunk("fallback.js", [source(fallback), source(bridge)], {
      imports: ["shared.js"],
    }),
    "shared.js": chunk("shared.js", [source(helper), legacyApp, packageModule]),
  };
  const rows = [
    { ...registration("GET", "/up", "/up/+server.ts"), family: "ops", slice: "API-3" },
    { ...registration("GET", "/up-alias", "/up/+server.ts"), family: "ops", slice: "API-3" },
    { ...registration("GET", "/profile", "/profile/+page.svelte"), owner: "Page owner" },
  ];
  const result = inspectSsrBundle(bundle, (id) => graph.get(id), rows);
  assert.deepEqual(result.honoRemoval, {
    chunks: [
      {
        file: "fallback.js",
        dependencies: [
          { dependency: bridge, entrypoints: [bridge], unowned: false },
          { dependency: fallback, entrypoints: [fallback], unowned: false },
        ],
      },
      {
        file: "shared.js",
        dependencies: [
          { dependency: "hono/dist/context.js", entrypoints: [bridge, helper], unowned: false },
          { dependency: "src/index.tsx", entrypoints: [bridge], unowned: false },
        ],
      },
    ],
    entrypoints: [
      { source: bridge, targets: [fallback], unownedImporters: [] },
      { source: helper, targets: [page, ops], unownedImporters: [] },
      { source: fallback, targets: [fallback], unownedImporters: [] },
    ],
    lazyChunks: [
      {
        file: "fallback.js",
        importers: ["index.js"],
        dependencyFiles: ["fallback.js", "shared.js"],
      },
      { file: "up.js", importers: ["index.js"], dependencyFiles: ["shared.js"] },
    ],
    units: [
      { target: fallback, slice: "API-10", registrations: [] },
      {
        target: page,
        registrations: [{ route: "GET /profile", family: null, slice: null, owner: "Page owner" }],
      },
      {
        target: ops,
        registrations: [
          { route: "GET /up", family: "ops", slice: "API-3", owner: null },
          { route: "GET /up-alias", family: "ops", slice: "API-3", owner: null },
        ],
      },
    ],
  });
});

test("keeps unmapped importers and missing edges visible beside known owners", () => {
  const page = "web/src/routes/profile/+page.svelte";
  const unmapped = "web/src/routes/profile/+server.ts";
  const helper = "web/src/lib/server/profile-helper.ts";
  const context = source("node_modules/hono/dist/context.js");
  const legacy = source("src/legacy.ts");
  const graph = new Map([
    [source(page), { importedIds: [source(helper)] }],
    [source(unmapped), { importedIds: [source(helper)] }],
    [source(helper), { dynamicallyImportedIds: ["hono/cookie", context] }],
    [legacy, { importedIds: [context] }],
  ]);
  const bundle = {
    ...ssr({
      modules: [source(page), source(helper), source(unmapped)],
      dynamicImports: ["lazy.js", "hono/cookie"],
    }),
    "lazy.js": chunk("lazy.js", [context, legacy], { imports: ["hono/cookie"] }),
  };
  const rows = [registration("GET", "/profile", "/profile/+page.svelte")];
  const { honoRemoval } = inspectSsrBundle(bundle, (id) => graph.get(id), rows);
  assert.deepEqual(honoRemoval.entrypoints, [
    { source: helper, targets: [page], unownedImporters: [unmapped] },
  ]);
  assert.deepEqual(honoRemoval.chunks, [
    {
      file: "index.js",
      dependencies: [{ dependency: "hono/cookie", entrypoints: [helper], unowned: false }],
    },
    {
      file: "lazy.js",
      dependencies: [
        { dependency: "hono/cookie", entrypoints: [], unowned: true },
        { dependency: "hono/dist/context.js", entrypoints: [helper], unowned: true },
      ],
    },
  ]);
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

test("groups every blocker by its legacy family and exact method", (t) => {
  const eventWrite = (method, path, kind) => ({
    ...registration(method, path, "/events/[key]/rsvp/+server.ts", kind),
    family: "event-writes",
  });
  const rows = [
    eventWrite("POST", "/events/:key/rsvp"),
    eventWrite("POST", "/e/:key/rsvp"),
    eventWrite("ALL", "/events/:key/rsvp", "method-fallback"),
    eventWrite("OPTIONS", "/events/:key/rsvp", "method-fallback"),
    {
      ...registration("GET", "/events/:file{.+\\.ics}", "/events/[key].ics/+server.ts"),
      family: "feeds",
    },
    { ...registration("GET", "/old", "/old/+page.svelte"), family: null },
    { ...registration("GET", "/older", "/older/+page.svelte"), target: null },
    { method: "ALL", path: "/*", kind: "middleware" },
  ];
  const routes = [mounted("/events/[key]/rsvp", /^\/events\/[^/]+\/rsvp$/, ["POST"])];
  const log = t.mock.method(console, "log", () => {});
  const adapter = { name: "fixture", adapt: () => {} };
  const guard = kitRetirementBuild(adapter, "report", () => ({ rows, inventory: rows }));
  guard.plugin.generateBundle.call({ getModuleInfo: noModuleInfo }, {}, ssr());
  guard.adapter.adapt({ routes });

  const report = requireKitRetirementReport(log.mock.calls[0].arguments[0], "report");
  assert.equal(report.checked, 7);
  assert.equal(report.ready, false);
  assert.deepEqual(
    report.unowned.map(({ route, path }) => [route, path]),
    [
      ["POST /e/:key/rsvp", `/e/${EVENT_KEY}/rsvp`],
      ["ALL /events/:key/rsvp", `/events/${EVENT_KEY}/rsvp`],
      ["OPTIONS /events/:key/rsvp", `/events/${EVENT_KEY}/rsvp`],
      ["GET /events/:file{.+\\.ics}", `/events/${EVENT_KEY}.ics`],
      ["GET /events/:file{.+\\.ics}", "/events/a/b.ics"],
      ["GET /old", "/old"],
      ["GET /older", undefined],
    ],
  );
  const [alias, fallback, options, feed, multiSegmentFeed, unclassified, missing] = report.unowned;
  assert.deepEqual(report.unownedByFamily, {
    "event-writes": { POST: [alias], ALL: [fallback], OPTIONS: [options] },
    feeds: { GET: [feed, multiSegmentFeed] },
    unresolved: { GET: [unclassified, missing] },
  });
});

test("report reader requires grouped findings and removal evidence", () => {
  const report = {
    mode: "report",
    checked: 1,
    ready: true,
    honoDependencies: [],
    unowned: [],
    honoRemoval: emptyRemoval,
  };
  const line = (unownedByFamily) =>
    `Kit retirement report ${JSON.stringify({ ...report, unownedByFamily })}`;
  assert.deepEqual(requireKitRetirementReport(line({}), "report"), {
    ...report,
    unownedByFamily: {},
  });
  for (const value of [undefined, null, "unresolved", []]) {
    assert.throws(
      () => requireKitRetirementReport(line(value), "report"),
      /incomplete Kit retirement report/,
    );
  }
  assert.throws(
    () =>
      requireKitRetirementReport(
        `Kit retirement report ${JSON.stringify({ ...report, unownedByFamily: {}, honoRemoval: {} })}`,
        "report",
      ),
    /incomplete Kit retirement report/,
  );
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
  const generate = (guard, bundle) =>
    guard.plugin.generateBundle.call({ getModuleInfo: noModuleInfo }, {}, bundle);
  assert.equal(kitRetirementBuild(cloudflare, undefined), undefined);
  assert.throws(() => kitRetirementBuild(cloudflare, "typo"), /invalid KIT_RETIREMENT_GUARD/);
  const strict = kitRetirementBuild(cloudflare, "strict", load);
  assert.throws(() => strict.adapter.adapt(covered), /missing Kit SSR dependency evidence/);
  assert.equal(strict.plugin.applyToEnvironment({ name: "client" }), false);
  assert.equal(strict.plugin.applyToEnvironment({ name: "ssr" }), true);
  const log = t.mock.method(console, "log", () => {});
  generate(strict, ssr({ imports: ["hono"] }));
  assert.throws(() => strict.adapter.adapt(covered), /Kit retirement guard found blockers/);
  generate(strict, ssr());
  assert.throws(() => strict.adapter.adapt(unowned), /Kit retirement guard found blockers/);
  assert.equal(adapted, 0);
  strict.adapter.adapt(covered);

  const report = kitRetirementBuild(cloudflare, "report", load);
  generate(report, ssr({ imports: ["hono"] }));
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
  assert.deepEqual(dependencyOnly.unownedByFamily, {});
  assert.deepEqual(routeOnly.honoDependencies, []);
  assert.deepEqual(routeOnly.unownedByFamily, { unresolved: { GET: routeOnly.unowned } });
  assert.deepEqual(
    routeOnly.unowned.map(({ route }) => route),
    ["GET /"],
  );
  assert.equal(clean.ready, true);
  assert.deepEqual(clean.unownedByFamily, {});
  assert.deepEqual(clean.honoRemoval, emptyRemoval);
  assert.equal(reportOnly.ready, false);
});
