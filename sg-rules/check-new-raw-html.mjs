// ast-grep reports every match. Use added Git lines as the baseline so existing
// assertions need no suppressions and a newly copied assertion still fails.
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { matchesGlob, normalize } from "node:path";
import { parse as parseScript } from "@babel/parser";
import { parse } from "yaml";
import { parseDiff } from "../ci/patch-coverage.mjs";

const rule = "no-raw-html-assertion";
const displayPath = (path) =>
  path.replace(/\p{C}/gu, (char) => `\\u{${char.codePointAt(0).toString(16)}}`);
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: "pipe" });

function baseRef() {
  if (process.env.GITHUB_ACTIONS !== "true") return "origin/main";
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const sha = event.pull_request?.base.sha ?? event.merge_group?.base_sha ?? event.before;
  if (sha === undefined || /^0{40}$/.test(sha)) return "origin/main";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid GitHub diff base SHA");
  return sha;
}

function hasSuppression(path) {
  if (!lstatSync(path).isFile()) throw new Error("Expected a regular source file");
  const source = readFileSync(path, "utf8");
  if (!source.includes("ast-grep-ignore")) return false;
  const ast = parseScript(source, {
    sourceType: path.endsWith(".cjs") ? "commonjs" : "unambiguous",
    plugins: ["typescript"],
  });
  return ast.comments?.some(({ value }) => /^[^\p{Alphabetic}]*ast-grep-ignore/u.test(value));
}

function scan(paths) {
  if (paths.length === 0) return [];
  const cli = ["-y", "--package", "@ast-grep/cli@0.50.0", "ast-grep"];
  const options = ["scan", "--json=compact", "--inspect=entity", "--filter", `^${rule}$`];
  const result = spawnSync("npx", [...cli, ...options, "--", ...paths], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  // The pinned CLI can exit zero after a walker error or a skipped read.
  const files = /^sg: summary\|file: scannedFileCount=(\d+),skippedFileCount=0$/m;
  const rules = /^sg: summary\|rule: effectiveRuleCount=1,skippedRuleCount=\d+$/m;
  const applied = result.stderr.match(/: language=TypeScript,appliedRuleCount=1$/gm);
  if (
    result.status !== 0 ||
    Number(files.exec(result.stderr)?.[1]) !== paths.length ||
    applied?.length !== paths.length ||
    !rules.test(result.stderr) ||
    /^ERROR:/m.test(result.stderr)
  )
    throw new Error("Incomplete ast-grep scan");
  return JSON.parse(result.stdout);
}

let stage = "read the Git baseline";
try {
  const base = git("merge-base", baseRef(), "HEAD").trim();
  const added = parseDiff(
    git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--text",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames",
      "--unified=0",
      base,
      "--",
    ),
  );
  const untracked = new Set(git("ls-files", "--others", "--exclude-standard", "-z").split("\0"));
  stage = "scan every added file in scope";
  const { files: scopes, message } = parse(readFileSync(`sg-rules/${rule}.yml`, "utf8"));
  const changed = [...added].filter(([, lines]) => lines.size > 0).map(([path]) => path);
  const paths = [...new Set([...changed, ...untracked])].filter((path) =>
    scopes.some((scope) => matchesGlob(path, scope)),
  );
  const suppressed = paths.find(hasSuppression);
  if (suppressed) console.error(`${displayPath(suppressed)}: ast-grep suppression is forbidden`);
  let violations = Number(Boolean(suppressed));
  for (const {
    file,
    range: { start, end },
  } of suppressed ? [] : scan(paths)) {
    const path = normalize(file);
    const lines = added.get(path);
    // ast-grep lines are zero-based and the end position is exclusive.
    const lastLine = end.line + Number(end.column > 0);
    let line = start.line + 1;
    while (line <= lastLine && !untracked.has(path) && !lines?.has(line)) line++;
    if (line > lastLine) continue;
    console.error(`${displayPath(path)}:${line}: ${message} (${rule})`);
    violations++;
  }
  if (violations > 0) process.exitCode = 1;
  else console.log(`${rule}: no findings on added lines`);
} catch {
  console.error(`${rule}: could not ${stage}`);
  process.exitCode = 2;
}
