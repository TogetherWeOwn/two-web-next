import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const config = fileURLToPath(new URL("../sgconfig.yml", import.meta.url));
const ratchetFilter = "^no-raw-byte-length-comparison-ratchet$";
const git = (cwd, ...args) => execFileSync("git", args, { cwd });

export function scanByteLengthComparisons(cwd, filter) {
  const output = execFileSync(
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
      filter,
      "--warning",
      "--json=compact",
      "--no-ignore",
      "hidden",
    ],
    { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

function comparisons(findings) {
  const entries = [];
  const seen = new Set();
  for (const finding of findings) {
    const file = normalize(finding.file);
    const { text, range } = finding.metaVariables.single.COMPARISON;
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

export function addedByteLengthComparisons(cwd, base, findings) {
  const current = comparisons(findings);
  const eligible = [...new Set(current.map(({ file }) => file))].filter(
    (file) => !file.endsWith(".svelte"),
  );
  if (!eligible.length) return current;

  const tree = git(cwd, "--literal-pathspecs", "ls-tree", "-rz", base, "--", ...eligible);
  const snapshot = mkdtempSync(join(tmpdir(), "ast-grep-byte-length-base-"));
  try {
    for (const entry of tree.toString("utf8").split("\0")) {
      if (!entry.startsWith("100")) continue;
      const tab = entry.indexOf("\t");
      const object = entry.slice(0, tab).split(" ")[2];
      const file = entry.slice(tab + 1);
      const path = join(snapshot, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, git(cwd, "cat-file", "blob", object));
    }
    const allowances = new Map();
    const keyFor = ({ file, text }) => JSON.stringify([file, text]);
    for (const entry of comparisons(scanByteLengthComparisons(snapshot, ratchetFilter))) {
      const key = keyFor(entry);
      allowances.set(key, (allowances.get(key) ?? 0) + 1);
    }
    return current.filter((entry) => {
      const key = keyFor(entry);
      const remaining = allowances.get(key) ?? 0;
      if (remaining) allowances.set(key, remaining - 1);
      return remaining === 0;
    });
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function comparisonBase(cwd) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return git(cwd, "merge-base", "HEAD", "origin/main").toString().trim();
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (event.pull_request) {
    const parents = git(cwd, "show", "-s", "--format=%P", "HEAD").toString().trim().split(" ");
    assert.ok(
      parents.length === 2 && parents[1] === event.pull_request.head.sha,
      "Expected the PR merge checkout",
    );
    return parents[0];
  }
  return git(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${event.merge_group?.base_sha ?? event.before ?? "HEAD^1"}^{commit}`,
  )
    .toString()
    .trim();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const cwd = process.cwd();
  const base = comparisonBase(cwd);
  const added = addedByteLengthComparisons(
    cwd,
    base,
    scanByteLengthComparisons(cwd, ratchetFilter),
  );
  for (const { file, text, line } of added) {
    console.error(
      `${file}:${line}: Use the shared byte-limit helpers for ${JSON.stringify(text)}.`,
    );
  }
  if (added.length) process.exitCode = 1;
}
