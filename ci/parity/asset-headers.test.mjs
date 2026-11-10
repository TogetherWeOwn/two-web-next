import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareProductionRecordings, productionAssetPaths } from "./asset-headers.mjs";
import { slug } from "./vectors.mjs";

const paths = ["/_app/immutable/chunks/example.js", "/_app/version.json"];
const headers = { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" };
const names = Object.keys(headers);
const row = (status, overrides = {}) => ({
  response: {
    status,
    headers: { ...headers, ...overrides },
    body: { sha256: String(status) },
  },
});
const recording = (status) =>
  new Map(paths.map((path) => [`static/${slug(path)}`, { GET: row(status), HEAD: row(status) }]));

test("discovers every immutable file and version and requires the reviewed built headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-asset-headers-"));
  try {
    mkdirSync(join(dir, "_app/immutable/chunks"), { recursive: true });
    writeFileSync(join(dir, "_app/immutable/chunks/example.js"), "export {};");
    writeFileSync(join(dir, "_app/version.json"), "{}");
    const source = "/_app/*\n  X-Frame-Options: DENY\n";
    // Pinned adapter inserts generated rules into the source block.
    writeFileSync(
      join(dir, "_headers"),
      "/_app/*\n  Cache-Control: no-cache\n  X-Frame-Options: DENY\n",
    );
    assert.deepEqual(productionAssetPaths(dir, source), paths);
    writeFileSync(join(dir, "_headers"), "/_app/*\n  X-Frame-Options: SAMEORIGIN\n");
    assert.throws(() => productionAssetPaths(dir, source), /reviewed/);
    writeFileSync(join(dir, "_headers"), source);
    rmSync(join(dir, "_app/version.json"));
    assert.throws(() => productionAssetPaths(dir, source), /version.json/);
    writeFileSync(join(dir, "_app/version.json"), "{}");
    rmSync(join(dir, "_app/immutable"), { recursive: true });
    assert.throws(() => productionAssetPaths(dir, source), /immutable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new asset bodies differ but security headers must match Hono at the same paths", () => {
  const result = compareProductionRecordings(recording(404), recording(200), paths, names, []);
  assert.deepEqual(result.comparison.failures, []);
  assert.deepEqual(result.assets.failures, []);
  assert.equal(result.assets.rows.length, paths.length * 2);
  assert.deepEqual(result.assets.rows[0].baseline, headers);
  assert.equal(result.assets.rows[0].baselineStatus, 404);
  assert.equal(result.assets.rows[0].candidateStatus, 200);
});

test("missing, changed or jointly absent asset headers fail without exceptions", () => {
  for (const value of [undefined, "SAMEORIGIN"]) {
    const a = recording(404);
    const b = recording(200);
    b.get(`static/${slug(paths[0])}`).GET = row(200, { "x-frame-options": value });
    const { assets } = compareProductionRecordings(a, b, paths, names, [
      { vector: "*", field: "*", reason: "not applicable to new asset headers" },
    ]);
    assert.equal(assets.failures.length, 1);
    assert.equal(assets.failures[0].field, "headers.x-frame-options");
  }
  const a = recording(404);
  const b = recording(200);
  for (const map of [a, b])
    map.get(`static/${slug(paths[0])}`).GET.response.headers["x-frame-options"] = undefined;
  assert.equal(compareProductionRecordings(a, b, paths, names, []).assets.failures.length, 1);
});

test("original inventory rows still compare complete responses", () => {
  const a = recording(404);
  const b = recording(200);
  a.set("routes/up", {
    GET: { response: { ...row(200).response, route: "/up", tailLabel: "/up" } },
  });
  b.set("routes/up", {
    GET: {
      response: {
        ...row(503, { "x-frame-options": "SAMEORIGIN" }).response,
        route: null,
        tailLabel: null,
      },
    },
  });
  const { comparison } = compareProductionRecordings(a, b, paths, names, []);
  for (const field of ["status", "route", "tailLabel", "body", "headers.x-frame-options"])
    assert.ok(
      comparison.failures.some((f) => f.key === "routes/up#GET" && f.field === field),
      field,
    );
});

test("missing records and missing or erroring built assets fail closed", () => {
  const a = recording(404);
  const b = recording(200);
  b.delete(`static/${slug(paths[0])}`);
  assert.equal(compareProductionRecordings(a, b, paths, names, []).assets.failures.length, 2);
  b.set(`static/${slug(paths[0])}`, { GET: row(404), HEAD: row(500) });
  const failed = compareProductionRecordings(a, b, paths, names, []).assets.failures;
  assert.equal(failed.length, 2);
  assert.ok(failed.every((f) => f.field === "asset.status"));
  assert.throws(() => compareProductionRecordings(a, b, [], names, []), /requires/);
  assert.throws(() => compareProductionRecordings(a, b, paths, [], []), /requires/);
  assert.throws(
    () => compareProductionRecordings(a, b, paths, ["x-frame-options"], []),
    /requires/,
  );
  assert.throws(() => compareProductionRecordings(a, b, ["/up"], names, []), /pre-hook/);
  assert.throws(
    () => compareProductionRecordings(a, b, [paths[0], paths[0]], names, []),
    /collide/,
  );
});
