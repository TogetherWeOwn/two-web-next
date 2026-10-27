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
import {
  assertKitPlanMatchesLedger,
  flattenKitPlan,
  loadKitCeilingLedger,
} from "./budget-ledger.mjs";
import { loadBundleBudgets, loadKitBudget } from "./budget-fragments.mjs";
import { run as runBundle } from "./check-bundle-budget.mjs";
import { run as runKit } from "./check-kit-perf.mjs";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// The exact served-asset ceilings shipped in ci/bundle-budget.json at the
// split commit. Aggregation must reproduce them exactly: any drift here is
// a budget change, which needs its own decision file, never a silent edit.
// Kit ceilings carry no literal table: they are derived from the decision
// ledger (ci/budget-ledger.mjs), see the ledger tests below.
const SHIPPING_BUNDLE_BUDGETS = {
  "public/islands/admin-event-editor.js": { maxRawBytes: 2048, maxGzipBytes: 1024 },
  "public/islands/admin-event-text-limits.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
  "public/islands/auth-status.js": { maxRawBytes: 3072, maxGzipBytes: 1536 },
  "public/islands/avatar.js": { maxRawBytes: 512, maxGzipBytes: 512 },
  "public/islands/copy-link.js": { maxRawBytes: 2048, maxGzipBytes: 1024 },
  "public/islands/event-device-timezone.js": { maxRawBytes: 2560, maxGzipBytes: 1280 },
  "public/islands/event-share.js": { maxRawBytes: 1024, maxGzipBytes: 768 },
  "public/islands/events-calendar.js": { maxRawBytes: 10240, maxGzipBytes: 3840 },
  "public/islands/going-count.js": { maxRawBytes: 5632, maxGzipBytes: 2304 },
  "public/islands/join-widget.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
  "public/islands/member-profile.js": { maxRawBytes: 15872, maxGzipBytes: 5632 },
  "public/islands/model-context.js": { maxRawBytes: 4608, maxGzipBytes: 2048 },
  "public/islands/past-events.js": { maxRawBytes: 4608, maxGzipBytes: 1792 },
  "public/islands/rsvp-button.js": { maxRawBytes: 17408, maxGzipBytes: 5120 },
  "public/islands/attendees-live.js": { maxRawBytes: 5120, maxGzipBytes: 2048 },
  "public/styles.css": { maxRawBytes: 6144, maxGzipBytes: 2048 },
  "public/admin-rsvp-review.css": { maxRawBytes: 1024, maxGzipBytes: 512 },
  "public/theme.css": { maxRawBytes: 15360, maxGzipBytes: 3584 },
  "public/theme-tokens.css": { maxRawBytes: 1536, maxGzipBytes: 512 },
  "public/event-theme.css": { maxRawBytes: 7168, maxGzipBytes: 2048 },
  "public/profile-theme.css": { maxRawBytes: 8704, maxGzipBytes: 2048 },
  "public/schedule-theme.css": { maxRawBytes: 6144, maxGzipBytes: 1792 },
  "public/islands/local-time-compare.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
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

// The Kit aggregate pin is derived, not tabulated: every value in
// ci/budgets/kit/*.json must be declared by a `Ceiling:` line in a decision
// file (ci/budget-ledger.mjs), and every declaration must be carried by a
// fragment. Raising a ceiling is one fragment edit plus one new decision.
test("kit fragments aggregate to the ceilings their decision files declare", () => {
  assertKitPlanMatchesLedger(loadKitBudget(repoRoot), loadKitCeilingLedger(repoRoot));
});

test("the ledger covers every unit the shipping plan carries", () => {
  const flat = flattenKitPlan(loadKitBudget(repoRoot));
  assert.deepEqual(
    [...flat.keys()].sort(),
    [...loadKitCeilingLedger(repoRoot).keys()].sort(),
  );
  assert.ok(flat.size >= 12, "fewer shipping ceilings than expected");
});

function ledgerFixture(t, { fragment = {}, decisions = {} }) {
  const root = scratchRoot(t, "budget-ledger-");
  writeFile(root, "ci/budgets/kit/server-js.json", JSON.stringify(fragment));
  for (const [name, body] of Object.entries(decisions)) {
    writeFile(root, `ci/budgets/decisions/kit-perf/${name}`, body);
  }
  return root;
}

const SERVER_PLAN = { server: { js: { maxRawBytes: 100, maxGzipBytes: 50, maxFiles: 3 } } };
const SERVER_DECLARATIONS = [
  "Ceiling: server.js.maxRawBytes = 100",
  "Ceiling: server.js.maxGzipBytes = 50",
  "Ceiling: server.js.maxFiles = 3",
].join("\n");

test("ledger: a fragment value no decision declares fails closed", (t) => {
  const root = ledgerFixture(t, {
    decisions: { "0001-base.md": "Ceiling: server.js.maxRawBytes = 100\n" },
  });
  assert.throws(
    () => assertKitPlanMatchesLedger(SERVER_PLAN, loadKitCeilingLedger(root)),
    /server\.js\.maxGzipBytes = 50 has no decision file declaring it/,
  );
});

test("ledger: a raised fragment needs a newer decision, the latest declaration wins", (t) => {
  const root = ledgerFixture(t, {
    decisions: {
      "0001-base.md": SERVER_DECLARATIONS,
      "2026-10-27-raise.md": "Ceiling: server.js.maxGzipBytes = 60 (previous 50)\n",
    },
  });
  const ledger = loadKitCeilingLedger(root);
  assert.deepEqual(ledger.get("server.js.maxGzipBytes"), {
    value: 60,
    previous: 50,
    file: "2026-10-27-raise.md",
  });
  assert.throws(
    () => assertKitPlanMatchesLedger(SERVER_PLAN, ledger),
    /server\.js\.maxGzipBytes = 50 but the latest decision \(2026-10-27-raise\.md\) declares 60/,
  );
  const raised = { server: { js: { ...SERVER_PLAN.server.js, maxGzipBytes: 60 } } };
  assertKitPlanMatchesLedger(raised, ledger);
});

test("ledger: a declaration no fragment carries fails closed", (t) => {
  const root = ledgerFixture(t, {
    decisions: { "0001-base.md": `${SERVER_DECLARATIONS}\nCeiling: startup.maxMs = 1\n` },
  });
  assert.throws(
    () => assertKitPlanMatchesLedger(SERVER_PLAN, loadKitCeilingLedger(root)),
    /declares startup\.maxMs but no fragment carries it/,
  );
});

test("ledger: malformed, duplicate and non-increasing declarations throw", (t) => {
  for (const [body, pattern] of [
    ["Ceiling: server.js.maxGzipBytes 50\n", /malformed ceiling line/],
    ["Ceiling: server.js.maxGzipBytes = 5e1\n", /malformed ceiling line/],
    ["Ceiling: server.js.maxGzipBytes = 50 (was 40)\n", /malformed ceiling line/],
    [
      "Ceiling: server.js.maxGzipBytes = 50\nCeiling: server.js.maxGzipBytes = 60\n",
      /declared twice/,
    ],
    ["Ceiling: server.js.maxGzipBytes = 50 (previous 50)\n", /previous 50 must be below 50/],
    ["Ceiling: __proto__ = 1\n", /unsupported ceiling key/],
  ]) {
    const root = ledgerFixture(t, { decisions: { "0001-bad.md": body } });
    assert.throws(() => loadKitCeilingLedger(root), pattern, body);
  }
});

test("ledger: the frozen legacy archive and prose never count as declarations", () => {
  const ledger = loadKitCeilingLedger(repoRoot);
  for (const { file } of ledger.values()) assert.ok(!file.startsWith("0000-legacy"), file);
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
