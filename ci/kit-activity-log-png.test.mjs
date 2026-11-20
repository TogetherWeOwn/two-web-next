import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { validatePngDirectory } from "./kit-activity-log-png.mjs";

const expectedViewports = {
  "populated-desktop.png": [1280, 800],
  "empty-desktop.png": [1280, 800],
  "populated-mobile.png": [390, 844],
  "empty-mobile.png": [390, 844],
  "keyboard-mobile.png": [390, 844],
};
const empty = Buffer.alloc(0);
const srgb = chunk("sRGB", Buffer.from([0]));

function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const result = Buffer.alloc(data.length + 8);
  result.writeUInt32BE(bytes.length);
  data.copy(result, 4);
  result.writeUInt32BE(crc32(data), result.length - 4);
  return result;
}
function png(
  [width, height],
  {
    rgba = false,
    depth = 8,
    interlace = 0,
    filter = 0,
    beforeIdat = empty,
    afterIdat = empty,
    trailingCompressed = empty,
    extraDecoded = 0,
  } = {},
) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, rgba ? 6 : 2, 0, 0, interlace], 8);
  const rows = Buffer.alloc(height * (1 + width * (rgba ? 4 : 3)) + extraDecoded);
  rows[0] = filter;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    beforeIdat,
    chunk("IDAT", Buffer.concat([deflateSync(rows), trailingCompressed])),
    afterIdat,
    chunk("IEND", empty),
  ]);
}

test("staging accepts exactly five valid PNGs and refuses extra files, links, or unapproved bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-png-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, size] of Object.entries(expectedViewports)) {
    writeFileSync(join(dir, name), png(size));
  }
  const expectedNames = Object.keys(expectedViewports).sort();
  const assertInventory = () =>
    assert.deepEqual(
      validatePngDirectory(dir)
        .map(({ name }) => name)
        .sort(),
      expectedNames,
    );
  assertInventory();
  const extra = join(dir, "extra.png");
  writeFileSync(extra, "extra");
  assert.throws(() => validatePngDirectory(dir), /inventory/);
  rmSync(extra);

  const file = join(dir, "populated-desktop.png");
  const desktop = expectedViewports["populated-desktop.png"];
  writeFileSync(file, png(desktop, { rgba: true, beforeIdat: srgb, filter: 4 }));
  assertInventory();

  const badCrc = png(desktop);
  badCrc[badCrc.length - 1] ^= 1;
  const malformed = {
    dimensions: png([390, 844]),
    signature: Buffer.from("not PNG"),
    crc: badCrc,
    metadata: png(desktop, { beforeIdat: chunk("tEXt", Buffer.from("x\0y")) }),
    "late sRGB": png(desktop, { afterIdat: srgb }),
    "trailing compressed bytes": png(desktop, { trailingCompressed: Buffer.from([1]) }),
    "row filter": png(desktop, { filter: 5 }),
    interlace: png(desktop, { interlace: 1 }),
    "bit depth": png(desktop, { depth: 16 }),
    "short decoded data": png(desktop, { extraDecoded: -1 }),
  };
  for (const [reason, bytes] of Object.entries(malformed)) {
    writeFileSync(file, bytes);
    assert.throws(() => validatePngDirectory(dir), /invalid viewport PNG/, reason);
  }
  writeFileSync(file, png(desktop, { extraDecoded: 1 }));
  assert.throws(() => validatePngDirectory(dir), "one byte over the decoded limit");

  // An invalid PNG at the byte limit must reach the PNG check, not the file-size check.
  writeFileSync(file, malformed.signature);
  truncateSync(file, 2 * 1024 * 1024);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport PNG/);
  truncateSync(file, 2 * 1024 * 1024 + 1);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport file/);
  rmSync(file);
  symlinkSync("empty-desktop.png", file);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport file/);
  rmSync(file);
  linkSync(join(dir, "empty-desktop.png"), file);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport file/);
});
