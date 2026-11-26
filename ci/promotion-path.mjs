import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Direct release workflow inputs and deployed readiness wiring, not ordinary app imports.
const directPaths = new Set(
  `ci/promotion-path.mjs ci/promotion-path-local.mjs
   ci/resolve-promotion-sha.mjs ci/production-deploy-gate.mjs ci/rollback-target.mjs ci/drill-scripts-ref.mjs
   ci/post-deploy-watch.mjs ci/check-production-secrets.mjs
   ci/operator-constants.mjs ci/wrangler-config.mjs ci/worker-bundle-evidence.mjs
   ci/staging-deploy-gate.mjs ci/staging-forward.mjs ci/staging-provenance.mjs ci/staging-soak-receipt.mjs ci/check-staging-journeys.mjs ci/web-standards.mjs
   ci/lighthouse-origin-lib.cjs ci/lighthouserc.cjs ci/quality-budget.json ci/lighthouse-samples.cjs ci/lighthouse-serving-values.cjs ci/lighthouse-preserve-mobile.sh
   ci/change-scope.sh ci/e2e-test-helpers.mjs ci/kit-route-flags.mjs ci/staging-kit-route-check.mjs ci/check-jobs-secrets.mjs
   ci/db-migrate.mjs ci/migration-admission.mjs ci/migration-ownership.mjs ci/migration-runtime-rights.mjs
   ci/check-migration-numbers.sh ci/check-snapshot-chain.mjs ci/check-snapshot-chain-selftest.mjs ci/check-migration-history.mjs
   drizzle.config.ts migrations.lock
   bin/smoke.mjs bin/version-check.mjs bin/revision-check.mjs bin/json-smoke.mjs
   ci/robots-directives.mjs ci/rendered-page.mjs lib/loopback-hosts.mjs
   bin/check-moderators.mjs bin/operator-probe-errors.mjs bin/ts-hook.mjs bin/ts-hooks.mjs src/probes/check-moderators.ts src/roles.ts
   src/worker.ts src/index.tsx src/version.ts src/release-tag.ts src/headers.ts src/route-ownership.ts web/src/hooks.server.ts web/src/lib/server/hono.ts
   src/up.ts src/up-body.ts src/up-config.ts src/up-database.ts src/up-migrations.ts
   src/up-queue.ts src/up-revision.ts src/up-timeout.ts
   playwright.staging.config.ts playwright.watch.config.ts e2e/ci-only.mjs e2e/watch-guard.mjs e2e/staging-guard.mjs e2e/search-retry.mjs
   e2e/featured-guest-poll.mjs e2e/qa-login-retry.mjs e2e/qa-request.mjs e2e/rsvp-pending.ts e2e/join-oneclick.ts e2e/fixture-sweep.mjs
   src/qa.ts src/session-cookie.ts web/scripts/copy-public.mjs ci/kit-route-evidence.mjs
   ci/build-ember-tokens.mjs ci/build-leaf-css.mjs ci/build-events-css.mjs ci/css-dictionary.mjs
   ci/minify-assets.mjs ci/budget-fragments.mjs ci/bundle-budget.json
   .npmrc package.json package-lock.json web/.npmrc web/package.json web/package-lock.json
   web/_headers web/vite.config.ts web/tsconfig.json`.split(/\s+/),
);

export function isPromotionPath(path) {
  return (
    directPaths.has(path) ||
    /^(?:\.github\/(?:workflows|actions)|drizzle|(?:db\/)?migrations)\//.test(path) ||
    /(?:^|\/)wrangler(?:[.-][^/]*)?\.(?:toml|jsonc?)$/i.test(path) ||
    /^ci\/budgets\/bundle\/[^/]+\.json$/.test(path) ||
    // Both release Playwright configs discover specs recursively.
    /^e2e\/(?:staging|watch)\/.*\.spec\.ts$/s.test(path) ||
    /^e2e\/(?:staging|watch)\/(?!.*\.test\.)[^/]+\.(?:ts|mjs)$/.test(path)
  );
}

const pageSize = 100;
const prFilesCap = 3000;
const compareFilesCap = 300;
const nonempty = (value) => typeof value === "string" && value.length > 0;
const isSha = (value) => nonempty(value) && /^[0-9a-f]{40}$/.test(value);
const knownStatus = new Set("added modified removed renamed copied changed unchanged".split(" "));

async function json(response) {
  assert.ok(response.ok, `GitHub read failed (HTTP ${response.status})`);
  return response.json().catch(() => {
    throw new Error("Invalid GitHub JSON");
  });
}

async function readPR(api, pull) {
  const pr = await json(await api("GET", pull));
  assert.ok(
    pr?.state === "open" && isSha(pr.head?.sha) && isSha(pr.base?.sha) && nonempty(pr.base.ref),
    "Missing open PR or full head/base identity",
  );
  return { head: pr.head.sha, base: pr.base.sha, baseRef: pr.base.ref, count: pr.changed_files };
}

function readFiles(rows, expected, files) {
  assert.ok(Array.isArray(rows) && rows.length === expected, "Incomplete file response");
  for (const row of rows) {
    const { filename, previous_filename: previous, status } = row ?? {};
    assert.ok(
      nonempty(filename) &&
        knownStatus.has(status) &&
        (nonempty(previous) || (previous === undefined && status !== "renamed")),
      "Invalid file metadata",
    );
    assert.ok(!files.has(filename), "Duplicate filename across file results");
    files.set(filename, previous);
  }
}

async function ensureLabel(api, label) {
  const labelPath = `/labels/${encodeURIComponent(label)}`;
  const read = await api("GET", labelPath);
  if (read.ok) return;
  assert.equal(read.status, 404, "Cannot read verdict label");
  const create = await api("POST", "/labels", {
    name: label,
    color: label.endsWith("yes") ? "d4a72c" : "bfdadc",
    description: "Advisory only; see the exact-head promotion-path Actions summary.",
  });
  // A concurrent creator can win the race; verify the label exists in that case.
  assert.ok(
    create.ok || (create.status === 422 && (await api("GET", labelPath)).ok),
    "Cannot create verdict label",
  );
}

export async function labelPromotionPath(request, number, summarize, signal) {
  const budget = signal ?? AbortSignal.timeout(180_000);
  assert.ok(Number.isSafeInteger(number) && number > 0, "Invalid PR number");
  const pull = `/pulls/${number}`;
  const issueLabels = `/issues/${number}/labels`;
  const api = (method, path, body) => request(method, path, body, budget);
  const remove = async (value, client = api) => {
    const name = encodeURIComponent(`promotion-path: ${value}`);
    const response = await client("DELETE", `${issueLabels}/${name}`);
    assert.ok(response.ok || response.status === 404, "Cannot remove verdict label");
  };
  let snapshot;
  let verdict = "unknown";
  try {
    snapshot = await readPR(api, pull);
    const { head, base, count } = snapshot;
    assert.ok(
      Number.isSafeInteger(count) && count >= 0 && count < prFilesCap,
      "File count missing or at GitHub's PR file cap",
    );
    const files = new Map();
    for (let offset = 0; offset < Math.max(1, count); offset += pageSize) {
      const query = `per_page=${pageSize}&page=${1 + offset / pageSize}`;
      const page = await json(await api("GET", `${pull}/files?${query}`));
      readFiles(page, Math.min(pageSize, count - offset), files);
    }
    const matches = [...files].some(
      ([path, prior]) => isPromotionPath(path) || (prior && isPromotionPath(prior)),
    );
    if (!matches) {
      // The PR files endpoint is mutable. Bind a negative to the immutable
      // three-dot comparison too; its file list is on page one and capped at 300.
      assert.ok(count < compareFilesCap, "Cannot prove a negative at GitHub's compare file cap");
      const comparison = await json(await api("GET", `/compare/${base}...${head}?per_page=1`));
      const pinned = new Map();
      readFiles(comparison?.files, count, pinned);
      assert.ok(
        [...files].every(([path, prior]) => pinned.has(path) && pinned.get(path) === prior),
        "PR files differ from pinned comparison",
      );
    }
    const value = matches ? "yes" : "no";
    const label = `promotion-path: ${value}`;
    const fresh = async () =>
      assert.ok(
        JSON.stringify(await readPR(api, pull)) === JSON.stringify(snapshot),
        "PR refs or file count changed during classification",
      );
    await ensureLabel(api, label);
    await fresh();
    await remove(matches ? "no" : "yes");
    await fresh();
    const applied = await api("POST", issueLabels, { labels: [label] });
    assert.ok(applied.ok, "Cannot apply verdict label");
    await fresh();
    verdict = value;
  } catch (error) {
    // The validated PR number lets serialized runs retire owned verdicts even before a snapshot.
    const outcomes = await Promise.allSettled([remove("no", request), remove("yes", request)]);
    const failures = outcomes.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (failures.length) throw new AggregateError([error, ...failures], "Label cleanup failed");
    throw error;
  } finally {
    summarize(
      `PR #${number} · head \`${snapshot?.head ?? "unavailable"}\` · base \`${snapshot?.base ?? "unavailable"}\` · verdict **${verdict}**\n\nAdvisory only. Labels can be stale or edited and do not waive review.\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY, GH_TOKEN } = process.env;
  const { number } = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
  const api = (method, path, body, budget) =>
    fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${GH_TOKEN}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(budget ? [budget] : [])]),
    });
  await labelPromotionPath(api, number, (summary) => appendFileSync(GITHUB_STEP_SUMMARY, summary));
}
