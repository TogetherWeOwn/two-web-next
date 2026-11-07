import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WATCH_DEFAULTS, probeReadiness, watchProduction } from "./post-deploy-watch.mjs";

const PROMOTED = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const healthy = (versionId = PROMOTED) => ({
  db: "ok",
  pending_migrations: 0,
  status: "healthy",
  revision: { version_id: versionId, commit: "a".repeat(40) },
});

function upFetch(answer) {
  return async (url) => {
    assert.equal(new URL(url).pathname, "/up");
    const { status = 200, body } = await answer();
    return { status, json: async () => body };
  };
}

async function probe(answer) {
  return probeReadiness({
    origin: "https://togetherweown.com",
    versionId: PROMOTED,
    fetchImpl: upFetch(answer),
  });
}

test("readiness: healthy or degraded on the promoted version is ok", async () => {
  assert.deepEqual(await probe(() => ({ body: healthy() })), { state: "ok" });
  assert.deepEqual(await probe(() => ({ body: { ...healthy(), status: "degraded" } })), {
    state: "ok",
  });
});

test("readiness: another live version stands the watch down, even when unhealthy", async () => {
  for (const status of [200, 503]) {
    const result = await probe(() => ({ status, body: healthy(OTHER) }));
    assert.equal(result.state, "superseded");
    assert.match(result.reason, new RegExp(OTHER));
  }
});

test("readiness: errors, bad status, unready envelopes and missing identity are misses", async () => {
  for (const answer of [
    () => {
      throw new TypeError("fetch failed");
    },
    () => ({ status: 503, body: healthy() }),
    () => ({ body: { ...healthy(), db: "error" } }),
    () => ({ body: { ...healthy(), pending_migrations: 1 } }),
    () => ({ body: { ...healthy(), status: "down" } }),
    () => ({ body: { ...healthy(), revision: undefined } }),
    () => ({ body: "not json" }),
  ]) {
    assert.equal((await probe(answer)).state, "miss");
  }
});

// A fake clock: each sleep advances time; probes and error-rate calls are scripted.
function harness({ probes = () => ({ state: "ok" }), rates = () => ({ verdict: "pass" }) } = {}) {
  let nowMs = Date.parse("2026-11-01T12:00:00Z");
  const calls = { probe: 0, rate: [], sleeps: 0, log: [] };
  const deps = {
    now: () => new Date(nowMs),
    sleep: async (seconds) => {
      calls.sleeps += 1;
      nowMs += seconds * 1000;
    },
    log: (line) => calls.log.push(line),
    probe: async () => {
      calls.probe += 1;
      return probes(calls.probe);
    },
    errorRate: async (config) => {
      calls.rate.push(config);
      return rates(calls.rate.length);
    },
  };
  return { deps, calls };
}

const config = {
  origin: "https://togetherweown.com",
  versionId: PROMOTED,
  workerName: "two-web-next-production",
  accountId: "fixture-account",
  apiToken: "fixture-only",
};

test("a healthy release passes after 30 minutes of minute probes and five-minute rate checks", async () => {
  const { deps, calls } = harness();
  const result = await watchProduction(config, deps);
  assert.equal(result.verdict, "pass");
  assert.equal(calls.probe, 31);
  assert.equal(calls.sleeps, 30);
  // Every five minutes, plus the final judgment at the deadline.
  assert.equal(calls.rate.length, 6);
  assert.equal(result.judged, 6);
  const [first] = calls.rate;
  assert.equal(first.versionId, PROMOTED);
  assert.equal(first.scriptName, "two-web-next-production");
  assert.equal(first.threshold, WATCH_DEFAULTS.threshold);
  assert.equal(first.minRequests, WATCH_DEFAULTS.minRequests);
  assert.equal(first.windowStartIso, "2026-11-01T12:00:00.000Z");
  assert.equal(first.soakSeconds, 0);
  assert.equal(first.attempts, 1);
});

test("three consecutive readiness misses breach; a single miss does not", async () => {
  const blip = harness({
    probes: (n) => (n === 4 ? { state: "miss", reason: "x" } : { state: "ok" }),
  });
  assert.equal((await watchProduction(config, blip.deps)).verdict, "pass");
  const down = harness({
    probes: (n) => (n >= 4 ? { state: "miss", reason: "x" } : { state: "ok" }),
  });
  const result = await watchProduction(config, down.deps);
  assert.deepEqual(
    { verdict: result.verdict, reason: result.reason },
    { verdict: "breach", reason: "readiness" },
  );
  assert.equal(down.calls.probe, 6);
});

test("an error-rate fail verdict breaches at once", async () => {
  const { deps, calls } = harness({
    rates: (n) => (n === 2 ? { verdict: "fail" } : { verdict: "pass" }),
  });
  const result = await watchProduction(config, deps);
  assert.deepEqual(
    { verdict: result.verdict, reason: result.reason },
    { verdict: "breach", reason: "error-rate" },
  );
  assert.equal(calls.rate.length, 2);
});

test("analytics errors warn but never roll back; insufficient samples pass", async () => {
  const errors = harness({ rates: () => ({ verdict: "error" }) });
  const result = await watchProduction(config, errors.deps);
  assert.equal(result.verdict, "pass");
  assert.equal(result.judged, 0);
  assert.ok(errors.calls.log.some((line) => line.includes("no error-rate judgment succeeded")));
  const quiet = harness({ rates: () => ({ verdict: "insufficient" }) });
  assert.equal((await watchProduction(config, quiet.deps)).verdict, "pass");
});

test("a superseded release stands down without a verdict on it", async () => {
  const { deps, calls } = harness({
    probes: (n) => (n === 3 ? { state: "superseded", reason: "other" } : { state: "ok" }),
  });
  assert.equal((await watchProduction(config, deps)).verdict, "superseded");
  assert.equal(calls.probe, 3);
});

test("a malformed promoted id refuses before any probe", async () => {
  const { deps, calls } = harness();
  await assert.rejects(
    watchProduction({ ...config, versionId: "x;id" }, deps),
    /PROMOTED_VERSION_ID must be a Worker Version ID/,
  );
  assert.equal(calls.probe, 0);
});

test("CLI config errors fail without writing breach=true", () => {
  const output = join(mkdtempSync(join(tmpdir(), "watch-")), "out");
  const result = spawnSync(process.execPath, ["ci/post-deploy-watch.mjs"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, PROMOTED_VERSION_ID: PROMOTED },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required/);
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    written = "";
  }
  assert.ok(!written.includes("breach=true"));
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("deploy-production watches for 30 minutes and rolls back on a breach or failed verification", () => {
  const workflow = read("../.github/workflows/deploy-production.yml");
  const job = (name, next) =>
    workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(`\n  ${next}:\n`));
  const deploy = job("deploy-production", "post-deploy-watch");
  assert.match(
    deploy,
    /promoted_version_id: \$\{\{ steps\.gradual\.outputs\.promoted-version-id \}\}/,
  );
  assert.match(deploy, /verify_outcome: \$\{\{ steps\.verify\.outcome \}\}/);
  assert.match(deploy, /- name: Verify public routes on the promoted version\n {8}id: verify\n/);
  const watch = job("post-deploy-watch", "auto-rollback");
  assert.match(watch, /needs: \[preflight, deploy-production\]/);
  // The candidate stays live at 100% even when a later deploy step fails
  // (for example the proof upload), so the watch still starts: it gates on
  // the verification outcome, not on the deploy job's success.
  assert.match(watch, /!cancelled\(\)/);
  assert.match(watch, /needs\.deploy-production\.outputs\.verify_outcome == 'success'/);
  // No Environment binding: the watch must start with no second approval
  // and performs no mutation, so it reads only repo-level credentials.
  assert.ok(!/environment:\n/.test(watch), "the watch binds no Environment");
  assert.match(watch, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CF_ANALYTICS_READ_TOKEN \}\}/);
  assert.match(watch, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CF_RUM_ACCOUNT_ID \}\}/);
  assert.ok(!/PRODUCTION_CLOUDFLARE/.test(watch), "the watch never sees the deployment token");
  assert.match(watch, /run: node ci\/post-deploy-watch\.mjs\n/);
  assert.match(watch, /breach: \$\{\{ steps\.watch\.outputs\.breach \}\}/);
  assert.match(watch, /verdict: \$\{\{ steps\.watch\.outputs\.verdict \}\}/);
  // Tip checkout: an older candidate cannot skip the watch with a script
  // that lacks this mode.
  assert.match(watch, /ref: \$\{\{ github\.sha \}\}/);
  const rollback = job("auto-rollback", "release");
  assert.match(rollback, /uses: \.\/\.github\/workflows\/rollback-production\.yml\n/);
  assert.match(rollback, /environment: production\n/);
  assert.match(rollback, /version_id: \$\{\{ needs\.preflight\.outputs\.rollback_version_id \}\}/);
  assert.match(rollback, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/);
  assert.match(
    rollback,
    /expected_current_version_id: \$\{\{ needs\.deploy-production\.outputs\.promoted_version_id \}\}/,
  );
  assert.match(rollback, /needs\.deploy-production\.outputs\.verify_outcome == 'failure'/);
  assert.match(rollback, /needs\.post-deploy-watch\.outputs\.breach == 'true'/);
  assert.match(rollback, /!cancelled\(\)/);
  // Explicit least-privilege map, never `secrets: inherit`: the two
  // production Environment secrets this leg needs, plus the webhook key
  // for the production rollback notify step.
  assert.ok(!/secrets: inherit/.test(rollback), "auto-rollback must not inherit every secret");
  assert.match(
    rollback,
    /PRODUCTION_CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.match(
    rollback,
    /PRODUCTION_CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
  assert.match(
    rollback,
    /PAPERCLIP_DEPLOY_WEBHOOK_SECRET: \$\{\{ secrets\.PAPERCLIP_DEPLOY_WEBHOOK_SECRET \}\}/,
  );
  // The release tags only after the watch passed: a superseded watch stands
  // down successfully without judging the candidate, so it is never tagged.
  assert.match(workflow, /needs: \[preflight, deploy-production, post-deploy-watch\]\n/);
  assert.match(workflow, /needs\.post-deploy-watch\.outputs\.verdict == 'pass'/);
  assert.equal(WATCH_DEFAULTS.durationSeconds, 1800);
});
