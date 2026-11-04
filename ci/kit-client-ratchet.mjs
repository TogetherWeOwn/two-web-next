#!/usr/bin/env node
// This writer uses only builtins and trusted main source. It never runs an
// artifact, installs a package, merges a PR, updates main, or force-pushes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROUTE_BUDGET,
  ROUTE_SCOPE,
  targetBytes,
  validateRouteBudget,
} from "./kit-route-budget.mjs";

export const BRANCH = "ci/client-budget-ratchet";
export const TITLE = "ci(perf): lower measured client budget ceilings";
export const CLIENT_FILES = [
  "ci/budgets/kit/client-js.json",
  "ci/budgets/kit/client-css.json",
  ROUTE_BUDGET,
];
const SHA = /^[a-f0-9]{40}$/;
const metrics = [
  ["rawBytes", "maxRawBytes", 512],
  ["gzipBytes", "maxGzipBytes", 256],
];
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const same = (a, b) => assert.deepEqual(a, b, "revision/inventory mismatch");
const keys = (v, expected) => {
  assert.ok(v && typeof v === "object" && !Array.isArray(v), "expected object");
  same(Object.keys(v).sort(), [...expected].sort());
};

function units(files) {
  const result = [];
  for (const [index, kind] of ["js", "css"].entries()) {
    const file = files[CLIENT_FILES[index]];
    keys(file, ["$comment", "client"]);
    assert.equal(typeof file.$comment, "string");
    keys(file.client, [kind]);
    result.push({ path: CLIENT_FILES[index], id: "aggregate", kind, ceiling: file.client[kind] });
  }
  const routeBudget = validateRouteBudget(files[ROUTE_BUDGET]);
  for (const [id, route] of Object.entries(routeBudget.routes))
    for (const kind of ["js", "css"])
      result.push({ path: ROUTE_BUDGET, id, kind, ceiling: route[kind] });
  for (const { ceiling } of result) {
    keys(ceiling, ["maxRawBytes", "maxGzipBytes", "maxFiles"]);
    for (const v of Object.values(ceiling))
      assert.ok(Number.isSafeInteger(v) && v >= 0, "invalid ceiling");
  }
  return result;
}

export function assertLowerOnly(base, next) {
  const baseline = units(base);
  const candidate = units(next);
  assert.equal(candidate.length, baseline.length);
  const expected = structuredClone(base);
  const expectedUnits = units(expected);
  for (let i = 0; i < baseline.length; i += 1) {
    same(
      [candidate[i].path, candidate[i].id, candidate[i].kind],
      [baseline[i].path, baseline[i].id, baseline[i].kind],
    );
    for (const [, key] of metrics) {
      assert.ok(candidate[i].ceiling[key] <= baseline[i].ceiling[key], "refusing increase");
      expectedUnits[i].ceiling[key] = candidate[i].ceiling[key];
    }
  }
  same(expected, next); // no comments, inventory, maxFiles, server or floor edits
}

export function propose(report, base, previous = base) {
  assert.equal(report.version, 1);
  assert.ok(SHA.test(report.sha), "missing commit evidence");
  const m = report.measurement;
  assert.equal(m?.version, 1);
  assert.equal(m.scope, ROUTE_SCOPE);
  assert.equal(m.exitCode, 0, "measurement did not pass");
  same(m.breaches, []);
  assert.equal(m.error, undefined, "measurement has error");
  same(Object.keys(m.routes).sort(), Object.keys(base[ROUTE_BUDGET].routes).sort());
  assertLowerOnly(base, previous);
  const files = structuredClone(previous);
  const changes = [];
  const shortfalls = [];
  const baselineUnits = units(base);
  for (const [index, { path, id, kind, ceiling }] of units(files).entries()) {
    const measured = id === "aggregate" ? m.aggregate[kind] : m.routes[id][kind];
    keys(measured, ["rawBytes", "gzipBytes", "files", "assets"]);
    for (const key of ["rawBytes", "gzipBytes", "files"])
      assert.ok(Number.isSafeInteger(measured[key]) && measured[key] >= 0, "invalid measurement");
    assert.ok(
      Array.isArray(measured.assets) && measured.assets.length === measured.files,
      "missing asset evidence",
    );
    assert.equal(new Set(measured.assets).size, measured.assets.length, "duplicate assets");
    for (const asset of measured.assets)
      assert.ok(
        typeof asset === "string" &&
          asset.startsWith(id === "aggregate" ? "_app/" : "_app/immutable/") &&
          !asset.includes("\\") &&
          !asset.split("/").some((part) => !part || part === "." || part === "..") &&
          asset.endsWith(`.${kind}`),
        "invalid asset evidence",
      );
    assert.ok(measured.files <= ceiling.maxFiles, "file count breach");
    for (const [key, limit, step] of metrics) {
      const original = baselineUnits[index].ceiling;
      assert.ok(measured[key] <= original[limit], "measurement exceeds current main ceiling");
      const target = targetBytes(measured[key], step);
      if (target > ceiling[limit])
        shortfalls.push({ path, id, kind, limit, ceiling: ceiling[limit], target });
      // STRICTLY more than one step. At exactly one step we do nothing.
      if (ceiling[limit] - target > step) {
        changes.push({
          path,
          id,
          kind,
          limit,
          measured: measured[key],
          before: ceiling[limit],
          after: target,
          step,
        });
        ceiling[limit] = target;
      }
    }
  }
  assertLowerOnly(base, files);
  assertLowerOnly(previous, files); // never re-raise an earlier draft's lowering
  return { files, changes, shortfalls };
}

const decisionPath = (sha) =>
  `ci/budgets/decisions/kit-perf/auto-client-ratchet-${sha.slice(0, 12)}.md`;
export const prBody = (sha) => `<!-- client-budget-ratchet:v1 ${sha} -->
## Linked Issues or Issue Description

Propose lower client ceilings from a trusted main build. No product or served bytes change.

## What Changed (optional)

- Lower only raw/gzip client ceilings. Preserve file caps, server/startup and CWV floors.
- Record measurements, strict step semantics and Undo in \`${decisionPath(sha)}\`.

## Verification

- Credential-free main build passed aggregate, served-asset and route checks before publishing its measurement.
- Repository-token create/update events do not trigger PR checks. Supported updates follow the draft hold-and-drain protocol below.
- Before promotion, an independently authenticated maintainer must append a persistent "Promotion hold" note to this PR body while it is still draft. Keep the edited body: all future writers refuse it; do not restore the automation body.
- Wait for every already-started client-budget-ratchet writer job to finish, including queued/waiting jobs. An in-flight commit may land after the hold. Re-read and pin the final PR head only after those jobs settle. No workflow setting or credential change is needed.
- Then mark this draft ready (GitHub UI or existing authorized CLI identity, never this workflow's repository token). Direct ready promotion while a writer is in flight is unsupported: the final metadata read and post-write check are not an atomic PR-state lock.
- Verify the normal CI, e2e, PR-lint/security checks and required reviews on that exact generated head before merge. If they are absent, stop; do not bypass or substitute older-head results. If a commit races an unsupported promotion, return to draft, keep the hold, drain writers, and promote again independently so normal workflows run on the settled head.
- This draft does not auto-merge. The writer refuses further updates once it is ready or its body is held; a metadata race after the last read is reported as failure, not rolled back or retried.

## Attestation

risk_tier: T1

### Claims

- C1: Only measured client byte ceilings decrease; application bytes and other gates do not change.

### Tests

- C1 | test=${decisionPath(sha)} | failed_before=not-run | proof=Generated decision records measured inputs; no code changes in this draft.

### High-risk checklist

- [ ] D1: No secrets in measurement or decision; byte counts and client asset paths only.
- [ ] D2: Not applicable: no authentication behavior changes.
- [ ] D3: Not applicable: no database or migration changes.
- [ ] D4: Headroom is measured times 1.25, rounded up by documented steps.
- [ ] D5: Writer uses expected-head compare-and-swap and refuses human revisions.
- [ ] D6: Normal required checks must run when this draft is marked ready.
- [ ] D7: Missing measurement evidence refuses the proposal.
- [ ] D8: Only allowlisted client budget files and this decision can change.

## Notes for reviewers (optional)

Undo: revert this PR's budget changes and generated decision through a reviewed PR; automation never raises ceilings.

## Model Used

No model is invoked at runtime; this draft is deterministic budget automation. The tooling was authored with Claude Code assistance; the attribution below credits that tooling, not a model run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;

export function replayDecision(evidence) {
  keys(evidence, ["version", "base", "history"]);
  assert.equal(evidence.version, 1);
  assert.ok(
    Array.isArray(evidence.history) && evidence.history.length > 0 && evidence.history.length < 100,
    "missing or excessive proposal history",
  );
  let result = { files: evidence.base };
  for (const entry of evidence.history) {
    keys(entry, ["report", "result"]);
    const expected = propose(entry.report, evidence.base, result.files);
    assert.deepEqual(entry.result, expected, "invalid proposal history");
    assert.ok(expected.changes.length > 0, "empty proposal");
    result = expected;
  }
  return result;
}

export function parseDecision(text) {
  const matches = [...text.matchAll(/## Machine-verifiable proposal\n\n```json\n([\s\S]*?)\n```/g)];
  assert.equal(matches.length, 1, "missing or ambiguous measured decision");
  const evidence = JSON.parse(matches[0][1]);
  replayDecision(evidence);
  return evidence;
}

export function measuredDecision(report, base, result, history = []) {
  const evidence = { version: 1, base, history: [...history, { report, result }] };
  return `# Measured lower-only client ratchet\n\nSource main: ${report.sha}\n\nRaw step: 512 B. Gzip step: 256 B. Target = ceil(measured × 1.25 / step) × step. Lower only when current minus target is strictly greater than one step. File counts do not ratchet. Existing lower draft values never rise.\n\nUndo: revert this PR's client budget changes and generated decision through a reviewed PR; automation never raises ceilings.\n\n## Latest changes and headroom shortfalls\n\n\`\`\`json\n${json({ changes: result.changes, shortfalls: result.shortfalls })}\`\`\`\n\n## Machine-verifiable proposal\n\n\`\`\`json\n${json(evidence)}\`\`\`\n`;
}

export async function publish({ api, report, repository }) {
  assert.equal(repository, "TogetherWeOwn/two-web-next", "unexpected repository");
  assert.ok(SHA.test(report.sha), "invalid source SHA");
  const prefix = `/repos/${repository}`;
  const main = async () => (await api("GET", `${prefix}/git/ref/heads/main`)).object.sha;
  if ((await main()) !== report.sha) return { status: "stale-main" };
  const load = async (ref) =>
    Object.fromEntries(
      await Promise.all(
        CLIENT_FILES.map(async (path) => {
          const result = await api("GET", `${prefix}/contents/${path}?ref=${ref}`);
          assert.equal(result.encoding, "base64");
          assert.ok(result.size < 512 * 1024, "oversized budget");
          return [path, JSON.parse(Buffer.from(result.content, "base64").toString("utf8"))];
        }),
      ),
    );
  const base = await load(report.sha);
  const prs = await api(
    "GET",
    `${prefix}/pulls?state=open&base=main&head=TogetherWeOwn:${BRANCH}&per_page=100`,
  );
  assert.ok(Array.isArray(prs) && prs.length <= 1, "duplicate ratchet PRs");
  let head = report.sha;
  let firstSha = report.sha;
  let previous = base;
  let history = [];
  const validateDraft = (pr) => {
    assert.ok(
      pr.state === "open" &&
        pr.draft &&
        pr.title === TITLE &&
        pr.user?.login === "github-actions[bot]",
      "human-owned, closed or ready PR",
    );
    const marker = pr.body?.match(/^<!-- client-budget-ratchet:v1 ([a-f0-9]{40}) -->/);
    assert.ok(marker, "missing automation marker");
    assert.equal(pr.body, prBody(marker[1]), "human PR revision");
    assert.equal(pr.base.ref, "main");
    assert.equal(pr.base.repo.full_name, repository);
    assert.equal(pr.head.ref, BRANCH);
    assert.equal(pr.head.repo.full_name, repository);
    assert.ok(SHA.test(pr.head.sha));
    return marker[1];
  };
  if (prs.length) {
    const pr = prs[0];
    firstSha = validateDraft(pr);
    head = pr.head.sha;
    const comparison = await api("GET", `${prefix}/compare/${firstSha}...${head}`);
    assert.equal(comparison.status, "ahead");
    assert.ok(
      comparison.commits.length > 0 &&
        comparison.commits.length < 100 &&
        comparison.total_commits === comparison.commits.length,
      "incomplete commit evidence",
    );
    for (const commit of comparison.commits) {
      assert.equal(commit.author?.login, "github-actions[bot]", "human branch revision");
      assert.equal(commit.committer?.login, "github-actions[bot]", "human committer revision");
      assert.equal(commit.commit?.verification?.verified, true, "unsigned automation revision");
    }
    assert.ok(
      comparison.files.length > 0 && comparison.files.length <= CLIENT_FILES.length + 1,
      "unexpected branch changes",
    );
    for (const file of comparison.files)
      assert.ok(
        [...CLIENT_FILES, decisionPath(firstSha)].includes(file.filename) &&
          ["added", "modified"].includes(file.status),
        "non-client branch change",
      );
    same(await load(firstSha), base); // newer human/main ceiling revision wins
    previous = await load(head);
    const saved = await api("GET", `${prefix}/contents/${decisionPath(firstSha)}?ref=${head}`);
    assert.equal(saved.encoding, "base64");
    assert.ok(saved.size <= 2 * 1024 * 1024, "oversized decision");
    const evidence = parseDecision(Buffer.from(saved.content, "base64").toString("utf8"));
    same(evidence.base, base);
    same(replayDecision(evidence).files, previous);
    history = evidence.history;
  }
  const proposal = propose(report, base, previous);
  if (!proposal.changes.length) return { status: "no-lowering", shortfalls: proposal.shortfalls };
  const additions = CLIENT_FILES.filter(
    (p) => JSON.stringify(proposal.files[p]) !== JSON.stringify(previous[p]),
  ).map((path) => ({ path, contents: Buffer.from(json(proposal.files[path])).toString("base64") }));
  const decision = measuredDecision(report, base, proposal, history);
  assert.ok(Buffer.byteLength(decision) <= 2 * 1024 * 1024, "oversized decision");
  parseDecision(decision); // validate the extended history before any writes
  additions.push({
    path: decisionPath(firstSha),
    contents: Buffer.from(decision).toString("base64"),
  });
  if ((await main()) !== report.sha) return { status: "stale-main" };
  if (!prs.length) {
    // A stable ref plus workflow concurrency prevents duplicate PRs. An orphan
    // or human branch is never adopted or overwritten: creation must succeed.
    await api("POST", `${prefix}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: head });
  } else {
    const live = await api("GET", `${prefix}/pulls/${prs[0].number}`);
    assert.equal(validateDraft(live), firstSha, "changed automation source");
    assert.equal(live.head.sha, head, "changed PR head");
  }
  // PR metadata cannot be locked atomically with a commit. Promotion must first
  // hold the body and drain in-flight writers (see the generated PR protocol).
  // GitHub performs an atomic expected-head check, including human races after
  // the reads above. No force update and no token is persisted in git config.
  const created = await api("POST", "/graphql", {
    query:
      "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: BRANCH },
        expectedHeadOid: head,
        message: {
          headline: TITLE,
          body: "Generated by deterministic budget automation. No model is invoked at runtime; attribution credits tooling authorship.\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>",
        },
        fileChanges: { additions },
      },
    },
  });
  assert.ok(!created.errors, "commit compare-and-swap refused");
  const sha = created.data?.createCommitOnBranch?.commit?.oid;
  assert.ok(SHA.test(sha), "missing created commit");
  if (prs.length) {
    const live = await api("GET", `${prefix}/pulls/${prs[0].number}`);
    assert.equal(
      validateDraft(live),
      firstSha,
      "PR changed during commit; stop promotion and recheck exact-head gates",
    );
    // PR head metadata may lag a successful commit; the branch ref is authoritative.
    const ref = await api("GET", `${prefix}/git/ref/heads/${BRANCH}`);
    assert.equal(ref.object.sha, sha, "branch changed during commit");
    return { status: "updated", sha, number: prs[0].number };
  }
  const live = await api("GET", `${prefix}/git/ref/heads/${BRANCH}`);
  assert.equal(live.object.sha, sha, "branch changed before PR creation");
  const pr = await api("POST", `${prefix}/pulls`, {
    title: TITLE,
    head: BRANCH,
    base: "main",
    draft: true,
    body: prBody(firstSha),
  });
  return { status: "created", sha, number: pr.number };
}

export function githubApi(token) {
  assert.ok(token, "missing existing automation token");
  return async (method, path, body) => {
    assert.ok(path.startsWith("/") && !path.startsWith("//"));
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `GitHub ${method} failed (${response.status}); no credential fallback`);
    const text = await response.text();
    assert.ok(text.length <= 4 * 1024 * 1024, "oversized API response");
    return JSON.parse(text);
  };
}

async function main() {
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REPOSITORY, "TogetherWeOwn/two-web-next");
  assert.ok(SHA.test(process.env.GITHUB_SHA ?? ""));
  assert.equal(process.argv.length, 4, "usage: kit-client-ratchet.mjs measure|publish REPORT");
  const [mode, path] = process.argv.slice(2);
  if (mode === "measure") {
    assert.ok(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN, "measurement must be token-free");
    const { checkRoutes } = await import("./check-kit-route-perf.mjs");
    const measurement = checkRoutes();
    assert.equal(measurement.exitCode, 0, "route gate must pass before measurement");
    writeFileSync(path, json({ version: 1, sha: process.env.GITHUB_SHA, measurement }), {
      flag: "wx",
    });
  } else {
    assert.equal(mode, "publish");
    const bytes = readFileSync(path);
    assert.ok(bytes.length <= 2 * 1024 * 1024, "oversized report");
    const report = JSON.parse(bytes);
    assert.equal(report.sha, process.env.GITHUB_SHA, "report is not this trusted main build");
    console.log(
      json(
        await publish({
          api: githubApi(process.env.GH_TOKEN),
          report,
          repository: process.env.GITHUB_REPOSITORY,
        }),
      ),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
