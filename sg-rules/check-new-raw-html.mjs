// ast-grep reports every match. Use added Git lines as the baseline so existing
// assertions need no suppressions and a newly copied assertion still fails.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { normalize } from "node:path";
import { parseDiff } from "../ci/patch-coverage.mjs";

const rule = "no-raw-html-assertion";
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function baseRef() {
  if (process.env.GITHUB_ACTIONS !== "true") return "origin/main";
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const sha = event.pull_request?.base.sha ?? event.merge_group?.base_sha ?? event.before;
  if (sha === undefined || /^0{40}$/.test(sha)) return "origin/main";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid GitHub diff base SHA");
  return sha;
}

try {
  const base = git("merge-base", baseRef(), "HEAD").trim();
  const added = parseDiff(
    git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames",
      "--unified=0",
      base,
      "--",
    ),
  );
  const untracked = new Set(git("ls-files", "--others", "--exclude-standard", "-z").split("\0"));
  const output = execFileSync(
    "npx",
    [
      "-y",
      "--package",
      "@ast-grep/cli@0.50.0",
      "ast-grep",
      "scan",
      "--json=compact",
      "--filter",
      `^${rule}$`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  let violations = 0;
  for (const {
    file,
    range: { start, end },
    message,
  } of JSON.parse(output)) {
    const path = normalize(file);
    const lines = added.get(path);
    // ast-grep lines are zero-based and the end position is exclusive.
    const lastLine = end.line + Number(end.column > 0);
    let line = start.line + 1;
    while (line <= lastLine && !untracked.has(path) && !lines?.has(line)) line++;
    if (line > lastLine) continue;
    console.error(`${path}:${line}: ${message} (${rule})`);
    violations++;
  }
  if (violations > 0) process.exitCode = 1;
  else console.log(`${rule}: no findings on added lines`);
} catch (error) {
  console.error(`${rule}: ${error.message}`);
  process.exitCode = 2;
}
