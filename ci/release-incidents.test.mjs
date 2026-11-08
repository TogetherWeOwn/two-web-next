import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  githubApi,
  heldProduction,
  jobMeasurements,
  qualityMeasurements,
  report,
  syncIncident,
} from "./release-incidents.mjs";

const LIVE = "a".repeat(40);
const MAIN = "b".repeat(40);
const NOW = Date.parse("2026-11-08T12:00:00Z");
const marker = (key) => `<!-- incident-key: ${key} -->`;
const env = (mode, extra = {}) => ({
  GITHUB_TOKEN: "fixture-token",
  GITHUB_REPOSITORY: "TogetherWeOwn/two-web-next",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: MAIN,
  INCIDENT_MODE: mode,
  ...extra,
});
const comparison = (since = "2026-11-08T05:59:59Z") => ({
  status: "ahead",
  ahead_by: 3,
  total_commits: 3,
  behind_by: 0,
  base_commit: { sha: LIVE },
  merge_base_commit: { sha: LIVE },
  commits: [{ sha: MAIN, commit: { committer: { date: since } } }],
});

function fixture({
  issues = [],
  jobs = [],
  mode = "promotion",
  compare = comparison(),
  main = MAIN,
  label = false,
  metadata = {},
  intercept,
} = {}) {
  const calls = [];
  const state = { issues: structuredClone(issues), label };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const overridden = intercept?.(method, path, body, state);
    if (overridden !== undefined) return overridden;
    if (method === "GET" && path.startsWith("/issues?"))
      return state.issues.filter((issue) => issue.state !== "closed");
    if (method === "GET" && path === "/labels/incident") {
      if (!state.label) throw Object.assign(new Error("not found"), { status: 404 });
      return { name: "incident" };
    }
    if (method === "POST" && path === "/labels") {
      state.label = true;
      return {};
    }
    if (method === "POST" && path === "/issues") {
      const issue = { ...body, number: 100 + state.issues.length, state: "open" };
      state.issues.push(issue);
      return issue;
    }
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) return {};
    if (method === "PATCH" && /\/issues\/\d+$/.test(path)) {
      Object.assign(
        state.issues.find((issue) => issue.number === Number(path.split("/")[2])),
        body,
      );
      return {};
    }
    if (method === "GET" && path === "/actions/runs/42")
      return {
        head_branch: "main",
        head_repository: { full_name: "TogetherWeOwn/two-web-next" },
        head_sha: MAIN,
        event: "workflow_run",
        display_title: `e2e-staging deploy ${LIVE}`,
        path: `.github/workflows/${mode === "staging" ? "e2e-staging" : "deploy-production"}.yml`,
        ...metadata,
      };
    if (method === "GET" && path.startsWith("/actions/runs/42/attempts/1/jobs?")) return { jobs };
    if (method === "GET" && path === "/commits/main") return { sha: main };
    if (method === "GET" && path.startsWith("/compare/")) return compare;
    throw new Error(`Unexpected fixture call: ${method} ${path}`);
  };
  return { api, calls, state };
}
const sync = (f, extra = {}) =>
  syncIncident({
    api: f.api,
    key: "staging-quality",
    title: "staging-quality failed",
    body: "Run: fixture; threshold <=600; measured 660",
    ...extra,
  });
const keyed = (number, key = "staging-quality") => ({ number, body: marker(key), state: "open" });

test("first failure creates the label and one keyed incident; repeats comment", async () => {
  const f = fixture();
  await sync(f);
  assert.equal(f.state.label, true);
  assert.equal(f.state.issues.length, 1);
  assert.match(f.state.issues[0].body, /incident-key: staging-quality/);
  assert.deepEqual(f.state.issues[0].labels, ["incident"]);
  await sync(f);
  assert.equal(f.state.issues.length, 1);
  assert.match(
    f.calls.find((call) => call.path === "/issues/100/comments").body.body,
    /Still failing/,
  );
});

test("recovery closes all keyed duplicates and does not create an incident", async () => {
  const f = fixture({ issues: [keyed(2), keyed(1), keyed(3, "other")] });
  await sync(f, { recovered: true });
  assert.equal(f.state.issues[0].state, "closed");
  assert.equal(f.state.issues[1].state, "closed");
  assert.equal(f.state.issues[2].state, "open");
  assert.equal(f.calls.filter((call) => call.path.endsWith("/comments")).length, 2);
  assert.ok(
    f.calls
      .filter((call) => call.path.endsWith("/comments"))
      .every((call) => call.body.body.startsWith("Recovered.")),
  );
  const empty = fixture();
  await sync(empty, { recovered: true });
  assert.equal(empty.calls.filter((call) => call.method !== "GET").length, 0);
});

test("pagination reaches keyed issues and refuses incomplete or malformed searches", async () => {
  const f = fixture({
    intercept(method, path) {
      if (method !== "GET" || !path.startsWith("/issues?")) return;
      return path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => keyed(i + 1, "other"))
        : [keyed(150)];
    },
  });
  await sync(f);
  assert.ok(f.calls.some((call) => call.path === "/issues/150/comments"));
  const full = fixture({
    intercept(method, path) {
      if (method === "GET" && path.startsWith("/issues?"))
        return Array.from({ length: 100 }, (_, i) => keyed(i + 1, "other"));
    },
  });
  await assert.rejects(sync(full), /ten pages/);
  assert.equal(full.calls.length, 10);
  const malformed = fixture({ issues: [{ number: "bad" }] });
  await assert.rejects(sync(malformed), /Malformed/);
});

test("PR markers do not dedupe incidents; a concurrent create converges on lowest issue", async () => {
  const pr = fixture({ issues: [{ ...keyed(2), pull_request: {} }] });
  await sync(pr);
  assert.equal(pr.state.issues.length, 2);
  const f = fixture({
    intercept(method, path, _body, state) {
      if (method === "GET" && path.startsWith("/issues?") && state.issues.length === 1) {
        state.issues.push(keyed(1));
      }
    },
  });
  await sync(f);
  assert.equal(f.state.issues.find((issue) => issue.number === 100).state, "closed");
  assert.ok(f.calls.some((call) => call.path === "/issues/1/comments"));
});

test("sink failures propagate; invalid keys cannot reach the API", async () => {
  const f = fixture({
    intercept(method, path) {
      if (method === "POST" && path === "/issues") throw new Error("sink unavailable");
    },
  });
  await assert.rejects(sync(f), /sink unavailable/);
  const invalid = fixture();
  await assert.rejects(sync(invalid, { key: "bad\nkey" }), /Invalid incident key/);
  assert.equal(invalid.calls.length, 0);
});

test("production age uses oldest unpromoted commit and strictly exceeds six hours", () => {
  const args = { liveSha: LIVE, mainSha: MAIN, nowMs: NOW };
  assert.equal(
    heldProduction({ ...args, comparison: comparison("2026-11-08T06:00:00Z") }).held,
    false,
  );
  const held = heldProduction({ ...args, comparison: comparison() });
  assert.equal(held.held, true);
  assert.equal(held.heldSince, "2026-11-08T05:59:59.000Z");
  assert.deepEqual(heldProduction({ ...args, mainSha: LIVE }), {
    held: false,
    heldSince: null,
    hours: 0,
  });
  for (const bad of [
    null,
    { ...comparison(), behind_by: 1 },
    { ...comparison(), base_commit: { sha: MAIN } },
    { ...comparison(), status: "diverged" },
    { ...comparison(), total_commits: 4 },
    comparison("2026-11-08T13:00:00Z"),
    comparison("not a date"),
  ]) {
    assert.throws(() => heldProduction({ ...args, comparison: bad }), /hold age/);
  }
});

test("numeric quality evidence never copies log URLs, tokens or snippets", () => {
  const log =
    "untrusted https://private.invalid/token secret=DO_NOT_COPY\n" +
    "✘ server-response-time failure for maxNumericValue assertion\n expected: <=600\n found: 660\n" +
    "<member-secret> unrelated text\n";
  assert.deepEqual(qualityMeasurements(log), [
    "server-response-time: threshold <=600; measured 660",
  ]);
  assert.deepEqual(
    qualityMeasurements("secret-audit maxNumericValue\nexpected: <=1\nfound: 2"),
    [],
  );
  assert.doesNotMatch(qualityMeasurements(log).join("\n"), /private|DO_NOT_COPY|member/);
});

test("failed quality and journeys alert immediately with tested SHA, steps and numeric evidence", async () => {
  const f = fixture({
    mode: "staging",
    jobs: [
      {
        id: 1,
        name: "staging-quality / web-quality",
        conclusion: "failure",
        steps: [{ name: "Lighthouse performance budgets", conclusion: "failure" }],
      },
      { id: 2, name: "staging-journeys", conclusion: "timed_out" },
    ],
  });
  await report(env("staging"), {
    api: f.api,
    measurements: async () => ["server-response-time: threshold <=600; measured 660"],
  });
  assert.equal(f.state.issues.length, 3);
  const quality = f.state.issues.find((issue) => issue.body.includes(marker("staging-quality")));
  assert.match(quality.body, /Lighthouse performance budgets/);
  assert.ok(quality.body.includes(`SHA: ${LIVE}`));
  assert.match(quality.body, /threshold <=600; measured 660/);
});

test("skipped staging jobs never clear incidents; executed green gates recover", async () => {
  const issues = [keyed(1), keyed(2, "staging-journeys"), keyed(3, "e2e-staging")];
  const skipped = fixture({
    mode: "staging",
    issues,
    jobs: [
      { name: "staging-quality / web-quality", conclusion: "skipped" },
      { name: "staging-journeys", conclusion: "skipped" },
    ],
  });
  await report(env("staging"), { api: skipped.api });
  assert.ok(skipped.state.issues.every((issue) => issue.state === "open"));
  const green = fixture({
    mode: "staging",
    issues,
    jobs: [
      { name: "staging-quality / web-quality", conclusion: "success" },
      { name: "staging-journeys", conclusion: "success" },
    ],
  });
  await report(env("staging"), { api: green.api });
  assert.ok(green.state.issues.every((issue) => issue.state === "closed"));
});

test("green no-candidate promotion still raises a hold and >6h incident", async () => {
  const f = fixture();
  await report(
    env("promotion", { RESULTS_JSON: JSON.stringify({ preflight: { result: "success" } }) }),
    { api: f.api, readLive: async () => LIVE, nowMs: NOW },
  );
  assert.equal(f.state.issues.length, 2);
  assert.ok(f.state.issues.some((issue) => issue.title === "production held > 6h"));
  const held = f.state.issues.find((issue) => issue.title === "production held > 6h");
  assert.ok(held.body.includes(LIVE) && held.body.includes(MAIN));
  assert.match(held.body, /Held since: 2026-11-08T05:59:59/);
});

test("current production does not open a no-op incident; unreadable identity cannot clear holds", async () => {
  const current = fixture({ main: LIVE });
  await report(env("promotion"), { api: current.api, readLive: async () => LIVE });
  assert.equal(current.state.issues.length, 0);
  const unknown = fixture({ issues: [keyed(1, "production-held")] });
  await assert.rejects(
    report(env("promotion"), { api: unknown.api, readLive: async () => null }),
    /hold evidence unavailable/,
  );
  assert.equal(unknown.state.issues[0].state, "open");
  assert.ok(
    unknown.state.issues.some((issue) => issue.title === "production hold evidence unavailable"),
  );
});

test("promotion guard failure records failing step and actual candidate even when not main tip", async () => {
  const f = fixture({
    jobs: [
      {
        name: "production-preflight",
        conclusion: "failure",
        steps: [
          {
            name: "Refuse disabled, held, non-main, unprotected, untested or placeholder deployment",
            conclusion: "failure",
          },
        ],
      },
    ],
  });
  await report(env("promotion", { CANDIDATE_SHA: LIVE }), {
    api: f.api,
    readLive: async () => LIVE,
    nowMs: NOW,
  });
  const incident = f.state.issues.find(
    (issue) => issue.title === "production promotion failed or held",
  );
  assert.ok(incident.body.includes(`SHA: ${LIVE}`));
  assert.match(incident.body, /production-preflight.*required success/);
});

test("superseded successful watch cannot recover a promotion incident", async () => {
  const f = fixture({ issues: [keyed(1, "production-promotion")] });
  await report(
    env("promotion", {
      RESULTS_JSON: JSON.stringify({
        "deploy-production": { result: "success" },
        "post-deploy-watch": { result: "success", outputs: { verdict: "superseded" } },
        "auto-rollback": { result: "skipped" },
      }),
    }),
    { api: f.api, readLive: async () => LIVE, nowMs: NOW },
  );
  assert.equal(f.state.issues[0].state, "open");
  assert.ok(f.calls.some((call) => call.path === "/issues/1/comments"));
  assert.doesNotMatch(
    f.calls.find((call) => call.path === "/issues/1/comments").body.body,
    /watch passed/,
  );
});

test("requested promotion observes age without waiting for jobs or inventing recovery", async () => {
  const f = fixture({
    issues: [keyed(1, "production-promotion")],
    metadata: { status: "waiting" },
    intercept(method, path) {
      if (method === "GET" && path.includes("/jobs?"))
        throw new Error("approval hold: jobs are not complete");
    },
  });
  await report(env("hold", { GITHUB_RUN_ID: "99", SOURCE_RUN_ID: "42", SOURCE_RUN_ATTEMPT: "1" }), {
    api: f.api,
    readLive: async () => LIVE,
    nowMs: NOW,
  });
  assert.equal(f.state.issues[0].state, "open");
  assert.ok(f.state.issues.some((issue) => issue.title === "production held > 6h"));
  assert.ok(!f.calls.some((call) => call.path.includes("/jobs?")));
});

test("automatic staging completion observes a hold within the three-hop chain", async () => {
  const f = fixture({
    mode: "staging",
    issues: [keyed(1, "production-promotion")],
    metadata: { status: "completed" },
    intercept(method, path) {
      if (method === "GET" && path.includes("/jobs?"))
        throw new Error("hold observation must not depend on staging job reporting");
    },
  });
  await report(env("hold", { SOURCE_RUN_ID: "42", SOURCE_RUN_ATTEMPT: "1" }), {
    api: f.api,
    readLive: async () => LIVE,
    nowMs: NOW,
  });
  assert.equal(f.state.issues[0].state, "open");
  const held = f.state.issues.find((issue) => issue.title === "production held > 6h");
  assert.ok(held);
  assert.ok(held.body.includes(`SHA: ${LIVE}`));
  assert.match(held.body, /Staging qualification completed/);
  assert.ok(!f.calls.some((call) => call.path.includes("/jobs?")));
});

test("hold observation rejects workflows outside staging and promotion", async () => {
  const f = fixture({ metadata: { path: ".github/workflows/untrusted.yml" } });
  await assert.rejects(report(env("hold"), { api: f.api }), /expected main workflow/);
  assert.equal(f.calls.filter((call) => call.method !== "GET").length, 0);
});

test("rehearsal failure, repeat and recovery exercise the real sink without live reads", async () => {
  const f = fixture();
  const options = {
    api: f.api,
    readLive: () => {
      throw new Error("must not probe");
    },
  };
  await report(env("rehearsal", { FORCE_FAIL: "true" }), options);
  await report(env("rehearsal", { FORCE_FAIL: "true" }), options);
  assert.equal(f.state.issues.length, 1);
  await report(env("rehearsal", { FORCE_FAIL: "false" }), options);
  assert.equal(f.state.issues[0].state, "closed");
  assert.match(f.state.issues[0].body, /No staging check or deploy was run/);
});

test("API pins host, refuses redirects and never includes remote error bodies", async () => {
  let options;
  const api = githubApi("fixture", async (url, init) => {
    assert.equal(new URL(url).hostname, "api.github.com");
    options = init;
    return new Response("secret server body", { status: 403 });
  });
  await assert.rejects(
    api("GET", "/issues"),
    (error) => error.status === 403 && !error.message.includes("secret"),
  );
  assert.equal(options.redirect, "error");
});

test("quality log redirect validation refuses untrusted destinations before download", async () => {
  for (const location of [
    "https://logs.example.org/log",
    "https://blob.core.windows.net.evil.invalid/log",
    "http://logs.blob.core.windows.net/log",
    "https://user:password@logs.blob.core.windows.net/log",
  ]) {
    let calls = 0;
    await assert.rejects(
      jobMeasurements("fixture-token", 1, async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      }),
      /redirect host refused/,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    jobMeasurements("fixture-token", 1, async () => new Response("untrusted", { status: 200 })),
    /redirect unavailable/,
  );
});

test("signed log download has no token and refuses further redirects", async () => {
  for (const host of ["logs.blob.core.windows.net", "logs.actions.githubusercontent.com"]) {
    const calls = [];
    const metrics = await jobMeasurements("fixture-token", 1, async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: `https://${host}/log` } })
        : new Response("server-response-time maxNumericValue\nexpected: <=600\nfound: 660\n");
    });
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).hostname, "api.github.com");
    assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-token");
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(calls[1].options.redirect, "error");
    assert.deepEqual(metrics, ["server-response-time: threshold <=600; measured 660"]);
  }
});

test("API and log response caps reject oversized bodies", async () => {
  const oversized = (limit) => new Response(new Uint8Array(limit + 1));
  await assert.rejects(
    githubApi("fixture-token", async () => oversized(2 * 1024 * 1024))("GET", "/issues"),
    /exceeded response size cap/,
  );
  let calls = 0;
  await assert.rejects(
    jobMeasurements("fixture-token", 1, async () => {
      calls++;
      return calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://logs.blob.core.windows.net/log" },
          })
        : oversized(8 * 1024 * 1024);
    }),
    /exceeded response size cap/,
  );
});

test("workflow wiring preserves release dependencies and isolates issue-write permission", () => {
  const read = (file) =>
    readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const staging = read("e2e-staging.yml");
  const production = read("deploy-production.yml");
  const rehearsal = read("incident-rehearsal.yml");
  const observer = read("release-incidents.yml");
  assert.doesNotMatch(staging, /issues: write|release-incidents\.mjs/);
  assert.match(observer, /workflows: \[e2e-staging, deploy-production\]/);
  assert.match(observer, /types: \[requested, completed\]/);
  assert.match(observer, /github\.event\.action == 'requested'/);
  assert.doesNotMatch(observer, /needs:|environment:|secrets\.|schedule:/);
  assert.match(observer, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(observer, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(production, /always\(\) && needs.preflight.result != 'skipped'/);
  assert.equal((production.match(/issues: write/g) ?? []).length, 1);
  assert.match(production, /RESULTS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(rehearsal, /INCIDENT_MODE: rehearsal/);
  assert.doesNotMatch(rehearsal, /environment:|secrets\.|wrangler|DATABASE_URL/);
  assert.match(rehearsal, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  const job = (workflow, id) =>
    workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0] ?? "";
  const hold = job(observer, "observe-production");
  const stagingReport = job(observer, "observe");
  const finalReport = job(production, "incidents");
  // No replaceable workflow-level pending slot, including events whose jobs skip.
  assert.doesNotMatch(observer, /\nconcurrency:/);
  assert.match(hold, /name == 'e2e-staging' && github\.event\.action == 'completed'/);
  assert.match(hold, /name == 'deploy-production' && github\.event\.action == 'requested'/);
  assert.match(hold, /INCIDENT_MODE: hold/);
  for (const block of [hold, finalReport]) {
    assert.match(
      block,
      /concurrency:\n      group: production-incident-observation\n      cancel-in-progress: false\n      queue: max/,
    );
  }
  assert.match(stagingReport, /group: staging-incident-observation/);
  assert.match(stagingReport, /queue: max/);
  assert.doesNotMatch(hold, /needs:|environment:|secrets\./);
  assert.doesNotMatch(production, /needs: (?:incidents|\[[^\n]*incidents)/);
});
