import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadKitBudget } from "./budget-fragments.mjs";
import { discoverKitAssets, run, runJson } from "./check-kit-perf.mjs";

const scriptPath = fileURLToPath(new URL("./check-kit-perf.mjs", import.meta.url));

test("kit perf selftest passes hermetically", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--selftest"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /kit perf budget selftest: \d+ cases passed/);
});

test("asset discovery misses nothing under _app", () => {
  const { js, css } = discoverKitAssets(
    new URL("../web/.svelte-kit/output/client/_app", import.meta.url).pathname,
  );
  assert.ok(Array.isArray(js) && Array.isArray(css));
});

test("missing client output fails closed, never green", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(new URL("./check-kit-perf.mjs", import.meta.url).href)}).then((m) => { process.exitCode = m.run("/nonexistent-root-xyz", { log() {}, error() {} }); })`,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    2,
    `expected exit 2, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
});

// --- Acceptance: empty or incompletely enumerated build output ------------
// Exit semantics (script header): 0 fits, 1 breach, 2 cannot enforce.
// A required asset group (server JS, client JS, client CSS) that is absent,
// empty, or only partly enumerated proves nothing about size, so each case
// must return 2 with a bounded diagnostic naming the group — never the
// current "0 files fit under every ceiling" green. Every fixture below
// supplies a VALID budget and Worker first, so a red result can only come
// from the named group, not from the missing-budget branch.

const WORKER_BODY = Buffer.from(`/* worker */\n${"x".repeat(1000)}`);
const SERVER_BODY = Buffer.from(`/* server chunk */\n${"w".repeat(800)}`);
const JS_BODY = Buffer.from(`console.log(1);\n${"y".repeat(500)}`);
const CSS_BODY = Buffer.from(`.a{color:red}\n${"z".repeat(200)}`);

const SERVER_DIR = "web/.svelte-kit/output/server";
const CLIENT_DIR = "web/.svelte-kit/output/client/_app";

function groupBudget(files) {
  if (files.length === 0) return { maxRawBytes: 4096, maxGzipBytes: 4096, maxFiles: 4 };
  return {
    maxRawBytes: files.reduce((sum, f) => sum + f.body.length, 0),
    // run() sums gzip per file, so the exact-fit ceiling does the same.
    maxGzipBytes: files.reduce((sum, f) => sum + gzipSync(f.body).length, 0),
    maxFiles: files.length,
  };
}

function writeFixtureFile(root, relative, body) {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

// Builds a complete, valid tree; each test then removes exactly one thing.
function makeFixture({
  server = [{ name: "chunks/server.js", body: SERVER_BODY }],
  clientJs = [{ name: "immutable/client.js", body: JS_BODY }],
  clientCss = [{ name: "immutable/client.css", body: CSS_BODY }],
  extraFiles = [],
  budgetOverrides = {},
  omitServerDir = false,
  omitClientDir = false,
} = {}) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-perf-accept-"),
  );
  writeFixtureFile(root, "web/.svelte-kit/cloudflare/_worker.js", WORKER_BODY);
  if (!omitServerDir) {
    mkdirSync(join(root, SERVER_DIR), { recursive: true });
    for (const f of server) writeFixtureFile(root, join(SERVER_DIR, f.name), f.body);
  }
  if (!omitClientDir) {
    mkdirSync(join(root, CLIENT_DIR), { recursive: true });
    for (const f of clientJs) writeFixtureFile(root, join(CLIENT_DIR, f.name), f.body);
    for (const f of clientCss) writeFixtureFile(root, join(CLIENT_DIR, f.name), f.body);
  }
  for (const f of extraFiles) writeFixtureFile(root, f.path, f.body);
  const budget = {
    worker: {
      "_worker.js": {
        maxRawBytes: WORKER_BODY.length,
        maxGzipBytes: gzipSync(WORKER_BODY).length,
      },
    },
    server: { js: { ...groupBudget(server), ...budgetOverrides.serverJs } },
    client: {
      js: { ...groupBudget(clientJs), ...budgetOverrides.clientJs },
      css: { ...groupBudget(clientCss), ...budgetOverrides.clientCss },
    },
    startup: { maxMs: 30_000 },
  };
  writeFixtureFile(root, "ci/kit-perf-budget.json", JSON.stringify(budget));
  return {
    root,
    runCaptured() {
      const logs = [];
      const errors = [];
      const code = run(root, {
        log: (text) => logs.push(String(text)),
        error: (text) => errors.push(String(text)),
      });
      return { code, logs, errors };
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Deep-tree fixtures exceed PATH_MAX for path-based removal too.
      }
      if (existsSync(root)) spawnSync("rm", ["-rf", root]);
    },
  };
}

function assertCannotEnforce(result, groupRe, label) {
  assert.equal(
    result.code,
    2,
    `${label}: expected cannot-enforce (2), got ${result.code}\nlogs: ${result.logs.join("\n")}\nerrors: ${result.errors.join("\n")}`,
  );
  assert.ok(
    result.errors.some((line) => groupRe.test(line)),
    `${label}: expected a diagnostic naming ${groupRe}, got: ${result.errors.join(" | ") || "(none)"}`,
  );
  assert.ok(
    result.errors.some((line) =>
      /empty|no \w* ?files|missing|cannot|unable|incomplete|enumerat|fail|unreadable|ENAMETOOLONG/i.test(
        line,
      ),
    ),
    `${label}: expected the diagnostic to say why it cannot enforce, got: ${result.errors.join(" | ")}`,
  );
  assert.ok(
    !result.logs.some((line) => line.includes("every Kit asset fits")),
    `${label}: must never claim every Kit asset fits`,
  );
  assert.ok(result.errors.length <= 6, `${label}: diagnostics must stay bounded`);
}

test("acceptance: existing but empty server JS output cannot enforce (exit 2)", (t) => {
  // A lone sourcemap is not server JS: zero real files must not read as fits.
  const fx = makeFixture({
    server: [],
    extraFiles: [{ path: join(SERVER_DIR, "chunks/server.js.map"), body: Buffer.from("{}") }],
  });
  t.after(fx.cleanup);
  assertCannotEnforce(fx.runCaptured(), /server/i, "empty server js");
});

test("acceptance: existing but empty client JS output cannot enforce (exit 2)", (t) => {
  const fx = makeFixture({ clientJs: [] });
  t.after(fx.cleanup);
  assertCannotEnforce(fx.runCaptured(), /client js/i, "empty client js");
});

test("acceptance: existing but empty client CSS output cannot enforce (exit 2)", (t) => {
  const fx = makeFixture({ clientCss: [] });
  t.after(fx.cleanup);
  assertCannotEnforce(fx.runCaptured(), /client css/i, "empty client css");
});

test("acceptance: missing server output dir cannot enforce with a valid budget", (t) => {
  const fx = makeFixture({ omitServerDir: true });
  t.after(fx.cleanup);
  assertCannotEnforce(fx.runCaptured(), /server/i, "missing server output");
});

test("acceptance: missing client output dir cannot enforce with a valid budget", (t) => {
  const fx = makeFixture({ omitClientDir: true });
  t.after(fx.cleanup);
  assertCannotEnforce(fx.runCaptured(), /client/i, "missing client output");
});

// Enumeration failure injection that works as root (chmod 000 does not):
// nest directories until the joined absolute path passes Linux PATH_MAX
// (4096), so enumerating the deep subtree fails with ENAMETOOLONG. The
// top-level assets still enumerate, so only an implementation that
// propagates enumeration failures — instead of swallowing them and
// totalling what it happened to find — can return 2 here. Ceilings are
// generous in these two tests so size can never be the cause.
function addUnenumerableDeepTree(baseDir, body) {
  const component = "d".repeat(180);
  const levels = Math.max(4, Math.ceil((4300 - baseDir.length) / (component.length + 1)) + 1);
  const previous = process.cwd();
  try {
    process.chdir(baseDir);
    for (let i = 0; i < levels; i += 1) {
      mkdirSync(component);
      process.chdir(component);
    }
    writeFileSync("deep.js", body);
  } finally {
    process.chdir(previous);
  }
}

const GENEROUS = { maxRawBytes: 1_000_000, maxGzipBytes: 1_000_000, maxFiles: 10 };

test("acceptance: incompletely enumerated server output cannot enforce (exit 2)", (t) => {
  const fx = makeFixture({ budgetOverrides: { serverJs: GENEROUS } });
  t.after(fx.cleanup);
  addUnenumerableDeepTree(join(fx.root, SERVER_DIR), SERVER_BODY);
  assertCannotEnforce(fx.runCaptured(), /server/i, "unenumerable server subtree");
});

test("acceptance: incompletely enumerated client output cannot enforce (exit 2)", (t) => {
  const fx = makeFixture({ budgetOverrides: { clientJs: GENEROUS } });
  t.after(fx.cleanup);
  addUnenumerableDeepTree(join(fx.root, CLIENT_DIR), JS_BODY);
  assertCannotEnforce(fx.runCaptured(), /client/i, "unenumerable client subtree");
});

test("acceptance: nested assets are all discovered and counted (exit 0)", (t) => {
  const fx = makeFixture({
    server: [
      { name: "chunks/server.js", body: SERVER_BODY },
      { name: "chunks/deep/nested.js", body: SERVER_BODY },
    ],
    clientJs: [
      { name: "immutable/client.js", body: JS_BODY },
      { name: "immutable/nodes/page.js", body: JS_BODY },
    ],
    clientCss: [
      { name: "immutable/client.css", body: CSS_BODY },
      { name: "immutable/assets/page.css", body: CSS_BODY },
    ],
  });
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(
    result.code,
    0,
    `expected fits (0), got ${result.code}\nerrors: ${result.errors.join("\n")}`,
  );
  // Exact-fit ceilings plus these counts pin that nested files were counted.
  assert.ok(result.logs.some((line) => line.includes("ok server js: 2/2 files")));
  assert.ok(result.logs.some((line) => line.includes("ok client js: 2/2 files")));
  assert.ok(result.logs.some((line) => line.includes("ok client css: 2/2 files")));
});

test("acceptance: sourcemaps stay excluded from totals and counts (exit 0)", (t) => {
  const bigMap = Buffer.from("m".repeat(100_000));
  const fx = makeFixture({
    extraFiles: [
      { path: join(SERVER_DIR, "chunks/server.js.map"), body: bigMap },
      { path: join(CLIENT_DIR, "immutable/client.js.map"), body: bigMap },
      { path: join(CLIENT_DIR, "immutable/client.css.map"), body: bigMap },
    ],
  });
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(
    result.code,
    0,
    `sourcemaps must not breach exact-fit ceilings, got ${result.code}\nerrors: ${result.errors.join("\n")}`,
  );
  assert.ok(result.logs.some((line) => line.includes("ok server js: 1/1 files")));
  assert.ok(result.logs.some((line) => line.includes("ok client js: 1/1 files")));
  assert.ok(result.logs.some((line) => line.includes("ok client css: 1/1 files")));
});

test("acceptance: an actual size breach still exits 1, not cannot-enforce", (t) => {
  const fx = makeFixture({
    budgetOverrides: { clientJs: { maxRawBytes: JS_BODY.length - 1 } },
  });
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(
    result.code,
    1,
    `expected breach (1), got ${result.code}\nerrors: ${result.errors.join("\n")}`,
  );
  assert.ok(result.errors.some((line) => /client js/i.test(line)));
});

// The shipping plan is the aggregation of ci/budgets/kit/*.json (one unit
// per fragment); serialize it here so fixtures can copy it into a scratch
// root as a legacy single file, exactly as SHIPPING_BUDGET_BYTES below.
const shippingBudgetText = JSON.stringify(
  loadKitBudget(fileURLToPath(new URL("../", import.meta.url))),
);
const shippingClientBudget = JSON.parse(shippingBudgetText).client.js;

function makeClientShippingFixture(body) {
  const fx = makeFixture({ clientJs: [{ name: "immutable/client.js", body }] });
  // Exercise the real shipping allocation, not a budget derived from the input.
  writeFixtureFile(fx.root, "ci/kit-perf-budget.json", shippingBudgetText);
  return fx;
}

test("shipping budget: measured 255253-byte client raw fits", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(255253, "a"));
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("shipping budget: refreshed 255872-byte client raw fits", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(255872, "a"));
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("shipping budget: event-detail 256580-byte client raw fits", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(256580, "a"));
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("shipping budget: event-detail 103073-byte client gzip fits", (t) => {
  const fx = makeClientShippingFixture(bodyWithGzipBytes(103073));
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("shipping budget: exact client raw boundary fits and one byte above fails", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(shippingClientBudget.maxRawBytes, "a"));
  t.after(fx.cleanup);
  const exact = fx.runCaptured();
  assert.equal(exact.code, 0, exact.errors.join("\n"));
  assert.deepEqual(exact.errors, []);

  writeFixtureFile(
    fx.root,
    join(CLIENT_DIR, "immutable/client.js"),
    Buffer.alloc(shippingClientBudget.maxRawBytes + 1, "a"),
  );
  const over = fx.runCaptured();
  assert.equal(over.code, 1);
  assert.deepEqual(over.errors, [
    `kit perf budget: client js: raw ${shippingClientBudget.maxRawBytes + 1}B over ${shippingClientBudget.maxRawBytes}B`,
  ]);
});

test("shipping budget: client gzip still fails independently of raw", (t) => {
  const body = Buffer.alloc(shippingClientBudget.maxGzipBytes + 1024);
  let seed = 123456789;
  for (let i = 0; i < body.length; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    body[i] = seed & 255;
  }
  const gzipBytes = gzipSync(body).length;
  assert.ok(body.length <= shippingClientBudget.maxRawBytes);
  assert.ok(gzipBytes > shippingClientBudget.maxGzipBytes);
  const fx = makeClientShippingFixture(body);
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 1);
  assert.deepEqual(result.errors, [
    `kit perf budget: client js: gzip ${gzipBytes}B over ${shippingClientBudget.maxGzipBytes}B`,
  ]);
});

// Shipping allocations must admit fixed evidence, not fixtures whose budgets
// grow with their bodies. Reverting any allocation must reject its interval;
// raising any allocation must incorrectly admit its fixed one-byte-over case.
// The shipping plan is the aggregation of ci/budgets/kit/*.json (one unit
// per fragment); serialize it once so fixtures can copy it into a scratch
// root as a legacy single file, byte-for-byte inside the fixture.
const SHIPPING_BUDGET_BYTES = Buffer.from(
  JSON.stringify(loadKitBudget(fileURLToPath(new URL("../", import.meta.url)))),
);
// Ten explicit server-gzip allocations are supported: current 334080, the
// independently justified 335104 ceiling (combined worst 334994, margin 110;
// lower 334848 rejects by 146), the independently justified 335360 ceiling
// (combined worst 335338, margin 22; lower 335104 rejects by 234), and the
// independently justified 335616 ceiling (combined worst 335504, margin 112;
// lower 335360 rejects by 144), and the
// independently justified 335872 ceiling (combined worst 335624, margin 248;
// lower 335616 rejects by 8), and the independently justified 336128 ceiling
// (combined worst 335977, margin 151; lower 335872 rejects by 105), the
// independently justified 336384 ceiling for the admin-orientation slice (two
// merged builds 336190 and 336192; lower 336128 rejects by 64), and the
// independently justified 336640 ceiling for the unrenderable-time guards
// (two merged builds 336514 and 336514; lower 336384 rejects by 130), and the
// independently justified 336896 ceiling for the bounded homepage reads (two
// merged builds 336673 and 336672; margin 223; lower 336640 rejects by 33).
// The restored-write banner admits 337920 (two builds 337895/337896; the
// lower 337664 ceiling rejects both).
// Fixture lengths below are fixed literals
// selected by this mapping, never `cap` or `cap + 1`; any other loaded
// ceiling fails the allocation control and the three server-gzip cases, so
// an arbitrary widening cannot go green.
let SHIPPING_SERVER_GZIP_CAP;
try {
  SHIPPING_SERVER_GZIP_CAP = JSON.parse(SHIPPING_BUDGET_BYTES.toString("utf8"))?.server?.js
    ?.maxGzipBytes;
} catch {
  SHIPPING_SERVER_GZIP_CAP = undefined;
}
const SHIPPING_SERVER_GZIP_ALLOCATIONS = {
  334080: { intervalBytes: 333639, exactBytes: 334080, overBytes: 334081 },
  335104: { intervalBytes: 334994, exactBytes: 335104, overBytes: 335105 },
  335360: { intervalBytes: 335338, exactBytes: 335360, overBytes: 335361 },
  335616: { intervalBytes: 335504, exactBytes: 335616, overBytes: 335617 },
  335872: { intervalBytes: 335624, exactBytes: 335872, overBytes: 335873 },
  336128: { intervalBytes: 335977, exactBytes: 336128, overBytes: 336129 },
  336384: { intervalBytes: 336192, exactBytes: 336384, overBytes: 336385 },
  336640: { intervalBytes: 336514, exactBytes: 336640, overBytes: 336641 },
  336896: { intervalBytes: 336673, exactBytes: 336896, overBytes: 336897 },
  337920: { intervalBytes: 337896, exactBytes: 337920, overBytes: 337921 },
};
const SHIPPING_SERVER_GZIP_UNSUPPORTED =
  `unsupported server gzip allocation ${String(SHIPPING_SERVER_GZIP_CAP)}: ` +
  `expected one of 334080, 335104, 335360, 335616, 335872, 336128, 336384, 336640, 336896, 337920`;

test("shipping budget: server gzip allocation is explicitly approved", () => {
  assert.ok(
    Object.hasOwn(SHIPPING_SERVER_GZIP_ALLOCATIONS, String(SHIPPING_SERVER_GZIP_CAP)),
    SHIPPING_SERVER_GZIP_UNSUPPORTED,
  );
});

// Client js raw and gzip allocations follow the same rule: explicit ceilings
// per axis — raw 257024 (baseline), 257536 (admin-orientation; merged build
// 257039 on the earlier base, which the lower 257024 ceiling rejects by 15)
// and 258048 (featured editorial-limits; merged build 257638, which the lower
// 257536 ceiling rejects by 102); gzip 103168 (baseline), 103424 (merged-tree
// worst 103302, margin 122; the lower 103168 ceiling rejects by 134) and
// 103680 (merged build 103569, which the lower 103168 ceiling rejects by 401).
// Restored-write admits raw 259072 and gzip 103936 (measured 258886/103906).
// Any other loaded ceiling fails its allocation control and its boundary cases.
const SHIPPING_CLIENT_RAW_CAP = shippingClientBudget?.maxRawBytes;
const SHIPPING_CLIENT_GZIP_CAP = shippingClientBudget?.maxGzipBytes;
const SHIPPING_CLIENT_RAW_ALLOCATIONS = {
  257024: { intervalBytes: 255856, exactBytes: 257024, overBytes: 257025 },
  257536: { intervalBytes: 257039, exactBytes: 257536, overBytes: 257537 },
  258048: { intervalBytes: 257638, exactBytes: 258048, overBytes: 258049 },
  259072: { intervalBytes: 258886, exactBytes: 259072, overBytes: 259073 },
};
const SHIPPING_CLIENT_GZIP_ALLOCATIONS = {
  103168: { exactBytes: 103168, overBytes: 103169 },
  103424: { intervalBytes: 103302, exactBytes: 103424, overBytes: 103425 },
  103680: { intervalBytes: 103569, exactBytes: 103680, overBytes: 103681 },
  103936: { intervalBytes: 103906, exactBytes: 103936, overBytes: 103937 },
};
const SHIPPING_CLIENT_RAW_UNSUPPORTED =
  `unsupported client raw allocation ${String(SHIPPING_CLIENT_RAW_CAP)}: ` +
  `expected one of 257024, 257536, 258048, 259072`;
const SHIPPING_CLIENT_GZIP_UNSUPPORTED =
  `unsupported client gzip allocation ${String(SHIPPING_CLIENT_GZIP_CAP)}: ` +
  `expected one of 103168, 103424, 103680, 103936`;

test("shipping budget: client raw allocation is explicitly approved", () => {
  assert.ok(
    Object.hasOwn(SHIPPING_CLIENT_RAW_ALLOCATIONS, String(SHIPPING_CLIENT_RAW_CAP)),
    SHIPPING_CLIENT_RAW_UNSUPPORTED,
  );
});

test("shipping budget: client gzip allocation is explicitly approved", () => {
  assert.ok(
    Object.hasOwn(SHIPPING_CLIENT_GZIP_ALLOCATIONS, String(SHIPPING_CLIENT_GZIP_CAP)),
    SHIPPING_CLIENT_GZIP_UNSUPPORTED,
  );
});
const SHIPPING_GROUPS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"];
const SHIPPING_BASES = {
  "kit.worker": WORKER_BODY,
  "kit.server.js": SERVER_BODY,
  "kit.client.js": JS_BODY,
  "kit.client.css": CSS_BODY,
};

// Fixed-seed high-entropy bytes let gzip size, rather than raw size, reach a
// ceiling. Correct for the small deflate framing overhead with bounded real
// compressions; no mocked length, compressor options or precompressed input.
function bodyWithGzipBytes(target) {
  const bytes = Buffer.alloc(target);
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 255;
  }
  let length = target - 32;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.ok(length > 0 && length <= bytes.length, "bounded gzip fixture length");
    const body = bytes.subarray(0, length);
    const gzipBytes = gzipSync(body).length;
    if (gzipBytes === target) return body;
    length += target - gzipBytes;
  }
  assert.fail(`could not construct exactly ${target} gzip bytes`);
}

function shippingBodies(group, axis, bytes) {
  const base = SHIPPING_BASES[group];
  if (axis === "files") return Array.from({ length: bytes }, () => base);
  // Group totals span two nested files, so gzip must be summed per file,
  // not computed from their concatenation. The Worker is a single entry.
  const prefix = group === "kit.worker" ? [] : [base];
  const used = prefix.reduce(
    (sum, body) => sum + (axis === "raw" ? body.length : gzipSync(body).length),
    0,
  );
  return [
    ...prefix,
    axis === "raw" ? Buffer.alloc(bytes - used, "x") : bodyWithGzipBytes(bytes - used),
  ];
}

function makeShippingFixture(t, group, axis, bytes) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-perf-shipping-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Copy the aggregated shipping plan byte-for-byte, including every
  // unrelated group. Never pass it through makeFixture(), groupBudget() or
  // budgetOverrides.
  writeFixtureFile(root, "ci/kit-perf-budget.json", SHIPPING_BUDGET_BYTES);
  const bodies = Object.fromEntries(
    Object.entries(SHIPPING_BASES).map(([id, body]) => [id, [body]]),
  );
  bodies[group] = shippingBodies(group, axis, bytes);
  writeFixtureFile(root, "web/.svelte-kit/cloudflare/_worker.js", bodies["kit.worker"][0]);
  for (const [id, dir, extension] of [
    ["kit.server.js", SERVER_DIR, "js"],
    ["kit.client.js", CLIENT_DIR, "js"],
    ["kit.client.css", CLIENT_DIR, "css"],
  ]) {
    bodies[id].forEach((body, index) => {
      writeFixtureFile(root, join(dir, `nested/${index}.${extension}`), body);
    });
  }
  assert.deepEqual(readFileSync(join(root, "ci/kit-perf-budget.json")), SHIPPING_BUDGET_BYTES);
  return { root, bodies };
}

// Literal boundaries are independent of the plan loaded above. In particular,
// neither a reverted cap nor an accidental increase can move the evidence.
// The server-gzip and client raw/gzip rows select fixed literals for the
// loaded allocation via the explicit mappings above; unsupported ceilings
// produce failing controls, never skips or green.
function shippingServerGzipCases() {
  if (SHIPPING_SERVER_GZIP_CAP === 334080) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 333639,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 334080 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 334081,
        ceiling: 334080,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 335104) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 334994,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 335104 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335105,
        ceiling: 335104,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 335360) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335338,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 335360 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335361,
        ceiling: 335360,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 335616) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335504,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 335616 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335617,
        ceiling: 335616,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 335872) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335624,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 335872 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335873,
        ceiling: 335872,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 336128) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 335977,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 336128 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336129,
        ceiling: 336128,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 336384) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336192,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 336384 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336385,
        ceiling: 336384,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 336640) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336514,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 336640 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336641,
        ceiling: 336640,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 336896) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336673,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 336896 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 336897,
        ceiling: 336896,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 337920) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337896,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 337920 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337921,
        ceiling: 337920,
        breach: true,
      },
    ];
  }
  return [
    { name: "server gzip newly allowed interval", unsupported: SHIPPING_SERVER_GZIP_UNSUPPORTED },
    { name: "server gzip exact ceiling", unsupported: SHIPPING_SERVER_GZIP_UNSUPPORTED },
    { name: "server gzip one byte over", unsupported: SHIPPING_SERVER_GZIP_UNSUPPORTED },
  ];
}
function shippingClientRawCases() {
  if (SHIPPING_CLIENT_RAW_CAP === 257024) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 255856,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 257024 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 257025,
        ceiling: 257024,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 257536) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 257039,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 257536 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 257537,
        ceiling: 257536,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 258048) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 257638,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 258048 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 258049,
        ceiling: 258048,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 259072) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 258886,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 259072 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 259073,
        ceiling: 259072,
        breach: true,
      },
    ];
  }
  return [
    { name: "client raw newly allowed interval", unsupported: SHIPPING_CLIENT_RAW_UNSUPPORTED },
    { name: "client raw exact ceiling", unsupported: SHIPPING_CLIENT_RAW_UNSUPPORTED },
    { name: "client raw one byte over", unsupported: SHIPPING_CLIENT_RAW_UNSUPPORTED },
  ];
}
function shippingClientGzipCases() {
  if (SHIPPING_CLIENT_GZIP_CAP === 103168) {
    return [
      { name: "client gzip exact ceiling", group: "kit.client.js", axis: "gzip", bytes: 103168 },
      {
        name: "client gzip one byte over",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103169,
        ceiling: 103168,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_GZIP_CAP === 103424) {
    return [
      {
        name: "client gzip newly allowed interval",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103302,
      },
      { name: "client gzip exact ceiling", group: "kit.client.js", axis: "gzip", bytes: 103424 },
      {
        name: "client gzip one byte over",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103425,
        ceiling: 103424,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_GZIP_CAP === 103680) {
    return [
      {
        name: "client gzip newly allowed interval",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103569,
      },
      { name: "client gzip exact ceiling", group: "kit.client.js", axis: "gzip", bytes: 103680 },
      {
        name: "client gzip one byte over",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103681,
        ceiling: 103680,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_GZIP_CAP === 103936) {
    return [
      {
        name: "client gzip newly allowed interval",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103906,
      },
      { name: "client gzip exact ceiling", group: "kit.client.js", axis: "gzip", bytes: 103936 },
      {
        name: "client gzip one byte over",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 103937,
        ceiling: 103936,
        breach: true,
      },
    ];
  }
  return [
    { name: "client gzip exact ceiling", unsupported: SHIPPING_CLIENT_GZIP_UNSUPPORTED },
    { name: "client gzip one byte over", unsupported: SHIPPING_CLIENT_GZIP_UNSUPPORTED },
  ];
}
for (const { name, group, axis, bytes, ceiling, breach = false, unsupported } of [
  ...shippingClientRawCases(),
  ...shippingServerGzipCases(),
  ...shippingClientGzipCases(),
  { name: "server raw exact ceiling", group: "kit.server.js", axis: "raw", bytes: 1203200 },
  {
    name: "server raw one byte over",
    group: "kit.server.js",
    axis: "raw",
    bytes: 1203201,
    ceiling: 1203200,
    breach: true,
  },
  {
    name: "Worker raw one byte over",
    group: "kit.worker",
    axis: "raw",
    bytes: 3585,
    ceiling: 3584,
    breach: true,
  },
  {
    name: "Worker gzip one byte over",
    group: "kit.worker",
    axis: "gzip",
    bytes: 1537,
    ceiling: 1536,
    breach: true,
  },
  {
    name: "CSS raw one byte over",
    group: "kit.client.css",
    axis: "raw",
    bytes: 3073,
    ceiling: 3072,
    breach: true,
  },
  { name: "CSS gzip newly allowed interval", group: "kit.client.css", axis: "gzip", bytes: 1029 },
  { name: "CSS gzip exact ceiling", group: "kit.client.css", axis: "gzip", bytes: 1280 },
  {
    name: "CSS gzip one byte over",
    group: "kit.client.css",
    axis: "gzip",
    bytes: 1281,
    ceiling: 1280,
    breach: true,
  },
  {
    name: "client file count one over",
    group: "kit.client.js",
    axis: "files",
    bytes: 56,
    ceiling: 55,
    breach: true,
  },
  {
    name: "server file count one over",
    group: "kit.server.js",
    axis: "files",
    bytes: 127,
    ceiling: 126,
    breach: true,
  },
  {
    name: "CSS file count one over",
    group: "kit.client.css",
    axis: "files",
    bytes: 5,
    ceiling: 4,
    breach: true,
  },
]) {
  test(`shipping budget: ${name}`, (t) => {
    if (unsupported) assert.fail(unsupported);
    const fx = makeShippingFixture(t, group, axis, bytes);
    const result = runJson(fx.root);
    assert.equal(result.code, breach ? 1 : 0, result.errors.join("\n"));
    assert.equal(result.report.exitCode, result.code);
    assert.equal(result.report.ok, !breach);
    assert.deepEqual(
      result.report.groups.map((entry) => entry.id),
      SHIPPING_GROUPS,
    );
    for (const entry of result.report.groups) {
      const expectedStatus = breach && entry.id === group ? "fail" : "pass";
      assert.equal(entry.status, expectedStatus, `${entry.id}: ${result.errors.join("\n")}`);
      assert.equal(entry.checks.length, 1);
      const check = entry.checks[0];
      assert.equal(check.status, expectedStatus);
      const bodies = fx.bodies[entry.id];
      assert.equal(
        check.rawBytes,
        bodies.reduce((sum, body) => sum + body.length, 0),
      );
      assert.equal(
        check.gzipBytes,
        bodies.reduce((sum, body) => sum + gzipSync(body).length, 0),
      );
      if (entry.id !== "kit.worker") assert.equal(check.files, bodies.length);
      if (entry.id === group) {
        assert.equal(check[axis === "files" ? "files" : `${axis}Bytes`], bytes);
      }
      // A refusal on one axis must leave the other axis and count in bounds.
      for (const [key, maxKey] of [
        ["rawBytes", "maxRawBytes"],
        ["gzipBytes", "maxGzipBytes"],
        ["files", "maxFiles"],
      ]) {
        if (entry.id !== group || key !== (axis === "files" ? "files" : `${axis}Bytes`)) {
          if (check[key] !== undefined)
            assert.ok(check[key] <= check[maxKey], `${entry.id} ${key}`);
        }
      }
    }
    if (!breach) {
      assert.deepEqual(result.errors, []);
      assert.ok(result.logs.includes("kit perf budget: every Kit asset fits."));
    } else {
      assert.equal(result.errors.length, 1, result.errors.join("\n"));
      const label = group.replace("kit.", "").replace(".", " ");
      if (group === "kit.worker") {
        assert.match(
          result.errors[0],
          /kit perf budget: _worker\.js: raw \d+\/3584B, gzip \d+\/1536B/,
        );
      } else {
        const detail =
          axis === "files"
            ? `${bytes} files over ${ceiling}`
            : `${axis} ${bytes}B over ${ceiling}B`;
        assert.equal(result.errors[0], `kit perf budget: ${label}: ${detail}`);
      }
      assert.ok(!result.logs.includes("kit perf budget: every Kit asset fits."));
    }
  });
}
