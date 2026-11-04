import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
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
    version: 1,
    nodeCount: 4,
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
  return { root, put, manifest, evidence, budget, save, saveBudget };
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
      assert.equal(checkRoutes(f.root).exitCode, 1);
    });
}

const invalid = {
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

test("headroom uses 25% and ceil-to-step boundaries", () => {
  assert.equal(targetBytes(4096, 512), 5120);
  assert.equal(targetBytes(4097, 512), 5632);
  assert.equal(targetBytes(1024, 256), 1280);
  assert.equal(targetBytes(1025, 256), 1536);
  assert.equal(targetBytes(0, 512), 0);
});
