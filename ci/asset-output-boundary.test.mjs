import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyStatus, parseStatus, validateRaw } from "./asset-output-boundary.mjs";

const allowed = ["public/a.js", "public/b.css"];
const hash = "a".repeat(40);
const raw = (oldMode, newMode, status, path = "public/a.js") =>
  `:${oldMode} ${newMode} ${hash} ${hash} ${status}\0${path}\0`;

describe("asset output boundary", () => {
  it("accepts allowed modified and new porcelain entries", () => {
    const entries = parseStatus(" M public/a.js\0?? public/b.css\0");
    assert.deepEqual(classifyStatus(entries, allowed), {
      files: allowed,
      unexpected: [],
    });
    assert.deepEqual(parseStatus(""), []);
  });

  it("rejects staged changes, deletes, renames, duplicates and unexpected paths", () => {
    const entries = parseStatus(
      "M  public/a.js\0 D public/b.css\0R  public/a.js\0old.js\0?? src/x.js\0 M public/a.js\0 M public/a.js\0",
    );
    assert.equal(entries[2].from, "old.js");
    const result = classifyStatus(entries, allowed);
    assert.deepEqual(result.files, []);
    assert.equal(result.unexpected.length, 6);
    assert.equal(parseStatus(" R public/a.js\0old.js\0")[0].from, "old.js");
  });

  it("fails closed on malformed porcelain and invalid allowlists", () => {
    for (const text of [" M public/a.js", "X public/a.js\0", "R  public/a.js\0", "\0"]) {
      assert.throws(() => parseStatus(text));
    }
    for (const path of ["../public/a.js", "public/../a.js", "public//a.js", "public/dir\\a.js"]) {
      assert.throws(() => classifyStatus([], [path]));
    }
  });

  it("accepts regular modifications and additions in raw diffs", () => {
    assert.deepEqual(
      validateRaw(
        raw("100644", "100644", "M") + raw("000000", "100644", "A", "public/b.css"),
        allowed,
      ),
      [],
    );
    assert.deepEqual(validateRaw("", allowed), []);
  });

  it("rejects deletes, renames, executable bits, symlinks and disallowed paths", () => {
    for (const diff of [
      raw("100644", "000000", "D"),
      raw("100644", "100644", "R"),
      raw("100644", "100755", "M"),
      raw("100755", "100644", "M"),
      raw("100644", "120000", "M"),
      raw("000000", "120000", "A"),
      raw("100644", "100644", "A"),
      raw("100644", "100644", "M", "src/x.js"),
      raw("100644", "100644", "M") + raw("100644", "100644", "M"),
    ]) {
      assert.notDeepEqual(validateRaw(diff, allowed), []);
    }
  });

  it("fails closed on truncated or malformed raw records", () => {
    assert.throws(() => validateRaw("truncated", allowed));
    for (const diff of [
      "invalid\0",
      "invalid\0public/a.js\0",
      `${raw("100644", "100644", "M")}\0`,
    ]) {
      assert.notDeepEqual(validateRaw(diff, allowed), []);
    }
  });
});
