import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const config = fileURLToPath(new URL("../sgconfig.yml", import.meta.url));
const rules = "^no-raw-byte-length-comparison(-tsx)?$";
const maxBuffer = 8 * 1024 * 1024;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, maxBuffer });
const appSource = /^(?:src|web\/src|assets)\//;
const nodeScript = /\.(?:mjs|js)$/;
const inScope = (file) =>
  (nodeScript.test(file) && !file.startsWith("public/")) ||
  (appSource.test(file) && /\.(?:ts|mts|cts|cjs|tsx|jsx)$/.test(file)) ||
  (file.startsWith("web/src/") && file.endsWith(".svelte"));

function scan(files, read) {
  if (!files.length) return [];
  const snapshot = mkdtempSync(join(tmpdir(), "ast-grep-byte-length-"));
  try {
    for (const file of files) {
      const bytes = read(file);
      assert.ok(isUtf8(bytes), `${file}: invalid UTF-8`);
      const path = join(snapshot, file);
      mkdirSync(dirname(path), { recursive: true });
      // Use an equal-length replacement so directives cannot hide matches or move their locations.
      writeFileSync(path, bytes.toString("utf8").replaceAll("ast-grep-ignore", "ast-grep-checks"));
    }
    const { status, error, stdout, stderr } = spawnSync(
      "npx",
      [
        "-y",
        "--package",
        "@ast-grep/cli@0.50.0",
        "ast-grep",
        "scan",
        "--config",
        config,
        "--filter",
        rules,
        "--warning",
        "--json=compact",
        "--inspect=summary",
        "--no-ignore",
        "hidden",
      ],
      { cwd: snapshot, encoding: "utf8", maxBuffer },
    );
    assert.equal(status, 0, error?.message ?? stderr);
    assert.ok(
      stderr.includes(`scannedFileCount=${files.length},skippedFileCount=0`),
      `Incomplete ast-grep scan:\n${stderr}`,
    );
    return JSON.parse(stdout);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export function scanByteLengthComparisons(cwd, allowUnstagedDeletions = true) {
  const paths = git(cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  assert.ok(isUtf8(paths), "Git returned non-UTF-8 paths");
  const removals = git(cwd, "ls-files", "--deleted", "-z");
  assert.ok(
    allowUnstagedDeletions || !removals.length,
    "The CI checkout has missing tracked files",
  );
  const deleted = new Set(removals.toString("utf8").split("\0"));
  const files = [...new Set(paths.toString("utf8").split("\0"))].filter(
    (file) => inScope(file) && !deleted.has(file),
  );
  return scan(files, (file) => {
    const path = join(cwd, file);
    assert.ok(lstatSync(path).isFile(), `${file}: expected a regular source file`);
    return readFileSync(path);
  });
}

function comparisons(findings) {
  const entries = [];
  const seen = new Set();
  for (const { file, metaVariables } of findings) {
    const { text, range } = metaVariables.single.COMPARISON;
    // A comparison can have a byte-length access on both sides.
    const occurrence = JSON.stringify([file, range.byteOffset.start, range.byteOffset.end]);
    if (seen.has(occurrence)) continue;
    seen.add(occurrence);
    entries.push({ file, text, line: range.start.line + 1 });
  }
  return entries.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

function addedByteLengthComparisons(cwd, base, findings) {
  const current = comparisons(findings);
  const eligible = [...new Set(current.map(({ file }) => file))].filter(
    (file) =>
      (nodeScript.test(file) && !appSource.test(file)) || file === "src/events/attendee-paths.ts",
  );
  if (!eligible.length) return current;

  const tree = git(cwd, "--literal-pathspecs", "ls-tree", "-rz", base, "--", ...eligible);
  assert.ok(isUtf8(tree), "Git returned non-UTF-8 base paths");
  const objects = new Map();
  for (const entry of tree.toString("utf8").split("\0")) {
    if (!entry.startsWith("100")) continue;
    const tab = entry.indexOf("\t");
    objects.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]);
  }
  const allowances = new Map();
  const keyFor = ({ file, text }) => JSON.stringify([file, text]);
  for (const entry of comparisons(
    scan([...objects.keys()], (file) => git(cwd, "cat-file", "blob", objects.get(file))),
  )) {
    const key = keyFor(entry);
    allowances.set(key, (allowances.get(key) ?? 0) + 1);
  }
  return current.filter((entry) => {
    const key = keyFor(entry);
    const remaining = allowances.get(key) ?? 0;
    if (remaining) allowances.set(key, remaining - 1);
    return remaining === 0;
  });
}

function comparisonBase(cwd) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};
  if (event.pull_request) {
    const parents = git(cwd, "show", "-s", "--format=%P", "HEAD").toString().trim().split(" ");
    assert.ok(
      parents.length === 2 && parents[1] === event.pull_request.head.sha,
      "Expected the PR merge checkout",
    );
    return parents[0];
  }
  const base = event.merge_group?.base_sha ?? event.before;
  const args = base
    ? ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]
    : ["merge-base", "HEAD", "origin/main"];
  return git(cwd, ...args)
    .toString()
    .trim();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const cwd = process.cwd();
  const base = comparisonBase(cwd);
  const findings = scanByteLengthComparisons(cwd, process.env.GITHUB_ACTIONS !== "true");
  const added = addedByteLengthComparisons(cwd, base, findings);
  for (const { file, text, line } of added) {
    console.error(
      `${file}:${line}: Use the shared byte-limit helpers for ${JSON.stringify(text)}.`,
    );
  }
  if (added.length) process.exitCode = 1;
}
