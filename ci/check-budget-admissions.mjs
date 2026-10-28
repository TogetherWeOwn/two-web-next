#!/usr/bin/env node
// Hard policy validation on PRs AND merge groups. No date or PR claimed by
// an admission is trusted for accounting: main history uses GitHub merged_at;
// queue attribution verifies each generated squash contribution against the
// attributed PR's added-file blob identities. Unsupported graphs fail closed.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBudgetBases } from "./budget-fragments.mjs";
import { DEPLOY_BASE, loadDeployBase } from "./kit-deploy-budget.mjs";
import {
  DECISIONS_DIR,
  parseAdmission,
  validateAdmissions,
  validateFrozenFiles,
} from "./budget-ledger.mjs";

const MANAGED = ["ci/budgets/kit", "ci/budgets/bundle", "ci/budgets/deploy", DECISIONS_DIR];
const SHA = /^[a-f0-9]{40}$/;
function sha(value) {
  if (typeof value !== "string" || !SHA.test(value))
    throw new Error("missing/invalid budget event SHA");
  return value;
}
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}
function snapshot(root, ref) {
  const result = new Map();
  const lines = git(
    root,
    "ls-tree",
    "-r",
    "--format=%(objectmode) %(objectname)\t%(path)",
    sha(ref),
    "--",
    ...MANAGED,
  );
  for (const line of lines.split("\n").filter(Boolean)) {
    const [identity, path] = line.split("\t");
    if (!path || !identity.startsWith("100644 "))
      throw new Error("budget evidence must be regular git files");
    result.set(path, identity.slice(7));
  }
  return result;
}
function admissions(root, files) {
  const records = [];
  for (const [file, blob] of files) {
    if (!file.startsWith(`${DECISIONS_DIR}/`)) continue;
    if (/^ci\/budgets\/decisions\/(kit-perf|bundle)\//.test(file)) continue;
    records.push(parseAdmission(file, git(root, "cat-file", "blob", blob)));
  }
  return records;
}
function mainPull(pr, repo) {
  return pr?.base?.ref === "main" && pr?.base?.repo?.full_name === repo;
}

export function githubRequest(repo, token, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token)
    throw new Error("GitHub provenance requires repository and read token");
  // Paginate arrays without relying on a truncated first page. API paths are
  // constructed here, never taken from decision bodies or response URLs.
  return async (endpoint) => {
    const rows = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}/${endpoint}?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub provenance API ${response.status} for ${endpoint}`);
      const body = await response.json();
      if (!Array.isArray(body)) return body;
      rows.push(...body);
      if (body.length < 100) return rows;
    }
    throw new Error("GitHub provenance pagination exceeded bound");
  };
}

async function mergedPull(commit, repo, request) {
  const pulls = await request(`commits/${commit}/pulls`);
  const matching = pulls.filter(
    (pr) => pr.merge_commit_sha === commit && pr.merged_at && mainPull(pr, repo),
  );
  if (matching.length !== 1) throw new Error(`missing/ambiguous main merge provenance: ${commit}`);
  return matching[0];
}

async function queueAttribution(
  root,
  base,
  head,
  baseFiles,
  repo,
  request,
  eventName,
  initialAllocations,
) {
  const attributed = new Map();
  const commits = git(root, "rev-list", "--first-parent", "--reverse", `${base}..${head}`)
    .split("\n")
    .filter(Boolean);
  let previous = base;
  let previousFiles = baseFiles;
  for (const commit of commits) {
    const parents = git(root, "show", "-s", "--format=%P", commit).split(" ");
    if (parents.length !== 1 || parents[0] !== previous)
      throw new Error("unsupported queue attribution graph (expected squash chain)");
    const files = snapshot(root, commit);
    validateFrozenFiles(previousFiles, files, initialAllocations);
    const added = [...files.keys()].filter((file) => !previousFiles.has(file));
    if (added.length) {
      let number;
      if (eventName === "push") {
        number = (await mergedPull(commit, repo, request)).number;
      } else {
        const subject = git(root, "show", "-s", "--format=%s", commit);
        const match = / \(#([1-9]\d*)\)$/.exec(subject);
        if (!match) throw new Error(`missing GitHub squash queue attribution: ${commit}`);
        number = Number(match[1]);
      }
      const pull = await request(`pulls/${number}`);
      if (!mainPull(pull, repo))
        throw new Error("queue attribution targets a different base/repository");
      const prFiles = await request(`pulls/${number}/files`);
      for (const file of added) {
        const proof = prFiles.filter(
          (entry) =>
            entry.filename === file && entry.status === "added" && entry.sha === files.get(file),
        );
        if (proof.length !== 1 || attributed.has(file))
          throw new Error(`missing/ambiguous PR file attribution: ${file}`);
        attributed.set(file, number);
      }
    }
    previous = commit;
    previousFiles = files;
  }
  if (previous !== head) throw new Error("empty/unsupported queue attribution range");
  return attributed;
}

export async function checkBudgetAdmissions({ root, repo, eventName, event, now, request }) {
  const head = sha(git(root, "rev-parse", "HEAD"));
  let base;
  if (eventName === "pull_request") {
    base = sha(event?.pull_request?.base?.sha);
    try {
      git(root, "merge-base", "--is-ancestor", sha(event?.pull_request?.head?.sha), head);
    } catch {
      throw new Error("budget PR checkout does not contain event head");
    }
  } else if (eventName === "merge_group") {
    base = sha(event?.merge_group?.base_sha);
    if (
      event.merge_group.base_ref !== "refs/heads/main" ||
      head !== sha(event.merge_group.head_sha)
    ) {
      throw new Error("budget event checkout does not match main merge group");
    }
  } else if (eventName === "push" && event?.ref === "refs/heads/main") base = sha(event.before);
  else throw new Error("unsupported/missing budget event context");
  git(root, "merge-base", "--is-ancestor", base, head);
  // Measure the same immutable bytes validated below, not a dirty install's
  // modified fragment or an untracked shadow admission.
  if (git(root, "status", "--porcelain", "--untracked-files=all", "--", ...MANAGED)) {
    throw new Error("budget bases/history differ from event checkout");
  }
  const baseFiles = snapshot(root, base);
  const headFiles = snapshot(root, head);
  // One-time installation is a separately reviewed initial allocation, not
  // an ongoing agent escape hatch. Once this checker exists on main, even a
  // new base is rejected. The measured-main SHA must be in the trusted base.
  const installing = !git(root, "ls-tree", base, "--", "ci/check-budget-admissions.mjs");
  const initialAllocations = installing ? new Set([DEPLOY_BASE]) : new Set();
  validateFrozenFiles(baseFiles, headFiles, initialAllocations);
  if (headFiles.has(DEPLOY_BASE) && !baseFiles.has(DEPLOY_BASE)) {
    loadDeployBase(root);
    const evidence = JSON.parse(
      git(root, "cat-file", "blob", headFiles.get(DEPLOY_BASE)),
    ).measuredMain;
    git(root, "merge-base", "--is-ancestor", sha(evidence.sha), base);
  }
  const historical = admissions(root, baseFiles);
  const proposed = admissions(
    root,
    new Map([...headFiles].filter(([file]) => !baseFiles.has(file))),
  );
  const mergeCache = new Map();
  for (const record of historical) {
    const commits = git(
      root,
      "log",
      "--first-parent",
      "--diff-filter=A",
      "--format=%H",
      base,
      "--",
      record.file,
    )
      .split("\n")
      .filter(Boolean);
    if (commits.length !== 1) throw new Error(`ambiguous main merge provenance: ${record.file}`);
    const commit = commits[0];
    if (!mergeCache.has(commit)) mergeCache.set(commit, await mergedPull(commit, repo, request));
    const pull = mergeCache.get(commit);
    if (pull.number !== record.pr)
      throw new Error(`historical PR attribution mismatch: ${record.file}`);
    record.mergedAt = pull.merged_at;
  }
  if (eventName === "pull_request") {
    if (!Number.isSafeInteger(event.number) || event.number < 1)
      throw new Error("invalid budget PR event number");
    for (const record of proposed) {
      if (record.pr !== event.number) throw new Error(`PR attribution mismatch: ${record.file}`);
    }
  } else if (proposed.length) {
    const attributed = await queueAttribution(
      root,
      base,
      head,
      baseFiles,
      repo,
      request,
      eventName,
      initialAllocations,
    );
    for (const record of proposed) {
      if (record.pr !== attributed.get(record.file))
        throw new Error(`queue PR attribution mismatch: ${record.file}`);
    }
  }
  const totals = validateAdmissions({
    bases: loadBudgetBases(root),
    historical,
    proposed,
    now,
  });
  return {
    proposed,
    historical,
    totals,
    authoritative: eventName !== "pull_request",
  };
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const result = await checkBudgetAdmissions({
    root,
    repo: process.env.GITHUB_REPOSITORY,
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    now: new Date().toISOString(),
    request: githubRequest(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
  });
  const lines = [
    "## Budget admission policy",
    "",
    `Validated ${result.proposed.length} new decisions and ${result.historical.length} historical decisions.`,
    "Base and history frozen; aggregate per-PR 0.5% and trusted rolling 7-day 2% caps passed.",
    result.authoritative
      ? "Authoritative combined-main/queue validation."
      : "Prequeue policy validation; merge-group measurement remains authoritative.",
    "",
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`budget admissions: cannot enforce: ${error.message}`);
    process.exitCode = 2;
  });
}
