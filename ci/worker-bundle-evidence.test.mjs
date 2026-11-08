import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { parse } from "yaml";
import { createKitRehearsal } from "./kit-upload-rehearsal.mjs";
import {
  SCHEMA,
  createInventory,
  deploymentReceipt,
  packageFinding,
  packageRoot,
  readWranglerOutput,
  sha256,
  uploadReceipt,
  verifyInventory,
} from "./worker-bundle-evidence.mjs";

const DIR = "dist-production";
const SHA = "a".repeat(40);
const VERSION = "11111111-2222-4333-8444-555555555555";
const OTHER_VERSION = "99999999-2222-4333-8444-555555555555";
const context = {
  sourceSha: SHA,
  runId: "123",
  runAttempt: "1",
  target: "two-web-next-production",
  environment: "production",
};

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const readMeta = (root) => JSON.parse(readFileSync(join(root, DIR, "bundle-meta.json"), "utf8"));
function writeMeta(root, meta) {
  put(root, `${DIR}/bundle-meta.json`, JSON.stringify(meta));
}

function fixture({ imports = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bundle-evidence-"));
  roots.push(root);
  const files = {
    "src/index.ts": "export default {};\n",
    "node_modules/hono/dist/index.js": "export const hono = 1;\n",
    "node_modules/hono/package.json": JSON.stringify({ name: "hono", version: "4.1.0" }),
    "node_modules/@scope/pkg/lib/a.js": "export const a = 1;\n",
    "node_modules/@scope/pkg/package.json": JSON.stringify({
      name: "@scope/pkg",
      version: "2.0.0",
    }),
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js": "export const dep = 1;\n",
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json": JSON.stringify({
      name: "dep",
      version: "1.0.0",
    }),
    "node_modules/shaken/index.js": "export const unused = 1;\n",
    "node_modules/shaken/package.json": JSON.stringify({ name: "shaken", version: "0.0.1" }),
    "node_modules/wrangler/package.json": JSON.stringify({
      name: "wrangler",
      version: "4.0.0",
      dependencies: { esbuild: "0.25.0" },
    }),
    "node_modules/esbuild/package.json": JSON.stringify({ name: "esbuild", version: "0.25.0" }),
    "package-lock.json": '{"lockfileVersion":3}\n',
    "wrangler.jsonc": '{"name":"two-web-next"}\n',
    [`${DIR}/worker.js`]: "console.log('worker');\n",
    [`${DIR}/worker.js.map`]: '{"version":3}\n',
  };
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  const size = (path) => Buffer.byteLength(files[path]);
  const inputPaths = [
    "src/index.ts",
    "node_modules/hono/dist/index.js",
    "node_modules/@scope/pkg/lib/a.js",
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js",
    "node_modules/shaken/index.js",
  ];
  const meta = {
    inputs: Object.fromEntries(
      inputPaths.map((path) => [path, { bytes: size(path), imports: [] }]),
    ),
    outputs: {
      [`${DIR}/worker.js`]: {
        bytes: size(`${DIR}/worker.js`),
        imports,
        // node_modules/shaken is fully tree-shaken: in inputs, absent here.
        inputs: Object.fromEntries(
          inputPaths.slice(0, 4).map((path, i) => [path, { bytesInOutput: 10 + i }]),
        ),
      },
      [`${DIR}/worker.js.map`]: { bytes: size(`${DIR}/worker.js.map`), imports: [], inputs: {} },
    },
  };
  writeMeta(root, meta);
  return root;
}

describe("production Kit build-only rehearsal receipt", () => {
  function kitFixture() {
    const root = fixture();
    for (const path of [
      "web/wrangler.production.jsonc",
      "web/worker.js",
      "web/_headers",
      "web/package-lock.json",
      "web/.svelte-kit/cloudflare/_worker.js",
      "web/.svelte-kit/cloudflare/_headers",
      "web/.svelte-kit/cloudflare/_routes.json",
      "web/.svelte-kit/cloudflare/_app/version.json",
      "web/.svelte-kit/cloudflare/_app/immutable/chunks/a.js",
    ])
      put(root, path, `fixture ${path}\n`);
    put(root, "replay/worker.js", readFileSync(join(root, DIR, "worker.js")));
    return root;
  }

  const receipt = (root, ctx = context) =>
    createKitRehearsal(root, join(root, DIR), join(root, "replay"), ctx);

  test("binds every build file and config to the exact run without claiming upload", () => {
    const root = kitFixture();
    put(root, "web/.svelte-kit/cloudflare/.assetsignore", "_worker.js\n");
    const first = receipt(root);
    assert.deepEqual(receipt(root), first);
    assert.equal(first.schema, "two.kit-upload-rehearsal.v1");
    assert.equal(first.evidence, "build-and-upload-rehearsal-only");
    assert.equal(first.sourceSha, SHA);
    assert.equal(first.runId, "123");
    assert.equal(first.runAttempt, "1");
    assert.equal(first.sameWorkerBytes, true);
    assert.equal(first.workerSha256, sha256("console.log('worker');\n"));
    assert.equal(first.versionId, undefined);
    assert.equal(first.absenceEligible, undefined);
    assert.ok(first.trees.assets.some((item) => item.path === ".assetsignore"));
    assert.ok(first.trees.assets.some((item) => item.path === "_worker.js"));
    assert.equal(first.inputs.length, 5);
    assert.equal(first.treeSha256, sha256(JSON.stringify(first.trees)));
    put(root, "web/.svelte-kit/cloudflare/new-static.txt", "new");
    assert.notEqual(receipt(root).treeSha256, first.treeSha256);
    put(root, "web/package-lock.json", "changed");
    assert.notDeepEqual(receipt(root).inputs, first.inputs);
  });

  test("does not require Pages-only route metadata on a Workers build", () => {
    const root = kitFixture();
    rmSync(join(root, "web/.svelte-kit/cloudflare/_routes.json"));
    assert.equal(receipt(root).sameWorkerBytes, true);
  });

  test("rejects changed or missing replay Worker bytes", () => {
    const root = kitFixture();
    put(root, "replay/worker.js", "different");
    assert.throws(() => receipt(root), /changed Worker bytes/);
    rmSync(join(root, "replay/worker.js"));
    put(root, "replay/README.md", "not a worker");
    assert.throws(() => receipt(root), /changed Worker bytes/);
  });

  test("rejects empty Worker, absent metafile and incomplete assets", () => {
    const root = kitFixture();
    put(root, `${DIR}/worker.js`, "");
    assert.throws(() => receipt(root), /Worker missing or empty/);
    put(root, `${DIR}/worker.js`, readFileSync(join(root, "replay/worker.js")));
    rmSync(join(root, DIR, "bundle-meta.json"));
    assert.throws(() => receipt(root), /metafile missing/);
    put(root, `${DIR}/bundle-meta.json`, "{}");
    rmSync(join(root, "web/.svelte-kit/cloudflare/_headers"));
    assert.throws(() => receipt(root), /missing Kit build file/);
    put(root, "web/.svelte-kit/cloudflare/_headers", "headers");
    rmSync(join(root, "web/.svelte-kit/cloudflare/_app/immutable"), { recursive: true });
    assert.throws(() => receipt(root), /immutable assets missing/);
  });

  test("rejects symlinked asset files and directories instead of omitting them", () => {
    const root = kitFixture();
    const link = join(root, "web/.svelte-kit/cloudflare/link");
    symlinkSync(join(root, DIR, "worker.js"), link);
    assert.throws(() => receipt(root), /regular file/);
    rmSync(link);
    symlinkSync(join(root, DIR), link, "dir");
    assert.throws(() => receipt(root), /regular file/);
  });

  test("Actions generates and retains the receipt and complete adapter tree", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    assert.ok(workflow.includes("node ci/kit-upload-rehearsal.mjs"));
    assert.ok(workflow.includes("artifacts/kit-upload-rehearsal/receipt.json"));
    const archive = workflow.slice(
      workflow.indexOf("      - name: Production Kit bundle build evidence"),
      workflow.indexOf("      - name: Production Kit fatal-response boundary"),
    );
    assert.ok(archive.includes("artifacts/kit-upload-rehearsal/"));
    assert.ok(archive.includes("web/.svelte-kit/cloudflare/"));
    assert.ok(archive.includes("include-hidden-files: true"));
  });

  test("rejects malformed build identity", () => {
    const root = kitFixture();
    for (const change of [{ sourceSha: "main" }, { runId: "0" }, { runAttempt: "" }]) {
      assert.throws(() => receipt(root, { ...context, ...change }), /required/);
    }
  });
});

function saved(root, ctx = context) {
  const inventory = createInventory(root, DIR, ctx);
  put(root, `${DIR}/inventory.json`, `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}

describe("createInventory and verifyInventory", () => {
  test("creates a deterministic inventory and verifies it", () => {
    const root = fixture();
    const first = createInventory(root, DIR, context);
    assert.deepEqual(createInventory(root, DIR, context), first);
    assert.equal(first.schema, SCHEMA);
    assert.equal(first.evidence, "build-only");
    assert.equal(first.sourceSha, SHA);
    assert.equal(first.bundle.sha256, sha256("console.log('worker');\n"));
    assert.equal(first.bundle.entry, "worker.js");
    assert.deepEqual(
      first.outputs.map((o) => o.path),
      ["worker.js", "worker.js.map"],
    );
    assert.equal(first.tools.esbuild, "0.25.0");
    assert.equal(first.tools.wrangler, "4.0.0");
    assert.equal(first.build.config.sha256, sha256('{"name":"two-web-next"}\n'));
    assert.equal(first.build.lockfile.sha256, sha256('{"lockfileVersion":3}\n'));
    assert.deepEqual(
      first.inputs.map((i) => i.path),
      [...first.inputs.map((i) => i.path)].sort((a, b) => a.localeCompare(b)),
    );

    saved(root);
    const raw = readFileSync(join(root, DIR, "inventory.json"), "utf8");
    const verified = verifyInventory(root, DIR, context);
    assert.deepEqual(verified.inventory, first);
    assert.equal(verified.inventorySha256, sha256(raw));
  });

  test("records scoped and pnpm package roots with manifest identity and version", () => {
    const inv = createInventory(fixture(), DIR, context);
    const byRoot = Object.fromEntries(inv.packages.map((p) => [p.manifest.path, p]));
    // These versions come from fixture inventory, not installed dependency pins.
    const { version: honoVersion } = byRoot["node_modules/hono/package.json"];
    const { version: scopedVersion } = byRoot["node_modules/@scope/pkg/package.json"];
    assert.equal(honoVersion, "4.1.0");
    assert.equal(byRoot["node_modules/@scope/pkg/package.json"].name, "@scope/pkg");
    assert.equal(scopedVersion, "2.0.0");
    const pnpm = byRoot["node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json"];
    assert.equal(pnpm.name, "dep");
    assert.equal(pnpm.version, "1.0.0");
    assert.equal(pnpm.manifest.sha256, sha256(JSON.stringify({ name: "dep", version: "1.0.0" })));
    const input = inv.inputs.find((i) => i.path === "node_modules/@scope/pkg/lib/a.js");
    assert.equal(input.packageRoot, "node_modules/@scope/pkg");
    assert.equal(inv.inputs.find((i) => i.path === "src/index.ts").packageRoot, null);
  });

  test("packageRoot parses scoped, pnpm and non-package paths", () => {
    assert.equal(packageRoot("src/index.ts"), null);
    assert.deepEqual(packageRoot("node_modules/@a/b/x.js"), {
      name: "@a/b",
      root: "node_modules/@a/b",
    });
    assert.deepEqual(packageRoot("node_modules/.pnpm/x@1/node_modules/x/i.js"), {
      name: "x",
      root: "node_modules/.pnpm/x@1/node_modules/x",
    });
    assert.throws(() => packageRoot("node_modules/Bad Name/x.js"), /invalid package path/);
  });

  test("tree-shaken inputs stay present with zero bytes in output", () => {
    const inv = createInventory(fixture(), DIR, context);
    const shaken = inv.inputs.find((i) => i.path === "node_modules/shaken/index.js");
    assert.equal(shaken.bytesInOutput, 0);
    assert.ok(inv.packages.some((p) => p.name === "shaken"));
    assert.equal(packageFinding(inv, "shaken"), "present");
    assert.equal(packageFinding(inv, "hono"), "present");
  });

  test("absent vitest is eligible and reported absent", () => {
    const inv = createInventory(
      fixture({
        imports: [
          { path: "node:fs", kind: "import-statement", external: true },
          { path: "cloudflare:workers", kind: "import-statement", external: true },
        ],
      }),
      DIR,
      context,
    );
    assert.equal(inv.absenceEligible, true);
    assert.deepEqual(inv.unknownExternals, []);
    assert.deepEqual(inv.externals, ["cloudflare:workers", "node:fs"]);
    assert.equal(packageFinding(inv, "vitest"), "absent-from-runtime-bundle");
  });

  test("an external package makes absence unknown", () => {
    const inv = createInventory(
      fixture({ imports: [{ path: "left-pad", kind: "import-statement", external: true }] }),
      DIR,
      context,
    );
    assert.equal(inv.absenceEligible, false);
    assert.deepEqual(inv.unknownExternals, ["left-pad"]);
    assert.equal(packageFinding(inv, "vitest"), "unknown");
    assert.equal(packageFinding(inv, "hono"), "present");
  });

  test("packageFinding rejects a foreign schema", () => {
    assert.throws(() => packageFinding({ schema: "other", packages: [] }, "x"));
  });

  test("rejects an internal (non-external) output import", () => {
    const root = fixture({ imports: [{ path: "chunk.js", kind: "import-statement" }] });
    assert.throws(() => createInventory(root, DIR, context), /untracked internal output import/);
  });

  describe("stale identity", () => {
    const cases = {
      sourceSha: { sourceSha: "b".repeat(40) },
      runId: { runId: "124" },
      runAttempt: { runAttempt: "2" },
    };
    for (const [name, change] of Object.entries(cases)) {
      test(`verify rejects stale ${name}`, () => {
        const root = fixture();
        saved(root);
        assert.throws(
          () => verifyInventory(root, DIR, { ...context, ...change }),
          /stale or invalid bundle evidence/,
        );
      });
    }

    test("wrong target or environment is rejected", () => {
      const root = fixture();
      saved(root);
      assert.throws(() => verifyInventory(root, DIR, { ...context, target: "other" }));
      assert.throws(() => verifyInventory(root, DIR, { ...context, environment: "staging" }));
      assert.throws(() => createInventory(root, DIR, { ...context, target: "other" }));
    });

    test("malformed identity is rejected", () => {
      const root = fixture();
      assert.throws(
        () => createInventory(root, DIR, { ...context, sourceSha: "abc" }),
        /source SHA required/,
      );
      assert.throws(
        () => createInventory(root, DIR, { ...context, runId: "0" }),
        /run ID required/,
      );
      assert.throws(
        () => createInventory(root, DIR, { ...context, runAttempt: undefined }),
        /run attempt required/,
      );
    });

    test("unsupported saved schema is rejected", () => {
      const root = fixture();
      const inv = saved(root);
      put(
        root,
        `${DIR}/inventory.json`,
        JSON.stringify({ ...inv, schema: "two.worker-bundle-inventory.v0" }),
      );
      assert.throws(() => verifyInventory(root, DIR, context), /unsupported inventory schema/);
    });
  });

  describe("changed or missing evidence", () => {
    const mutations = {
      "changed bundle": (root) => put(root, `${DIR}/worker.js`, "console.log('tampered!');\n"),
      "changed bundle (same size)": (root) =>
        put(root, `${DIR}/worker.js`, "console.log('WORKER');\n"),
      "missing bundle": (root) => rmSync(join(root, DIR, "worker.js")),
      "changed source map": (root) => put(root, `${DIR}/worker.js.map`, '{"version":4}\n'),
      "missing metafile": (root) => rmSync(join(root, DIR, "bundle-meta.json")),
      "changed metafile": (root) => {
        const meta = readMeta(root);
        meta.inputs["src/index.ts"].imports = [{ path: "x" }];
        writeMeta(root, meta);
      },
      "changed source": (root) => put(root, "src/index.ts", "export default { x: 1 };\n"),
      "changed source (same size)": (root) =>
        put(root, "src/index.ts", "export default [];\n\n".slice(0, 19)),
      "missing source": (root) => rmSync(join(root, "src/index.ts")),
      "changed config": (root) => put(root, "wrangler.jsonc", '{"name":"evil-worker"}\n'),
      "missing config": (root) => rmSync(join(root, "wrangler.jsonc")),
      "changed lockfile": (root) => put(root, "package-lock.json", '{"lockfileVersion":2}\n'),
      "missing lockfile": (root) => rmSync(join(root, "package-lock.json")),
      "changed package manifest": (root) =>
        put(
          root,
          "node_modules/hono/package.json",
          JSON.stringify({ name: "hono", version: "4.9.9" }),
        ),
      "missing package manifest": (root) => rmSync(join(root, "node_modules/hono/package.json")),
      "missing inventory": (root) => rmSync(join(root, DIR, "inventory.json")),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      test(`verify fails on ${name}`, () => {
        const root = fixture();
        saved(root);
        mutate(root);
        assert.throws(() => verifyInventory(root, DIR, context));
      });
    }

    test("package manifest with wrong identity or no version fails", () => {
      let root = fixture();
      put(
        root,
        "node_modules/hono/package.json",
        JSON.stringify({ name: "not-hono", version: "1.0.0" }),
      );
      assert.throws(() => createInventory(root, DIR, context), /package identity mismatch/);
      root = fixture();
      put(root, "node_modules/hono/package.json", JSON.stringify({ name: "hono" }));
      assert.throws(() => createInventory(root, DIR, context), /package version missing/);
    });

    test("esbuild version must match the one Wrangler declares", () => {
      const root = fixture();
      put(
        root,
        "node_modules/esbuild/package.json",
        JSON.stringify({ name: "esbuild", version: "0.24.0" }),
      );
      assert.throws(
        () => createInventory(root, DIR, context),
        /unexpected Wrangler esbuild version/,
      );
    });

    test("stale metafile sizes fail", () => {
      let root = fixture();
      let meta = readMeta(root);
      meta.outputs[`${DIR}/worker.js`].bytes += 1;
      writeMeta(root, meta);
      assert.throws(() => createInventory(root, DIR, context), /stale metafile output size/);
      root = fixture();
      meta = readMeta(root);
      meta.inputs["src/index.ts"].bytes += 1;
      writeMeta(root, meta);
      assert.throws(() => createInventory(root, DIR, context), /stale metafile input size/);
    });

    test("output referencing an unknown input fails", () => {
      const root = fixture();
      const meta = readMeta(root);
      meta.outputs[`${DIR}/worker.js`].inputs["src/ghost.ts"] = { bytesInOutput: 1 };
      writeMeta(root, meta);
      assert.throws(() => createInventory(root, DIR, context), /unknown input/);
    });

    test("empty metafile inputs fail", () => {
      const root = fixture();
      const meta = readMeta(root);
      meta.inputs = {};
      meta.outputs[`${DIR}/worker.js`].inputs = {};
      writeMeta(root, meta);
      assert.throws(() => createInventory(root, DIR, context), /empty metafile inputs/);
    });
  });

  describe("unexpected runtime modules", () => {
    test("an additional runtime module in the directory fails", () => {
      const root = fixture();
      put(root, `${DIR}/extra-module.js`, "export {};\n");
      assert.throws(
        () => createInventory(root, DIR, context),
        /untracked bundle file: extra-module\.js/,
      );
    });

    test("an unknown metafile output fails", () => {
      const root = fixture();
      put(root, `${DIR}/other.js`, "x");
      const meta = readMeta(root);
      meta.outputs[`${DIR}/other.js`] = { bytes: 1, imports: [], inputs: {} };
      writeMeta(root, meta);
      // other.js is also untracked on disk; remove it to isolate the metafile check.
      rmSync(join(root, DIR, "other.js"));
      assert.throws(() => createInventory(root, DIR, context), /unsupported output set/);
    });

    test("a missing expected output fails", () => {
      const root = fixture();
      const meta = readMeta(root);
      delete meta.outputs[`${DIR}/worker.js.map`];
      writeMeta(root, meta);
      assert.throws(() => createInventory(root, DIR, context), /unsupported output set/);
    });
  });

  describe("path safety", () => {
    for (const bad of [
      "../outside.js",
      "/etc/passwd",
      "src//index.ts",
      "src/./index.ts",
      "src\\index.ts",
      "",
    ]) {
      test(`metafile input ${JSON.stringify(bad)} is rejected`, () => {
        const root = fixture();
        const meta = readMeta(root);
        meta.inputs[bad] = { bytes: 1, imports: [] };
        writeMeta(root, meta);
        assert.throws(
          () => createInventory(root, DIR, context),
          /non-relative path|non-canonical path/,
        );
      });
    }

    test("a symlinked source that escapes the root fails", () => {
      const root = fixture();
      const outside = mkdtempSync(join(tmpdir(), "bundle-outside-"));
      roots.push(outside);
      writeFileSync(join(outside, "secret.ts"), "export default {};\n");
      rmSync(join(root, "src/index.ts"));
      symlinkSync(join(outside, "secret.ts"), join(root, "src/index.ts"));
      assert.throws(() => createInventory(root, DIR, context), /path escapes root/);
    });

    test("a symlink to a file inside the root is not a regular file", () => {
      const root = fixture();
      rmSync(join(root, "src/index.ts"));
      symlinkSync(join(root, "wrangler.jsonc"), join(root, "src/index.ts"));
      assert.throws(() => createInventory(root, DIR, context), /expected a regular file/);
    });

    test("a symlinked bundle output fails", () => {
      const root = fixture();
      const target = join(root, "real-worker.js");
      writeFileSync(target, "console.log('worker');\n");
      rmSync(join(root, DIR, "worker.js"));
      symlinkSync(target, join(root, DIR, "worker.js"));
      assert.throws(() => createInventory(root, DIR, context), /expected a regular file/);
    });

    test("a symlinked package directory escaping the root fails", () => {
      const root = fixture();
      const outside = mkdtempSync(join(tmpdir(), "bundle-outside-"));
      roots.push(outside);
      writeFileSync(
        join(outside, "package.json"),
        JSON.stringify({ name: "hono", version: "6.6.6" }),
      );
      rmSync(join(root, "node_modules/hono/package.json"));
      symlinkSync(join(outside, "package.json"), join(root, "node_modules/hono/package.json"));
      assert.throws(() => createInventory(root, DIR, context), /path escapes root/);
    });
  });
});

describe("receipts", () => {
  const upload = (overrides = {}) => ({
    type: "version-upload",
    version: 1,
    worker_name: "two-web-next-production",
    wrangler_environment: "production",
    version_id: VERSION,
    ...overrides,
  });
  const verifiedFor = () => {
    const root = fixture();
    saved(root);
    return verifyInventory(root, DIR, context);
  };

  describe("Wrangler JSONL file reader", () => {
    const outputFile = (raw) => {
      const root = fixture();
      put(root, "upload.jsonl", raw);
      return join(root, "upload.jsonl");
    };
    const limit = 1024 * 1024;

    test("reads multiple records with CRLF and a trailing newline", () => {
      const records = [{ type: "version-upload-start" }, upload()];
      const path = outputFile(
        `${records.map((record) => JSON.stringify(record)).join("\r\n")}\r\n`,
      );
      assert.deepEqual(readWranglerOutput(path), records);
    });

    for (const raw of ["", " \r\n\t"]) {
      test(`rejects empty output ${JSON.stringify(raw)}`, () => {
        assert.throws(() => readWranglerOutput(outputFile(raw)), /Wrangler output empty/);
      });
    }

    test("rejects a malformed line even after a valid upload record", () => {
      assert.throws(
        () => readWranglerOutput(outputFile(`${JSON.stringify(upload())}\n{broken}\n`)),
        SyntaxError,
      );
    });

    test("accepts exactly 1 MiB and rejects one byte over", () => {
      const record = JSON.stringify(upload());
      const raw = `${record}${" ".repeat(limit - Buffer.byteLength(record))}`;
      assert.equal(Buffer.byteLength(raw), limit);
      assert.deepEqual(readWranglerOutput(outputFile(raw)), [upload()]);
      assert.throws(() => readWranglerOutput(outputFile(`${raw} `)), /Wrangler output too large/);
    });

    test("enforces the byte limit for multibyte UTF-8 output", () => {
      const prefix = '{"message":"';
      const suffix = '"}\n';
      const raw = `${prefix}${"é".repeat((limit - prefix.length - suffix.length - 1) / 2)} ${suffix}`;
      assert.equal(Buffer.byteLength(raw), limit);
      assert.equal(readWranglerOutput(outputFile(raw)).length, 1);
      assert.throws(() => readWranglerOutput(outputFile(`${raw} `)), /Wrangler output too large/);
    });

    test("rejects a missing, empty or nonexistent output path", () => {
      assert.throws(() => readWranglerOutput(undefined), /Wrangler output path required/);
      assert.throws(() => readWranglerOutput(""), /Wrangler output path required/);
      assert.throws(() => readWranglerOutput(join(fixture(), "missing.jsonl")), /ENOENT/);
    });

    test("uploaded CLI requires its output env path and writes no receipt on invalid JSONL", () => {
      const root = fixture();
      saved(root);
      const env = {
        ...process.env,
        BUILD_SHA: SHA,
        GITHUB_RUN_ID: context.runId,
        GITHUB_RUN_ATTEMPT: context.runAttempt,
      };
      delete env.WRANGLER_OUTPUT_FILE_PATH;
      const run = () =>
        spawnSync(
          process.execPath,
          [new URL("./worker-bundle-evidence.mjs", import.meta.url).pathname, "uploaded", DIR],
          { cwd: root, env, encoding: "utf8", timeout: 10_000 },
        );
      let result = run();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Wrangler output path required/);
      assert.equal(existsSync(join(root, DIR, "upload.json")), false);
      env.WRANGLER_OUTPUT_FILE_PATH = join(root, "upload.jsonl");
      for (const raw of ["", `${JSON.stringify(upload())}\n{broken}\n`, " ".repeat(limit + 1)]) {
        put(root, "upload.jsonl", raw);
        result = run();
        assert.equal(result.status, 1, result.stderr);
        assert.equal(existsSync(join(root, DIR, "upload.json")), false);
      }
      put(root, "upload.jsonl", `${JSON.stringify(upload())}\n`);
      result = run();
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(readFileSync(join(root, DIR, "upload.json"), "utf8"));
      assert.deepEqual(receipt, uploadReceipt(verifyInventory(root, DIR, context), [upload()]));
    });
  });

  test("uploadReceipt binds the upload to the verified inventory digest", () => {
    const verified = verifiedFor();
    const receipt = uploadReceipt(verified, [{ type: "version-upload-start" }, upload()]);
    assert.deepEqual(receipt, {
      schema: "two.worker-bundle-upload.v1",
      sourceSha: SHA,
      runId: "123",
      runAttempt: "1",
      target: "two-web-next-production",
      environment: "production",
      inventorySha256: verified.inventorySha256,
      bundleSha256: verified.inventory.bundle.sha256,
      versionId: VERSION,
    });
  });

  test("uploadReceipt rejects missing and duplicate upload records", () => {
    const verified = verifiedFor();
    assert.throws(() => uploadReceipt(verified, []), /exactly one/);
    assert.throws(() => uploadReceipt(verified, [{ type: "deploy" }]), /exactly one/);
    assert.throws(
      () => uploadReceipt(verified, [upload(), upload({ version_id: OTHER_VERSION })]),
      /exactly one/,
    );
  });

  test("uploadReceipt rejects wrong schema version, target, environment and id", () => {
    const verified = verifiedFor();
    assert.throws(
      () => uploadReceipt(verified, [upload({ version: 2 })]),
      /unknown Wrangler upload schema/,
    );
    assert.throws(
      () => uploadReceipt(verified, [upload({ worker_name: "other-worker" })]),
      /wrong uploaded Worker/,
    );
    assert.throws(
      () => uploadReceipt(verified, [upload({ wrangler_environment: "staging" })]),
      /wrong uploaded environment/,
    );
    assert.throws(
      () => uploadReceipt(verified, [upload({ wrangler_environment: undefined })]),
      /wrong uploaded environment/,
    );
    assert.throws(
      () => uploadReceipt(verified, [upload({ version_id: "not-a-uuid" })]),
      /upload version ID missing/,
    );
    assert.throws(
      () => uploadReceipt(verified, [upload({ version_id: undefined })]),
      /upload version ID missing/,
    );
  });

  test("deploymentReceipt promotes only the uploaded version", () => {
    const verified = verifiedFor();
    const receipt = uploadReceipt(verified, [upload()]);
    const deployed = deploymentReceipt(verified, receipt, VERSION);
    assert.equal(deployed.schema, "two.worker-bundle-deployment.v1");
    assert.equal(deployed.evidence, "promoted-and-smoke-verified");
    assert.equal(deployed.versionId, VERSION);
    assert.equal(deployed.inventorySha256, verified.inventorySha256);
  });

  test("deploymentReceipt fails on a mismatched promoted version", () => {
    const verified = verifiedFor();
    const receipt = uploadReceipt(verified, [upload()]);
    assert.throws(
      () => deploymentReceipt(verified, receipt, OTHER_VERSION),
      /promoted version does not match/,
    );
    assert.throws(() => deploymentReceipt(verified, receipt, undefined));
    assert.throws(
      () => deploymentReceipt(verified, receipt, "nope"),
      /promoted version ID missing/,
    );
  });

  test("deploymentReceipt fails when the upload receipt was tampered with", () => {
    const verified = verifiedFor();
    const receipt = uploadReceipt(verified, [upload()]);
    assert.throws(
      () => deploymentReceipt(verified, { ...receipt, bundleSha256: "0".repeat(64) }, VERSION),
      /does not match/,
    );
    assert.throws(
      () => deploymentReceipt(verified, { ...receipt, inventorySha256: "0".repeat(64) }, VERSION),
      /does not match/,
    );
    assert.throws(
      () => deploymentReceipt(verified, { ...receipt, sourceSha: "c".repeat(40) }, VERSION),
      /does not match/,
    );
  });
});

describe("workflow evidence wiring", () => {
  const workflow = (name) =>
    parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const artifactPin = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9";

  test("production verifies and uploads the same prebuilt bytes, then binds only after smoke", () => {
    const steps = workflow("deploy-production").jobs["deploy-production"].steps;
    const find = (text) => steps.findIndex((step) => step.name?.includes(text));
    const build = find("Build production target");
    const inventory = find("Inventory the exact");
    const upload = find("Upload reviewed production");
    const smoke = find("Verify public routes on the promoted");
    const promotion = find("Record successful production promotion");
    const proof = find("Upload production promotion proof");
    const deployed = find("Bind bundle evidence");
    const archive = find("Archive production bundle");
    assert.ok(
      build >= 0 &&
        build < inventory &&
        inventory < upload &&
        upload < smoke &&
        smoke < promotion &&
        promotion < proof &&
        proof < deployed &&
        deployed < archive,
    );
    assert.match(
      steps[build].run,
      /--outdir dist-production --metafile dist-production\/bundle-meta\.json/,
    );
    assert.equal(steps[inventory].id, "inventory");
    assert.equal(steps[inventory].env.BUILD_SHA, "${{ needs.preflight.outputs.sha }}");
    const command = steps[upload].run;
    assert.match(command, /set -euo pipefail/);
    assert.match(command, /test ! -e "\$WRANGLER_OUTPUT_FILE_PATH"/);
    const verifyAt = command.indexOf("worker-bundle-evidence.mjs verify dist-production");
    const uploadAt = command.indexOf("npx wrangler versions upload");
    const receiptAt = command.indexOf("worker-bundle-evidence.mjs uploaded dist-production");
    assert.ok(verifyAt >= 0 && verifyAt < uploadAt && uploadAt < receiptAt);
    assert.match(command, /versions upload[^\n]+--no-bundle dist-production\/worker\.js\n/);
    assert.equal(steps[upload].env.BUILD_SHA, steps[inventory].env.BUILD_SHA);
    assert.equal(
      steps[upload].env.WRANGLER_OUTPUT_FILE_PATH,
      "${{ runner.temp }}/worker-version-upload.jsonl",
    );
    assert.equal(
      steps[deployed].if,
      undefined,
      "receipt must require prior success, never always()",
    );
    assert.match(steps[deployed].run, /worker-bundle-evidence.mjs deployed dist-production/);
    assert.equal(
      steps[deployed].env.PROMOTED_VERSION_ID,
      "${{ steps.gradual.outputs.promoted-version-id }}",
    );
    assert.equal(steps[archive].uses, artifactPin);
    assert.match(steps[archive].if, /steps.inventory.outcome == 'success'/);
    assert.equal(steps[archive].with.path, "dist-production/");
    assert.equal(steps[archive].with["if-no-files-found"], "error");
    assert.equal(steps[archive].with["retention-days"], 30);
  });

  test("CI creates build-only evidence and checks pinned no-bundle equivalence", () => {
    const steps = workflow("ci").jobs.check.steps;
    const pilot = steps.find((step) => step.name?.startsWith("Verify production build inventory"));
    assert.ok(pilot);
    assert.equal(pilot.env.BUILD_SHA, "${{ github.sha }}");
    assert.match(pilot.run, /worker-bundle-evidence.mjs create dist-production/);
    assert.match(pilot.run, /worker-bundle-evidence.mjs verify dist-production/);
    assert.match(
      pilot.run,
      /versions upload --env production --dry-run --no-bundle dist-production\/worker.js/,
    );
    assert.match(pilot.run, /cmp dist-production\/worker.js dist-production-replay\/worker.js/);
    assert.doesNotMatch(pilot.run, /worker-bundle-evidence.mjs (?:uploaded|deployed)/);
    const archive = steps.find((step) => step.name === "Archive build-only Worker bundle evidence");
    assert.equal(archive.uses, artifactPin);
    assert.equal(archive.if, pilot.if);
    assert.equal(archive.with["if-no-files-found"], "error");
    assert.ok(
      steps.some(
        (step) =>
          step.run ===
          "node --test ci/worker-bundle-evidence.test.mjs ci/kit-upload-evidence.test.mjs ci/pure-hono-rollback.test.mjs",
      ),
    );
  });
});
