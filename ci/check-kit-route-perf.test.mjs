import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { INITIAL_CLIENT_BUDGET } from "./client-ratchet-approval.mjs";
import { measure as measureKit } from "./check-kit-perf.mjs";
import { CLIENT_FILES, measuredDecision, propose } from "./kit-client-ratchet.mjs";
import {
  checkRoutes,
  measureRoutes,
  OUTPUT,
  ROUTE_BUDGET,
  ROUTE_SCOPE,
  targetBytes,
} from "./check-kit-route-perf.mjs";

const node = (n) => `.svelte-kit/generated/build/client-optimized/nodes/${n}.js`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "route-perf-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (p, v) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), typeof v === "string" ? v : JSON.stringify(v));
  };
  const manifest = {
    start: {
      file: "_app/immutable/start.js",
      name: "entry/start",
      isEntry: true,
      dynamicImports: ["runtime"],
    },
    runtime: { file: "_app/immutable/runtime.js", imports: ["shared"] },
    app: {
      file: "_app/immutable/app.js",
      name: "entry/app",
      isEntry: true,
      dynamicImports: [node(0), node(1), node(2), node(3), "error"],
    },
    [node(0)]: {
      file: "_app/immutable/layout.js",
      isEntry: true,
      imports: ["shared"],
      css: ["_app/immutable/layout.css"],
    },
    [node(1)]: { file: "_app/immutable/error.js", isEntry: true },
    [node(2)]: {
      file: "_app/immutable/home.js",
      isEntry: true,
      imports: ["shared"],
      dynamicImports: ["lazy"],
      css: ["_app/immutable/home.css"],
    },
    [node(3)]: { file: "_app/immutable/about.js", isEntry: true, imports: ["shared"] },
    shared: { file: "_app/immutable/shared.js", imports: ["runtime"] }, // cycle, counted once
    lazy: { file: "_app/immutable/lazy.js", imports: ["shared"], css: ["_app/immutable/lazy.css"] },
    error: { file: "_app/immutable/error-template.js" },
  };
  const evidence = {
    version: 2,
    nodeCount: 4,
    unusedNodes: [],
    bootstrap: [manifest.start.file, manifest.app.file],
    stylesheets: [],
    routes: [
      { id: "/", page: { layouts: [0, null], errors: [1], leaf: 2 } },
      { id: "/about", page: { layouts: [0], errors: [1], leaf: 3 } },
      { id: "/api", page: null },
    ],
  };
  put("web/src/routes/+page.svelte", "page");
  put("web/src/routes/about/+page.svelte", "page");
  put("web/src/routes/api/+server.ts", "endpoint");
  for (const chunk of Object.values(manifest))
    for (const file of [chunk.file, ...(chunk.css ?? [])])
      put(`${OUTPUT}/client/${file}`, file.repeat(5));
  put(`${OUTPUT}/server/manifest-full.js`, "never execute this file");
  const save = () => {
    put(`${OUTPUT}/client/.vite/manifest.json`, manifest);
    evidence.viteSha256 = hash(readFileSync(join(root, OUTPUT, "client/.vite/manifest.json")));
    evidence.serverSha256 = hash(readFileSync(join(root, OUTPUT, "server/manifest-full.js")));
    put(`${OUTPUT}/client-route-evidence.json`, evidence);
  };
  save();
  const budget = { version: 1, scope: ROUTE_SCOPE, routes: {} };
  for (const [id, route] of Object.entries(measureRoutes(root).routes)) {
    budget.routes[id] = {};
    for (const kind of ["js", "css"]) {
      const v = route[kind];
      budget.routes[id][kind] = {
        maxRawBytes: v.rawBytes,
        maxGzipBytes: v.gzipBytes,
        maxFiles: v.files,
      };
    }
  }
  const saveBudget = () => put(ROUTE_BUDGET, budget);
  saveBudget();
  const approveBudget = () =>
    put(
      "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md",
      `## Initial approved route plan\n\n\`\`\`json\n${JSON.stringify(budget)}\n\`\`\`\n`,
    );
  approveBudget();
  return { root, put, manifest, evidence, budget, save, saveBudget, approveBudget };
}

test("route cost includes bootstrap/static/dynamic/shared/errors/CSS once, not all navigation leaves", (t) => {
  const { root } = fixture(t);
  const report = checkRoutes(root);
  assert.equal(report.exitCode, 0);
  const home = report.routes["/"];
  assert.equal(home.js.files, 9);
  assert.equal(home.css.files, 3);
  assert.ok(home.js.assets.includes("_app/immutable/lazy.js"));
  assert.ok(home.js.assets.includes("_app/immutable/runtime.js"));
  assert.ok(home.js.assets.includes("_app/immutable/error.js"));
  assert.ok(!home.js.assets.includes("_app/immutable/about.js"));
  assert.ok(!report.routes["/about"].js.assets.includes("_app/immutable/lazy.js"));
  assert.equal(
    home.js.rawBytes,
    home.js.assets.reduce((s, p) => s + readFileSync(join(root, OUTPUT, "client", p)).length, 0),
  );
  assert.equal(
    home.js.gzipBytes,
    home.js.assets.reduce(
      (s, p) => s + gzipSync(readFileSync(join(root, OUTPUT, "client", p))).length,
      0,
    ),
  );
  assert.deepEqual(report.routes["/api"].js, { rawBytes: 0, gzipBytes: 0, files: 0, assets: [] });
  assert.deepEqual(measureRoutes(root), measureRoutes(root));
});

for (const kind of ["js", "css"])
  test(`non-immutable ${kind} is included in aggregate ratchets and passes the shipping gate`, (t) => {
    const f = fixture(t);
    const before = checkRoutes(f.root);
    const asset = `_app/runtime/extra.${kind}`;
    const bytes = Array.from({ length: kind === "js" ? 128 : 16 }, (_, i) => hash(String(i))).join(
      "",
    );
    f.put(`${OUTPUT}/client/${asset}`, bytes);
    const measurement = checkRoutes(f.root);
    assert.equal(measurement.exitCode, 0);
    // The graph-backed route scope stays immutable-only; aggregate scope is all _app JS/CSS.
    assert.deepEqual(measurement.routes, before.routes);
    const value = measurement.aggregate[kind];
    assert.equal(value.rawBytes, before.aggregate[kind].rawBytes + Buffer.byteLength(bytes));
    assert.equal(value.gzipBytes, before.aggregate[kind].gzipBytes + gzipSync(bytes).length);
    assert.equal(value.files, before.aggregate[kind].files + 1);
    assert.ok(value.assets.includes(asset));
    const base = {
      [CLIENT_FILES[0]]: { $comment: "fixture", client: { js: INITIAL_CLIENT_BUDGET.js } },
      [CLIENT_FILES[1]]: { $comment: "fixture", client: { css: INITIAL_CLIENT_BUDGET.css } },
      [ROUTE_BUDGET]: f.budget,
    };
    const report = { version: 1, sha: "a".repeat(40), measurement };
    const result = propose(report, base);
    assert.ok(result.changes.some((change) => change.id === "aggregate" && change.kind === kind));
    // Apply the actual generated fragments, not independently reconstructed ceilings.
    for (const path of CLIENT_FILES) f.put(path, result.files[path]);
    f.put("ci/budgets/kit/worker.json", {
      worker: { "_worker.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } },
    });
    f.put("ci/budgets/kit/server.json", {
      server: { js: { maxRawBytes: 4096, maxGzipBytes: 4096, maxFiles: 5 } },
    });
    f.put("ci/budgets/kit/startup.json", { startup: { maxMs: 30000 } });
    f.put("web/.svelte-kit/cloudflare/_worker.js", "worker");
    const shipping = measureKit(f.root);
    assert.equal(shipping.code, 0, JSON.stringify(shipping));
    for (const k of ["js", "css"]) {
      const enforced = shipping.groups.find((group) => group.id === `kit.client.${k}`).checks[0];
      for (const metric of ["rawBytes", "gzipBytes", "files"])
        assert.equal(measurement.aggregate[k][metric], enforced[metric]);
      assert.equal(
        result.files[CLIENT_FILES[k === "js" ? 0 : 1]].client[k].maxFiles,
        INITIAL_CLIENT_BUDGET[k].maxFiles,
      );
    }
  });

for (const [metric, field] of [
  ["raw", "maxRawBytes"],
  ["gzip", "maxGzipBytes"],
  ["count", "maxFiles"],
]) {
  for (const kind of ["js", "css"])
    test(`${kind} ${metric} breach is hard`, (t) => {
      const f = fixture(t);
      f.budget.routes["/"][kind][field] -= 1;
      f.saveBudget();
      f.approveBudget(); // Test the measured breach, not an unsupported policy edit.
      assert.equal(checkRoutes(f.root).exitCode, 1);
    });
}

for (const kind of ["js", "css"])
  for (const metric of ["maxRawBytes", "maxGzipBytes", "maxFiles"])
    for (const delta of [-1, 1])
      test(`unsupported ${kind} ${metric} change (${delta}) refuses route enforcement`, (t) => {
        const f = fixture(t);
        assert.equal(checkRoutes(f.root).exitCode, 0);
        f.budget.routes["/"][kind][metric] += delta;
        f.saveBudget();
        const result = checkRoutes(f.root);
        assert.equal(result.exitCode, 2);
        assert.match(result.error, /approved route plan/);
      });

for (const kind of ["js", "css"])
  for (const metric of ["maxRawBytes", "maxGzipBytes", "maxFiles"])
    test(`a live ${kind} ${metric} edit after a legitimate route-only decrease fails closed`, (t) => {
      const f = fixture(t);
      for (const route of Object.values(f.budget.routes))
        for (const k of ["js", "css"]) {
          route[k].maxRawBytes += 8192;
          route[k].maxGzipBytes += 4096;
        }
      f.approveBudget();
      f.saveBudget();
      const base = {
        [CLIENT_FILES[0]]: { $comment: "fixture", client: { js: INITIAL_CLIENT_BUDGET.js } },
        [CLIENT_FILES[1]]: { $comment: "fixture", client: { css: INITIAL_CLIENT_BUDGET.css } },
        [ROUTE_BUDGET]: f.budget,
      };
      const measurement = checkRoutes(f.root);
      assert.equal(measurement.exitCode, 0);
      for (const k of ["js", "css"]) {
        measurement.aggregate[k].rawBytes = INITIAL_CLIENT_BUDGET[k].maxRawBytes;
        measurement.aggregate[k].gzipBytes = INITIAL_CLIENT_BUDGET[k].maxGzipBytes;
      }
      const report = { version: 1, sha: "a".repeat(40), measurement };
      const result = propose(report, base);
      assert.ok(result.changes.length > 0);
      assert.ok(result.changes.every((change) => change.id !== "aggregate"));
      f.put(
        "ci/budgets/decisions/kit-perf/auto-client-ratchet-aaaaaaaaaaaa.md",
        measuredDecision(report, base, result),
      );
      f.put(ROUTE_BUDGET, result.files[ROUTE_BUDGET]);
      assert.equal(checkRoutes(f.root).exitCode, 0);
      const ceiling = result.files[ROUTE_BUDGET].routes["/"][kind];
      ceiling[metric] += metric === "maxRawBytes" ? 512 : metric === "maxGzipBytes" ? 256 : 1;
      assert.ok(
        ceiling[metric] <= base[ROUTE_BUDGET].routes["/"][kind][metric] || metric === "maxFiles",
      );
      f.put(ROUTE_BUDGET, result.files[ROUTE_BUDGET]);
      const rejected = checkRoutes(f.root);
      assert.equal(rejected.exitCode, 2);
      assert.match(rejected.error, /approved route plan/);
    });

test("new source, built and live-budget route still requires explicit admission", (t) => {
  const f = fixture(t);
  f.put("web/src/routes/new/+page.svelte", "new");
  f.evidence.routes.push({ id: "/new", page: f.evidence.routes[0].page });
  f.budget.routes["/new"] = f.budget.routes["/"];
  f.save();
  f.saveBudget();
  const result = checkRoutes(f.root);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /approved route plan/);
});

test("missing initial approved route evidence fails closed", (t) => {
  const f = fixture(t);
  rmSync(
    join(f.root, "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md"),
  );
  assert.equal(checkRoutes(f.root).exitCode, 2);
});

const invalid = {
  "malformed initial plan": (f) =>
    f.put(
      "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md",
      "no evidence",
    ),
  "ambiguous initial plan": (f) => {
    const path = "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md";
    const text = readFileSync(join(f.root, path), "utf8");
    f.put(path, text + text);
  },
  "symlink initial plan": (f) => {
    const path = join(
      f.root,
      "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md",
    );
    rmSync(path);
    symlinkSync(join(f.root, ROUTE_BUDGET), path);
  },
  "unproven decision": (f) =>
    f.put("ci/budgets/decisions/kit-perf/auto-client-ratchet-aaaaaaaaaaaa.md", "no evidence"),
  "new source route": (f) => f.put("web/src/routes/new/+page.svelte", "new"),
  "new server-only page route": (f) => f.put("web/src/routes/new/+page.server.ts", "new"),
  "new layout-reset page route": (f) => f.put("web/src/routes/new/+page@.svelte", "new"),
  "huge node count": (f) => {
    f.evidence.nodeCount = Number.MAX_SAFE_INTEGER;
    f.save();
  },
  "new built route without source": (f) => {
    f.evidence.routes.push({ id: "/new", page: f.evidence.routes[0].page });
    f.save();
  },
  "new unbudgeted route": (f) => {
    delete f.budget.routes["/about"];
    f.saveBudget();
  },
  "stale budget route": (f) => {
    f.budget.routes["/gone"] = f.budget.routes["/"];
    f.saveBudget();
  },
  "empty budget": (f) => {
    f.budget.routes = {};
    f.saveBudget();
  },
  "unknown ceiling": (f) => {
    f.budget.routes["/"].js.extra = 1;
    f.saveBudget();
  },
  "invalid number": (f) => {
    f.budget.routes["/"].js.maxRawBytes = -1;
    f.saveBudget();
  },
  "missing budget": (f) => rmSync(join(f.root, ROUTE_BUDGET)),
  "malformed manifest": (f) => f.put(`${OUTPUT}/client/.vite/manifest.json`, "{"),
  "empty manifest": (f) => {
    for (const k of Object.keys(f.manifest)) delete f.manifest[k];
    f.save();
  },
  "missing evidence": (f) => rmSync(join(f.root, OUTPUT, "client-route-evidence.json")),
  "missing server manifest": (f) => rmSync(join(f.root, OUTPUT, "server/manifest-full.js")),
  "stale hash": (f) => f.put(`${OUTPUT}/server/manifest-full.js`, "changed"),
  "untracked physical asset": (f) => f.put(`${OUTPUT}/client/_app/immutable/orphan.js`, "new"),
  "missing emitted asset": (f) => rmSync(join(f.root, OUTPUT, "client/_app/immutable/shared.js")),
  "orphan manifest asset": (f) => {
    f.manifest.orphan = { file: "_app/immutable/orphan.js" };
    f.put(`${OUTPUT}/client/_app/immutable/orphan.js`, "new");
    f.save();
  },
  "unknown dependency": (f) => {
    f.manifest.shared.imports = ["absent"];
    f.save();
  },
  "malformed dependency list": (f) => {
    f.manifest.shared.imports = "runtime";
    f.save();
  },
  "missing dispatcher node": (f) => {
    f.manifest.app.dynamicImports.pop();
    f.manifest.app.dynamicImports.pop();
    f.save();
  },
  "missing unused node inventory": (f) => {
    delete f.evidence.unusedNodes;
    f.save();
  },
  "invalid unused node": (f) => {
    f.evidence.unusedNodes = [99];
    f.save();
  },
  "duplicate unused node": (f) => {
    f.evidence.unusedNodes = [3, 3];
    f.save();
  },
  "route node labeled unused": (f) => {
    f.evidence.unusedNodes = [2];
    f.save();
  },
  "old evidence version": (f) => {
    f.evidence.version = 1;
    f.save();
  },
  "new missing node": (f) => {
    f.evidence.nodeCount += 1;
    f.save();
  },
  "invalid route node": (f) => {
    f.evidence.routes[0].page.leaf = 50;
    f.save();
  },
  "page replaced with endpoint": (f) => {
    f.evidence.routes[0].page = null;
    f.save();
  },
  "duplicate routes": (f) => {
    f.evidence.routes.push(f.evidence.routes[0]);
    f.save();
  },
  "path traversal": (f) => {
    f.manifest.shared.file = "_app/immutable/../outside.js";
    f.save();
  },
  "duplicate output": (f) => {
    f.manifest.shared.file = f.manifest.lazy.file;
    f.save();
  },
  "symlink asset": (f) => {
    const p = join(f.root, OUTPUT, "client/_app/immutable/shared.js");
    rmSync(p);
    symlinkSync("runtime.js", p);
  },
  "non-immutable symlink asset": (f) => {
    symlinkSync("immutable/shared.js", join(f.root, OUTPUT, "client/_app/env.js"));
  },
  "non-immutable symlink directory": (f) => {
    symlinkSync("immutable", join(f.root, OUTPUT, "client/_app/runtime"));
  },
  "symlink evidence": (f) => {
    const p = join(f.root, OUTPUT, "client-route-evidence.json");
    rmSync(p);
    symlinkSync("server/manifest-full.js", p);
  },
};
for (const [name, mutate] of Object.entries(invalid))
  test(`${name} cannot enforce, never passes`, (t) => {
    const f = fixture(t);
    mutate(f);
    assert.equal(checkRoutes(f.root).exitCode, 2);
  });

test("real Kit layout-reset output maps compact server nodes without dropping unused emissions", (t) => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "route-reset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (p, text) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  put("package.json", '{"type":"module","private":true}');
  mkdirSync(join(root, "web"));
  symlinkSync(
    new URL("../web/node_modules", import.meta.url).pathname,
    join(root, "web/node_modules"),
  );
  put(
    "web/vite.config.js",
    `import { sveltekit } from '@sveltejs/kit/vite'; export default { plugins: [sveltekit()] };`,
  );
  put(
    "web/src/app.html",
    "<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>",
  );
  put(
    "web/src/routes/+layout.svelte",
    "<script>let {children}=$props();</script>{@render children()}",
  );
  put("web/src/routes/+page.svelte", "<h1>Home</h1>");
  put(
    "web/src/routes/a/+layout.svelte",
    "<script>let {children}=$props();</script><aside>Unused</aside>{@render children()}",
  );
  put("web/src/routes/a/+page@.svelte", "<h1>Reset</h1>");
  const build = spawnSync(
    process.execPath,
    [join(root, "web/node_modules/vite/bin/vite.js"), "build"],
    {
      cwd: join(root, "web"),
      encoding: "utf8",
      timeout: 90000,
    },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  put(
    "ci/kit-route-evidence.mjs",
    readFileSync(new URL("./kit-route-evidence.mjs", import.meta.url)),
  );
  const generated = spawnSync(process.execPath, [join(root, "ci/kit-route-evidence.mjs")], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(generated.status, 0, generated.stderr);
  const report = measureRoutes(root);
  const manifest = JSON.parse(readFileSync(join(root, OUTPUT, "client/.vite/manifest.json")));
  const evidence = JSON.parse(readFileSync(join(root, OUTPUT, "client-route-evidence.json")));
  const emitted = Object.keys(manifest).filter((key) =>
    /client-optimized\/nodes\/\d+\.js$/.test(key),
  );
  assert.equal(emitted.length, 5);
  assert.equal(evidence.routes.find((r) => r.id === "/a").page.leaf, 4);
  assert.deepEqual(evidence.unusedNodes, [2]);
  assert.equal(evidence.routes.find((r) => r.id === "/").page.leaf, 3);
  for (const id of ["/", "/a"]) {
    assert.ok(report.routes[id].js.assets.includes(manifest[node(2)].file));
    assert.equal(
      report.routes[id].js.gzipBytes,
      report.routes[id].js.assets.reduce(
        (sum, file) => sum + gzipSync(readFileSync(join(root, OUTPUT, "client", file))).length,
        0,
      ),
    );
  }
  assert.ok(report.routes["/a"].js.assets.includes(manifest[node(4)].file));
  assert.ok(!report.routes["/"].js.assets.includes(manifest[node(4)].file));
  assert.equal(report.aggregate.js.files, Object.values(manifest).length);
  const evidencePath = `${OUTPUT}/client-route-evidence.json`;
  put(evidencePath, JSON.stringify({ ...evidence, unusedNodes: [] }));
  assert.throws(() => measureRoutes(root), /inventory mismatch/);
  put(evidencePath, JSON.stringify(evidence));
  put(`${OUTPUT}/client/_app/immutable/orphan.js`, "unaccounted");
  assert.throws(() => measureRoutes(root), /inventory mismatch/);
  // A future Kit loader-syntax change must refuse, never guess an index.
  const serverPath = `${OUTPUT}/server/manifest-full.js`;
  const serverText = readFileSync(join(root, serverPath), "utf8");
  assert.ok(serverText.includes("__memo(() => import('./nodes/0.js'))"));
  put(
    serverPath,
    serverText.replace(
      "__memo(() => import('./nodes/0.js'))",
      "__memo(()=>import('./nodes/0.js'))",
    ),
  );
  const unsupported = spawnSync(process.execPath, [join(root, "ci/kit-route-evidence.mjs")], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /unsupported Kit node loader syntax/);
});

test("headroom uses 25% and ceil-to-step boundaries", () => {
  assert.equal(targetBytes(4096, 512), 5120);
  assert.equal(targetBytes(4097, 512), 5632);
  assert.equal(targetBytes(1024, 256), 1280);
  assert.equal(targetBytes(1025, 256), 1536);
  assert.equal(targetBytes(0, 512), 0);
});
