import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Playwright captures full pages: the image must be at least viewport height.
export function validateCapturePng(bytes, width, minHeight) {
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(signature),
    "invalid PNG signature",
  );
  assert.ok(
    Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(minHeight) && minHeight > 0,
  );
  let offset = 8;
  let header;
  let ended = false;
  let dataEnded = false;
  const data = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, "truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, "truncated PNG chunk data");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      crc32(bytes.subarray(offset + 4, offset + 8 + length)),
      bytes.readUInt32BE(end - 4),
      "PNG CRC mismatch",
    );
    if (!header) {
      assert.equal(type, "IHDR", "PNG header must be first");
      assert.equal(length, 13, "invalid PNG header length");
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        depth: payload[8],
        color: payload[9],
      };
      assert.equal(header.width, width, "PNG width mismatch");
      assert.ok(
        header.height >= minHeight && header.height <= 32768,
        "PNG height outside capture bounds",
      );
      assert.ok(
        header.depth === 8 && (header.color === 2 || header.color === 6),
        "unsupported PNG format",
      );
      assert.ok(
        payload[10] === 0 && payload[11] === 0 && payload[12] === 0,
        "unsupported PNG encoding",
      );
    } else if (type === "IDAT") {
      assert.ok(!dataEnded, "nonconsecutive PNG image data");
      data.push(payload);
    } else {
      if (data.length) dataEnded = true;
      assert.notEqual(type, "IHDR", "duplicate PNG header");
      if (type === "IEND") {
        assert.equal(length, 0, "invalid PNG end chunk");
        assert.ok(data.length > 0, "missing PNG image data");
        assert.equal(end, bytes.length, "trailing PNG data");
        ended = true;
        break;
      }
      assert.ok((bytes[offset + 4] & 32) !== 0, "unsupported critical PNG chunk");
    }
    offset = end;
  }
  assert.ok(ended, "missing PNG end chunk");
  const stride = header.width * (header.color === 6 ? 4 : 3) + 1;
  const size = stride * header.height;
  assert.ok(size <= 256 * 1024 * 1024, "PNG image exceeds decode budget");
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: size });
  assert.equal(pixels.length, size, "invalid PNG scanline length");
  for (let row = 0; row < header.height; row++)
    assert.ok(pixels[row * stride] <= 4, "invalid PNG filter");
  return { width: header.width, height: header.height };
}
