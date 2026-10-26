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
// (ci/kit-perf-budget.json and ci/bundle-budget.json at the split commit).
// Aggregation must reproduce them exactly: any drift here is a budget
// change, which needs its own decision file, never a silent edit.
const SHIPPING_KIT_BUDGET = {
  worker: { "_worker.js": { maxRawBytes: 3584, maxGzipBytes: 1536 } },
  server: { js: { maxRawBytes: 1203200, maxGzipBytes: 335104, maxFiles: 126 } },
  client: {
    js: { maxRawBytes: 254976, maxGzipBytes: 102912, maxFiles: 55 },
    css: { maxRawBytes: 3072, maxGzipBytes: 1024, maxFiles: 4 },
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
  "public/islands/events-calendar.js": { maxRawBytes: 10240, maxGzipBytes: 3840 },
  "public/islands/going-count.js": { maxRawBytes: 5632, maxGzipBytes: 2304 },
  "public/islands/join-widget.js": { maxRawBytes: 1536, maxGzipBytes: 768 },
  "public/islands/member-profile.js": { maxRawBytes: 14336, maxGzipBytes: 5120 },
  "public/islands/model-context.js": { maxRawBytes: 4608, maxGzipBytes: 2048 },
  "public/islands/past-events.js": { maxRawBytes: 4608, maxGzipBytes: 1792 },
  "public/islands/rsvp-button.js": { maxRawBytes: 17408, maxGzipBytes: 5120 },
  "public/islands/attendees-live.js": { maxRawBytes: 5120, maxGzipBytes: 2048 },
  "public/styles.css": { maxRawBytes: 6144, maxGzipBytes: 2048 },
  "public/admin-rsvp-review.css": { maxRawBytes: 1024, maxGzipBytes: 512 },
  "public/theme.css": { maxRawBytes: 15360, maxGzipBytes: 3584 },
  "public/theme-tokens.css": { maxRawBytes: 1536, maxGzipBytes: 512 },
  "public/event-theme.css": { maxRawBytes: 7168, maxGzipBytes: 2048 },
  "public/profile-theme.css": { maxRawBytes: 8192, maxGzipBytes: 2048 },
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

test("kit fragments aggregate to the exact pre-split ceilings", () => {
  assert.deepEqual(loadKitBudget(repoRoot), SHIPPING_KIT_BUDGET);
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
  const { root } = bundleFixture(t, {});
  writeFile(root, "ci/budgets/bundle/extra.json", JSON.stringify({ nope: {} }));
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
