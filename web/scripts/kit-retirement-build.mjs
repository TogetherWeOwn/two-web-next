import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { concretePath, multiSegmentPath } from "../../ci/parity/vectors.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const legacySeams = new Set([
  "src/index.tsx",
  "src/route-ownership.ts",
  "src/worker.ts",
  "web/src/lib/server/hono.ts",
  "web/src/routes/[...path]/+server.ts",
]);
const readFixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url), "utf8"));
const loadInventory = () => ({
  inventory: readFixture("route-inventory"),
  rows: readFixture("route-kit-map").rows,
});
const reportPrefix = "Kit retirement report ";

export function requireKitRetirementReport(output, mode) {
  const reports = output.split("\n").filter((line) => line.startsWith(reportPrefix));
  assert.equal(reports.length, 1, "expected exactly one Kit retirement report");
  const report = JSON.parse(reports[0].slice(reportPrefix.length));
  assert.equal(report.mode, mode, "wrong Kit retirement report mode");
  assert.ok(Number.isSafeInteger(report.checked) && report.checked > 0, "empty retirement report");
  assert.ok(
    typeof report.ready === "boolean" &&
      Array.isArray(report.honoDependencies) &&
      Array.isArray(report.unowned),
    "incomplete Kit retirement report",
  );
  return report;
}

/** @param {import("vite").Rollup.OutputBundle} bundle */
export function inspectSsrBundle(bundle) {
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  assert.ok(
    chunks.some((chunk) => chunk.isEntry),
    "missing Kit SSR entry chunks",
  );
  const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules));
  assert.ok(modules.length, "empty Kit SSR module graph");
  const ids = new Set([
    ...modules,
    ...chunks.flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports]),
  ]);
  const dependencies = new Set();
  for (const id of ids) {
    const file = id.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
    const dependency = file.split(/(?:^|\/)node_modules\//).at(-1);
    if (/^hono(?:\/|$)/.test(dependency)) {
      dependencies.add(dependency);
    }
    if (isAbsolute(file)) {
      const source = relative(root, file);
      if (legacySeams.has(source)) dependencies.add(source);
    }
  }
  return [...dependencies].sort();
}

const routeKey = ({ method, path }) => `${method} ${path}`;
const routeTarget = /^web\/src\/routes(\/.*?)?\/\+(page\.svelte|server\.ts)$/;
const openCatchAll = /^\/\[\.\.\.[^/]+\]$/;

/** @param {import("@sveltejs/kit").RouteDefinition[]} routes */
export function inspectRoutes(routes, inventory, rows) {
  assert.ok(routes.length, "empty Kit adapter route inventory");
  const registrations = rows.map(routeKey).sort();
  assert.ok(registrations.length, "empty legacy route inventory");
  assert.equal(new Set(registrations).size, registrations.length, "duplicate legacy route");
  assert.deepEqual(registrations, inventory.map(routeKey).sort(), "legacy route inventory drift");
  const unowned = [];
  let checked = 0;
  for (const row of rows) {
    if (row.kind === "middleware") continue;
    assert.ok(
      row.kind === "endpoint" || row.kind === "method-fallback",
      `invalid registration kind for ${routeKey(row)}`,
    );
    checked++;
    const target = typeof row.target === "string" && routeTarget.exec(row.target);
    if (!target) {
      unowned.push({ route: routeKey(row), reason: "unresolved Kit target" });
      continue;
    }
    const id = target[1] || "/";
    const routeSegments = id.replace(/\/\([^/]+\)/g, "");
    const method = row.method === "ALL" ? "*" : row.method;
    if (openCatchAll.test(routeSegments) || /\[[^\]]+=/.test(routeSegments)) {
      unowned.push({ route: routeKey(row), reason: `unsupported ownership target ${id}` });
      continue;
    }
    const paths = [concretePath(row.path), multiSegmentPath(row.path)].filter(Boolean);
    for (const path of paths) {
      // Kit's adapter route list follows routing priority. A regex match alone
      // cannot prove a named matcher accepts this value.
      const matched = routes.find((route) => route.pattern.test(path));
      const methods = target[2] === "page.svelte" ? matched?.page.methods : matched?.api.methods;
      const ownsMethod =
        methods?.includes(method) || (row.kind === "method-fallback" && methods?.includes("*"));
      if (matched?.id !== id || !ownsMethod) {
        unowned.push({
          route: routeKey(row),
          path,
          reason: `expected ${method} at ${id}, matched ${matched?.id ?? "no route"}`,
        });
      }
    }
  }
  assert.ok(checked, "no legacy endpoint or method-fallback registrations");
  return { checked, unowned };
}

/**
 * Read the exact build's SSR output graph and Kit's analyzed route methods.
 * The filter does not run in dev, on the client, or during an ordinary build.
 * @param {import("@sveltejs/kit").Adapter} adapter
 * @param {string | undefined} mode
 */
export function kitRetirementBuild(adapter, mode, load = loadInventory) {
  if (mode === undefined) return;
  assert.ok(mode === "report" || mode === "strict", "invalid KIT_RETIREMENT_GUARD mode");

  /** @type {string[] | undefined} */
  let honoDependencies;
  /** @type {import("vite").Plugin} */
  const plugin = {
    name: "two-kit-retirement-guard",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "ssr",
    generateBundle(_options, bundle) {
      honoDependencies = inspectSsrBundle(bundle);
    },
  };

  return {
    plugin,
    /** @type {import("@sveltejs/kit").Adapter} */
    adapter: {
      ...adapter,
      adapt(builder) {
        assert.ok(honoDependencies, "missing Kit SSR dependency evidence");
        const { inventory, rows } = load();
        const { checked, unowned } = inspectRoutes(builder.routes, inventory, rows);
        const ready = honoDependencies.length === 0 && unowned.length === 0;
        const report = { mode, ready, checked, honoDependencies, unowned };
        console.log(reportPrefix + JSON.stringify(report));
        assert.ok(mode === "report" || ready, "Kit retirement guard found blockers");
        return adapter.adapt(builder);
      },
    },
  };
}
