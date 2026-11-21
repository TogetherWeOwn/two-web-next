import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import zlib, { crc32, deflateRawSync } from "node:zlib";
import { validatePureHonoRecoveryEvidence } from "./pure-hono-recovery-evidence.mjs";
import { readRouteEvidenceArtifact } from "./route-evidence-artifact-bytes.mjs";
import {
  decodePureHonoRecoveryZip,
  extractRouteEvidenceZip,
  ROUTE_EVIDENCE_ZIP_LIMITS,
} from "./route-evidence-artifact-zip.mjs";

// Minimal synthetic ZIP writer; `opts` mutates individual header fields.
function zip(entries, opts = {}) {
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "latin1");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const compressed = e.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const body = e.trailing ? Buffer.concat([compressed, Buffer.from(e.trailing)]) : compressed;
    const gap = Buffer.from(e.gap ?? "");
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const extra = e.extra ?? Buffer.alloc(0);
    const comment = Buffer.from(e.comment ?? "");
    const usize = e.usize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const flags = e.flags ?? 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.version ?? 0, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(localExtra.length, 28);
    const descriptor = Buffer.alloc(flags & 8 ? (e.unsigned ? 12 : 16) : 0);
    if (descriptor.length) {
      const at = e.unsigned ? 0 : 4;
      if (at) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(e.descriptorCrc ?? crc, at);
      descriptor.writeUInt32LE(body.length, at + 4);
      descriptor.writeUInt32LE(usize, at + 8);
    }
    locals.push(gap, lh, name, localExtra, body, descriptor);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.madeBy ?? 20, 4);
    cd.writeUInt16LE(e.version ?? 0, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(usize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt16LE(comment.length, 32);
    cd.writeUInt32LE(e.attrs ?? 0, 38);
    cd.writeUInt32LE(e.local ?? offset + gap.length, 42);
    cds.push([cd, name, extra, comment]);
    offset += gap.length + 30 + name.length + localExtra.length + body.length + descriptor.length;
  }
  const localSuffix = Buffer.from(opts.localSuffix ?? "");
  locals.push(localSuffix);
  offset += localSuffix.length;
  const cdBuf = Buffer.concat((opts.reverseCentral ? cds.reverse() : cds).flat());
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(opts.comment ?? 0, 20);
  return Buffer.concat([...locals, cdBuf, end]);
}

const refused = /route evidence refused: unsafe artifact archive/;
const ok = [
  { name: "report.json", data: '{"a":1}' },
  { name: "notes.txt", data: "hello", method: 0 },
];

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const response = (chunks, ok = true) => ({
  ok,
  body: (async function* () {
    yield* chunks;
  })(),
});
const refusedDownload = /route evidence refused: invalid artifact download/;

test("verifies bounded streamed artifact bytes before extracting", async () => {
  const archive = zip(ok);
  const expected = digest(archive);
  const files = await readRouteEvidenceArtifact(
    response([archive.subarray(0, 10), archive.subarray(10)]),
    expected,
  );
  assert.equal(files.get("report.json").toString(), '{"a":1}');
  const tinyChunks = Array.from(archive, (byte) => Uint8Array.of(byte));
  assert.equal((await readRouteEvidenceArtifact(response(tinyChunks), expected)).size, 2);
  for (const [download, hash] of [
    [response([archive]), `sha256:${"0".repeat(64)}`],
    [response([archive], false), expected],
    [response([archive]), "bad"],
    [response([]), expected],
    [response(["not bytes"]), expected],
    [response([new Uint8Array(0), archive]), expected],
  ])
    await assert.rejects(readRouteEvidenceArtifact(download, hash), refusedDownload);
  const interrupted = {
    ok: true,
    body: (async function* () {
      yield archive.subarray(0, 10);
      throw new Error("transport secret");
    })(),
  };
  await assert.rejects(readRouteEvidenceArtifact(interrupted, expected), (error) => {
    assert.match(error.message, refusedDownload);
    assert.doesNotMatch(error.message, /transport secret/);
    return true;
  });
  const badZip = Buffer.from("bad zip");
  await assert.rejects(readRouteEvidenceArtifact(response([badZip]), digest(badZip)), refused);
});

test("accepts an exact-cap archive and refuses an independently valid one-byte-over archive", async () => {
  const max = 10 * 1024 * 1024;
  const overhead = zip([
    { name: "a.json", method: 0 },
    { name: "b.json", method: 0 },
  ]).length;
  const size = (max - overhead) / 2;
  const makeArchive = (extra) =>
    zip([
      { name: "a.json", data: Buffer.alloc(size), method: 0 },
      { name: "b.json", data: Buffer.alloc(size + extra), method: 0 },
    ]);
  const exact = makeArchive(0);
  const over = makeArchive(1);
  assert.equal(exact.length, max);
  assert.equal(over.length, max + 1);
  assert.equal(
    extractRouteEvidenceZip(over, { ...ROUTE_EVIDENCE_ZIP_LIMITS, maxArchiveBytes: max + 1 }).size,
    2,
  );
  assert.equal((await readRouteEvidenceArtifact(response([exact]), digest(exact))).size, 2);
  await assert.rejects(readRouteEvidenceArtifact(response([over]), digest(over)), refusedDownload);
});

test("accepts each ZIP limit exactly and rejects one unit over", () => {
  const archive = zip([{ name: "a.json", data: "a".repeat(100) }]);
  const compressedSize = archive.readUInt32LE(18);
  const limits = {
    maxArchiveBytes: archive.length,
    maxEntries: 1,
    maxEntryBytes: 100,
    maxTotalBytes: 100,
    maxRatio: 100 / compressedSize,
  };
  assert.equal(extractRouteEvidenceZip(archive, limits).get("a.json").length, 100);
  for (const key of ["maxArchiveBytes", "maxEntries", "maxEntryBytes", "maxTotalBytes"]) {
    assert.throws(
      () => extractRouteEvidenceZip(archive, { ...limits, [key]: limits[key] - 1 }),
      refused,
      key,
    );
  }
  assert.throws(
    () => extractRouteEvidenceZip(archive, { ...limits, maxRatio: 99 / compressedSize }),
    refused,
  );
});

test("accepts valid archives at byte and compression limits and rejects one byte over", () => {
  const limits = {
    maxArchiveBytes: 10000,
    maxEntries: 10,
    maxEntryBytes: 1000,
    maxTotalBytes: 1000,
    maxRatio: 1000,
  };
  const exact = zip([{ name: "a", data: "x".repeat(100), method: 0 }]);
  const over = zip([{ name: "a", data: "x".repeat(101), method: 0 }]);
  for (const key of ["maxArchiveBytes", "maxEntryBytes", "maxTotalBytes"]) {
    const boundary = key === "maxArchiveBytes" ? exact.length : 100;
    assert.equal(
      extractRouteEvidenceZip(exact, { ...limits, [key]: boundary }).get("a").length,
      100,
    );
    assert.throws(
      () => extractRouteEvidenceZip(over, { ...limits, [key]: boundary }),
      refused,
      key,
    );
  }

  const compressedExact = zip([{ name: "a", data: "x".repeat(100) }]);
  const compressedOver = zip([{ name: "a", data: "x".repeat(101) }]);
  const compressedSize = compressedExact.readUInt32LE(18);
  assert.equal(compressedOver.readUInt32LE(18), compressedSize);
  const ratioLimits = { ...limits, maxRatio: 100 / compressedSize };
  assert.equal(extractRouteEvidenceZip(compressedExact, ratioLimits).get("a").length, 100);
  assert.throws(() => extractRouteEvidenceZip(compressedOver, ratioLimits), refused);
});

test("enforces entry count and cumulative bytes across multiple entries", () => {
  const entries = [
    { name: "a", data: "abc", method: 0 },
    { name: "b", data: "de", method: 0 },
  ];
  const archive = zip(entries);
  const limits = {
    maxArchiveBytes: archive.length,
    maxEntries: 2,
    maxEntryBytes: 3,
    maxTotalBytes: 5,
    maxRatio: 1,
  };
  assert.deepEqual([...extractRouteEvidenceZip(archive, limits).values()].map(String), [
    "abc",
    "de",
  ]);
  assert.throws(() => extractRouteEvidenceZip(archive, { ...limits, maxEntries: 1 }), refused);
  assert.throws(() => extractRouteEvidenceZip(archive, { ...limits, maxTotalBytes: 4 }), refused);
});

test("bounds inflated output even when the declared size is within the cap", () => {
  const limits = {
    maxArchiveBytes: 1000,
    maxEntries: 1,
    maxEntryBytes: 100,
    maxTotalBytes: 100,
    maxRatio: 1000,
  };
  const exact = { name: "a", data: "x".repeat(100) };
  assert.equal(extractRouteEvidenceZip(zip([exact]), limits).get("a").length, 100);
  assert.throws(
    () => extractRouteEvidenceZip(zip([{ ...exact, data: "x".repeat(101), usize: 100 }]), limits),
    refused,
  );
});

test("extracts stored and deflated regular files as data", () => {
  const files = extractRouteEvidenceZip(zip(ok));
  assert.deepEqual([...files.keys()], ["report.json", "notes.txt"]);
  assert.equal(files.get("report.json").toString(), '{"a":1}');
  assert.equal(files.get("notes.txt").toString(), "hello");
});

test("accepts an empty deflated file", () => {
  assert.equal(
    extractRouteEvidenceZip(zip([{ name: "empty.json", data: "" }])).get("empty.json").length,
    0,
  );
});

test("validates streaming data descriptors", () => {
  const entry = { name: "a.json", data: "x", flags: 8 };
  assert.equal(
    extractRouteEvidenceZip(zip([entry]))
      .get("a.json")
      .toString(),
    "x",
  );
  for (const unsigned of [false, true]) {
    const collision = { ...entry, data: Buffer.from("ac0a7ad5", "hex"), unsigned };
    assert.equal(crc32(collision.data), 0x08074b50);
    assert.deepEqual(extractRouteEvidenceZip(zip([collision])).get("a.json"), collision.data);
    assert.throws(
      () => extractRouteEvidenceZip(zip([{ ...entry, unsigned, descriptorCrc: 1 }])),
      refused,
    );
  }
});

test("refuses contradictory local headers", () => {
  const flags = zip(ok);
  flags.writeUInt16LE(8, 6);
  assert.throws(() => extractRouteEvidenceZip(flags), refused);
  const size = zip(ok);
  size.writeUInt32LE(0, 22);
  assert.throws(() => extractRouteEvidenceZip(size), refused);
});

test("refuses unsafe or non-allowlisted names", () => {
  for (const name of ["../x", "a/b", "/abs", "a\\b", ".hidden", "a b", "dir/", "", "é"])
    assert.throws(() => extractRouteEvidenceZip(zip([{ name, data: "x" }])), refused, name);
});

test("refuses duplicate names, case-insensitively", () => {
  const dup = [
    { name: "a.json", data: "1" },
    { name: "A.json", data: "2" },
  ];
  assert.throws(() => extractRouteEvidenceZip(zip(dup)), refused);
});

test("refuses symlinks, directories, encryption and unknown methods", () => {
  const e = { name: "a.json", data: "x" };
  assert.throws(
    () => extractRouteEvidenceZip(zip([{ ...e, madeBy: 0x314, attrs: (0o120777 << 16) >>> 0 }])),
    refused,
  );
  assert.throws(
    () => extractRouteEvidenceZip(zip([{ ...e, madeBy: 0x1314, attrs: (0o120777 << 16) >>> 0 }])),
    refused,
  );
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, madeBy: 0x1414 }])), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, attrs: 0x10 }])), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, flags: 1 }])), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, method: 12 }])), refused);
});

test("refuses size lies, bad CRC and decompression bombs", () => {
  const e = { name: "a.json", data: "x".repeat(100) };
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, usize: 10 }])), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, usize: 200 }])), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...e, crc: 1 }])), refused);
  assert.throws(
    () => extractRouteEvidenceZip(zip([{ ...e, trailing: "extra compressed data" }])),
    refused,
  );
  const bomb = { name: "b.bin", data: Buffer.alloc(1024 * 1024) };
  assert.throws(() => extractRouteEvidenceZip(zip([bomb])), refused);
  const big = { name: "c.bin", data: Buffer.alloc(100, 1) };
  const limits = {
    maxArchiveBytes: 1e6,
    maxEntries: 2,
    maxEntryBytes: 50,
    maxTotalBytes: 50,
    maxRatio: 1e9,
  };
  assert.throws(() => extractRouteEvidenceZip(zip([big]), limits), refused);
  const total = { ...limits, maxEntryBytes: 1e6, maxTotalBytes: 10 };
  assert.throws(() => extractRouteEvidenceZip(zip(ok), total), refused);
  assert.throws(
    () => extractRouteEvidenceZip(zip(ok), { ...total, maxTotalBytes: 1e6, maxEntries: 1 }),
    refused,
  );
});

test("refuses overlapping independently valid nested local entries", () => {
  const inner = zip([{ name: "inner", data: "payload", method: 0 }]);
  const innerEnd = inner.length - 22;
  const innerCdOffset = inner.readUInt32LE(innerEnd + 16);
  const innerLocal = inner.subarray(0, innerCdOffset);
  const outer = zip([{ name: "outer", data: innerLocal, method: 0 }]);
  assert.deepEqual(extractRouteEvidenceZip(inner).get("inner"), Buffer.from("payload"));
  assert.deepEqual(extractRouteEvidenceZip(outer).get("outer"), innerLocal);

  const outerEnd = outer.length - 22;
  const innerCd = Buffer.from(inner.subarray(innerCdOffset, innerEnd));
  innerCd.writeUInt32LE(30 + Buffer.byteLength("outer"), 42);
  const end = Buffer.from(outer.subarray(outerEnd));
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(end.readUInt32LE(12) + innerCd.length, 12);
  const nested = Buffer.concat([outer.subarray(0, outerEnd), innerCd, end]);
  assert.throws(() => extractRouteEvidenceZip(nested), refused);
});

test("refuses structural abuse", () => {
  const good = zip(ok);
  assert.throws(() => extractRouteEvidenceZip(zip(ok, { comment: 4 })), refused);
  assert.throws(() => extractRouteEvidenceZip(Buffer.concat([good, Buffer.from("x")])), refused);
  assert.throws(() => extractRouteEvidenceZip(good.subarray(0, good.length - 5)), refused);
  assert.throws(() => extractRouteEvidenceZip(Buffer.alloc(0)), refused);
  assert.throws(() => extractRouteEvidenceZip("not a buffer"), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...ok[0], local: 3 }])), refused);
  assert.throws(() => extractRouteEvidenceZip(zip([ok[0], { ...ok[1], local: 0 }])), refused);
  const zip64 = Buffer.from(good);
  zip64.writeUInt16LE(0xffff, good.length - 12);
  assert.throws(() => extractRouteEvidenceZip(zip64), refused);
});

test("error text never echoes archive-controlled content", () => {
  assert.throws(
    () => extractRouteEvidenceZip(zip([{ name: "../secret", data: "x" }])),
    (err) => {
      assert.match(err.message, refused);
      assert.doesNotMatch(err.message, /secret/);
      return true;
    },
  );
});

const regularFile = { madeBy: 0x0314, version: 20, attrs: (0o100644 << 16) >>> 0 };
function recoveryEntry(name, data = "x", fields = {}) {
  return { ...regularFile, name, data, ...fields };
}
const refuseRecovery = (archive) =>
  assert.throws(() => decodePureHonoRecoveryZip(archive), {
    message: "pure Hono recovery evidence refused: unsafe archive",
  });
const cdOffset = (archive) => archive.readUInt32LE(archive.length - 6);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("recovery ZIP round-trips inert files through the synthetic validator", () => {
  const payload = [
    recoveryEntry("worker.js", 'throw new Error("inert fixture");'),
    recoveryEntry("effective-config.json", "{}", { method: 0, version: 10 }),
    recoveryEntry("assets/nested/version.json", "{}", { flags: 0x0800 }),
  ];
  const identity = {
    sourceSha: "a".repeat(40),
    runId: "123",
    runAttempt: "2",
    originalVersionId: "11111111-1111-4111-8111-111111111111",
  };
  const manifest = JSON.stringify({
    schema: "two.pure-hono-recovery.v1",
    target: "two-web-next-production",
    ...identity,
    files: payload.map(({ name, data }) => ({
      path: name,
      bytes: Buffer.byteLength(data),
      sha256: sha256(data),
    })),
  });
  const entries = [recoveryEntry("manifest.json", manifest), ...payload];
  const archive = zip(entries, { reverseCentral: true });
  const archiveSha256 = sha256(archive);
  // Invented trust inputs exercise consistency only, not GitHub or Sigstore.
  const workflow = ".github/workflows/synthetic-recovery.yml";
  const producer = {
    ...identity,
    workflow,
    repository: "TogetherWeOwn/two-web-next",
    ref: "refs/heads/main",
  };
  const files = decodePureHonoRecoveryZip(archive);
  const paths = files.map(({ path }) => path);
  const centralOrder = entries.map(({ name }) => name).reverse();
  assert.deepEqual(paths, centralOrder);
  assert.deepEqual(files[0], { path: payload[2].name, bytes: Buffer.from("{}"), type: "file" });
  assert.deepEqual(
    validatePureHonoRecoveryEvidence({
      archive,
      expected: { ...identity, workflow, archiveSha256 },
      attestation: {
        ...producer,
        subjectSha256: archiveSha256,
        invocationId: "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123/attempts/2",
      },
      run: { ...producer, status: "completed", conclusion: "success" },
      decode: decodePureHonoRecoveryZip,
    }),
    { archiveSha256, fileCount: payload.length },
  );
  assert.equal(extractRouteEvidenceZip(zip(entries.slice(0, -1))).size, entries.length - 1);
  assert.throws(() => extractRouteEvidenceZip(archive), refused);
});

test("recovery ZIP admits path boundaries and refuses invalid names and aliases", () => {
  for (const path of [`assets/${"a".repeat(505)}`, `assets/${"a/".repeat(30)}b`]) {
    assert.equal(decodePureHonoRecoveryZip(zip([recoveryEntry(path)]))[0].path, path);
  }
  for (const names of [
    ["private.txt"],
    ["assets/../private"],
    ["assets/a\\private"],
    ["assets/a."],
    ["assets/a//b"],
    ["assets/é"],
    ["assets/NUL.txt"],
    [`assets/${"a".repeat(506)}`],
    [`assets/${"a/".repeat(31)}b`],
    ["assets/a", "assets/a"],
    ["assets/a", "assets/A"],
    ["assets/A/x", "assets/a/y"],
    ["assets/a/x", "assets/a"],
  ]) {
    refuseRecovery(zip(names.map((name) => recoveryEntry(name))));
  }
});

test("recovery ZIP refuses unsupported metadata, contradictory headers and bad payloads", () => {
  for (const fields of [
    { madeBy: 20 },
    { attrs: (0o120777 << 16) >>> 0 },
    { attrs: (0o010644 << 16) >>> 0 },
    { attrs: ((0o100644 << 16) | 0x10) >>> 0 },
    { attrs: (0o040755 << 16) >>> 0 },
    { flags: 8 },
    { flags: 0x4000 },
    { version: 45 },
    { extra: Buffer.from([1, 0, 0, 0]) },
    { localExtra: Buffer.from([1, 0, 0, 0]) },
    { comment: "x" },
    { crc: 1 },
    { usize: 2 },
    { trailing: "x" },
  ]) {
    refuseRecovery(zip([recoveryEntry("assets/a", "x", fields)]));
  }
  const entry = recoveryEntry("worker.js");
  for (const offset of [4, 6, 10, 14, 18, 22, 26, 30]) {
    const archive = zip([entry]);
    archive[offset] ^= 1;
    refuseRecovery(archive);
  }
  const abbreviated = zip([entry]);
  abbreviated.writeUInt32LE(cdOffset(abbreviated) - 29, cdOffset(abbreviated) + 42);
  refuseRecovery(abbreviated);
  refuseRecovery(zip([entry]).subarray(0, -1));
  refuseRecovery(zip([]));
});

test("recovery ZIP accounts for every byte before the central directory", () => {
  const hidden = zip([recoveryEntry("assets/hidden")]);
  const gap = hidden.subarray(0, cdOffset(hidden));
  const worker = recoveryEntry("worker.js");
  const config = recoveryEntry("effective-config.json");
  for (const archive of [
    zip([{ ...worker, gap }, config]),
    zip([worker, { ...config, gap }]),
    zip([worker, config], { localSuffix: gap }),
  ]) {
    assert.equal(extractRouteEvidenceZip(archive).size, 2); // legacy gap behavior unchanged
    refuseRecovery(archive);
  }
});

const mib = 1024 ** 2;
const storedEntry = (name, data) => recoveryEntry(name, data, { method: 0 });

test("recovery ZIP admits exact archive and manifest sizes and refuses one byte over", () => {
  const assetMax = 64 * mib - zip([storedEntry("assets/a", "")]).length;
  const limits = { "manifest.json": mib, "assets/a": assetMax };
  for (const [name, length] of Object.entries(limits)) {
    const data = Buffer.alloc(length + 1);
    const [file] = decodePureHonoRecoveryZip(zip([storedEntry(name, data.subarray(1))]));
    assert.equal(file.bytes.length, length);
    refuseRecovery(zip([storedEntry(name, data)]));
  }
});

test("recovery ZIP bounds member count, total expansion and ratio", (t) => {
  const entries = Array.from({ length: 4098 }, (_, i) => storedEntry(`assets/${i}`, ""));
  assert.equal(decodePureHonoRecoveryZip(zip(entries.slice(1))).length, 4097);
  refuseRecovery(zip(entries));
  // Fixed raw DEFLATE streams keep this boundary independent of encoder choices.
  const ratioStreams = [
    { length: 1200, hex: "63601805a360148c82a10100" },
    { length: 1201, hex: "63601805a360148c82210200" },
  ];
  for (const { length, hex } of ratioStreams) {
    const data = Buffer.alloc(length);
    const compressed = Buffer.from(hex, "hex");
    assert.equal(compressed.length, 12);
    assert.deepEqual(zlib.inflateRawSync(compressed), data);
    const archive = zip([recoveryEntry("assets/ratio", data, { compressed })]);
    if (length === 1200) assert.deepEqual(decodePureHonoRecoveryZip(archive)[0].bytes, data);
    else refuseRecovery(archive);
  }

  // Reuse a genuine 1 MiB member whose compressed size clears the 100:1 cap.
  const data = Buffer.alloc(mib);
  createHash("shake256", { outputLength: 16384 }).update("fixture").digest().copy(data);
  const fields = { compressed: deflateRawSync(data), usize: data.length, crc: crc32(data) };
  const chunks = Array.from({ length: 128 }, (_, i) => recoveryEntry(`assets/${i}`, "", fields));
  assert.equal(decodePureHonoRecoveryZip(zip(chunks)).length, chunks.length);
  const inflate = t.mock.method(zlib, "inflateRawSync");
  syncBuiltinESMExports();
  t.after(() => {
    inflate.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual(decodePureHonoRecoveryZip(zip(chunks.slice(0, 1)))[0].bytes, data);
  assert.equal(inflate.mock.callCount(), 1);
  inflate.mock.resetCalls();
  refuseRecovery(zip([...chunks, storedEntry("assets/over", "x")]));
  refuseRecovery(zip(chunks.slice(0, 2), { localSuffix: Buffer.of(0) }));
  assert.equal(inflate.mock.callCount(), 0);
});
