import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { expectedCaptureNames } from "./join-evidence-contract.mjs";
import { createCaptureManifest } from "./join-evidence-manifest.mjs";

function chunk(type, data) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function image(width, height, marker) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  pixels[1] = marker;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fixture() {
  const names = expectedCaptureNames();
  const cases = names
    .map((file, index) => {
      const [, renderer, state, width] = /^(hono|kit)-(.+)-(1280|390)\.png$/.exec(file);
      const name = `${renderer} ${state} at ${width}`;
      return `    # Subtest: ${name}\n    ok ${index + 1} - ${name}`;
    })
    .join("\n");
  const suite = "Join presence state evidence";
  const tap = Buffer.from(
    `TAP version 13\n# Subtest: ${suite}\n${cases}\n    1..20\nok 1 - ${suite}\n1..1\n# tests 20\n# suites 1\n# pass 20\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
  );
  const files = new Map(
    names.map((name, index) => {
      const mobile = name.endsWith("-390.png");
      return [
        name,
        image(mobile ? 390 : 1280, (mobile ? 844 : 800) + (index === 0 ? 10 : 0), index + 1),
      ];
    }),
  );
  files.set("test-report.tap", tap);
  const expected = { application: "a".repeat(40), controller: "b".repeat(40) };
  return {
    files,
    entries: [...files.keys()].map((name) => ({ name, isFile: () => true })),
    actual: { ...expected, applicationClean: true, controllerClean: true },
    expected,
    runId: "123",
    runAttempt: "1",
  };
}

test("manifest hashes the validated captures and receipt", () => {
  const input = fixture();
  const manifest = createCaptureManifest(input);
  assert.equal(manifest.images.length, 20);
  assert.equal(manifest.applicationSha, input.expected.application);
  assert.equal(manifest.controllerSha, input.expected.controller);
  assert.equal(manifest.runId, input.runId);
  assert.equal(manifest.runAttempt, input.runAttempt);
  assert.equal(new Set(manifest.images.map((item) => item.sha256)).size, 20);
  assert.equal(
    manifest.reportSha256,
    createHash("sha256").update(input.files.get("test-report.tap")).digest("hex"),
  );
  for (const item of manifest.images) {
    assert.equal(
      item.sha256,
      createHash("sha256").update(input.files.get(item.file)).digest("hex"),
    );
    const [, renderer, state, size] = /^(hono|kit)-(.+)-(1280|390)\.png$/.exec(item.file);
    const width = Number(size);
    const height = width === 390 ? 844 : 800;
    assert.equal(item.renderer, renderer);
    assert.equal(item.state, state);
    assert.deepEqual(item.viewport, { width, height });
    assert.deepEqual(item.dimensions, {
      width,
      height: height + (item.file === expectedCaptureNames()[0] ? 10 : 0),
    });
  }
});

test("rejects invalid provenance, receipt, inventory, and image bytes", () => {
  const input = fixture();
  assert.throws(() =>
    createCaptureManifest({ ...input, actual: { ...input.actual, controllerClean: false } }),
  );
  assert.throws(() => createCaptureManifest({ ...input, runId: "" }));
  assert.throws(() => createCaptureManifest({ ...input, entries: input.entries.slice(1) }));
  const files = new Map(input.files);
  files.set("test-report.tap", Buffer.from("invalid"));
  assert.throws(() => createCaptureManifest({ ...input, files }));
  files.set("test-report.tap", input.files.get("test-report.tap"));
  files.set(expectedCaptureNames()[0], Buffer.from("invalid"));
  assert.throws(() => createCaptureManifest({ ...input, files }));
});
