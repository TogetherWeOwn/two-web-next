// Budget fragments: ci/kit-perf-budget.json and ci/bundle-budget.json were
// single shared files whose one-line $comment decision history made almost
// every open PR conflict with every merge. Ceilings now live one unit per
// file under ci/budgets/<kind>/, and the checkers aggregate them at CI time
// (ci/budget-fragments.mjs). These tests prove the aggregation reproduces
// the exact pre-split ceilings, keeps the checkers' exit semantics
// (0 fits, 1 breach, 2 cannot enforce), fails closed on ambiguous or broken
// fragments, and preserves the legacy $comment history byte-for-byte.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadBundleBudgets, loadKitBudget } from "./budget-fragments.mjs";
import { run as runBundle } from "./check-bundle-budget.mjs";
import { run as runKit } from "./check-kit-perf.mjs";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// The exact ceilings shipped in the monolith files before the split
// (ci/kit-perf-budget.json and ci/bundle-budget.json at the split commit),
// plus the raise that landed on main during the split review and was
// ported into its fragment (client.js.maxRawBytes 254976 -> 256000; see
// ci/budgets/decisions/kit-perf/2026-10-26-client-js-raw-256000.md), the
// server.js.maxGzipBytes 335104 -> 335360 raise (see
// ci/budgets/decisions/kit-perf/2026-10-26-server-gzip-335360.md), and the
// one new-asset fragment ported from an open branch during its post-split
// merge: public/islands/event-time-from-now.js 2048/1024 (see
// ci/budgets/decisions/bundle/2026-10-26-event-time-from-now.md).
// Aggregation must reproduce them exactly: any drift here is a budget
// change, which needs its own decision file, never a silent edit.
const SHIPPING_KIT_BUDGET = {
  worker: { "_worker.js": { maxRawBytes: 3584, maxGzipBytes: 1536 } },
  server: { js: { maxRawBytes: 1203200, maxGzipBytes: 335360, maxFiles: 126 } },
  client: {
    js: { maxRawBytes: 257024, maxGzipBytes: 103168, maxFiles: 55 },
    css: { maxRawBytes: 3072, maxGzipBytes: 1280, maxFiles: 4 },
  },
  startup: { maxMs: 60000 },
};

const SHIPPING_BUNDLE_BUDGETS = {
  "public/islands/admin-event-editor.js": { maxRawBytes: 2048, maxGzipBytes: 1024 },
  "public/islands/admin-event-text-limits.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
  "public/islands/auth-status.js": { maxRawBytes: 3072, maxGzipBytes: 1536 },
  "public/islands/avatar.js": { maxRawBytes: 512, maxGzipBytes: 512 },
  "public/islands/copy-link.js": { maxRawBytes: 2048, maxGzipBytes: 1024 },
  "public/islands/event-device-timezone.js": { maxRawBytes: 2560, maxGzipBytes: 1280 },
  "public/islands/event-share.js": { maxRawBytes: 1024, maxGzipBytes: 768 },
  "public/islands/events-calendar.js": { maxRawBytes: 10752, maxGzipBytes: 4096 },
  "public/islands/going-count.js": { maxRawBytes: 5632, maxGzipBytes: 2304 },
  "public/islands/join-widget.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
  "public/islands/member-profile.js": { maxRawBytes: 15872, maxGzipBytes: 5632 },
  "public/islands/model-context.js": { maxRawBytes: 4608, maxGzipBytes: 2048 },
  "public/islands/past-events.js": { maxRawBytes: 5120, maxGzipBytes: 2048 },
  "public/islands/rsvp-button.js": { maxRawBytes: 17408, maxGzipBytes: 5120 },
  "public/islands/attendees-live.js": { maxRawBytes: 5120, maxGzipBytes: 2048 },
  "public/styles.css": { maxRawBytes: 6144, maxGzipBytes: 2048 },
  "public/admin-rsvp-review.css": { maxRawBytes: 1024, maxGzipBytes: 512 },
  "public/operator-overrides-theme.css": { maxRawBytes: 512, maxGzipBytes: 256 },
  "public/theme.css": { maxRawBytes: 15360, maxGzipBytes: 3584 },
  "public/theme-tokens.css": { maxRawBytes: 1536, maxGzipBytes: 512 },
  "public/event-theme.css": { maxRawBytes: 7168, maxGzipBytes: 2048 },
  "public/profile-theme.css": { maxRawBytes: 8704, maxGzipBytes: 2048 },
  "public/schedule-theme.css": { maxRawBytes: 6144, maxGzipBytes: 1792 },
  "public/islands/local-time-compare.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
  "public/islands/event-time-from-now.js": { maxRawBytes: 2048, maxGzipBytes: 1024 },
};

// sha256 of the frozen legacy-history archives: header + the verbatim
// pre-split $comment. If either hash changes, decision history was edited.
const LEGACY_HISTORY = [
  [
    "ci/budgets/decisions/kit-perf/0000-legacy-history-through-2026-10-26.md",
    "c564eb780daa8f77f43365628e93b9c33c216451f1b9769b55d997085579ec45",
  ],
  [
    "ci/budgets/decisions/bundle/0000-legacy-history-through-2026-10-26.md",
    "76fcc6de2741ebcce84e986fd60ae89d9813e07081bf2ceba86cff0929dbb84e",
  ],
];

function scratchRoot(t, label) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), label));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root, relative, body) {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

const sink = { log() {}, error() {} };

function kitFixture(t, fragments) {
  const root = scratchRoot(t, "budget-fragments-kit-");
  const worker = Buffer.from(`/* worker */\n${"x".repeat(1000)}`);
  const server = Buffer.from(`/* server chunk */\n${"w".repeat(800)}`);
  const js = Buffer.from(`console.log(1);\n${"y".repeat(500)}`);
  const css = Buffer.from(`.a{color:red}\n${"z".repeat(200)}`);
  writeFile(root, "web/.svelte-kit/cloudflare/_worker.js", worker);
  writeFile(root, "web/.svelte-kit/output/server/chunks/a.js", server);
  writeFile(root, "web/.svelte-kit/output/client/_app/immutable/a.js", js);
  writeFile(root, "web/.svelte-kit/output/client/_app/immutable/a.css", css);
  const exact = (body) => ({ maxRawBytes: body.length, maxGzipBytes: gzipSync(body).length });
  const defaults = {
    "worker.json": { worker: { "_worker.js": exact(worker) } },
    "server.json": { server: { js: { ...exact(server), maxFiles: 4 } } },
    "client-js.json": { client: { js: { ...exact(js), maxFiles: 4 } } },
    "client-css.json": { client: { css: { ...exact(css), maxFiles: 4 } } },
    "startup.json": { startup: { maxMs: 30000 } },
  };
  for (const [name, fragment] of Object.entries({ ...defaults, ...fragments })) {
    if (fragment !== null) writeFile(root, `ci/budgets/kit/${name}`, JSON.stringify(fragment));
  }
  return root;
}

// Admitted server.js maxGzipBytes allocations. The SHIPPING_KIT_BUDGET pin
// above (335104) is the historical baseline; 335360 is the second,
// independently measured saved-review allocation (combined worst 335164,
// margin 196; lower 335104 rejects by 60; the next 256B step 335616 stays
// unsupported); 335872 is the third, independently measured allocation
// (measured 335639, margin 233; lower 335616 rejects by 23); 336128 is the
// fourth, independently measured allocation (combined worst 335901, margin
// 227; lower 335872 rejects by 29; the next 256B step 336384 was
// unsupported then); 336384 is the fifth, event-share-honesty allocation
// (combined worst 336168, margin 216; lower 336128 rejects by 40); 336640 is
// the sixth, unrenderable-time guard allocation (combined worst 336514, margin
// 126; lower 336384 rejects by 130); 336896 is the seventh, featured-unpublish
// allocation (combined worst 336801, margin 95; lower 336640 rejects by 161).
// 337152 admits the host/join composition after featured-unpublish landed
// (measured 337015 before a behavior-preserving URL-check size reduction).
// 337664 admits the honest roster/venue states composed with host/join
// (latest composition 337545; current main 337408 rejects by 137).
// Every other pin stays exact: the oracle rejects any ceiling outside this
// list, then deep-compares the rest of the plan.
// 337408 admits the ongoing-night composition on statement-deadline main
// (measured 337286; the previous 337152 ceiling rejects by 134).
// 337920 admits GET /version on current main (measured 337718; 337664 rejects by 54)
// and the Kit outage-header CTA composed with it (two builds 337793 and 337795).
// 338176 admits the activity-log recovery links on current main (two builds
// 338013 and 338012; 337920 rejects by 93 and 92).
// 338432 admits the MCP result budget on main 004ce006 (two builds 338213
// and 338213; 338176 rejects by 37).
// 338688 admits the MCP truncation notice on top of it (two builds 338619;
// 338432 rejects by 187).
const SHIPPING_SERVER_GZIP_ALLOCATIONS = [
  335104, 335360, 335872, 336128, 336384, 336640, 336896, 337152, 337408, 337664, 337920, 338176,
  338432, 338688,
];
// Admitted server.js maxRawBytes allocations. The SHIPPING_KIT_BUDGET pin
// above (1203200) is the historical baseline; 1203968 admits the
// agent-event statement-deadline composition (measured combined worst
// 1203932, margin 36; lower step 1203712 rejects by 220; see
// ci/budgets/decisions/kit-perf/2026-10-29-agent-event-deadlines-server-raw.md).
// 1205504 admits that main plus ongoing-night renderers (measured 1205293;
// the lower 1205248 step rejects by 45).
// 1207040 admits the roster/venue composition (1206782; main 1205504 rejects by 1278).
// 1207552 admits GET /version on current main (1207318; 1207040 rejects by 278).
// 1208064 admits the Kit outage-header CTA composed with GET /version
// (two builds 1207650 and 1207652; main 1207552 rejects by 98 and 100).
// 1209344 admits the activity-log recovery links on current main
// (two builds 1209132 and 1209130; main 1208064 rejects by 1068 and 1066).
// 1209856 admits the MCP result budget on main 004ce006 (two builds 1209740
// and 1209742; 1209344 rejects by 396 and 398).
// 1211392 admits the MCP truncation notice on top of it (two builds 1210976;
// 1209856 rejects by 1120).
const SHIPPING_SERVER_RAW_ALLOCATIONS = [
  1203200, 1203968, 1205504, 1207040, 1207552, 1208064, 1209344, 1209856, 1211392,
];
// Admitted client.js [maxRawBytes, maxGzipBytes] pairs. 257024/103168 is the
// SHIPPING_KIT_BUDGET baseline; 258048/103424 is the event-detail second step
// on current main (measured union 258023 raw / 103383 gzip, margins 25 / 41;
// the lower 257536 raw step rejects by 487 and 103168 gzip by 215). Pairs are
// admitted together, never per axis: any other pair is compared against the
// baseline pin and fails.
const SHIPPING_CLIENT_JS_ALLOCATIONS = [
  [257024, 103168],
  [258048, 103424],
  // Initial-base host/join allocation: 258282/103538; the latest composed
  // build remains within this pair at 258554/103627 after URL-check simplification.
  [258560, 103680],
  // Honest roster/venue states: two merged builds 259224/103522; the lower
  // 258560 raw step rejects by 664, gzip ceiling unchanged.
  [259584, 103680],
  // Kit outage-header CTA: two builds 259746/103695; the lower pair rejects
  // raw by 162 and gzip by 15.
  [260096, 103936],
  // Activity-log recovery links: two builds 260403/103909; the lower 260096
  // raw step rejects by 307, gzip ceiling unchanged.
  [260608, 103936],
];

function assertShippingKitBudget(actual) {
  const gzip = actual?.server?.js?.maxGzipBytes;
  assert.ok(
    SHIPPING_SERVER_GZIP_ALLOCATIONS.includes(gzip),
    `unsupported server gzip allocation ${String(gzip)}: expected one of 335104, 335360, 335872, 336128, 336384, 336640, 336896, 337152, 337408, 337664, 337920, 338176, 338432, 338688`,
  );
  const serverRaw = actual?.server?.js?.maxRawBytes;
  assert.ok(
    SHIPPING_SERVER_RAW_ALLOCATIONS.includes(serverRaw),
    `unsupported server raw allocation ${String(serverRaw)}: expected one of 1203200, 1203968, 1205504, 1207040, 1207552, 1208064, 1209344, 1209856, 1211392`,
  );
  const clientJs = actual?.client?.js;
  const [maxRawBytes, maxGzipBytes] = SHIPPING_CLIENT_JS_ALLOCATIONS.find(
    ([raw, clientGzip]) => clientJs?.maxRawBytes === raw && clientJs?.maxGzipBytes === clientGzip,
  ) ?? [SHIPPING_KIT_BUDGET.client.js.maxRawBytes, SHIPPING_KIT_BUDGET.client.js.maxGzipBytes];
  assert.deepEqual(actual, {
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: serverRaw, maxGzipBytes: gzip },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes, maxGzipBytes },
    },
  });
}

test("kit fragments aggregate to an admitted shipping allocation", () => {
  assertShippingKitBudget(loadKitBudget(repoRoot));
});

test("shipping oracle admits the measured 335360 server gzip allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 335360 } },
  });
});

test("shipping oracle admits the measured 335872 server gzip allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 335872 } },
  });
});

test("shipping oracle admits the measured 336128 server gzip allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 336128 } },
  });
});

test("shipping oracle admits the measured 336384 server gzip allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 336384 } },
  });
});

test("shipping oracle admits the measured 336640 server gzip allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 336640 } },
  });
});

test("shipping oracle admits the measured 336896 server gzip allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 336896 } },
  });
});

test("shipping oracle admits the measured host/join allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes: 337152 } },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 258560, maxGzipBytes: 103680 },
    },
  });
});

test("shipping oracle admits the measured roster/venue allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1207040, maxGzipBytes: 337664 },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 259584, maxGzipBytes: 103680 },
    },
  });
});

test("shipping oracle admits the measured /version server allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1207552, maxGzipBytes: 337920 },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 259584, maxGzipBytes: 103680 },
    },
  });
});

test("shipping oracle admits the measured outage-header allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1208064, maxGzipBytes: 337920 },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 260096, maxGzipBytes: 103936 },
    },
  });
});

test("shipping oracle admits the measured activity-log recovery allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1209344, maxGzipBytes: 338176 },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 260608, maxGzipBytes: 103936 },
    },
  });
});

test("shipping oracle admits the measured MCP result-budget server allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1209856, maxGzipBytes: 338432 },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 260608, maxGzipBytes: 103936 },
    },
  });
});

test("shipping oracle admits the measured MCP truncation-notice server allocations together", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1211392, maxGzipBytes: 338688 },
    },
    client: {
      ...SHIPPING_KIT_BUDGET.client,
      js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 260608, maxGzipBytes: 103936 },
    },
  });
});

test("shipping oracle admits the measured 1203968 server raw allocation", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1203968 } },
  });
});

test("shipping oracle admits the measured ongoing-night server allocations", () => {
  assertShippingKitBudget({
    ...SHIPPING_KIT_BUDGET,
    server: {
      js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes: 1205504, maxGzipBytes: 337408 },
    },
  });
});

test("shipping oracle rejects an unsupported server raw allocation", () => {
  for (const maxRawBytes of [
    1203201, 1203712, 1203967, 1203969, 1205248, 1205503, 1205505, 1207551, 1207553, 1209343,
    1209345, 1209855, 1209857, 1211391, 1211393,
  ]) {
    const unsupported = {
      ...SHIPPING_KIT_BUDGET,
      server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxRawBytes } },
    };
    assert.throws(
      () => assertShippingKitBudget(unsupported),
      new RegExp(`unsupported server raw allocation ${maxRawBytes}`),
    );
  }
});

test("shipping oracle rejects an unsupported server gzip allocation", () => {
  for (const maxGzipBytes of [
    335105, 335359, 335616, 336385, 336641, 336897, 337153, 337407, 337409, 337919, 337921, 338175,
    338177, 338431, 338433, 338687, 338689,
  ]) {
    const unsupported = {
      ...SHIPPING_KIT_BUDGET,
      server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes } },
    };
    assert.throws(
      () => assertShippingKitBudget(unsupported),
      new RegExp(`unsupported server gzip allocation ${maxGzipBytes}`),
    );
  }
  assert.throws(() => assertShippingKitBudget({}), /unsupported server gzip allocation/);
});

test("shipping oracle rejects off-axis drift at an admitted allocation", () => {
  const drifts = [
    [
      "server raw",
      (plan) => (plan.server.js.maxRawBytes += 1),
      /unsupported server raw allocation 1203201/,
    ],
    ["server files", (plan) => (plan.server.js.maxFiles += 1)],
    ["client raw", (plan) => (plan.client.js.maxRawBytes += 1)],
    ["client gzip", (plan) => (plan.client.js.maxGzipBytes += 1)],
    ["client files", (plan) => (plan.client.js.maxFiles += 1)],
    ["client css gzip", (plan) => (plan.client.css.maxGzipBytes += 1)],
    ["worker gzip", (plan) => (plan.worker["_worker.js"].maxGzipBytes += 1)],
    ["startup", (plan) => (plan.startup.maxMs += 1)],
  ];
  for (const [label, drift, expected = /Expected values to be strictly deep-equal/] of drifts) {
    const plan = JSON.parse(JSON.stringify(SHIPPING_KIT_BUDGET));
    plan.server.js.maxGzipBytes = 335360;
    drift(plan);
    assert.throws(
      () => assertShippingKitBudget(plan),
      expected,
      `${label} drift must fail the shipping oracle`,
    );
  }
});

test("shipping oracle admits the measured 258048/103424 client js allocation", () => {
  for (const maxGzipBytes of SHIPPING_SERVER_GZIP_ALLOCATIONS) {
    assertShippingKitBudget({
      ...SHIPPING_KIT_BUDGET,
      server: { js: { ...SHIPPING_KIT_BUDGET.server.js, maxGzipBytes } },
      client: {
        ...SHIPPING_KIT_BUDGET.client,
        js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes: 258048, maxGzipBytes: 103424 },
      },
    });
  }
});

test("shipping oracle rejects client js pairs outside the admitted list", () => {
  for (const [maxRawBytes, maxGzipBytes] of [
    [258047, 103424],
    [258049, 103424],
    [258048, 103423],
    [258048, 103425],
    [257536, 103424],
    [258048, 103168],
    [257024, 103424],
    [258048, 103680],
    [258560, 103424],
    [258559, 103680],
    [258561, 103680],
    [258560, 103679],
    [258560, 103681],
    [260096, 103680],
    [259584, 103936],
    [260095, 103936],
    [260097, 103936],
    [260096, 103935],
    [260096, 103937],
    [260608, 103680],
    [260607, 103936],
    [260609, 103936],
    [260608, 103935],
    [260608, 103937],
  ]) {
    assert.throws(
      () =>
        assertShippingKitBudget({
          ...SHIPPING_KIT_BUDGET,
          client: {
            ...SHIPPING_KIT_BUDGET.client,
            js: { ...SHIPPING_KIT_BUDGET.client.js, maxRawBytes, maxGzipBytes },
          },
        }),
      /Expected values to be strictly deep-equal/,
      `client js ${maxRawBytes}/${maxGzipBytes} must fail the shipping oracle`,
    );
  }
});

test("shipping oracle rejects off-axis drift at the 258048/103424 client js allocation", () => {
  const drifts = [
    [
      "server raw",
      (plan) => (plan.server.js.maxRawBytes += 1),
      /unsupported server raw allocation 1203201/,
    ],
    ["server files", (plan) => (plan.server.js.maxFiles += 1)],
    ["client raw", (plan) => (plan.client.js.maxRawBytes += 1)],
    ["client gzip", (plan) => (plan.client.js.maxGzipBytes += 1)],
    ["client files", (plan) => (plan.client.js.maxFiles += 1)],
    ["client css gzip", (plan) => (plan.client.css.maxGzipBytes += 1)],
    ["worker gzip", (plan) => (plan.worker["_worker.js"].maxGzipBytes += 1)],
    ["startup", (plan) => (plan.startup.maxMs += 1)],
  ];
  for (const [label, drift, expected = /Expected values to be strictly deep-equal/] of drifts) {
    const plan = JSON.parse(JSON.stringify(SHIPPING_KIT_BUDGET));
    plan.server.js.maxGzipBytes = 336384;
    plan.client.js.maxRawBytes = 258048;
    plan.client.js.maxGzipBytes = 103424;
    assertShippingKitBudget(JSON.parse(JSON.stringify(plan)));
    drift(plan);
    assert.throws(
      () => assertShippingKitBudget(plan),
      expected,
      `${label} drift must fail the shipping oracle`,
    );
  }
});

test("bundle fragments aggregate to the exact pre-split ceilings", () => {
  assert.deepEqual(loadBundleBudgets(repoRoot), SHIPPING_BUNDLE_BUDGETS);
});

test("every shipping fragment carries exactly one budget unit", () => {
  // The anti-conflict grain: a future PR must touch one small file, never a
  // shared list. A fragment that grows a second unit reintroduces the
  // shared-file collision this split removed.
  for (const name of readdirSync(join(repoRoot, "ci/budgets/bundle"))) {
    if (!name.endsWith(".json")) continue;
    const fragment = JSON.parse(readFileSync(join(repoRoot, "ci/budgets/bundle", name), "utf8"));
    assert.equal(
      Object.keys(fragment.budgets ?? {}).length,
      1,
      `bundle fragment ${name} must define exactly one budgets entry`,
    );
  }
  for (const name of readdirSync(join(repoRoot, "ci/budgets/kit"))) {
    if (!name.endsWith(".json")) continue;
    const fragment = JSON.parse(readFileSync(join(repoRoot, "ci/budgets/kit", name), "utf8"));
    let units = 0;
    for (const [section, value] of Object.entries(fragment)) {
      if (section.startsWith("$")) continue;
      units += section === "startup" ? 1 : Object.keys(value).length;
    }
    assert.equal(units, 1, `kit fragment ${name} must define exactly one budget unit`);
  }
});

for (const [relative, sha256] of LEGACY_HISTORY) {
  test(`legacy decision history is preserved byte-for-byte: ${relative}`, () => {
    const bytes = readFileSync(join(repoRoot, relative));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  });
}

test("kit checker fits a fragment tree exactly at its ceilings", (t) => {
  assert.equal(runKit(kitFixture(t, {}), sink), 0);
});

test("kit checker breach against a fragment ceiling exits 1", (t) => {
  const root = kitFixture(t, {
    "server.json": { server: { js: { maxRawBytes: 999999, maxGzipBytes: 1, maxFiles: 4 } } },
  });
  assert.equal(runKit(root, sink), 1);
});

test("duplicate kit unit across fragments cannot enforce (2)", (t) => {
  const root = kitFixture(t, {
    "server-copy.json": { server: { js: { maxRawBytes: 10, maxGzipBytes: 10, maxFiles: 1 } } },
  });
  const errors = [];
  const code = runKit(root, {
    log() {},
    error(text) {
      errors.push(String(text));
    },
  });
  assert.equal(code, 2);
  assert.ok(
    errors.some((line) => line.includes("duplicate") && line.includes("server.js")),
    `expected a duplicate-unit diagnostic, got: ${errors.join("; ")}`,
  );
});

test("malformed kit fragment cannot enforce (2)", (t) => {
  const root = kitFixture(t, {});
  writeFile(root, "ci/budgets/kit/server.json", "{");
  assert.equal(runKit(root, sink), 2);
});

test("kit fragments plus a legacy file is ambiguous and cannot enforce (2)", (t) => {
  const root = kitFixture(t, {});
  writeFile(root, "ci/kit-perf-budget.json", JSON.stringify(loadKitBudget(root)));
  assert.equal(runKit(root, sink), 2);
});

test("legacy single-file kit budget still loads for scratch fixtures", (t) => {
  const root = kitFixture(t, {
    "worker.json": null,
    "server.json": null,
    "client-js.json": null,
    "client-css.json": null,
    "startup.json": null,
  });
  rmSync(join(root, "ci/budgets/kit"), { recursive: true, force: true });
  const budget = {
    worker: { "_worker.js": { maxRawBytes: 3584, maxGzipBytes: 1536 } },
    server: { js: { maxRawBytes: 1203200, maxGzipBytes: 335104, maxFiles: 126 } },
    client: {
      js: { maxRawBytes: 254976, maxGzipBytes: 102912, maxFiles: 55 },
      css: { maxRawBytes: 3072, maxGzipBytes: 1024, maxFiles: 4 },
    },
    startup: { maxMs: 60000 },
  };
  writeFile(root, "ci/kit-perf-budget.json", JSON.stringify(budget));
  assert.deepEqual(loadKitBudget(root), budget);
  assert.equal(runKit(root, sink), 0);
});

function bundleFixture(t, fragments) {
  const root = scratchRoot(t, "budget-fragments-bundle-");
  const payload = Buffer.from(Array.from({ length: 128 }, (_, i) => `/* asset-${i} */\n`).join(""));
  writeFile(root, "public/islands/example.js", payload);
  writeFile(root, "public/styles.css", payload);
  const exact = { maxRawBytes: payload.length, maxGzipBytes: gzipSync(payload).length };
  const defaults = {
    "example.json": { budgets: { "public/islands/example.js": { ...exact } } },
    "styles.json": { budgets: { "public/styles.css": { ...exact } } },
  };
  for (const [name, fragment] of Object.entries({ ...defaults, ...fragments })) {
    writeFile(root, `ci/budgets/bundle/${name}`, JSON.stringify(fragment));
  }
  return { root, exact };
}

test("bundle checker fits a fragment tree exactly at its ceilings", (t) => {
  const { root } = bundleFixture(t, {});
  assert.equal(runBundle(root, sink), 0);
});

test("bundle checker breach against a fragment ceiling exits 1", (t) => {
  const { root, exact } = bundleFixture(t, {});
  writeFile(
    root,
    "ci/budgets/bundle/example.json",
    JSON.stringify({
      budgets: { "public/islands/example.js": { ...exact, maxRawBytes: exact.maxRawBytes - 1 } },
    }),
  );
  assert.equal(runBundle(root, sink), 1);
});

test("duplicate bundle entry across fragments cannot enforce (2)", (t) => {
  const { root } = bundleFixture(t, {
    "example-copy.json": {
      budgets: { "public/islands/example.js": { maxRawBytes: 1, maxGzipBytes: 1 } },
    },
  });
  const errors = [];
  const code = runBundle(root, {
    log() {},
    error(text) {
      errors.push(String(text));
    },
  });
  assert.equal(code, 2);
  assert.ok(
    errors.some((line) => line.includes("duplicate") && line.includes("public/islands/example.js")),
    `expected a duplicate-entry diagnostic, got: ${errors.join("; ")}`,
  );
});

test("bundle fragments plus a legacy file is ambiguous and cannot enforce (2)", (t) => {
  const { root, exact } = bundleFixture(t, {});
  writeFile(
    root,
    "ci/bundle-budget.json",
    JSON.stringify({ budgets: { "public/islands/example.js": exact } }),
  );
  assert.equal(runBundle(root, sink), 2);
});

test("missing kit budgets entirely cannot enforce (2)", (t) => {
  const root = scratchRoot(t, "budget-fragments-empty-");
  assert.equal(runKit(root, sink), 2);
  assert.throws(() => loadBundleBudgets(root));
});

test("empty kit fragment dir cannot enforce (2)", (t) => {
  const root = kitFixture(t, {});
  rmSync(join(root, "ci/budgets/kit"), { recursive: true, force: true });
  mkdirSync(join(root, "ci/budgets/kit"), { recursive: true });
  assert.equal(runKit(root, sink), 2);
});

test("bundle fragment with an unsupported top-level key cannot enforce (2)", (t) => {
  const { root, exact } = bundleFixture(t, {});
  // An otherwise-valid fragment carrying one real budgets entry: only the
  // unsupported-key guard can reject it (a bare { nope: {} } fragment is
  // rejected anyway for having no budgets object, which would leave the
  // guard itself unprotected by this test).
  writeFile(
    root,
    "ci/budgets/bundle/example.json",
    JSON.stringify({
      budgets: { "public/islands/example.js": { ...exact } },
      nope: {},
    }),
  );
  assert.equal(runBundle(root, sink), 2);
});

test("empty kit fragment beside valid fragments cannot enforce (2)", (t) => {
  const root = kitFixture(t, {});
  writeFile(root, "ci/budgets/kit/empty.json", "{}");
  assert.equal(runKit(root, sink), 2);
});

test("multi-unit kit fragment cannot enforce (2)", (t) => {
  // The valid client.js and client.css units together in one fragment,
  // with no separate css fragment: the aggregate is exactly the canonical
  // plan, so only the one-unit-per-fragment guard can reject this tree (an
  // invented extra unit is rejected by the plan validator anyway, which
  // would leave the guard itself unprotected by this test).
  const root = kitFixture(t, {
    "client-js.json": {
      client: {
        js: { maxRawBytes: 999999, maxGzipBytes: 999999, maxFiles: 9 },
        css: { maxRawBytes: 999999, maxGzipBytes: 999999, maxFiles: 9 },
      },
    },
    "client-css.json": null,
  });
  assert.equal(runKit(root, sink), 2);
});

test("empty bundle fragment beside valid fragments cannot enforce (2)", (t) => {
  const { root } = bundleFixture(t, {});
  writeFile(root, "ci/budgets/bundle/empty.json", JSON.stringify({ budgets: {} }));
  assert.equal(runBundle(root, sink), 2);
});

test("multi-entry bundle fragment cannot enforce (2)", (t) => {
  const { root, exact } = bundleFixture(t, {});
  writeFile(
    root,
    "ci/budgets/bundle/example.json",
    JSON.stringify({
      budgets: {
        "public/islands/example.js": { ...exact },
        "public/islands/extra.js": { ...exact },
      },
    }),
  );
  assert.equal(runBundle(root, sink), 2);
});

test("kit fragment magic keys cannot pollute Object.prototype (2)", (t) => {
  const root = kitFixture(t, {});
  writeFile(
    root,
    "ci/budgets/kit/pollution.json",
    '{"__proto__":{"polluted":{"maxRawBytes":1,"maxGzipBytes":1}}}',
  );
  assert.equal(runKit(root, sink), 2);
  assert.equal({}.polluted, undefined);
});

test("kit fragment with an unsupported empty section cannot enforce (2)", (t) => {
  // An empty unknown section contributes no unit, so it must not be able
  // to ride beside a valid unit and silently disappear before validation:
  // the aggregate would otherwise look exactly canonical and fit.
  const root = kitFixture(t, {
    "startup.json": { startup: { maxMs: 30000 }, typo: {} },
  });
  assert.equal(runKit(root, sink), 2);
});

test("kit fragment with an unsupported section is rejected by the loader", (t) => {
  const root = kitFixture(t, {
    "typo.json": { typo: { x: { maxRawBytes: 1, maxGzipBytes: 1, maxFiles: 1 } } },
  });
  assert.throws(() => loadKitBudget(root), /unsupported budget section: typo/);
});

test("kit fragment with an inherited section name cannot enforce (2)", (t) => {
  // "toString" is not a magic key, but (budget[section] ??= {}) would find
  // the inherited function instead of creating an own section, hiding the
  // unit from the validator and mutating Object.prototype.toString.
  const root = kitFixture(t, {});
  writeFile(
    root,
    "ci/budgets/kit/inherited.json",
    '{"toString":{"probeMarker":{"maxRawBytes":1,"maxGzipBytes":1}}}',
  );
  assert.equal(runKit(root, sink), 2);
  assert.equal(Object.prototype.toString.probeMarker, undefined);
});

test("kit fragment with an empty section beside a valid unit cannot enforce (2)", (t) => {
  // A known section with no entries defines nothing; accepting it would
  // let committed input claim a section it never actually budgets.
  const root = kitFixture(t, {
    "client-js.json": {
      client: { js: { maxRawBytes: 999999, maxGzipBytes: 999999, maxFiles: 9 } },
      server: {},
    },
  });
  assert.equal(runKit(root, sink), 2);
});
