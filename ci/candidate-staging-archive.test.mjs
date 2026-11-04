import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { decodeCandidateArchive } from "./candidate-staging-archive.mjs";

function zip(entries = [{}]) {
  const locals = [];
  const centrals = [];
  const positions = [];
  let offset = 0;
  for (const [index, input] of entries.entries()) {
    const name = Buffer.from(
      input.path ?? (index === 0 ? "worker/worker.mjs" : `assets/file-${index}.txt`),
    );
    const bytes =
      input.bytes ?? Buffer.from("throw new Error('candidate bytes must remain inert');");
    const method = input.method ?? 8;
    const flags = input.descriptor ? 0x0808 : 0x0800;
    const compressed = method === 0 ? bytes : deflateRawSync(bytes);
    const extra = input.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!input.descriptor) {
      local.writeUInt32LE(crc32(bytes), 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(bytes.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(input.descriptor ? 16 : 0);
    if (input.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc32(bytes), 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(bytes.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    positions.push({
      local: offset,
      central: centrals.reduce((sum, part) => sum + part.length, 0),
      data: offset + local.length + name.length + extra.length,
      descriptor: offset + local.length + name.length + extra.length + compressed.length,
    });
    const record = Buffer.concat([local, name, extra, compressed, descriptor]);
    locals.push(record);
    centrals.push(Buffer.concat([central, name, extra]));
    offset += record.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  for (const position of positions) position.central += offset;
  return {
    bytes: Buffer.concat([...locals, directory, end]),
    positions,
    end: offset + directory.length,
    central: offset,
  };
}

function decode(bytes) {
  return decodeCandidateArchive(bytes, candidateSha256(bytes));
}

for (const method of [0, 8]) {
  for (const descriptor of [false, true]) {
    test(`inert memory decode: method=${method}, descriptor=${descriptor}`, () => {
      const source = Buffer.from("throw new Error('must not execute');");
      const archive = zip([
        { method, descriptor, bytes: source },
        { path: "assets/styles.css", method, descriptor },
      ]);
      const files = decode(archive.bytes);
      assert.equal(files.length, 2);
      assert.deepEqual(files[0], { path: "worker/worker.mjs", type: "file", bytes: source });
      assert.equal(files[1].path, "assets/styles.css");
      // Stored files must not alias the untrusted archive buffer.
      files[0].bytes.fill(0);
      assert.deepEqual(decode(archive.bytes)[0].bytes, source);
    });
  }
}

test("empty regular assets and safe metadata extras are data", () => {
  const extra = Buffer.from([0x55, 0x54, 1, 0, 0]);
  const archive = zip([{}, { bytes: Buffer.alloc(0), extra }]);
  assert.equal(decode(archive.bytes)[1].bytes.length, 0);
});

for (const path of [
  "../worker/worker.mjs",
  "/worker/worker.mjs",
  "worker//worker.mjs",
  "worker/./worker.mjs",
  "worker/../worker.mjs",
  "worker\\worker.mjs",
  "worker/worker.mjs\0",
  "worker/worker.mjs\n",
  "worker/wørker.mjs",
  "C:/worker/worker.mjs",
  "assets/.env",
  "assets/dir/.secret",
  "package.json",
  "worker/config.json",
  "assets/folder/",
  "a".repeat(241),
]) {
  test(`unsafe archive path refuses: ${JSON.stringify(path)}`, () => {
    assert.throws(() => decode(zip([{}, { path }]).bytes), /Candidate archive refused:/);
  });
}

for (const path of ["worker/worker.mjs", "Worker/worker.mjs", "WORKER/WORKER.MJS"]) {
  test(`duplicate or case-alias path refuses: ${path}`, () => {
    assert.throws(() => decode(zip([{}, { path }]).bytes), /entry-path/);
  });
}

test("missing Worker entrypoint refuses", () => {
  assert.throws(() => decode(zip([{ path: "assets/app.css" }]).bytes), /central-completeness/);
});

test("selected archive digest is mandatory before parsing", () => {
  const archive = zip().bytes;
  for (const digest of [undefined, 1, [candidateSha256(archive)], "F".repeat(64), "0".repeat(64)]) {
    assert.throws(() => decodeCandidateArchive(archive, digest), /archive-digest-or-size/);
  }
  assert.throws(
    () => decodeCandidateArchive(new Uint8Array(archive), candidateSha256(archive)),
    /archive-digest-or-size/,
  );
  assert.throws(() => decode(Buffer.alloc(16 * 1024 * 1024 + 1)), /archive-digest-or-size/);
});

const corruptions = [
  ["missing end signature", (a) => a.bytes.writeUInt32LE(0, a.end)],
  ["multipart disk", (a) => a.bytes.writeUInt16LE(1, a.end + 4)],
  ["multipart central disk", (a) => a.bytes.writeUInt16LE(1, a.end + 6)],
  ["entry-count disagreement", (a) => a.bytes.writeUInt16LE(2, a.end + 8)],
  [
    "zero entries",
    (a) => {
      a.bytes.writeUInt16LE(0, a.end + 8);
      a.bytes.writeUInt16LE(0, a.end + 10);
    },
  ],
  [
    "too many entries",
    (a) => {
      a.bytes.writeUInt16LE(4097, a.end + 8);
      a.bytes.writeUInt16LE(4097, a.end + 10);
    },
  ],
  ["short central size", (a) => a.bytes.writeUInt32LE(0, a.end + 12)],
  ["central outside archive", (a) => a.bytes.writeUInt32LE(0xffffffff, a.end + 16)],
  ["end comment", (a) => a.bytes.writeUInt16LE(1, a.end + 20)],
  ["bad central signature", (a) => a.bytes.writeUInt32LE(0, a.central)],
  ["ZIP64 required version", (a) => a.bytes.writeUInt16LE(45, a.central + 6)],
  ["encrypted flags", (a) => a.bytes.writeUInt16LE(0x0801, a.central + 8)],
  ["unsupported compression", (a) => a.bytes.writeUInt16LE(99, a.central + 10)],
  ["central CRC tamper", (a) => a.bytes.writeUInt32LE(0, a.central + 16)],
  ["oversize compressed entry", (a) => a.bytes.writeUInt32LE(0xffffffff, a.central + 20)],
  ["oversize expanded entry", (a) => a.bytes.writeUInt32LE(16 * 1024 * 1024 + 1, a.central + 24)],
  ["central name length", (a) => a.bytes.writeUInt16LE(0xffff, a.central + 28)],
  ["central extra length", (a) => a.bytes.writeUInt16LE(0xffff, a.central + 30)],
  ["central comment", (a) => a.bytes.writeUInt16LE(1, a.central + 32)],
  ["central disk entry", (a) => a.bytes.writeUInt16LE(1, a.central + 34)],
  ["DOS directory", (a) => a.bytes.writeUInt32LE(0x10, a.central + 38)],
  ["Unix symlink", (a) => a.bytes.writeUInt32LE((0o120777 << 16) >>> 0, a.central + 38)],
  ["Unix directory", (a) => a.bytes.writeUInt32LE((0o40755 << 16) >>> 0, a.central + 38)],
  ["Unix FIFO", (a) => a.bytes.writeUInt32LE((0o10644 << 16) >>> 0, a.central + 38)],
  ["prefix or gap", (a) => a.bytes.writeUInt32LE(1, a.central + 42)],
  [
    "central name differs",
    (a) => {
      a.bytes[a.central + 46] = 97;
    },
  ],
  ["bad local signature", (a) => a.bytes.writeUInt32LE(0, 0)],
  ["local ZIP64", (a) => a.bytes.writeUInt16LE(45, 4)],
  ["local flags differ", (a) => a.bytes.writeUInt16LE(0, 6)],
  ["local method differs", (a) => a.bytes.writeUInt16LE(0, 8)],
  ["local timestamp differs", (a) => a.bytes.writeUInt16LE(1, 10)],
  ["local date differs", (a) => a.bytes.writeUInt16LE(1, 12)],
  ["local CRC differs", (a) => a.bytes.writeUInt32LE(0, 14)],
  ["local compressed size differs", (a) => a.bytes.writeUInt32LE(0, 18)],
  ["local size differs", (a) => a.bytes.writeUInt32LE(0, 22)],
  ["local name length differs", (a) => a.bytes.writeUInt16LE(1, 26)],
  ["local extra length outside archive", (a) => a.bytes.writeUInt16LE(0xffff, 28)],
  ["compressed payload corrupt", (a) => a.bytes.fill(0xff, a.positions[0].data, a.central)],
];
for (const [name, mutate] of corruptions) {
  test(`malformed archive refuses: ${name}`, () => {
    const archive = zip();
    mutate(archive);
    assert.throws(() => decode(archive.bytes), /Candidate archive refused:/);
  });
}

for (const descriptorOffset of [0, 4, 8, 12]) {
  test(`streaming data descriptor corruption refuses at ${descriptorOffset}`, () => {
    const archive = zip([{ descriptor: true }]);
    archive.bytes.writeUInt32LE(0, archive.positions[0].descriptor + descriptorOffset);
    assert.throws(() => decode(archive.bytes), /Candidate archive refused:/);
  });
}

for (const extra of [
  Buffer.from([1]),
  Buffer.from([0x55, 0x54, 1, 0]),
  Buffer.from([1, 0, 0, 0]),
  Buffer.from([0x75, 0x70, 0, 0]),
  Buffer.from([0x55, 0x54, 0, 0, 0x55, 0x54, 0, 0]),
]) {
  test(`unsupported/truncated/duplicate extra refuses: ${extra.toString("hex")}`, () => {
    assert.throws(() => decode(zip([{ extra }]).bytes), /Candidate archive refused:/);
  });
}

test("ZIP suffixes, prefixes and truncated bytes refuse even with matching digest", () => {
  const archive = zip().bytes;
  for (const value of [
    Buffer.concat([archive, Buffer.from("suffix")]),
    Buffer.concat([Buffer.from("prefix"), archive]),
    archive.subarray(0, archive.length - 1),
    archive.subarray(0, 21),
  ]) {
    assert.throws(() => decode(value), /Candidate archive refused:/);
  }
});

test("stored data requires both exact lengths and CRC", () => {
  const archive = zip([{ method: 0 }]);
  archive.bytes[archive.positions[0].data] ^= 1;
  assert.throws(() => decode(archive.bytes), /entry-integrity/);
  const shorter = zip([{ method: 0 }]);
  shorter.bytes.writeUInt32LE(1, shorter.central + 24);
  shorter.bytes.writeUInt32LE(1, 22);
  assert.throws(() => decode(shorter.bytes), /stored-size/);
});

test("overlapping local entries refuse", () => {
  const archive = zip([{}, {}]);
  archive.bytes.writeUInt32LE(0, archive.positions[1].central + 42);
  assert.throws(() => decode(archive.bytes), /local-layout/);
});

test("aggregate declared expansion bound refuses before decompression", () => {
  const archive = zip([{}, {}]);
  for (const position of archive.positions)
    archive.bytes.writeUInt32LE(9 * 1024 * 1024, position.central + 24);
  assert.throws(() => decode(archive.bytes), /expanded-size/);
});

test("deflate expansion cannot exceed even a falsified small declared size", () => {
  const archive = zip([{ bytes: Buffer.alloc(2 * 1024 * 1024) }]);
  archive.bytes.writeUInt32LE(1, archive.central + 24);
  archive.bytes.writeUInt32LE(1, 22);
  assert.throws(() => decode(archive.bytes), /deflate-data/);
});

test("deflate trailing bytes cannot hide another payload", () => {
  const archive = zip();
  const insertion = Buffer.from("extra");
  const bytes = Buffer.concat([
    archive.bytes.subarray(0, archive.central),
    insertion,
    archive.bytes.subarray(archive.central),
  ]);
  const central = archive.central + insertion.length;
  const end = archive.end + insertion.length;
  const length = archive.bytes.readUInt32LE(18) + insertion.length;
  bytes.writeUInt32LE(length, 18);
  bytes.writeUInt32LE(length, central + 20);
  bytes.writeUInt32LE(central, end + 16);
  assert.throws(() => decode(bytes), /deflate-data/);
});

test("parser diagnostics never echo paths or content", () => {
  const marker = "must-not-be-diagnostic";
  const archive = zip([{ path: `../../${marker}`, bytes: Buffer.from(marker) }]);
  assert.throws(
    () => decode(archive.bytes),
    (error) => {
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.cause, undefined);
      return /Candidate archive refused:/.test(error.message);
    },
  );
});
