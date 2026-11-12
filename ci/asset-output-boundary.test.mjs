import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyStatus, parseStatus, validateRaw } from "./asset-output-boundary.mjs";
import { collectAssetPatch } from "./asset-patch-collection.mjs";

const allowed = ["public/a.js", "public/b.css"];
const hash = "a".repeat(40);
const raw = (oldMode, newMode, status, path = "public/a.js") =>
  `:${oldMode} ${newMode} ${hash} ${hash} ${status}\0${path}\0`;

function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), "asset-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
      patch: "",
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
    assert.match(result.patch, /new file mode 100644/);
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
