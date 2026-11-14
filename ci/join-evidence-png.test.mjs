import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { validateCapturePng } from "./join-evidence-png.mjs";

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

function image({
  width = 2,
  height = 3,
  rows = Buffer.alloc(27),
  data,
  color = 6,
  split = false,
  headerType = "IHDR",
} = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = color;
  const compressed = data ?? deflateSync(rows);
  const idat = split
    ? [chunk("IDAT", compressed.subarray(0, 3)), chunk("IDAT", compressed.subarray(3))]
    : [chunk("IDAT", compressed)];
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk(headerType, header),
    ...idat,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("accepts a valid full-page capture taller than the viewport", () => {
  assert.deepEqual(validateCapturePng(image(), 2, 2), { width: 2, height: 3 });
});

test("accepts RGB and RGBA with every filter and split image data", () => {
  for (const color of [2, 6]) {
    const stride = 2 * (color === 2 ? 3 : 4) + 1;
    const rows = Buffer.alloc(stride * 5);
    for (let row = 0; row < 5; row++) rows[row * stride] = row;
    assert.deepEqual(validateCapturePng(image({ color, height: 5, rows, split: true }), 2, 2), {
      width: 2,
      height: 5,
    });
  }
});

test("rejects wrong signature, dimensions, truncation and trailing data", () => {
  const png = image();
  assert.throws(() => validateCapturePng(Buffer.from("not a PNG"), 2, 2));
  assert.throws(() => validateCapturePng(png, 3, 2), /width mismatch/);
  assert.throws(() => validateCapturePng(png, 2, 4), /height outside/);
  assert.throws(() => validateCapturePng(png.subarray(0, -1), 2, 2));
  assert.throws(() => validateCapturePng(Buffer.concat([png, Buffer.from([0])]), 2, 2), /trailing/);
});

test("rejects non-letter chunk type bytes even with a valid CRC", () => {
  for (const headerType of [Buffer.from([0xc9, 0x48, 0x44, 0x52]), Buffer.from("I1DR")]) {
    assert.throws(() => validateCapturePng(image({ headerType }), 2, 2), /invalid PNG chunk type/);
  }
});

test("rejects corruption, invalid compressed data and malformed scanlines", () => {
  const png = image();
  png[20] ^= 1;
  assert.throws(() => validateCapturePng(png, 2, 2), /CRC/);
  assert.throws(() => validateCapturePng(image({ data: Buffer.from("invalid") }), 2, 2));
  assert.throws(
    () => validateCapturePng(image({ rows: Buffer.alloc(26) }), 2, 2),
    /scanline length/,
  );
  const rows = Buffer.alloc(27);
  rows[9] = 5;
  assert.throws(() => validateCapturePng(image({ rows }), 2, 2), /filter/);
});
