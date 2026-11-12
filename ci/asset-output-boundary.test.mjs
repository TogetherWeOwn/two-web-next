import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyStatus, parseStatus, validateRaw } from "./asset-output-boundary.mjs";
import { compareAssetSnapshots } from "./asset-snapshot-comparison.mjs";

const allowed = ["public/a.js", "public/b.css"];
const hash = "a".repeat(40);
const raw = (oldMode, newMode, status, path = "public/a.js") =>
  `:${oldMode} ${newMode} ${hash} ${hash} ${status}\0${path}\0`;

const file = (path, bytes, mode = "100644") => ({ path, mode, bytes: Buffer.from(bytes) });

describe("raw asset snapshot comparison", () => {
  it("compares binary bytes and returns sorted allowed additions and modifications", () => {
    const before = [file("public/a.js", [0, 255]), file("src/x", [1])];
    const after = [
      file("public/b.css", [255, 0]),
      file("src/x", [1]),
      file("public/a.js", [0, 254]),
    ];
    assert.deepEqual(compareAssetSnapshots({ before, after, allowed }), [
      { path: "public/a.js", status: "M" },
      { path: "public/b.css", status: "A" },
    ]);
    assert.deepEqual(compareAssetSnapshots({ before, after: before, allowed }), []);
  });

  it("rejects unexpected changes, deletions and unsafe modes", () => {
    const base = file("public/a.js", [1]);
    for (const after of [
      [],
      [file("src/x", [2]), base],
      [file("public/a.js", [1], "100755")],
      [file("public/a.js", [1], "120000")],
    ]) {
      assert.throws(() => compareAssetSnapshots({ before: [base], after, allowed }), /unsafe/);
    }
  });

  it("rejects malformed, duplicate and oversized records and invalid allowlists", () => {
    const good = file("public/a.js", [1]);
    for (const records of [
      [good, good],
      [{ ...good, bytes: "not bytes" }],
      [file("public/../x", [1])],
      [file("public/\ud800.js", [1])],
    ]) {
      assert.throws(
        () => compareAssetSnapshots({ before: records, after: records, allowed }),
        /malformed or duplicate snapshot record/,
      );
    }
    const oversized = [file("public/a.js", Buffer.alloc(16 * 1024 * 1024))];
    assert.throws(
      () => compareAssetSnapshots({ before: oversized, after: oversized, allowed }),
      /snapshot exceeds byte limit/,
    );
    const records = Array.from({ length: 10001 }, (_, i) => file(`src/${i}`, []));
    const atLimit = records.slice(0, 10000);
    assert.deepEqual(compareAssetSnapshots({ before: atLimit, after: atLimit, allowed }), []);
    assert.throws(
      () => compareAssetSnapshots({ before: records, after: records, allowed }),
      /invalid snapshot record count/,
    );
    assert.throws(() => compareAssetSnapshots({ before: [], after: [], allowed: ["public/../x"] }));
  });
});

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
