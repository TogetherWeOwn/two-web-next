#!/usr/bin/env node
// Hard policy validation on PRs AND merge groups. No date or PR claimed by
// an admission is trusted for accounting: main history uses GitHub merged_at;
// queue attribution verifies each generated squash contribution against the
// attributed PR's added-file blob identities. Unsupported graphs fail closed.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { loadBudgetBases } from "./budget-fragments.mjs";
import { DEPLOY_BASE, loadDeployBase } from "./kit-deploy-budget.mjs";
import {
  DECISIONS_DIR,
  parseAdmission,
  parseAllocation,
  budgetUnits,
  retiredBudgetUnits,
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
    records.push(
      (file.startsWith(`${DECISIONS_DIR}/allocations/`) ? parseAllocation : parseAdmission)(
        file,
        git(root, "cat-file", "blob", blob),
      ),
    );
  }
  return records;
}
function mainPull(pr, repo) {
  return pr?.base?.ref === "main" && pr?.base?.repo?.full_name === repo;
}

// GitHub expresses a requested delay either as delta-seconds or as an
// HTTP-date in retry-after, and as a UNIX-seconds quota reset in
// x-ratelimit-reset. Read whichever is present, in that precedence.
function retryDelaySeconds(headers) {
  const header = (name) => {
    const value = typeof headers.get === "function" ? headers.get(name) : headers[name];
    return typeof value === "string" ? value : null;
  };
  const retryAfter = header("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);
  const date = retryAfter && Date.parse(retryAfter);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  const reset = header("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset))
    return Math.max(0, Number(reset) - Math.ceil(Date.now() / 1000));
  return 0;
}

export function githubRequest(repo, token, fetchImpl = fetch, options = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token)
    throw new Error("GitHub provenance requires repository and read token");
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;
  const cache = new Map();
  return async (endpoint) => {
    if (cache.has(endpoint)) return cache.get(endpoint);
    const rows = [];
    for (let page = 1; page <= 100; page += 1) {
      let body;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let response;
        try {
          response = await fetchImpl(
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
        } catch (error) {
          if (attempt === 2)
            throw new Error(`GitHub provenance network error for ${endpoint}`, { cause: error });
        }
        if (response?.ok) {
          // Reading the body is part of the transport: a stream that terminates
          // after the response arrives is retried exactly like a failed fetch.
          try {
            body = await response.json();
            break;
          } catch (error) {
            if (attempt === 2)
              throw new Error(`GitHub provenance body error for ${endpoint}`, { cause: error });
            response = null;
          }
        }
        if (response) {
          const transient =
            response.status === 429 ||
            response.status >= 500 ||
            (response.status === 403 &&
              (response.headers?.get("retry-after") ||
                response.headers?.get("x-ratelimit-remaining") === "0"));
          if (!transient || attempt === 2)
            throw new Error(`GitHub provenance API ${response.status} for ${endpoint}`);
        }
        const seconds = retryDelaySeconds(new Headers(response?.headers));
        // Do not retry before GitHub's requested delay; fail closed instead of
        // holding the required job indefinitely for an excessive delay.
        if (seconds > 120)
          throw new Error(`GitHub provenance retry delay exceeds bound for ${endpoint}`);
        await wait(Math.max(1000 * 2 ** attempt, seconds * 1000) + Math.floor(random() * 250));
      }
      if (!Array.isArray(body)) {
        cache.set(endpoint, body);
        return body;
      }
      rows.push(...body);
      if (body.length < 100) {
        cache.set(endpoint, rows);
        return rows;
      }
    }
    throw new Error("GitHub provenance pagination exceeded bound");
  };
}

// Only a protected-main GitHub squash commit can supply the old-history
// shortcut. Ordinary author/committer dates and filenames never establish age.
// Recent or nonstandard commits still require GitHub merge_commit_sha/merged_at.
function oldSquashTime(root, commit, pr, now) {
  const [name, email, date, subject] = git(
    root,
    "show",
    "-s",
    "--format=%cn%n%ce%n%cI%n%s",
    commit,
  ).split("\n");
  if (name !== "GitHub" || email !== "noreply@github.com" || !subject.endsWith(` (#${pr})`))
    return null;
  const time = Date.parse(date);
  return Number.isFinite(time) && time <= Date.parse(now) - 7 * 86400000 ? date : null;
}

// Only top-level $ metadata is ignored by the fragment loaders. Permit its
// edits and byte-ceiling decreases; all operational data remains frozen.
function isSafeFragmentChange(before, after) {
  function compare(a, b, key = "", depth = 0) {
    if (a === b) return true;
    if (key === "maxRawBytes" || key === "maxGzipBytes") {
      if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && b > 0 && b < a) {
        return true;
      }
      return false;
    }
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) ||
      Array.isArray(b)
    )
      return false;
    const keys = Object.keys(a).filter((k) => depth !== 0 || !k.startsWith("$"));
    const otherKeys = Object.keys(b).filter((k) => depth !== 0 || !k.startsWith("$"));
    return (
      keys.length === otherKeys.length &&
      keys.every((k) => Object.hasOwn(b, k) && compare(a[k], b[k], k, depth + 1))
    );
  }
  return compare(before, after);
}

function validateAllocationChanges(
  root,
  base,
  baseFiles,
  headFiles,
  head,
  installOnly,
  renamesServed,
) {
  const records = admissions(
    root,
    new Map([...headFiles].filter(([file]) => !baseFiles.has(file))),
  ).filter((record) => record.action);
  const initial = new Set(installOnly);
  const retired = new Set();
  const existing = new Set();
  for (const [file, blob] of baseFiles) {
    if (file.startsWith("ci/budgets/bundle/")) {
      const plan = JSON.parse(git(root, "cat-file", "blob", blob));
      for (const unit of budgetUnits("bundle", plan.budgets).keys()) existing.add(unit);
    }
  }
  // A retired identity cannot be recycled as a fresh base to reset its caps. Keep
  // the retired asset's effective ceiling keyed by its served path: a rename
  // that re-registers the very same asset may only carry those ceilings forward
  // or tighten them, never exceed them.
  const retiredCeilings = new Map();
  const retiredPaths = new Set();
  // Retirement evidence can arrive in this very contribution (a rename retires
  // the old identity and initializes the new one together), so read it from the
  // base history and from this change's own added files.
  for (const record of [
    ...admissions(root, baseFiles),
    ...admissions(root, new Map([...headFiles].filter(([file]) => !baseFiles.has(file)))),
  ].filter((row) => row.action === "retire")) {
    const served = Object.keys(record.budget.budgets)[0];
    retiredPaths.add(served);
    for (const [unit, entry] of budgetUnits("bundle", record.budget.budgets)) {
      existing.add(unit);
      retiredCeilings.set(`${served}\u0000${entry.path.at(-1)}`, entry.value);
    }
  }
  // Which retired served asset each new one continues: the retire/initial pairs
  // in this very change, matched on fragment naming (a renames b -> b). A rename
  // is recorded as retiring the old identity and initializing the new one, so
  // that pairing is the recognition; an unrelated new asset has no prior ceiling
  // to inherit and its growth goes through the ordinary admission caps instead.
  const inheritedAssets = new Map();
  for (const record of records.filter((row) => row.action === "initial")) {
    const served = Object.keys(record.budget.budgets)[0];
    // A recognized rename: the provider reports the old served path as the origin
    // of the new one, and retiring that identity is part of the same change.
    const prior = renamesServed.get(served);
    if (prior !== undefined && retiredCeilings.has(`${prior}\u0000maxRawBytes`))
      inheritedAssets.set(served, prior);
  }
  for (const record of records) {
    const { fragment, budget, measured, action } = record;
    const target = action === "initial" ? initial : retired;
    if (target.has(fragment)) throw new Error(`duplicate allocation: ${fragment}`);
    if (
      action === "initial"
        ? baseFiles.has(fragment) || !headFiles.has(fragment)
        : !baseFiles.has(fragment) || headFiles.has(fragment)
    )
      throw new Error(`allocation must match a new/deleted fragment: ${fragment}`);
    const blob = (action === "initial" ? headFiles : baseFiles).get(fragment);
    // Compare the mapping structurally: JSON member order is a serialization
    // detail, not part of the lifecycle contract (see ci/budgets/README.md
    // "budget must reproduce the fragment's complete JSON mapping").
    if (!sameJsonMapping(JSON.parse(git(root, "cat-file", "blob", blob)), budget))
      throw new Error(`allocation fragment evidence mismatch: ${fragment}`);
    const asset = Object.keys(budget.budgets)[0];
    const identity = git(
      root,
      "ls-tree",
      "--format=%(objectmode) %(objectname)",
      head,
      "--",
      asset,
    );
    if (action === "retire") {
      if (identity) throw new Error(`retirement asset remains in inventory: ${asset}`);
    } else {
      if (!identity.startsWith("100644 "))
        throw new Error(`allocation asset missing from inventory: ${asset}`);
      const bytes = execFileSync("git", ["-C", root, "cat-file", "blob", identity.slice(7)], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const sizes = { maxRawBytes: bytes.length, maxGzipBytes: gzipSync(bytes).length };
      for (const [unit, entry] of budgetUnits("bundle", budget.budgets)) {
        if (existing.has(unit))
          throw new Error(`duplicate initial allocation for existing unit: ${unit}`);
        existing.add(unit);
        // A rename must not launder an oversized asset into fresh ceilings. When
        // the identical served bytes are in flight under a new path, this initial
        // allocation is that retired asset under a new identity: the new ceiling
        // may only carry the retired one forward, or tighten it.
        const axis = entry.path.at(-1);
        const priorPath = inheritedAssets.get(asset);
        const prior =
          priorPath === undefined ? undefined : retiredCeilings.get(`${priorPath}\u0000${axis}`);
        if (prior !== undefined && entry.value > prior)
          throw new Error(`rename ceiling exceeds the retired ceiling: ${unit}`);
        const actual = sizes[entry.path.at(-1)];
        if (
          measured[unit] !== actual ||
          entry.value < actual ||
          BigInt(entry.value) * 100n > BigInt(actual) * 102n
        )
          throw new Error(`initial allocation requires exact measurement plus at most 2%: ${unit}`);
      }
    }
    target.add(fragment);
  }
  const tightened = new Set();
  for (const [file, blob] of baseFiles) {
    if (
      !/^ci\/budgets\/(kit|bundle)\/[^/]+\.json$/.test(file) ||
      !headFiles.has(file) ||
      headFiles.get(file) === blob
    )
      continue;
    try {
      if (
        isSafeFragmentChange(
          JSON.parse(git(root, "cat-file", "blob", blob)),
          JSON.parse(git(root, "cat-file", "blob", headFiles.get(file))),
        )
      )
        tightened.add(file);
    } catch {
      /* malformed changes remain frozen */
    }
  }
  validateFrozenFiles(baseFiles, headFiles, initial, retired, tightened);
  return { initial, retired };
}

// Deep structural equality for JSON values: arrays compare element-wise in
// order (order is meaningful there), objects compare by member set and value
// however the source spelled them.
function sameJsonMapping(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameJsonMapping(item, b[index]));
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => key in b && sameJsonMapping(a[key], b[key]))
  );
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
  const accumulatedRenames = new Map();
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
    const { initial, retired } = validateAllocationChanges(
      root,
      previous,
      previousFiles,
      files,
      commit,
      initialAllocations,
      accumulatedRenames,
    );
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
            entry.filename === file &&
            entry.sha === files.get(file) &&
            (entry.status === "added" ||
              (entry.status === "renamed" &&
                file.startsWith("ci/budgets/bundle/") &&
                initial.has(file) &&
                retired.has(entry.previous_filename))),
        );
        if (proof.length !== 1 || attributed.has(file))
          throw new Error(`missing/ambiguous PR file attribution: ${file}`);
        attributed.set(file, number);
        for (const entry of prFiles) {
          if (entry.status === "renamed" && entry.previous_filename?.startsWith("public/"))
            accumulatedRenames.set(entry.filename, entry.previous_filename);
        }
      }
    }
    previous = commit;
    previousFiles = files;
  }
  if (previous !== head) throw new Error("empty/unsupported queue attribution range");
  return { attributed, renames: accumulatedRenames };
}

export async function checkBudgetAdmissions({
  root,
  repo,
  eventName,
  event,
  now,
  request,
  pullRequestRenames,
}) {
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
  // The deploy base has a one-time installation exception, separate from
  // measured served-asset lifecycle decisions. Its measured-main SHA must
  // already be in the trusted base; the exception cannot be reused later.
  const installing = !git(root, "ls-tree", base, "--", "ci/check-budget-admissions.mjs");
  const initialAllocations = installing ? new Set([DEPLOY_BASE]) : new Set();
  // Which served asset the provider reports each new one as continuing. On a pull
  // request this comes from the PR's file list; on a merge group the queue
  // traversal supplies its own per-contribution provenance. It is injected
  // rather than fetched here so hermetic fixtures can exercise both paths.
  let queueRenames = new Map();
  const provenRenames = new Map();
  for (const [next, prior] of Object.entries(
    eventName === "pull_request" ? (pullRequestRenames?.(event) ?? {}) : {},
  )) {
    if (prior?.startsWith("public/")) provenRenames.set(next, prior);
  }
  for (const [next, prior] of queueRenames) provenRenames.set(next, prior);
  validateAllocationChanges(
    root,
    base,
    baseFiles,
    headFiles,
    head,
    initialAllocations,
    provenRenames,
  );
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
  // A lower base must not manufacture the overage used to justify an
  // admission against what was actually available at the group's base.
  const tightenedUnits = new Set();
  for (const [file, blob] of baseFiles) {
    const match = /^ci\/budgets\/(kit|bundle)\/[^/]+\.json$/.exec(file);
    if (!match || !headFiles.has(file) || headFiles.get(file) === blob) continue;
    const before = JSON.parse(git(root, "cat-file", "blob", blob));
    const after = JSON.parse(git(root, "cat-file", "blob", headFiles.get(file)));
    const kind = match[1];
    const oldUnits = budgetUnits(kind, kind === "bundle" ? before.budgets : before);
    const newUnits = budgetUnits(kind, kind === "bundle" ? after.budgets : after);
    for (const [unit, value] of oldUnits) {
      if (newUnits.get(unit).value < value.value) tightenedUnits.add(unit);
    }
  }
  if (proposed.some((record) => !record.action && tightenedUnits.has(record.unit)))
    throw new Error("cannot tighten a unit and add its admission in the same batch");
  const mergeCache = new Map();
  const activeUnits = new Set(
    proposed.filter((record) => !record.action).map((record) => record.unit),
  );
  for (const record of historical) {
    // Frozen history on untouched units cannot change any cap outcome. Avoid
    // making unrelated PRs depend on GitHub API availability.
    if (record.action || !activeUnits.has(record.unit)) continue;
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
    const oldTime = oldSquashTime(root, commit, record.pr, now);
    if (oldTime) {
      record.mergedAt = oldTime;
      continue;
    }
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
  } else {
    const queue = await queueAttribution(
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
      if (record.pr !== queue.attributed.get(record.file))
        throw new Error(`queue PR attribution mismatch: ${record.file}`);
    }
    queueRenames = queue.renames;
  }
  const newUnits = new Set(
    proposed
      .filter((row) => row.action === "initial")
      .flatMap((row) => [...budgetUnits("bundle", row.budget.budgets).keys()]),
  );
  if (proposed.some((row) => !row.action && newUnits.has(row.unit)))
    throw new Error("initial allocation cannot also receive a delta");
  const retired = retiredBudgetUnits([...historical, ...proposed]);
  if (proposed.some((row) => !row.action && retired.has(row.unit)))
    throw new Error("retired unit cannot receive a new delta");
  const totals = validateAdmissions({
    bases: loadBudgetBases(root),
    historical: historical.filter((record) => !record.action),
    proposed: proposed.filter((record) => !record.action),
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
    "History frozen and operational bases only tightened; aggregate per-PR 0.5% and trusted rolling 7-day 2% caps passed.",
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
