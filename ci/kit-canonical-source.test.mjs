import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  bindCanonicalSources,
  canonicalCellIdentity,
  inspectCanonicalSource,
} from "./kit-canonical-source.mjs";

const B_COMMIT = "1fe09ab868a6fea4a7873e4a096523b78747b232";
const B_TREE = "454843aa9ac7b9f911020108ba539a4353ee977d";
const OTHER_SHA = "2".repeat(40);
const ZERO = "0".repeat(40);

const scratch = realpathSync(
  mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "kit-canonical-source-")),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  PATH: process.env.PATH,
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
};

function git(root, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", root, ...args],
    { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(result.status, 0, `fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

let counter = 0;
function fixtureRoot(name = "repo") {
  const root = join(scratch, `${name}-${counter++}`);
  mkdirSync(root);
  return root;
}

function write(root, path, content, mode) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mode) chmodSync(full, mode);
}

function commitAll(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

// Inert data only: nothing here is executed.
const FILES = {
  ".gitignore": "dist/\n",
  "README.md": "fixture readme\n",
  "package-lock.json": '{"lockfileVersion":3,"packages":{}}\n',
  "wrangler.jsonc": '{"name":"fixture-inert"}\n',
  "src/index.txt": "inert source data\n",
  ".github/workflows/ci.yml": "name: inert\n",
};

function makeRepo(name) {
  const root = fixtureRoot(name);
  git(root, "init", "-q");
  for (const [path, content] of Object.entries(FILES)) write(root, path, content);
  write(root, "bin/tool.sh", "inert executable data\n", 0o755);
  const sha = commitAll(root, "first");
  return { root, sha };
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("canonicalCellIdentity permits only exact B commit and tree", () => {
  const collectorSha = OTHER_SHA;
  assert.deepEqual(canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT, collectorSha }), {
    cell: "B",
    candidateSha: B_COMMIT,
    candidateTree: B_TREE,
    collectorSha,
  });
});

test("canonicalCellIdentity rejects later cells, defaults, floats and equal D=B", () => {
  const collectorSha = OTHER_SHA;
  for (const cell of ["A", "C", "D", "b", "B ", "", undefined, null, 1.5, 2]) {
    assert.throws(
      () => canonicalCellIdentity({ cell, candidateSha: B_COMMIT, collectorSha }),
      /no approved source mapping/,
      `cell ${String(cell)}`,
    );
  }
  assert.throws(() => canonicalCellIdentity({}), /explicit full source SHA/);
  assert.throws(() => canonicalCellIdentity({ cell: "B" }), /explicit full source SHA/);
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", collectorSha }),
    /explicit full source SHA/,
  );
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT }),
    /explicit full source SHA/,
  );
  for (const bad of [1.5, 123, "1fe09ab", B_COMMIT.toUpperCase(), `${B_COMMIT}0`, "HEAD", "main"]) {
    assert.throws(
      () => canonicalCellIdentity({ cell: "B", candidateSha: bad, collectorSha }),
      /explicit full source SHA/,
      `candidate ${String(bad)}`,
    );
    assert.throws(
      () => canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT, collectorSha: bad }),
      /explicit full source SHA/,
      `collector ${String(bad)}`,
    );
  }
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", candidateSha: OTHER_SHA, collectorSha: ZERO }),
    /does not match cell/,
  );
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT, collectorSha: B_COMMIT }),
    /collector cannot be the measured baseline/,
  );
});

test("inspectCanonicalSource returns a receipt with real fields and digests", () => {
  const { root, sha: first } = makeRepo("receipt");
  write(root, "src/index.txt", "second inert data\n");
  const second = commitAll(root, "second");
  const receipt = inspectCanonicalSource(root, second);

  assert.equal(receipt.commit, second);
  assert.equal(receipt.tree, git(root, "rev-parse", `${second}^{tree}`));
  assert.deepEqual(receipt.parents, [first]);
  assert.deepEqual(inspectCanonicalSource(root, second), receipt, "receipt is deterministic");

  const expectedPaths = git(root, "ls-tree", "-r", "--name-only", second).split("\n");
  assert.deepEqual(
    receipt.files.map((file) => file.path),
    expectedPaths,
  );
  assert.ok(!receipt.files.some((file) => file.path.startsWith("dist/")));
  for (const file of receipt.files) {
    const bytes = Buffer.from(
      file.path === "src/index.txt"
        ? "second inert data\n"
        : file.path === "bin/tool.sh"
          ? "inert executable data\n"
          : FILES[file.path],
    );
    assert.deepEqual(Object.keys(file), ["path", "mode", "blob", "bytes", "sha256"]);
    assert.equal(file.bytes, bytes.length, file.path);
    assert.equal(file.sha256, sha256Hex(bytes), file.path);
    assert.equal(file.blob, git(root, "rev-parse", `${second}:${file.path}`), file.path);
    assert.equal(file.mode, file.path === "bin/tool.sh" ? "100755" : "100644", file.path);
  }
  assert.equal(receipt.filesSha256, sha256Hex(JSON.stringify(receipt.files)));

  const original = makeRepo("receipt-rootcommit");
  const rootCommit = inspectCanonicalSource(original.root, original.sha);
  assert.equal(rootCommit.commit, original.sha);
  assert.deepEqual(rootCommit.parents, []);
});

test("inspectCanonicalSource reports a root commit with no parents", () => {
  const { root, sha } = makeRepo("rootcommit");
  assert.deepEqual(inspectCanonicalSource(root, sha).parents, []);
});

test("inspectCanonicalSource allows generated ignored output", () => {
  const { root, sha } = makeRepo("ignored");
  write(root, "dist/generated.js", "generated inert output\n");
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  const receipt = inspectCanonicalSource(root, sha);
  assert.ok(!receipt.files.some((file) => file.path.startsWith("dist/")));
});

test("inspectCanonicalSource rejects bad expected SHAs and wrong HEAD", () => {
  const { root, sha } = makeRepo("head");
  for (const bad of [undefined, "", "HEAD", sha.slice(0, 12), sha.toUpperCase(), 1.5]) {
    assert.throws(() => inspectCanonicalSource(root, bad), /explicit full source SHA/);
  }
  assert.throws(() => inspectCanonicalSource(root, OTHER_SHA), /source HEAD mismatch/);
  write(root, "src/index.txt", "later\n");
  commitAll(root, "later");
  assert.throws(() => inspectCanonicalSource(root, sha), /source HEAD mismatch/);
});

test("inspectCanonicalSource rejects the wrong root", () => {
  const { root, sha } = makeRepo("wrongroot");
  assert.throws(() => inspectCanonicalSource(join(root, "src"), sha), /not source root/);
  const plain = fixtureRoot("nongit");
  assert.throws(() => inspectCanonicalSource(plain, sha), /Git inspection failed|not source root/);
  assert.throws(() => inspectCanonicalSource(join(scratch, "does-not-exist"), sha));
});

test("inspectCanonicalSource rejects a symlinked or aliased root", () => {
  const { root, sha } = makeRepo("aliasroot");
  const alias = join(scratch, `alias-${counter++}`);
  symlinkSync(root, alias);
  assert.throws(() => inspectCanonicalSource(alias, sha), /missing or symlinked|alias/);
});

test("inspectCanonicalSource rejects changed, missing and untracked files", () => {
  const changed = makeRepo("changed");
  write(changed.root, "src/index.txt", "tampered\n");
  assert.throws(() => inspectCanonicalSource(changed.root, changed.sha), /dirty/);

  const missing = makeRepo("missing");
  unlinkSync(join(missing.root, "src/index.txt"));
  assert.throws(() => inspectCanonicalSource(missing.root, missing.sha), /dirty/);

  const untracked = makeRepo("untracked");
  write(untracked.root, "extra/new.txt", "not in tree\n");
  assert.throws(() => inspectCanonicalSource(untracked.root, untracked.sha), /dirty/);

  const staged = makeRepo("staged");
  write(staged.root, "src/index.txt", "staged change\n");
  git(staged.root, "add", "src/index.txt");
  assert.throws(() => inspectCanonicalSource(staged.root, staged.sha), /dirty/);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`blob comparison catches mutation hidden by ${flag}`, () => {
    const { root, sha } = makeRepo(`hidden${flag.replaceAll("-", "")}`);
    write(root, "src/index.txt", "hidden tamper\n");
    git(root, "update-index", flag, "src/index.txt");
    assert.equal(
      git(root, "status", "--porcelain=v1", "--untracked-files=all"),
      "",
      "fixture must hide the mutation from status",
    );
    assert.throws(
      () => inspectCanonicalSource(root, sha),
      /tracked source bytes differ from pinned tree/,
    );
  });

  test(`hidden missing file under ${flag} still fails`, () => {
    const { root, sha } = makeRepo(`hiddenmissing${flag.replaceAll("-", "")}`);
    unlinkSync(join(root, "src/index.txt"));
    git(root, "update-index", flag, "src/index.txt");
    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.throws(() => inspectCanonicalSource(root, sha));
  });

  test(`tracked lock and config mutations are refused under ${flag}`, () => {
    for (const path of ["package-lock.json", "wrangler.jsonc"]) {
      const { root, sha } = makeRepo(`lock${path.replace(/\W/g, "")}${flag.replaceAll("-", "")}`);
      write(root, path, `${FILES[path]}\n`);
      assert.throws(() => inspectCanonicalSource(root, sha), /dirty/, `plain ${path}`);
      git(root, "update-index", flag, path);
      assert.throws(
        () => inspectCanonicalSource(root, sha),
        /tracked source bytes differ from pinned tree/,
        `hidden ${path}`,
      );
    }
  });
}

test("hidden mode change is refused", () => {
  const { root, sha } = makeRepo("hiddenmode");
  chmodSync(join(root, "bin/tool.sh"), 0o644);
  git(root, "update-index", "--assume-unchanged", "bin/tool.sh");
  assert.throws(
    () => inspectCanonicalSource(root, sha),
    /tracked source mode differs from pinned tree/,
  );
  const added = makeRepo("hiddenmodeadd");
  chmodSync(join(added.root, "README.md"), 0o755);
  git(added.root, "update-index", "--assume-unchanged", "README.md");
  assert.throws(
    () => inspectCanonicalSource(added.root, added.sha),
    /tracked source mode differs from pinned tree/,
  );
});

test("tracked symlinks are unsupported tree members", () => {
  const root = fixtureRoot("symlink");
  git(root, "init", "-q");
  write(root, "README.md", "inert\n");
  symlinkSync("README.md", join(root, "link.md"));
  const sha = commitAll(root, "with symlink");
  assert.throws(() => inspectCanonicalSource(root, sha), /unsupported source tree member/);
});

test("a regular file replaced by a symlink is refused even when hidden", () => {
  const { root, sha } = makeRepo("swapped");
  unlinkSync(join(root, "src/index.txt"));
  symlinkSync("../README.md", join(root, "src/index.txt"));
  git(root, "update-index", "--assume-unchanged", "src/index.txt");
  assert.throws(() => inspectCanonicalSource(root, sha));
});

test("a tracked directory replaced by a symlink is refused even when hidden", () => {
  const { root, sha } = makeRepo("dirswap");
  const outside = fixtureRoot("outside");
  write(outside, "index.txt", FILES["src/index.txt"]);
  rmSync(join(root, "src"), { recursive: true });
  symlinkSync(outside, join(root, "src"));
  git(root, "update-index", "--assume-unchanged", "src/index.txt");
  assert.throws(() => inspectCanonicalSource(root, sha), /missing or symlinked/);
});

test("submodule-style gitlinks are unsupported tree members", () => {
  const root = fixtureRoot("gitlink");
  git(root, "init", "-q");
  write(root, "README.md", "inert\n");
  git(root, "add", "README.md");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${OTHER_SHA},vendor/mod`);
  git(root, "commit", "-q", "-m", "gitlink");
  const sha = git(root, "rev-parse", "HEAD");
  assert.throws(() => inspectCanonicalSource(root, sha));
});

test("unsafe tracked paths are refused", () => {
  const root = fixtureRoot("unsafepath");
  git(root, "init", "-q");
  write(root, "README.md", "inert\n");
  write(root, "back\\slash.txt", "inert\n");
  const sha = commitAll(root, "backslash path");
  assert.throws(() => inspectCanonicalSource(root, sha), /unsafe tracked source path/);
});

test("empty tree is refused", () => {
  const root = fixtureRoot("empty");
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "empty");
  const sha = git(root, "rev-parse", "HEAD");
  assert.throws(() => inspectCanonicalSource(root, sha), /source file count bound/);
});

test("bindCanonicalSources checks the cell before touching any path", () => {
  const missing = join(scratch, "never-created");
  for (const cell of ["A", "C", undefined]) {
    assert.throws(
      () =>
        bindCanonicalSources(missing, missing, {
          cell,
          candidateSha: B_COMMIT,
          collectorSha: OTHER_SHA,
        }),
      /no approved source mapping/,
    );
  }
  assert.throws(
    () =>
      bindCanonicalSources(missing, missing, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: B_COMMIT,
      }),
    /collector cannot be the measured baseline/,
  );
});

test("canonical source fixtures stay wired into the existing Actions selftests", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(
    workflow,
    /run: node --test [^\n]*ci\/kit-canonical-retention\.test\.mjs ci\/kit-canonical-source\.test\.mjs/,
  );
});

const bContext = { cell: "B", candidateSha: B_COMMIT, collectorSha: OTHER_SHA };

test("bindCanonicalSources rejects equal and nested roots before inspecting sources", () => {
  const { root } = makeRepo("bind-equal");
  assert.throws(() => bindCanonicalSources(root, root, bContext), /separate and non-nested/);
  assert.throws(
    () => bindCanonicalSources(root, join(root, "src"), bContext),
    /separate and non-nested/,
  );
  assert.throws(
    () => bindCanonicalSources(join(root, "src"), root, bContext),
    /separate and non-nested/,
  );
});

test("bindCanonicalSources requires the actual B source", () => {
  const collector = makeRepo("bind-collector");
  const candidate = makeRepo("bind-candidate");
  // Fixture repositories cannot reproduce the pinned B commit, so binding must fail.
  assert.throws(
    () =>
      bindCanonicalSources(collector.root, candidate.root, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: collector.sha,
      }),
    /source HEAD mismatch/,
  );
  assert.throws(
    () =>
      bindCanonicalSources(collector.root, candidate.root, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: OTHER_SHA,
      }),
    /source HEAD mismatch/,
  );
});
