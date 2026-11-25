import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { concretePath, multiSegmentPath } from "../../ci/parity/vectors.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fallbackTarget = "web/src/routes/[...path]/+server.ts";
const fallbackSources = ["web/src/lib/server/hono.ts", fallbackTarget];
const legacySeams = new Set([
  "src/index.tsx",
  "src/route-ownership.ts",
  "src/worker.ts",
  ...fallbackSources,
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
      Array.isArray(report.unowned) &&
      report.unownedByFamily &&
      typeof report.unownedByFamily === "object" &&
      !Array.isArray(report.unownedByFamily) &&
      Array.isArray(report.honoRemoval?.entrypoints) &&
      Array.isArray(report.honoRemoval.chunks) &&
      Array.isArray(report.honoRemoval.lazyChunks) &&
      Array.isArray(report.honoRemoval.units),
    "incomplete Kit retirement report",
  );
  return report;
}

const moduleFile = (id) => id.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
const sourcePath = (file) => (isAbsolute(file) ? relative(root, file) : undefined);
const kitSource = (id) => {
  if (id.startsWith("\0")) return;
  const source = sourcePath(moduleFile(id));
  return source?.startsWith("web/src/") ? source : undefined;
};

function honoDependency(id) {
  const file = moduleFile(id);
  const dependency = file.split(/(?:^|\/)node_modules\//).at(-1);
  if (/^hono(?:\/|$)/.test(dependency)) return dependency;
  const source = sourcePath(file);
  if (legacySeams.has(source)) return source;
}

function addToSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function removalUnits(rows) {
  const bySource = new Map();
  const units = new Map();
  for (const row of rows) {
    if (
      row.kind === "middleware" ||
      typeof row.target !== "string" ||
      !routeTarget.test(row.target)
    ) {
      continue;
    }
    const { target, family = null, slice = null, owner = null } = row;
    if (!units.has(target)) units.set(target, { target, registrations: [] });
    units.get(target).registrations.push({ route: routeKey(row), family, slice, owner });
    bySource.set(target, target);
    if (target.endsWith("/+page.svelte")) {
      bySource.set(target.replace(/\.svelte$/, ".server.ts"), target);
    }
  }
  units.set(fallbackTarget, { target: fallbackTarget, slice: "API-10", registrations: [] });
  for (const source of fallbackSources) bySource.set(source, fallbackTarget);
  return { bySource, units };
}

function entrypointOwners(id, importers, bySource) {
  const units = new Set();
  const unownedImporters = new Set();
  const pending = new Set([id]);
  // Visiting each module once also handles cycles between shared helpers.
  for (const current of pending) {
    const source = kitSource(current);
    const unit = bySource.get(source);
    if (unit) {
      units.add(unit);
      continue;
    }
    const parents = [...(importers.get(current) ?? [])];
    if (!parents.length || parents.some((parent) => !kitSource(parent))) {
      unownedImporters.add(source);
    }
    for (const parent of parents) if (kitSource(parent)) pending.add(parent);
  }
  if (!units.size && !unownedImporters.size) unownedImporters.add(kitSource(id));
  return { units, unownedImporters };
}

function traceKitEntrypoints(origins, importers) {
  const entrypoints = new Set();
  const pending = new Set(origins);
  let unowned = false;
  for (const id of pending) {
    if (kitSource(id)) {
      entrypoints.add(id);
      continue;
    }
    const parents = importers.get(id);
    if (!parents?.size) unowned = true;
    for (const parent of parents ?? []) pending.add(parent);
  }
  return { entrypoints, unowned: unowned || !entrypoints.size };
}

function describeEntrypoints(ids, importers, rows) {
  const { bySource, units } = removalUnits(rows);
  const entrypoints = new Map();
  const usedUnits = new Set();
  for (const id of ids) {
    const source = kitSource(id);
    if (!entrypoints.has(source)) {
      entrypoints.set(source, { targets: new Set(), unownedImporters: new Set() });
    }
    const entry = entrypoints.get(source);
    const owners = entrypointOwners(id, importers, bySource);
    for (const target of owners.units) {
      entry.targets.add(target);
      usedUnits.add(target);
    }
    for (const importer of owners.unownedImporters) entry.unownedImporters.add(importer);
  }
  return {
    entrypoints: [...entrypoints.keys()].sort().map((source) => {
      const { targets, unownedImporters } = entrypoints.get(source);
      return {
        source,
        targets: [...targets].sort(),
        unownedImporters: [...unownedImporters].sort(),
      };
    }),
    units: [...usedUnits].sort().map((target) => units.get(target)),
  };
}

function inspectLazyChunks(chunksByFile, dependencyChunks) {
  const dynamicImporters = new Map();
  for (const chunk of chunksByFile.values()) {
    for (const file of chunk.dynamicImports) {
      if (chunksByFile.has(file)) addToSet(dynamicImporters, file, chunk.fileName);
    }
  }
  const filesWithDependencies = new Set(dependencyChunks.map(({ file }) => file));
  const lazyChunks = [];
  for (const file of [...dynamicImporters.keys()].sort()) {
    const reachable = new Set([file]);
    for (const current of reachable) {
      for (const imported of chunksByFile.get(current).imports) {
        if (chunksByFile.has(imported)) reachable.add(imported);
      }
    }
    const dependencyFiles = [...reachable].filter((name) => filesWithDependencies.has(name)).sort();
    if (dependencyFiles.length) {
      lazyChunks.push({ file, importers: [...dynamicImporters.get(file)].sort(), dependencyFiles });
    }
  }
  return lazyChunks;
}

/** @param {import("vite").Rollup.OutputBundle} bundle */
export function inspectSsrBundle(bundle, getModuleInfo, rows) {
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  assert.ok(
    chunks.some((chunk) => chunk.isEntry),
    "missing Kit SSR entry chunks",
  );
  const moduleIds = new Set(chunks.flatMap((chunk) => Object.keys(chunk.modules)));
  assert.ok(moduleIds.size, "empty Kit SSR module graph");
  const importers = new Map();
  for (const id of moduleIds) {
    const info = getModuleInfo(id);
    for (const dependency of [
      ...(info?.importedIds ?? []),
      ...(info?.dynamicallyImportedIds ?? []),
    ]) {
      addToSet(importers, dependency, id);
    }
  }

  const entrypointIds = new Set();
  const dependencyNames = new Set();
  const dependencyChunks = [];
  const chunksByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  for (const chunk of chunks) {
    const emitted = new Set(Object.keys(chunk.modules));
    const findings = new Map();
    for (const id of [...emitted, ...chunk.imports, ...chunk.dynamicImports]) {
      const dependency = honoDependency(id);
      if (dependency) addToSet(findings, dependency, id);
    }
    if (!findings.size) continue;

    const dependencies = [];
    for (const dependency of [...findings.keys()].sort()) {
      dependencyNames.add(dependency);
      const sources = new Set();
      let unowned = false;
      for (const id of findings.get(dependency)) {
        // An external import belongs to this output chunk. Use only its own
        // emitted modules as evidence for the direct import edge.
        const origins = emitted.has(id)
          ? [id]
          : [...(importers.get(id) ?? [])].filter((parent) => emitted.has(parent));
        const trace = traceKitEntrypoints(origins, importers);
        unowned ||= trace.unowned;
        for (const current of trace.entrypoints) {
          entrypointIds.add(current);
          sources.add(kitSource(current));
        }
      }
      dependencies.push({ dependency, entrypoints: [...sources].sort(), unowned });
    }
    dependencyChunks.push({ file: chunk.fileName, dependencies });
  }

  return {
    honoDependencies: [...dependencyNames].sort(),
    honoRemoval: {
      ...describeEntrypoints(entrypointIds, importers, rows),
      chunks: dependencyChunks.sort((a, b) => a.file.localeCompare(b.file)),
      lazyChunks: inspectLazyChunks(chunksByFile, dependencyChunks),
    },
  };
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

function groupUnownedRoutes(unowned, rows) {
  const registrations = new Map(rows.map((row) => [routeKey(row), row]));
  const families = Object.groupBy(
    unowned,
    ({ route }) => registrations.get(route).family ?? "unresolved",
  );
  return Object.fromEntries(
    Object.entries(families).map(([family, blockers]) => [
      family,
      Object.groupBy(blockers, ({ route }) => registrations.get(route).method),
    ]),
  );
}

// Read the exact build's SSR graph and Kit's analyzed route methods.
export function kitRetirementBuild(adapter, mode, load = loadInventory) {
  if (mode === undefined) return;
  assert.ok(mode === "report" || mode === "strict", "invalid KIT_RETIREMENT_GUARD mode");

  let evidence;
  /** @type {import("vite").Plugin} */
  const plugin = {
    name: "two-kit-retirement-guard",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "ssr",
    generateBundle(_options, bundle) {
      const { inventory, rows } = load();
      evidence = {
        inventory,
        rows,
        ...inspectSsrBundle(bundle, (id) => this.getModuleInfo(id), rows),
      };
    },
  };

  return {
    plugin,
    /** @type {import("@sveltejs/kit").Adapter} */
    adapter: {
      ...adapter,
      adapt(builder) {
        assert.ok(evidence, "missing Kit SSR dependency evidence");
        const { inventory, rows, honoDependencies, honoRemoval } = evidence;
        const { checked, unowned } = inspectRoutes(builder.routes, inventory, rows);
        const ready = honoDependencies.length === 0 && unowned.length === 0;
        const unownedByFamily = groupUnownedRoutes(unowned, rows);
        const report = {
          mode,
          ready,
          checked,
          honoDependencies,
          unowned,
          unownedByFamily,
          honoRemoval,
        };
        console.log(reportPrefix + JSON.stringify(report));
        assert.ok(mode === "report" || ready, "Kit retirement guard found blockers");
        return adapter.adapt(builder);
      },
    },
  };
}
