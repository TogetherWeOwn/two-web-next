import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { runJson } from "./check-kit-perf.mjs";

const WORKER = Buffer.from("/* worker */\nexport default {};\n");
const SERVER = Buffer.from("export const server = true;\n");
const JS = Buffer.from("console.log('client');\n");
const CSS = Buffer.from(".card { color: red; }\n");
const WORKER_GZIP = gzipSync(WORKER).length;
const CSS_GZIP = gzipSync(CSS).length;

function fixture(t, notes) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-note-regression-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, bytes) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  write("web/.svelte-kit/cloudflare/_worker.js", WORKER);
  write("web/.svelte-kit/output/server/chunks/server.js", SERVER);
  write("web/.svelte-kit/output/client/_app/immutable/client.js", JS);
  write("web/.svelte-kit/output/client/_app/immutable/a.css", CSS);
  write("web/.svelte-kit/output/client/_app/immutable/b.css", CSS);
  write(
    "ci/kit-perf-budgets/base.json",
    JSON.stringify({
      worker: { "_worker.js": { maxRawBytes: WORKER.length, maxGzipBytes: WORKER_GZIP } },
      server: {
        js: { maxRawBytes: SERVER.length, maxGzipBytes: gzipSync(SERVER).length, maxFiles: 1 },
      },
      client: {
        js: { maxRawBytes: JS.length, maxGzipBytes: gzipSync(JS).length, maxFiles: 1 },
        css: { maxRawBytes: CSS.length * 2, maxGzipBytes: CSS_GZIP * 2, maxFiles: 2 },
      },
      startup: { maxMs: 30_000 },
    }),
  );
  for (const [name, note] of Object.entries(notes)) {
    write(`ci/kit-perf-budgets/${name}.json`, JSON.stringify(note));
  }
  return root;
}

// Discarding updates into a cloned Worker/CSS target must fail these exact
// measured-ceiling assertions, even though the unchanged base also fits.
for (const [label, section, groupId, expected] of [
  [
    "Worker",
    "worker",
    "kit.worker",
    { maxRawBytes: WORKER.length + 8, maxGzipBytes: WORKER_GZIP + 5 },
  ],
  [
    "CSS",
    "client",
    "kit.client.css",
    { maxRawBytes: CSS.length * 2 + 12, maxGzipBytes: CSS_GZIP * 2 + 7, maxFiles: 5 },
  ],
]) {
  test(`notes regression: ${label} sums every declared ceiling across notes`, (t) => {
    const deltas =
      section === "worker"
        ? [
            { maxRawBytes: 3, maxGzipBytes: 2 },
            { maxRawBytes: 5, maxGzipBytes: 3 },
          ]
        : [
            { maxRawBytes: 5, maxGzipBytes: 3, maxFiles: 1 },
            { maxRawBytes: 7, maxGzipBytes: 4, maxFiles: 2 },
          ];
    const target = section === "worker" ? "_worker.js" : "css";
    const root = fixture(t, {
      20: { note: "first measured adjustment", [section]: { [target]: deltas[0] } },
      3: { note: "second measured adjustment", [section]: { [target]: deltas[1] } },
    });
    const result = runJson(root);
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.equal(result.report.ok, true);
    const check = result.report.groups.find((group) => group.id === groupId).checks[0];
    for (const [field, value] of Object.entries(expected)) assert.equal(check[field], value, field);
    assert.equal(check.status, "pass");
  });
}

for (const [section, target, groupId, field] of [
  ["worker", "_worker.js", "kit.worker", "maxRawBytes"],
  ["worker", "_worker.js", "kit.worker", "maxGzipBytes"],
  ["client", "css", "kit.client.css", "maxRawBytes"],
  ["client", "css", "kit.client.css", "maxGzipBytes"],
  ["client", "css", "kit.client.css", "maxFiles"],
]) {
  test(`notes regression: ${groupId} ${field} reduction breaches an exact-fit asset`, (t) => {
    const root = fixture(t, {
      9: { note: "reduce this ceiling by one", [section]: { [target]: { [field]: -1 } } },
    });
    const result = runJson(root);
    assert.equal(result.code, 1, result.errors.join("\n"));
    assert.equal(result.report.exitCode, 1);
    assert.equal(result.report.ok, false);
    assert.equal(result.report.groups.find((group) => group.id === groupId).status, "fail");
    assert.ok(!result.logs.some((line) => line.includes("every Kit asset fits")));
  });
}

// Removing either section's object guard must turn its empty-array case red:
// Object.entries([]) otherwise applies nothing and the exact-fit base passes.
for (const section of ["server", "client"]) {
  for (const [label, value] of [
    ["empty array", []],
    ["null", null],
    ["empty string", ""],
    ["number", 0],
    ["boolean", false],
  ]) {
    test(`notes regression: ${section} rejects ${label} section as INVALID_PLAN`, (t) => {
      const root = fixture(t, { 9: { note: "malformed adjustment", [section]: value } });
      const result = runJson(root);
      assert.equal(result.code, 2);
      assert.equal(result.report.exitCode, 2);
      assert.equal(result.report.ok, false);
      assert.equal(result.report.error.code, "INVALID_PLAN");
      assert.match(
        result.report.error.message,
        new RegExp(`9\\.json: ${section} must be an object`),
      );
      assert.ok(result.report.groups.every((group) => group.status === "cannot-enforce"));
      assert.ok(!result.logs.some((line) => line.includes("every Kit asset fits")));
    });
  }
}

test("notes regression: omitted optional sections still allow an exact-fit base", (t) => {
  const root = fixture(t, { 9: { note: "record the unchanged ceiling" } });
  const result = runJson(root);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.equal(result.report.ok, true);
  assert.ok(result.logs.some((line) => line.includes("every Kit asset fits")));
});
