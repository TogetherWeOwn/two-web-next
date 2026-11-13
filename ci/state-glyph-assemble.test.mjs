// State glyph assembly: the script pins two reviewed commits and one tree id,
// so these tests run it as a child process against a fake `git` on PATH. The
// fake records every call and answers from a JSON config, which lets each
// failure path be forced without real commits that hash to the pins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./state-glyph-assemble.mjs", import.meta.url));
const PIN = "c5fc4d991f87485ac2a1a06e0a1aa9486a355a4f";
const GLYPH = "b952cc5888ff1e91a4095c3d7edce2ebbda92e83";
const TREE = "c6b391c683b3ca5c61a3ad8263a7d088bbd7bbb3";
const FILES = ["web/src/lib/StateGlyph.svelte", "test/kit-state-glyph.test.ts"];

const FAKE_GIT = `const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_CONFIG, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "-C") process.exit(97);
const dir = args[1];
const [cmd, ...rest] = args.slice(2);
const side = cfg.dirs[dir] || {};
if (cmd === "rev-parse") console.log(side.head ?? "");
else if (cmd === "status") console.log(side.status ?? "");
else if (cmd === "ls-tree") console.log((side.lsTree || {})[rest[rest.length - 1]] ?? "");
else if (cmd === "add") {}
else if (cmd === "write-tree") console.log(cfg.tree);
else process.exit(98);
`;

let root;
let pinDir;
let glyphDir;
let binDir;

function writeConfig(overrides = {}) {
  const lsTree = Object.fromEntries(FILES.map((f) => [f, `100644 blob abc\t${f}`]));
  const cfg = {
    tree: TREE,
    dirs: {
      [pinDir]: { head: PIN, status: "", lsTree: {} },
      [glyphDir]: { head: GLYPH, status: "", lsTree },
    },
  };
  overrides.mutate?.(cfg);
  writeFileSync(join(root, "config.json"), JSON.stringify(cfg));
}

function run(args = [pinDir, glyphDir]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GIT_CONFIG: join(root, "config.json"),
      FAKE_GIT_LOG: join(root, "git.log"),
    },
  });
}

function gitCalls() {
  const path = join(root, "git.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "state-glyph-assemble-"));
  pinDir = join(root, "app");
  glyphDir = join(root, "glyph");
  binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "fake-git.cjs"), FAKE_GIT);
  writeFileSync(
    join(binDir, "git"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(binDir, "fake-git.cjs")}" "$@"\n`,
  );
  chmodSync(join(binDir, "git"), 0o755);
  for (const f of FILES) {
    mkdirSync(join(pinDir, f, ".."), { recursive: true });
    mkdirSync(join(glyphDir, f, ".."), { recursive: true });
    writeFileSync(join(glyphDir, f), `contents of ${f}\n`);
  }
  writeConfig();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("copies the allowlisted files, stages them, and prints the manifest", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    pin: PIN,
    glyph: GLYPH,
    integrationTree: TREE,
    overlay: FILES,
  });
  for (const f of FILES) {
    assert.equal(readFileSync(join(pinDir, f), "utf8"), `contents of ${f}\n`);
  }
  const calls = gitCalls();
  const add = calls.find((c) => c[2] === "add");
  assert.deepEqual(add, ["-C", pinDir, "add", "--", ...FILES]);
  assert.equal(calls.at(-1)[2], "write-tree");
});

for (const [name, args] of [
  ["no arguments", []],
  ["one argument", ["only-one"]],
  ["three arguments", ["a", "b", "c"]],
  ["an empty argument", ["", "b"]],
]) {
  test(`rejects ${name} before touching git`, () => {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected separate pin-stack and glyph checkout paths/);
    assert.deepEqual(gitCalls(), []);
  });
}

test("rejects a pin checkout at the wrong commit", () => {
  writeConfig({ mutate: (c) => (c.dirs[pinDir].head = GLYPH) });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty or does not match its reviewed commit/);
  assert.equal(existsSync(join(pinDir, FILES[0])), false);
});

test("rejects a glyph checkout at the wrong commit", () => {
  writeConfig({ mutate: (c) => (c.dirs[glyphDir].head = PIN) });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty or does not match its reviewed commit/);
});

test("rejects a dirty pin checkout", () => {
  writeConfig({ mutate: (c) => (c.dirs[pinDir].status = "?? stray.txt") });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty or does not match its reviewed commit/);
});

test("rejects a dirty glyph checkout", () => {
  writeConfig({ mutate: (c) => (c.dirs[glyphDir].status = " M web/src/lib/StateGlyph.svelte") });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty or does not match its reviewed commit/);
});

for (const [label, line] of [
  ["executable", "100755 blob abc\tf"],
  ["symlink", "120000 blob abc\tf"],
  ["missing from the commit", ""],
]) {
  test(`rejects a glyph file that is ${label}`, () => {
    writeConfig({ mutate: (c) => (c.dirs[glyphDir].lsTree[FILES[0]] = line) });
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Unexpected glyph file mode: ${FILES[0]}`));
    assert.equal(existsSync(join(pinDir, FILES[0])), false);
  });
}

test("rejects a glyph path that is a symlink in the working tree", () => {
  const target = join(root, "outside.txt");
  writeFileSync(target, "secret\n");
  rmSync(join(glyphDir, FILES[0]));
  symlinkSync(target, join(glyphDir, FILES[0]));
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Not a regular file: ${FILES[0]}`));
  assert.equal(existsSync(join(pinDir, FILES[0])), false);
});

test("rejects a glyph file missing from the working tree", () => {
  rmSync(join(glyphDir, FILES[0]));
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
});

test("rejects an overlay path that already exists in the pin commit", () => {
  writeConfig({
    mutate: (c) => (c.dirs[pinDir].lsTree[FILES[0]] = `100644 blob abc\t${FILES[0]}`),
  });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Overlay already exists: ${FILES[0]}`));
  assert.equal(existsSync(join(pinDir, FILES[0])), false);
  assert.equal(
    gitCalls().some((c) => c[2] === "add"),
    false,
  );
});

test("a failure on the second file leaves the first copied but never stages or hashes", () => {
  writeConfig({ mutate: (c) => (c.dirs[glyphDir].lsTree[FILES[1]] = "100755 blob abc\tf") });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Unexpected glyph file mode: ${FILES[1]}`));
  assert.equal(readFileSync(join(pinDir, FILES[0]), "utf8"), `contents of ${FILES[0]}\n`);
  assert.equal(existsSync(join(pinDir, FILES[1])), false);
  const calls = gitCalls();
  assert.equal(
    calls.some((c) => c[2] === "add" || c[2] === "write-tree"),
    false,
  );
});

test("rejects an integration tree that differs from the reviewed tree", () => {
  writeConfig({ mutate: (c) => (c.tree = "0".repeat(40)) });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Integration tree mismatch: 0{40}/);
  assert.equal(result.stdout, "");
});

test("surfaces a failing git command as a non-zero exit", () => {
  // The fake exits 98 for unknown subcommands; an unreachable git must not pass silently.
  writeFileSync(join(binDir, "git"), "#!/bin/sh\nexit 1\n");
  const result = run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
