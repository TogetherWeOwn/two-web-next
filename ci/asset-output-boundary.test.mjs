import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyStatus, parseStatus, validateRaw } from "./asset-output-boundary.mjs";
import { collectAssetPatch } from "./asset-patch-collection.mjs";

const allowed = ["public/a.js", "public/b.css"];
const hash = "a".repeat(40);
const raw = (oldMode, newMode, status, path = "public/a.js") =>
  `:${oldMode} ${newMode} ${hash} ${hash} ${status}\0${path}\0`;

function checkout(t, trailingSpace = false) {
  const temporary = mkdtempSync(join(tmpdir(), "asset-patch-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = trailingSpace ? join(temporary, "checkout ") : temporary;
  if (trailingSpace) mkdirSync(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/a.js"), "old\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const sourceSha = git("rev-parse", "HEAD").trim();
  return { root, git, sourceSha, allowed };
}

describe("asset patch collection", () => {
  it("collects only allowed modified and new outputs as an applicable patch", (t) => {
    const input = checkout(t);
    assert.deepEqual(collectAssetPatch(input), {
      sourceSha: input.sourceSha,
      files: [],
      patch: Buffer.alloc(0),
    });
    writeFileSync(join(input.root, "public/a.js"), "changed\n");
    writeFileSync(join(input.root, "public/b.css"), "new\n");
    const result = collectAssetPatch(input);
    assert.deepEqual(result.files, allowed);
    assert.equal(result.sourceSha, input.sourceSha);
    const patchFile = join(tmpdir(), `asset-patch-${input.sourceSha}-${process.pid}`);
    t.after(() => rmSync(patchFile, { force: true }));
    writeFileSync(patchFile, result.patch);
    input.git("reset", "--hard", "-q", input.sourceSha);
    rmSync(join(input.root, "public/b.css"), { force: true });
    input.git("apply", "--check", patchFile);
    input.git("apply", patchFile);
    assert.match(result.patch.toString("utf8"), /new file mode 100644/);
  });

  it("round trips non-UTF-8 text and binary bytes despite configured diff drivers", (t) => {
    const input = checkout(t);
    const text = Buffer.from([0x61, 0xff, 0x0a]);
    const binary = Buffer.from([0x00, 0xff, 0x01, 0x00, 0x0a]);
    writeFileSync(join(input.root, ".git/info/attributes"), "public/* diff=fixture\n");
    input.git("config", "diff.fixture.command", "false");
    input.git("config", "diff.fixture.textconv", "false");
    writeFileSync(join(input.root, "public/a.js"), text);
    writeFileSync(join(input.root, "public/b.css"), binary);
    const result = collectAssetPatch(input);
    const withoutBinary = input.git("diff", "--no-ext-diff", "--no-textconv", "--", ...allowed);
    assert.match(withoutBinary, /Binary files/);
    const patchFile = join(input.root, ".git/fixture.patch");
    writeFileSync(patchFile, result.patch);
    input.git("reset", "--hard", "-q", input.sourceSha);
    rmSync(join(input.root, "public/b.css"), { force: true });
    writeFileSync(join(input.root, ".git/no-binary.patch"), withoutBinary);
    assert.throws(() => input.git("apply", "--check", ".git/no-binary.patch"));
    input.git("apply", patchFile);
    assert.deepEqual(readFileSync(join(input.root, "public/a.js")), text);
    assert.deepEqual(readFileSync(join(input.root, "public/b.css")), binary);
  });

  it("fails closed when patch output exceeds the one MiB bound", (t) => {
    const input = checkout(t);
    writeFileSync(join(input.root, "public/a.js"), Buffer.alloc(900 * 1024, 0x61));
    assert.ok(collectAssetPatch(input).patch.length > 900 * 1024);
    writeFileSync(join(input.root, "public/a.js"), Buffer.alloc(1024 * 1024, 0x61));
    assert.throws(() => collectAssetPatch(input), /maxBuffer|ENOBUFS/);
  });

  it("rejects unexpected, deleted and staged paths", (t) => {
    const input = checkout(t);
    writeFileSync(join(input.root, "stray"), "unexpected");
    assert.throws(() => collectAssetPatch(input), /unexpected outputs/);
    rmSync(join(input.root, "stray"));
    rmSync(join(input.root, "public/a.js"));
    assert.throws(() => collectAssetPatch(input), /unexpected outputs/);
    input.git("restore", "public/a.js");
    writeFileSync(join(input.root, "public/a.js"), "staged");
    input.git("add", "public/a.js");
    assert.throws(() => collectAssetPatch(input), /unexpected outputs/);
  });

  it("rejects executable files and symlink replacements", (t) => {
    const input = checkout(t);
    chmodSync(join(input.root, "public/a.js"), 0o755);
    assert.throws(() => collectAssetPatch(input), /unsafe diff/);
    chmodSync(join(input.root, "public/a.js"), 0o644);
    rmSync(join(input.root, "public/a.js"));
    symlinkSync("b.css", join(input.root, "public/a.js"));
    assert.throws(() => collectAssetPatch(input), /malformed porcelain status|unsafe diff/);
  });

  it("accepts checkout paths ending in whitespace", (t) => {
    const input = checkout(t, true);
    writeFileSync(join(input.root, "public/a.js"), "changed\n");
    assert.deepEqual(collectAssetPatch(input).files, ["public/a.js"]);
  });

  it("does not select another checkout through inherited Git variables", (t) => {
    const input = checkout(t);
    const other = mkdtempSync(join(tmpdir(), "asset-other-"));
    t.after(() => rmSync(other, { recursive: true, force: true }));
    execFileSync("git", ["clone", "-q", input.root, other]);
    writeFileSync(join(input.root, "public/a.js"), "from input\n");
    writeFileSync(join(other, "public/b.css"), "other checkout\n");
    const before = readFileSync(join(other, ".git/index"));
    const oldDir = process.env.GIT_DIR;
    const oldTree = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      const result = collectAssetPatch(input);
      assert.deepEqual(result.files, ["public/a.js"]);
      assert.match(result.patch.toString(), /from input/);
    } finally {
      if (oldDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = oldDir;
      if (oldTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = oldTree;
    }
    assert.deepEqual(readFileSync(join(other, ".git/index")), before);
  });

  it("emits ordinary applicable prefixes despite conflicting Git configuration", (t) => {
    const input = checkout(t);
    input.git("config", "diff.noprefix", "true");
    input.git("config", "diff.context", "0");
    input.git("config", "color.ui", "always");
    writeFileSync(join(input.root, "public/b.css"), "new output\n");
    const result = collectAssetPatch(input);
    const patchFile = join(input.root, ".git/fixture.patch");
    writeFileSync(patchFile, result.patch);
    rmSync(join(input.root, "public/b.css"));
    input.git("apply", patchFile);
    assert.equal(readFileSync(join(input.root, "public/b.css"), "utf8"), "new output\n");
    assert.throws(() => readFileSync(join(input.root, "b.css")), /ENOENT/);
  });

  it("rejects conversions even when normalization hides a byte-only change", (t) => {
    const input = checkout(t);
    writeFileSync(join(input.root, ".git/info/attributes"), "public/* text eol=lf\n");
    writeFileSync(join(input.root, "public/a.js"), "old\r\n");
    assert.throws(() => collectAssetPatch(input), /conversion|attribute/i);
  });

  it("rejects legacy CRLF conversion attributes", (t) => {
    const input = checkout(t);
    for (const attribute of ["crlf", "crlf=input"]) {
      writeFileSync(join(input.root, ".git/info/attributes"), `public/* ${attribute}\n`);
      writeFileSync(join(input.root, "public/a.js"), "old\r\n");
      assert.throws(() => collectAssetPatch(input), /conversion|attribute/i);
    }
  });

  it("rejects clean filters named like check-attr sentinel values", (t) => {
    const input = checkout(t);
    for (const name of ["unset", "unspecified"]) {
      writeFileSync(join(input.root, ".git/info/attributes"), `public/* filter=${name}\n`);
      input.git("config", `filter.${name}.clean`, "printf 'old\\n'");
      writeFileSync(join(input.root, "public/a.js"), "changed\n");
      assert.throws(() => collectAssetPatch(input), /conversion|filter/i);
      input.git("config", "--unset", `filter.${name}.clean`);
    }
  });

  it("rejects clean filters before invoking them", (t) => {
    const input = checkout(t);
    const marker = join(input.root, ".git/filter-ran");
    writeFileSync(join(input.root, ".git/info/attributes"), "public/* filter=fixture\n");
    input.git("config", "filter.fixture.clean", `touch ${marker}; cat`);
    writeFileSync(join(input.root, "public/a.js"), "changed\n");
    assert.throws(() => collectAssetPatch(input), /conversion|attribute/i);
    assert.throws(() => readFileSync(marker), /ENOENT/);
  });

  it("treats allowlisted pathspec metacharacters literally", (t) => {
    const input = checkout(t);
    const literal = "public/a[1].js";
    writeFileSync(join(input.root, literal), "literal\n");
    const result = collectAssetPatch({ ...input, allowed: [literal] });
    assert.deepEqual(result.files, [literal]);
    const patchFile = join(input.root, ".git/literal.patch");
    writeFileSync(patchFile, result.patch);
    rmSync(join(input.root, literal));
    input.git("apply", patchFile);
    assert.equal(readFileSync(join(input.root, literal), "utf8"), "literal\n");
  });

  it("rejects executable output when Git filemode tracking is disabled", (t) => {
    const input = checkout(t);
    input.git("config", "core.filemode", "false");
    chmodSync(join(input.root, "public/a.js"), 0o755);
    assert.throws(() => collectAssetPatch(input), /executable|unsafe diff/i);
  });

  it("rejects ignored new allowed outputs rather than omitting them", (t) => {
    const input = checkout(t);
    writeFileSync(join(input.root, ".git/info/exclude"), "public/b.css\n");
    writeFileSync(join(input.root, "public/b.css"), "ignored\n");
    assert.throws(() => collectAssetPatch(input), /ignored/i);
  });

  it("rejects invalid or wrong source identity and propagates Git failures", (t) => {
    const input = checkout(t);
    assert.throws(() => collectAssetPatch({ ...input, sourceSha: "HEAD" }), /exact source SHA/);
    assert.throws(
      () => collectAssetPatch({ ...input, sourceSha: "a".repeat(40) }),
      /does not match/,
    );
    assert.throws(() => collectAssetPatch({ ...input, root: join(input.root, "missing") }));
    assert.throws(
      () => collectAssetPatch({ ...input, allowed: ["public/../bad"] }),
      /invalid allowed/,
    );
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
