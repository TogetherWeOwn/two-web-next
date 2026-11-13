import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { expectedCaptureNames } from "./join-evidence-contract.mjs";
import { readCaptureFiles } from "./join-evidence-files.mjs";
import { createCaptureManifest, createTargetCaptureManifest } from "./join-evidence-manifest.mjs";
import { collectSourceIdentities } from "./join-evidence-source.mjs";

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

function fixture(profile = "baseline") {
  const names = expectedCaptureNames(profile);
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

test("collects actual checkout identities and detects untracked changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "join-evidence-source-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      }).trim();
    git("init", "--quiet");
    await writeFile(join(directory, "tracked"), "original");
    git("add", "tracked");
    git("commit", "--quiet", "-m", "fixture");
    const sha = git("rev-parse", "HEAD");
    assert.deepEqual(collectSourceIdentities(directory, directory), {
      application: sha,
      applicationClean: true,
      controller: sha,
      controllerClean: true,
    });
    await writeFile(join(directory, "tracked"), "modified");
    assert.equal(collectSourceIdentities(directory, directory).applicationClean, false);
    git("add", "tracked");
    assert.equal(collectSourceIdentities(directory, directory).controllerClean, false);
    git("reset", "--hard", "--quiet", "HEAD");
    await writeFile(join(directory, "untracked"), "change");
    assert.equal(collectSourceIdentities(directory, directory).applicationClean, false);
    assert.throws(() => collectSourceIdentities("relative", directory), /absolute/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("validates target receipts and images using the selected profile", () => {
  const input = fixture("target");
  const manifest = createCaptureManifest({ ...input, profile: "target" });
  assert.equal(manifest.images.length, 20);
  assert.equal(manifest.profile, "target");
  assert.ok(manifest.images.some((item) => item.state === "expired"));
  assert.throws(() => createCaptureManifest(input), /file set/);
});

test("reads target evidence only with the target profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "join-evidence-target-"));
  try {
    const input = fixture("target");
    for (const [name, bytes] of input.files) await writeFile(join(directory, name), bytes);
    await assert.rejects(readCaptureFiles(directory), /unexpected evidence file set/);
    const controller = "94e2a41941e5c0779120ce997dbbd815e9bb0874";
    const actual = { ...input.actual, controller };
    const expected = { ...input.expected, controller };
    const args = { directory, actual, expected, runId: input.runId, runAttempt: input.runAttempt };
    await assert.rejects(
      createTargetCaptureManifest({ ...args, actual: input.actual }),
      /SHA mismatch/,
    );
    await assert.rejects(
      createTargetCaptureManifest({ ...args, actual: { ...actual, controllerClean: false } }),
      /not clean/,
    );
    await assert.rejects(
      createTargetCaptureManifest({ ...args, actual: input.actual, expected: input.expected }),
      /unsupported target controller SHA/,
    );
    const manifest = await createTargetCaptureManifest(args);
    assert.equal(manifest.profile, "target");
    assert.equal(manifest.images.length, 20);
    assert.ok(manifest.images.some((item) => item.state === "stale-populated"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads only bounded regular evidence files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "join-evidence-files-"));
  try {
    const names = [...expectedCaptureNames(), "test-report.tap"];
    for (const name of names) await writeFile(join(directory, name), name);
    const result = await readCaptureFiles(directory);
    for (const name of names) assert.equal(result.files.get(name).toString(), name);

    const first = join(directory, names[0]);
    await unlink(first);
    await symlink(join(directory, names[1]), first);
    await assert.rejects(readCaptureFiles(directory));
    await unlink(first);
    await writeFile(first, "image");
    const report = join(directory, "test-report.tap");
    for (const [path, limit] of [
      [report, 1024 * 1024],
      [first, 32 * 1024 * 1024],
    ]) {
      await truncate(path, limit);
      await readCaptureFiles(directory);
      await truncate(path, limit + 1);
      await assert.rejects(readCaptureFiles(directory), /invalid evidence file/);
      await writeFile(path, "reset");
    }
    await writeFile(join(directory, "unexpected"), "extra");
    await assert.rejects(readCaptureFiles(directory), /unexpected evidence file set/);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
