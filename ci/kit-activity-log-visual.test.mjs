import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { validatePngDirectory, viewportPngs } from "./kit-activity-log-png.mjs";
import { expectedContent, validateView } from "./kit-activity-log-visual.mjs";

test("capture refuses renderer, fixture content and keyboard drift", () => {
  const response = ["http://127.0.0.1:8788/admin/activity-log", 200, "kit", "private, no-store"];
  const state = [true, false, false];
  const content = structuredClone(expectedContent(false));
  validateView(response, content, state, false, false);
  const hono = response.with(2, "hono");
  assert.throws(() => validateView(hono, content, state, false, false), /provenance/);
  assert.throws(() => validateView(response, content, [true, true, false], false, true), /state/);
  content[1][3] = "unapproved";
  assert.throws(() => validateView(response, content, state, false, false), /content/);
});

function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const result = Buffer.alloc(data.length + 8);
  result.writeUInt32BE(bytes.length);
  data.copy(result, 4);
  result.writeUInt32BE(crc32(data), result.length - 4);
  return result;
}
function png([width, height], meta = Buffer.alloc(0)) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    meta,
    chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3)))),
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
  for (const bytes of [png([390, 844]), metadata, Buffer.from("not PNG")]) {
    writeFileSync(file, bytes);
    assert.throws(() => validatePngDirectory(dir), /invalid viewport PNG/);
  }
  rmSync(file);
  symlinkSync("empty-desktop.png", file);
  assert.throws(() => validatePngDirectory(dir), /invalid viewport file/);
});

test("only the protected diagnostic publishes the validated directory", () => {
  const url = new URL("../.github/workflows/kit-activity-log-diagnostic.yml", import.meta.url);
  const source = readFileSync(url, "utf8");
  assert.match(source, /^on:\s+workflow_dispatch:/m);
  assert.match(source, /PUBLICATION_ADMITTED.*== true/);
  assert.match(source, /validatePngDirectory\([\s\S]+uses: actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(source, /path: .*\/kit-activity-log-approved\/\s+retention-days: 1/);
  assert.equal(source.match(/uses: actions\/upload-artifact@/g)?.length, 1);
});
