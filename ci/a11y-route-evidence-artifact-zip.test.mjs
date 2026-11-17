import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { extractRouteEvidenceZip } from "./route-evidence-artifact-zip.mjs";

// Minimal synthetic ZIP writer; `opts` mutates individual header fields.
function zip(entries, opts = {}) {
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "latin1");
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const body = Buffer.concat([compressed, Buffer.from(e.trailing ?? "")]);
    const usize = e.usize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const flags = e.flags ?? 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(e.descriptorCrc ?? crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(usize, 12);
    }
    locals.push(lh, name, body, descriptor);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.madeBy ?? 20, 4);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(usize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.attrs ?? 0, 38);
    cd.writeUInt32LE(e.local ?? offset, 42);
    cds.push(cd, name);
    offset += 30 + name.length + body.length + descriptor.length;
  }
  const cdBuf = Buffer.concat(cds);
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
  assert.throws(() => extractRouteEvidenceZip(zip([{ ...entry, descriptorCrc: 1 }])), refused);
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
