// Assemble the reviewed integration stack in a disposable Actions checkout.
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

const PIN = "b492421e51215ec7b6781afe05017d3229da306e";
const GLYPH = "b952cc5888ff1e91a4095c3d7edce2ebbda92e83";
const EXPECTED_TREE = "56d0e1037f4df6d0dc896ee62dc16476d33991de";
const FILES = ["web/src/lib/StateGlyph.svelte", "test/kit-state-glyph.test.ts"];

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

const [pinDir, glyphDir] = process.argv.slice(2);
if (!pinDir || !glyphDir || process.argv.length !== 4) {
  throw new Error("Expected separate pin-stack and glyph checkout paths");
}
for (const [directory, expected] of [
  [pinDir, PIN],
  [glyphDir, GLYPH],
]) {
  if (git(directory, "rev-parse", "HEAD") !== expected || git(directory, "status", "--porcelain")) {
    throw new Error("Source checkout is dirty or does not match its reviewed commit");
  }
}
for (const path of FILES) {
  // Only regular tracked files from the pinned commit may cross the boundary.
  if (git(glyphDir, "ls-tree", GLYPH, "--", path).split(" ")[0] !== "100644") {
    throw new Error(`Unexpected glyph file mode: ${path}`);
  }
  if (!lstatSync(join(glyphDir, path)).isFile()) throw new Error(`Not a regular file: ${path}`);
  if (git(pinDir, "ls-tree", PIN, "--", path)) throw new Error(`Overlay already exists: ${path}`);
  copyFileSync(join(glyphDir, path), join(pinDir, path));
}
git(pinDir, "add", "--", ...FILES);
const tree = git(pinDir, "write-tree");
if (tree !== EXPECTED_TREE) throw new Error(`Integration tree mismatch: ${tree}`);
process.stdout.write(
  `${JSON.stringify({ pin: PIN, glyph: GLYPH, integrationTree: tree, overlay: FILES }, null, 2)}\n`,
);
