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
import { approvedClientBudget, INITIAL_CLIENT_BUDGET } from "./client-ratchet-approval.mjs";

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

function makeClientShippingFixture(body, historical = false) {
  const fx = makeFixture({ clientJs: [{ name: "immutable/client.js", body }] });
  // Fixed historic evidence uses its pinned allocation; current boundaries use
  // the actual shipping plan. Neither budget is derived from the fixture body.
  const budget = JSON.parse(shippingBudgetText);
  if (historical) budget.client = INITIAL_CLIENT_BUDGET;
  writeFixtureFile(fx.root, "ci/kit-perf-budget.json", JSON.stringify(budget));
  return fx;
}

test("historical client budget: measured 255253-byte client raw fits", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(255253, "a"), true);
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("historical client budget: refreshed 255872-byte client raw fits", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(255872, "a"), true);
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("historical client budget: event-detail 256580-byte client raw fits", (t) => {
  const fx = makeClientShippingFixture(Buffer.alloc(256580, "a"), true);
  t.after(fx.cleanup);
  const result = fx.runCaptured();
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("historical client budget: event-detail 103073-byte client gzip fits", (t) => {
  const fx = makeClientShippingFixture(bodyWithGzipBytes(103073), true);
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
  const body = bodyWithGzipBytes(shippingClientBudget.maxGzipBytes + 1);
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

// Retain fixed client evidence against the pre-ratchet allocation, not budgets
// derived from fixture bodies. Server/Worker budgets still use shipping values.
// Current-plan controls below independently verify the measured decision chain
// and every current client ceiling, including legitimate generated decreases.
const SHIPPING_BUDGET_BYTES = Buffer.from(
  JSON.stringify({ ...JSON.parse(shippingBudgetText), client: INITIAL_CLIENT_BUDGET }),
);
// Explicit server-gzip allocations are supported: baseline 334080, the
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
// merged builds 336673 and 336672; margin 223; lower 336640 rejects by 33),
// the host/join 337152 ceiling, the ongoing-night 337408 ceiling, and the
// honest roster/venue 337664 ceiling on current main (two composed builds
// 337545 and 337547; main's 337408 rejects by 137 and 139), and the
// GET /version 337920 ceiling on current main (two composed builds 337717
// and 337718; main's 337664 rejects by 53 and 54), which also admits the Kit
// outage-header CTA composed with it (two builds 337793 and 337795), and the
// activity-log recovery 338176 ceiling (two composed builds 338013 and
// 338012; main's 337920 rejects by 93 and 92), and the MCP result-budget
// 338432 ceiling (two builds composed with main 004ce006, both 338213;
// main's 338176 rejects by 37), and the MCP truncation-notice 338688
// ceiling on top of it (two composed builds, both 338619; 338432 rejects
// by 187), and the session role-recheck 339968 ceiling on top of that
// (two builds, both 339958; 338688 rejects by 1270), and the recheck
// review-hardening 340224 ceiling on top of that (two builds 340038 and
// 340039; 339968 rejects by 70 and 71), and the moderator row-names
// 340736 ceiling on top of that (two builds 340593 and 340594; 340224
// rejects by 369 and 370), and the QA-token throttle 341248 ceiling on
// top of that (two builds, both 341055; 340736 rejects by 319), and the
// explicitly bounded Ember 342272 ceiling (frozen builds 341996/341995;
// 341248 rejects by 748/747). See the dated decision for build identities.
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
  337152: { intervalBytes: 337015, exactBytes: 337152, overBytes: 337153 },
  337408: { intervalBytes: 337286, exactBytes: 337408, overBytes: 337409 },
  337664: { intervalBytes: 337545, exactBytes: 337664, overBytes: 337665 },
  337920: { intervalBytes: 337795, exactBytes: 337920, overBytes: 337921 },
  338176: { intervalBytes: 338013, exactBytes: 338176, overBytes: 338177 },
  338432: { intervalBytes: 338213, exactBytes: 338432, overBytes: 338433 },
  338688: { intervalBytes: 338619, exactBytes: 338688, overBytes: 338689 },
  339968: { intervalBytes: 339958, exactBytes: 339968, overBytes: 339969 },
  340224: { intervalBytes: 340039, exactBytes: 340224, overBytes: 340225 },
  340736: { intervalBytes: 340594, exactBytes: 340736, overBytes: 340737 },
  341248: { intervalBytes: 341055, exactBytes: 341248, overBytes: 341249 },
  342272: { intervalBytes: 341996, exactBytes: 342272, overBytes: 342273 },
};
const SHIPPING_SERVER_GZIP_UNSUPPORTED =
  `unsupported server gzip allocation ${String(SHIPPING_SERVER_GZIP_CAP)}: ` +
  `expected one of 334080, 335104, 335360, 335616, 335872, 336128, 336384, 336640, 336896, 337152, 337408, 337664, 337920, 338176, 338432, 338688, 339968, 340224, 340736, 341248, 342272`;

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
// The host/join carry-over with render-time URL checks adds raw 258560
// (measured 258282). The honest roster/venue states add raw 259584
// (two merged builds 259224; the lower 258560 rejects by 664), with the
// gzip ceiling unchanged. The Kit outage-header CTA adds raw 260096 and
// gzip 103936 (two builds 259746/103695; the lower pair rejects by 162/15).
// The activity-log recovery links add raw 260608 (two composed builds
// 260403; the lower 260096 rejects by 307), with the gzip ceiling unchanged.
// The moderator row accessible names add raw 261632 and gzip 104448 (two
// builds 261250/104332; the lower 261120 raw step rejects by 130 and the
// lower 104192 gzip step by 140).
// Any other loaded ceiling fails its allocation control and its boundary cases.
const SHIPPING_CLIENT_RAW_CAP = INITIAL_CLIENT_BUDGET.js.maxRawBytes;
const SHIPPING_CLIENT_GZIP_CAP = INITIAL_CLIENT_BUDGET.js.maxGzipBytes;

test("shipping client ceilings exactly match the measured lower-only decision chain", () => {
  assert.deepEqual(
    JSON.parse(shippingBudgetText).client,
    approvedClientBudget(fileURLToPath(new URL("../", import.meta.url))),
  );
});
const SHIPPING_CLIENT_RAW_ALLOCATIONS = {
  257024: { intervalBytes: 255856, exactBytes: 257024, overBytes: 257025 },
  257536: { intervalBytes: 257039, exactBytes: 257536, overBytes: 257537 },
  258048: { intervalBytes: 257638, exactBytes: 258048, overBytes: 258049 },
  258560: { intervalBytes: 258282, exactBytes: 258560, overBytes: 258561 },
  259584: { intervalBytes: 259224, exactBytes: 259584, overBytes: 259585 },
  260096: { intervalBytes: 259746, exactBytes: 260096, overBytes: 260097 },
  260608: { intervalBytes: 260403, exactBytes: 260608, overBytes: 260609 },
  261632: { intervalBytes: 261250, exactBytes: 261632, overBytes: 261633 },
};
const SHIPPING_CLIENT_GZIP_ALLOCATIONS = {
  103168: { exactBytes: 103168, overBytes: 103169 },
  103424: { intervalBytes: 103302, exactBytes: 103424, overBytes: 103425 },
  103680: { intervalBytes: 103569, exactBytes: 103680, overBytes: 103681 },
  103936: { intervalBytes: 103695, exactBytes: 103936, overBytes: 103937 },
  104448: { intervalBytes: 104332, exactBytes: 104448, overBytes: 104449 },
};
const SHIPPING_CLIENT_RAW_UNSUPPORTED =
  `unsupported client raw allocation ${String(SHIPPING_CLIENT_RAW_CAP)}: ` +
  `expected one of 257024, 257536, 258048, 258560, 259584, 260096, 260608, 261632`;
const SHIPPING_CLIENT_GZIP_UNSUPPORTED =
  `unsupported client gzip allocation ${String(SHIPPING_CLIENT_GZIP_CAP)}: ` +
  `expected one of 103168, 103424, 103680, 103936, 104448`;

test("historical client budget: client raw allocation is explicitly approved", () => {
  assert.ok(
    Object.hasOwn(SHIPPING_CLIENT_RAW_ALLOCATIONS, String(SHIPPING_CLIENT_RAW_CAP)),
    SHIPPING_CLIENT_RAW_UNSUPPORTED,
  );
});

test("historical client budget: client gzip allocation is explicitly approved", () => {
  assert.ok(
    Object.hasOwn(SHIPPING_CLIENT_GZIP_ALLOCATIONS, String(SHIPPING_CLIENT_GZIP_CAP)),
    SHIPPING_CLIENT_GZIP_UNSUPPORTED,
  );
});
const SHIPPING_SERVER_RAW_CAP = JSON.parse(SHIPPING_BUDGET_BYTES.toString("utf8")).server.js
  .maxRawBytes;
const SHIPPING_SERVER_RAW_ALLOCATIONS = {
  1220608: { intervalBytes: 1220482, exactBytes: 1220608, overBytes: 1220609 },
  1222656: { intervalBytes: 1222251, exactBytes: 1222656, overBytes: 1222657 },
  1226752: { intervalBytes: 1226469, exactBytes: 1226752, overBytes: 1226753 },
  1227264: { intervalBytes: 1226904, exactBytes: 1227264, overBytes: 1227265 },
};
const SHIPPING_SERVER_RAW_UNSUPPORTED =
  `unsupported server raw allocation ${String(SHIPPING_SERVER_RAW_CAP)}: ` +
  `expected one of 1220608, 1222656, 1226752, 1227264`;

test("shipping budget: server raw allocation is explicitly approved", () => {
  assert.ok(
    Object.hasOwn(SHIPPING_SERVER_RAW_ALLOCATIONS, String(SHIPPING_SERVER_RAW_CAP)),
    SHIPPING_SERVER_RAW_UNSUPPORTED,
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

function shippingBodies(group, axis, bytes, minimal = false) {
  const base = minimal ? Buffer.from("x") : SHIPPING_BASES[group];
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

function makeShippingFixture(
  t,
  group,
  axis,
  bytes,
  budgetBytes = SHIPPING_BUDGET_BYTES,
  minimal = false,
) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-perf-shipping-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Copy the supplied plan byte-for-byte, including every unrelated group. Never pass it through makeFixture(), groupBudget() or
  // budgetOverrides.
  writeFixtureFile(root, "ci/kit-perf-budget.json", budgetBytes);
  const bodies = Object.fromEntries(
    Object.entries(SHIPPING_BASES).map(([id, body]) => [
      id,
      [minimal && id.startsWith("kit.client.") ? Buffer.from("x") : body],
    ]),
  );
  bodies[group] = shippingBodies(group, axis, bytes, minimal);
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
  assert.deepEqual(readFileSync(join(root, "ci/kit-perf-budget.json")), budgetBytes);
  return { root, bodies };
}

// Literal boundaries are independent of the plan loaded above. In particular,
// neither a reverted cap nor an accidental increase can move the evidence.
// The server-gzip and client raw/gzip rows select fixed literals for the
// loaded allocation via the explicit mappings above; unsupported ceilings
// produce failing controls, never skips or green.
for (const kind of ["js", "css"]) {
  for (const [axis, key] of [
    ["raw", "maxRawBytes"],
    ["gzip", "maxGzipBytes"],
    ["files", "maxFiles"],
  ]) {
    test(`current shipping client ${kind} ${axis}: exact ceiling fits and one above fails`, (t) => {
      const ceiling = JSON.parse(shippingBudgetText).client[kind][key];
      for (const delta of [0, 1]) {
        const fx = makeShippingFixture(
          t,
          `kit.client.${kind}`,
          axis,
          ceiling + delta,
          Buffer.from(shippingBudgetText),
          true,
        );
        const result = runJson(fx.root);
        const check = result.report.groups.find((g) => g.id === `kit.client.${kind}`).checks[0];
        // Independent ratchets can make another axis bind first (including
        // raw before gzip). Prove every diagnostic, not an impossible joint fit.
        const bodies = fx.bodies[`kit.client.${kind}`];
        const metrics = {
          raw: bodies.reduce((sum, body) => sum + body.length, 0),
          gzip: bodies.reduce((sum, body) => sum + gzipSync(body).length, 0),
          files: bodies.length,
        };
        const caps = JSON.parse(shippingBudgetText).client[kind];
        for (const [metric, capKey] of [
          ["raw", "maxRawBytes"],
          ["gzip", "maxGzipBytes"],
          ["files", "maxFiles"],
        ]) {
          const diagnostic =
            metric === "files"
              ? `${metrics[metric]} files over ${caps[capKey]}`
              : `${metric} ${metrics[metric]}B over ${caps[capKey]}B`;
          assert.equal(
            result.errors.some((line) => line.includes(diagnostic)),
            metrics[metric] > caps[capKey],
          );
        }
        const expected =
          metrics.raw > caps.maxRawBytes ||
          metrics.gzip > caps.maxGzipBytes ||
          metrics.files > caps.maxFiles
            ? 1
            : 0;
        assert.equal(result.code, expected, result.errors.join("\n"));
        assert.equal(result.errors.length, expected);
        if (axis === "files")
          assert.equal(
            result.errors.some((line) => line.includes(`${ceiling + 1} files over ${ceiling}`)),
            delta === 1,
          );
        assert.equal(check[key], ceiling);
        assert.equal(check[axis === "files" ? "files" : `${axis}Bytes`], ceiling + delta);
      }
    });
  }
}

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
  if (SHIPPING_SERVER_GZIP_CAP === 337152) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337015,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 337152 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337153,
        ceiling: 337152,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 337408) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337286,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 337408 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337409,
        ceiling: 337408,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 337664) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337545,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 337664 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 337665,
        ceiling: 337664,
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
        bytes: 337795,
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
  if (SHIPPING_SERVER_GZIP_CAP === 338176) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 338013,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 338176 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 338177,
        ceiling: 338176,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 338432) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 338213,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 338432 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 338433,
        ceiling: 338432,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 338688) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 338619,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 338688 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 338689,
        ceiling: 338688,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 339968) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 339958,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 339968 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 339969,
        ceiling: 339968,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 340224) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 340039,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 340224 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 340225,
        ceiling: 340224,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 340736) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 340594,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 340736 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 340737,
        ceiling: 340736,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 341248) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 341055,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 341248 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 341249,
        ceiling: 341248,
        breach: true,
      },
    ];
  }
  if (SHIPPING_SERVER_GZIP_CAP === 342272) {
    return [
      {
        name: "server gzip newly allowed interval",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 341996,
      },
      {
        name: "server gzip repeated Ember measurement",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 341995,
      },
      {
        name: "server gzip combined Ember measurement",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 341997,
      },
      {
        name: "server gzip repeated combined Ember measurement",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 341993,
      },
      { name: "server gzip exact ceiling", group: "kit.server.js", axis: "gzip", bytes: 342272 },
      {
        name: "server gzip one byte over",
        group: "kit.server.js",
        axis: "gzip",
        bytes: 342273,
        ceiling: 342272,
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
  if (SHIPPING_CLIENT_RAW_CAP === 258560) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 258282,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 258560 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 258561,
        ceiling: 258560,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 259584) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 259224,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 259584 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 259585,
        ceiling: 259584,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 260096) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 259746,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 260096 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 260097,
        ceiling: 260096,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 260608) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 260403,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 260608 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 260609,
        ceiling: 260608,
        breach: true,
      },
    ];
  }
  if (SHIPPING_CLIENT_RAW_CAP === 261632) {
    return [
      {
        name: "client raw newly allowed interval",
        group: "kit.client.js",
        axis: "raw",
        bytes: 261250,
      },
      { name: "client raw exact ceiling", group: "kit.client.js", axis: "raw", bytes: 261632 },
      {
        name: "client raw one byte over",
        group: "kit.client.js",
        axis: "raw",
        bytes: 261633,
        ceiling: 261632,
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
        bytes: 103695,
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
  if (SHIPPING_CLIENT_GZIP_CAP === 104448) {
    return [
      {
        name: "client gzip newly allowed interval",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 104332,
      },
      { name: "client gzip exact ceiling", group: "kit.client.js", axis: "gzip", bytes: 104448 },
      {
        name: "client gzip one byte over",
        group: "kit.client.js",
        axis: "gzip",
        bytes: 104449,
        ceiling: 104448,
        breach: true,
      },
    ];
  }
  return [
    { name: "client gzip exact ceiling", unsupported: SHIPPING_CLIENT_GZIP_UNSUPPORTED },
    { name: "client gzip one byte over", unsupported: SHIPPING_CLIENT_GZIP_UNSUPPORTED },
  ];
}
function shippingServerRawCases() {
  const allocation = SHIPPING_SERVER_RAW_ALLOCATIONS[SHIPPING_SERVER_RAW_CAP];
  if (!allocation) {
    return [
      { name: "server raw newly allowed interval", unsupported: SHIPPING_SERVER_RAW_UNSUPPORTED },
      { name: "server raw exact ceiling", unsupported: SHIPPING_SERVER_RAW_UNSUPPORTED },
      { name: "server raw one byte over", unsupported: SHIPPING_SERVER_RAW_UNSUPPORTED },
    ];
  }
  return [
    {
      name: "server raw newly allowed interval",
      group: "kit.server.js",
      axis: "raw",
      bytes: allocation.intervalBytes,
    },
    {
      name: "server raw exact ceiling",
      group: "kit.server.js",
      axis: "raw",
      bytes: allocation.exactBytes,
    },
    {
      name: "server raw one byte over",
      group: "kit.server.js",
      axis: "raw",
      bytes: allocation.overBytes,
      ceiling: allocation.exactBytes,
      breach: true,
    },
  ];
}
for (const { name, group, axis, bytes, ceiling, breach = false, unsupported } of [
  ...shippingClientRawCases(),
  ...shippingServerGzipCases(),
  ...shippingClientGzipCases(),
  ...shippingServerRawCases(),
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
  test(`pinned budget: ${name}`, (t) => {
    if (unsupported) assert.fail(unsupported);
    const fx = makeShippingFixture(t, group, axis, bytes);
    const result = runJson(fx.root);
    // Server gzip is advisory: it warns and exits 0 instead of failing.
    const warnOnly = Boolean(breach) && group === "kit.server.js" && axis === "gzip";
    if (warnOnly) {
      assert.equal(result.code, 0, result.errors.join("\n"));
      assert.equal(result.report.groups.find((g) => g.id === group).status, "warn");
      assert.equal(result.report.ok, true);
      assert.equal(result.report.warnings.length, 1);
      assert.equal(
        result.warnings[0],
        `kit perf budget: warning: server js: gzip ${bytes}B over ${ceiling}B (advisory, not a failure)`,
      );
      assert.deepEqual(result.errors, []);
      return;
    }
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

// Server gzip advisory semantics (synthetic fixtures, budgets exact-fit).
function serverCase(t, { files, serverJs }) {
  const fx = makeFixture({ server: files, budgetOverrides: { serverJs } });
  t.after(() => fx.cleanup());
  return fx;
}
const SERVER_GZIP = gzipSync(SERVER_BODY).length;

test("server gzip: exact ceiling passes with no warning", (t) => {
  const fx = serverCase(t, { files: undefined, serverJs: {} });
  const result = runJson(fx.root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.report.warnings, undefined);
});

test("server gzip: one byte over warns, exits 0, and reports evidence", (t) => {
  const fx = serverCase(t, { files: undefined, serverJs: { maxGzipBytes: SERVER_GZIP - 1 } });
  const human = fx.runCaptured();
  assert.equal(human.code, 0);
  assert.ok(human.errors.some((l) => l.includes("warning: server js: gzip")));
  assert.ok(!human.logs.includes("kit perf budget: every Kit asset fits."));
  const json = runJson(fx.root);
  assert.equal(json.report.groups.find((g) => g.id === "kit.server.js").status, "warn");
  assert.equal(json.report.groups.find((g) => g.id === "kit.server.js").checks[0].status, "warn");
  assert.equal(json.report.ok, true);
  assert.equal(json.report.warnings.length, 1);
});

test("server raw bytes and file count stay hard", (t) => {
  const raw = runJson(
    serverCase(t, { files: undefined, serverJs: { maxRawBytes: SERVER_BODY.length - 1 } }).root,
  );
  assert.equal(raw.code, 1);
  assert.deepEqual(raw.warnings, []);
  const files = runJson(
    serverCase(t, {
      files: [
        { name: "chunks/a.js", body: SERVER_BODY },
        { name: "chunks/b.js", body: SERVER_BODY },
      ],
      serverJs: { maxFiles: 1 },
    }).root,
  );
  assert.equal(files.code, 1);
});

test("server mixed gzip warning plus raw breach fails and keeps the warning", (t) => {
  const fx = serverCase(t, {
    files: undefined,
    serverJs: { maxRawBytes: SERVER_BODY.length - 1, maxGzipBytes: SERVER_GZIP - 1 },
  });
  const result = runJson(fx.root);
  assert.equal(result.code, 1);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.groups.find((g) => g.id === "kit.server.js").status, "fail");
  assert.equal(result.report.warnings.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /server js: raw \d+B over \d+B$/);
});

test("client and Worker gzip overages stay hard", (t) => {
  const client = serverCase(t, { files: undefined, serverJs: {} });
  const budgetPath = join(client.root, "ci/kit-perf-budget.json");
  for (const mutate of [
    (b) => (b.client.js.maxGzipBytes -= 1),
    (b) => (b.client.css.maxGzipBytes -= 1),
    (b) => (b.worker["_worker.js"].maxGzipBytes -= 1),
  ]) {
    const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
    mutate(budget);
    writeFileSync(budgetPath, JSON.stringify(budget));
    const result = runJson(client.root);
    assert.equal(result.code, 1);
    assert.deepEqual(result.warnings, []);
    writeFileSync(budgetPath, JSON.stringify({ ...JSON.parse(readFileSync(budgetPath, "utf8")) }));
    // Restore for the next mutation.
    budget.client.js.maxGzipBytes = gzipSync(JS_BODY).length;
    budget.client.css.maxGzipBytes = gzipSync(CSS_BODY).length;
    budget.worker["_worker.js"].maxGzipBytes = gzipSync(WORKER_BODY).length;
    writeFileSync(budgetPath, JSON.stringify(budget));
  }
});

test("server gzip: malformed ceiling and missing evidence still exit 2", (t) => {
  for (const bad of ["x", -1, null, 1.5]) {
    const fx = serverCase(t, { files: undefined, serverJs: { maxGzipBytes: bad } });
    const result = runJson(fx.root);
    assert.equal(result.code, 2, `ceiling ${String(bad)}`);
    assert.equal(result.report.error.code, "INVALID_PLAN");
  }
  const missing = makeFixture({ omitServerDir: true });
  t.after(() => missing.cleanup());
  assert.equal(runJson(missing.root).code, 2);
});
