import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { validatePngDirectory, viewportPngs } from "./kit-activity-log-png.mjs";

function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const result = Buffer.alloc(data.length + 8);
  result.writeUInt32BE(bytes.length);
  data.copy(result, 4);
  result.writeUInt32BE(crc32(data), result.length - 4);
  return result;
}
function png([width, height], meta = Buffer.alloc(0), extraDecoded = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    meta,
    chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3) + extraDecoded))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("staging accepts exactly five valid PNGs and refuses extra files, links, or unapproved bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-png-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, size] of Object.entries(viewportPngs))
    writeFileSync(join(dir, name), png(size));
  assert.equal(validatePngDirectory(dir).length, 5);
  const extra = join(dir, "extra.png");
  writeFileSync(extra, "extra");
  assert.throws(() => validatePngDirectory(dir), /inventory/);
  rmSync(extra);
  const file = join(dir, "populated-desktop.png");
  const metadata = png([1280, 800], chunk("tEXt", Buffer.from("x\0y")));
  const malformed = [png([390, 844]), metadata, Buffer.from("not PNG")];
  for (const bytes of malformed) {
    writeFileSync(file, bytes);
    assert.throws(() => validatePngDirectory(dir), /invalid viewport PNG/);
  }
  writeFileSync(file, png([1280, 800], undefined, 1));
  assert.throws(() => validatePngDirectory(dir), { code: "ERR_BUFFER_TOO_LARGE" });
  truncateSync(file, 2 * 1024 * 1024 + 1);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport file/);
  rmSync(file);
  symlinkSync("empty-desktop.png", file);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport file/);
});
