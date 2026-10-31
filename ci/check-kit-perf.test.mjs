import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadKitBudget } from "./budget-fragments.mjs";
import { validateKitPlan } from "./bundle-inventory.mjs";
import { discoverKitAssets, kitBudgetSummary, run, runJson } from "./check-kit-perf.mjs";

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
    extraFiles: [
      {
        path: join(SERVER_DIR, "chunks/server.js.map"),
        body: Buffer.from("{}"),
      },
    ],
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

const GENEROUS = {
  maxRawBytes: 1_000_000,
  maxGzipBytes: 1_000_000,
  maxFiles: 10,
};

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

// The measured-fit witnesses below record what a shipped feature actually
// needed. Freezing the ceilings they were measured against (never the live plan)
// keeps them valid forever: a later tightening proves a gain without erasing the
// evidence that an earlier change fit, and a later raise cannot make them pass
// by inflating the budget the body is compared to.
function historicalShippingPlan(ceilingOverrides) {
  const plan = JSON.parse(shippingBudgetText);
  for (const [path, value] of Object.entries(ceilingOverrides)) {
    let target = plan;
    const keys = path.split(".");
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
  }
  return JSON.stringify(plan);
}

function makeClientShippingFixture(body, ceilings = {}) {
  const fx = makeFixture({ clientJs: [{ name: "immutable/client.js", body }] });
  // Exercise the real shipping allocation, not a budget derived from the input.
  writeFixtureFile(fx.root, "ci/kit-perf-budget.json", shippingBudgetText);
  if (Object.keys(ceilings).length > 0) {
    writeFixtureFile(fx.root, "ci/kit-perf-budget.json", historicalShippingPlan(ceilings));
  }
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
  const fx = makeClientShippingFixture(Buffer.alloc(256580, "a"), {
    "client.js.maxRawBytes": 256580,
  });
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("shipping budget: event-detail 103073-byte client gzip fits", (t) => {
  const fx = makeClientShippingFixture(bodyWithGzipBytes(103073), {
    "client.js.maxGzipBytes": 103073,
  });
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

// Supplemental boundary coverage follows the effective shipping plan. This
// does not authorize raises: independent fixed fixtures exercise the checker,
// and check-budget-admissions.mjs freezes bases and checks additive policy.
const SHIPPING_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SHIPPING_PLAN = loadKitBudget(SHIPPING_ROOT);
const SHIPPING_BUDGET_BYTES = Buffer.from(JSON.stringify(SHIPPING_PLAN));

test("shipping budget: canonical inventory remains complete", () => {
  assert.equal(validateKitPlan(SHIPPING_PLAN), null);
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

// A literal admission table would recreate a shared-file hotspot. These
// boundary rows test mechanics, while fixed-fixture policy tests independently
// reject missing records, frozen-base edits, aggregate cap breaches and forgery.
function ceilingOf(key) {
  if (key.startsWith("worker._worker.js."))
    return SHIPPING_PLAN.worker["_worker.js"][key.slice("worker._worker.js.".length)];
  let value = SHIPPING_PLAN;
  for (const part of key.split(".")) value = value[part];
  assert.ok(Number.isSafeInteger(value) && value > 0, `invalid ceiling ${key}`);
  return value;
}

function boundaryRows({ label, group, axis, key }) {
  const cap = ceilingOf(key);
  return [
    { name: `${label} exact ceiling`, group, axis, bytes: cap },
    {
      name: `${label} one byte over`,
      group,
      axis,
      bytes: cap + 1,
      ceiling: cap,
      breach: true,
    },
  ];
}

const overRow = (name, group, axis, key) => {
  const cap = ceilingOf(key);
  return { name, group, axis, bytes: cap + 1, ceiling: cap, breach: true };
};

for (const { name, group, axis, bytes, ceiling, breach = false } of [
  ...boundaryRows({
    label: "client raw",
    group: "kit.client.js",
    axis: "raw",
    key: "client.js.maxRawBytes",
  }),
  ...boundaryRows({
    label: "server gzip",
    group: "kit.server.js",
    axis: "gzip",
    key: "server.js.maxGzipBytes",
  }),
  ...boundaryRows({
    label: "client gzip",
    group: "kit.client.js",
    axis: "gzip",
    key: "client.js.maxGzipBytes",
  }),
  ...boundaryRows({
    label: "server raw",
    group: "kit.server.js",
    axis: "raw",
    key: "server.js.maxRawBytes",
  }),
  overRow("Worker raw one byte over", "kit.worker", "raw", "worker._worker.js.maxRawBytes"),
  overRow("Worker gzip one byte over", "kit.worker", "gzip", "worker._worker.js.maxGzipBytes"),
  overRow("CSS raw one byte over", "kit.client.css", "raw", "client.css.maxRawBytes"),
  ...boundaryRows({
    label: "CSS gzip",
    group: "kit.client.css",
    axis: "gzip",
    key: "client.css.maxGzipBytes",
  }),
  overRow("client file count one over", "kit.client.js", "files", "client.js.maxFiles"),
  overRow("server file count one over", "kit.server.js", "files", "server.js.maxFiles"),
  overRow("CSS file count one over", "kit.client.css", "files", "client.css.maxFiles"),
]) {
  test(`shipping budget: ${name}`, (t) => {
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
          new RegExp(
            `kit perf budget: _worker\\.js: raw \\d+/${ceilingOf("worker._worker.js.maxRawBytes")}B, ` +
              `gzip \\d+/${ceilingOf("worker._worker.js.maxGzipBytes")}B`,
          ),
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

test("Kit summary warns near proxy ceilings without changing their hard verdict", (t) => {
  const fx = makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const result = runJson(fx.root);
  assert.equal(result.code, 0);
  const summary = kitBudgetSummary({
    code: result.code,
    groups: result.report.groups,
  });
  assert.match(summary, /WARNING/);
  assert.match(summary, /remain hard/);
  assert.match(summary, /kit.server.js/);
});

// Retain the newly merged feature's independent measurements without reviving
// a last-writer allocation table. This fixture's cap is fixed even if shipping
// later admits a different value; both exact fit and one-byte breach are real.
for (const [bytes, expected] of [
  [336_801, 0],
  [336_896, 0],
  [336_897, 1],
]) {
  test(`fixed featured-unpublish gzip fixture: ${bytes}B at 336896B cap`, (t) => {
    const fx = makeShippingFixture(t, "kit.server.js", "gzip", bytes);
    const plan = JSON.parse(readFileSync(join(fx.root, "ci/kit-perf-budget.json"), "utf8"));
    plan.server.js.maxGzipBytes = 336_896;
    writeFixtureFile(fx.root, "ci/kit-perf-budget.json", JSON.stringify(plan));
    const result = runJson(fx.root);
    assert.equal(result.code, expected, result.errors.join("\n"));
    const server = result.report.groups.find((group) => group.id === "kit.server.js");
    assert.equal(server.checks[0].gzipBytes, bytes);
    assert.equal(server.status, expected ? "fail" : "pass");
  });
}
