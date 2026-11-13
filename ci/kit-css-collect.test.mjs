import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { CLIENT_DIR, collect } from "./kit-css-collect.mjs";

const tmp = mkdtempSync(join(tmpdir(), "kit-css-collect-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const put = (root, rel, data) => {
  const file = join(root, CLIENT_DIR, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const TWO = { "immutable/assets/a.css": "a{b:c}", "immutable/assets/b.css": "d{e:f}" };
const fixture = (files = TWO) => {
  n += 1;
  const root = join(tmp, `root${n}`);
  mkdirSync(join(root, CLIENT_DIR), { recursive: true });
  for (const [rel, data] of Object.entries(files)) put(root, rel, data);
  return { root, out: join(tmp, `out${n}`) };
};
const sha = "a".repeat(40);
const ids = {
  leg: "head",
  sourceSha: sha,
  workflowSha: "b".repeat(40),
  runId: "7",
  runAttempt: "1",
};
const run = (paths, over = {}, limits) =>
  collect({ ...paths, ...ids, repository: "o/r", ...over }, limits);

describe("kit css collector", () => {
  it("retains only CSS with a manifest of hashes and gzip sizes", () => {
    const paths = fixture({ ...TWO, "immutable/chunks/x.js": "secret()" });
    const m = run(paths);
    const bytes = Buffer.from("a{b:c}");
    assert.deepEqual(m.files[0], {
      path: "immutable/assets/a.css",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rawBytes: 6,
      gzipBytes: gzipSync(bytes).length,
    });
    assert.equal(m.totals.files, 2);
    assert.equal(m.totals.gzipBytes, m.files[0].gzipBytes + m.files[1].gzipBytes);
    assert.deepEqual(JSON.parse(readFileSync(join(paths.out, "manifest.json"), "utf8")), m);
    assert.equal(readFileSync(join(paths.out, "css/immutable/assets/b.css"), "utf8"), "d{e:f}");
    assert.equal(existsSync(join(paths.out, "css/immutable/chunks/x.js")), false);
    assert.equal(m.workflow.runId, "7");
  });

  const refused = [
    ["missing client dir", () => ({ ...fixture(), root: join(tmp, "nowhere") }), {}, /missing/],
    ["no CSS", () => fixture({ "immutable/x.js": "1" }), {}, /no client CSS/],
    ["empty CSS", () => fixture({ "a.css": "" }), {}, /empty CSS/],
    ["unsafe name", () => fixture({ "a b.css": "x{}" }), {}, /unsafe CSS path/],
    ["bad leg", fixture, { leg: "both" }, /leg/],
    ["short SHA", fixture, { sourceSha: "abc" }, /SHA/],
    ["uppercase SHA", fixture, { workflowSha: "A".repeat(40) }, /SHA/],
    ["bad run id", fixture, { runId: "1; rm" }, /numeric/],
    ["bad repository", fixture, { repository: "o/r/x" }, /repository/],
    ["too many files", fixture, {}, /more than 1 CSS/, { files: 1 }],
    ["file too large", fixture, {}, /over 3 bytes/, { fileBytes: 3 }],
    ["total too large", fixture, {}, /in total/, { totalBytes: 8 }],
    ["too deep", () => fixture({ "a/b/c.css": "x{}" }), {}, /deeper/, { depth: 1 }],
    ["too many entries", fixture, {}, /entries/, { entries: 1 }],
  ];
  for (const [name, make, over, pattern, limits] of refused) {
    it(`fails closed: ${name}`, () => {
      const paths = make();
      const roomy = { files: 9, fileBytes: 99, totalBytes: 99, entries: 99, depth: 9 };
      assert.throws(() => run(paths, over, limits && { ...roomy, ...limits }), pattern);
      assert.equal(existsSync(join(paths.out, "manifest.json")), false);
    });
  }

  it("accepts each collection boundary and rejects one over it", () => {
    const exact = { files: 2, fileBytes: 6, totalBytes: 12, entries: 4, depth: 2 };
    for (const key of Object.keys(exact)) {
      const accepted = fixture();
      assert.equal(run(accepted, {}, exact).totals.files, 2, key);
      const rejected = fixture();
      assert.throws(() => run(rejected, {}, { ...exact, [key]: exact[key] - 1 }), undefined, key);
      assert.equal(existsSync(rejected.out), false, key);
    }
  });

  it("rejects a wide directory at the entry limit on repeated attempts", () => {
    const paths = fixture({ "a.css": "x{}" });
    for (let i = 0; i < 100; i++) put(paths.root, `extra${i}.js`, "x");
    const limits = { files: 9, fileBytes: 99, totalBytes: 99, entries: 2, depth: 9 };
    for (let i = 0; i < 10; i++) assert.throws(() => run(paths, {}, limits), /entries/);
    assert.equal(existsSync(paths.out), false);
  });

  it("refuses linked ancestors of either path", () => {
    const paths = fixture();
    const alias = join(tmp, `alias${n}`);
    symlinkSync(paths.root, alias);
    assert.throws(
      () => run({ root: paths.root, out: join(alias, "output") }),
      /linked path ancestor/,
    );
    assert.equal(existsSync(join(paths.root, "output")), false);
    assert.throws(() => run({ root: alias, out: paths.out }), /linked path ancestor/);
    assert.equal(existsSync(paths.out), false);
  });

  it("refuses special entries without opening them", () => {
    for (const name of ["pipe.css", "pipe.txt"]) {
      const paths = fixture();
      const result = spawnSync("mkfifo", [join(paths.root, CLIENT_DIR, name)]);
      assert.equal(result.status, 0);
      assert.throws(() => run(paths), /special filesystem entry/);
      assert.equal(existsSync(paths.out), false);
    }
  });

  it("refuses symlinks, dirty or nested output and writes nothing", () => {
    const linked = fixture();
    symlinkSync("/etc/hostname", join(linked.root, CLIENT_DIR, "link.css"));
    assert.throws(() => run(linked), /symbolic link/);
    assert.equal(existsSync(linked.out), false);
    const ancestor = fixture();
    const web = join(ancestor.root, "web");
    rmSync(web, { recursive: true });
    symlinkSync(join(linked.root, "web"), web);
    assert.throws(() => run(ancestor), /linked client directory/);
    assert.equal(existsSync(ancestor.out), false);
    const dirty = fixture();
    mkdirSync(dirty.out);
    writeFileSync(join(dirty.out, "old"), "x");
    assert.throws(() => run(dirty), /fresh directory/);
    const nested = fixture();
    assert.throws(() => run({ root: nested.root, out: join(nested.root, "out") }), /disjoint/);
  });

  it("encodes refused filenames as one Actions annotation", () => {
    const paths = fixture();
    const name = "bad%0A\r\n::warning::injected.css";
    symlinkSync("missing", join(paths.root, CLIENT_DIR, name));
    const script = new URL("./kit-css-collect.mjs", import.meta.url).pathname;
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--root",
        paths.root,
        "--out",
        paths.out,
        "--leg",
        "base",
        "--source-sha",
        sha,
        "--workflow-sha",
        sha,
        "--run-id",
        "1",
        "--run-attempt",
        "1",
        "--repository",
        "o/r",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "::error::kit-css-collect: symbolic link refused: bad%250A%0D%0A::warning::injected.css\n",
    );
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(paths.out, "manifest.json")), false);
  });

  it("exits non-zero with an annotation on bad input and zero on success", () => {
    const script = new URL("./kit-css-collect.mjs", import.meta.url).pathname;
    const paths = fixture();
    const args = ["--root", paths.root, "--out", paths.out, "--leg", "base"];
    const tail = ["--workflow-sha", sha, "--run-id", "1", "--run-attempt", "1"];
    tail.push("--repository", "o/r");
    const node = (list) => spawnSync(process.execPath, [script, ...list], { encoding: "utf8" });
    const bad = node([...args, "--source-sha", "zz", ...tail]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error::kit-css-collect/);
    const ok = node([...args, "--source-sha", sha, ...tail]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /2 CSS files, 12 raw/);
    assert.equal(node(["--unknown"]).status, 1);
  });
});
