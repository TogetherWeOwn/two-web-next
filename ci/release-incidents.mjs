// Stable-key incident sink, adapted from two-bot-next/scripts/incident_issue.py.
// Reporting owns no deployment permission: only this repository's Issues API is writable.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readLiveProductionCommit } from "./production-deploy-gate.mjs";

const SHA = /^[0-9a-f]{40}$/;
const RED = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const marker = (key) => `<!-- incident-key: ${key} -->`;
const text = (value) =>
  String(value)
    .replace(/[\r\n`<>@]/g, " ")
    .slice(0, 160);

async function openIssues(api, key) {
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api("GET", `/issues?state=open&labels=incident&per_page=100&page=${page}`);
    if (
      !Array.isArray(batch) ||
      batch.length > 100 ||
      batch.some(
        (issue) =>
          !Number.isSafeInteger(issue?.number) ||
          issue.number <= 0 ||
          (issue.body != null && typeof issue.body !== "string"),
      )
    ) {
      throw new Error("Malformed incident issue list");
    }
    matches.push(
      ...batch.filter((issue) => !issue.pull_request && (issue.body ?? "").includes(marker(key))),
    );
    if (batch.length < 100) return matches.sort((a, b) => a.number - b.number);
  }
  throw new Error("Incident issue search exceeded ten pages");
}

export async function syncIncident({ api, key, title, body, recovered = false }) {
  if (!/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(key)) throw new Error("Invalid incident key");
  const issues = await openIssues(api, key);
  const comment = (number, message) =>
    api("POST", `/issues/${number}/comments`, {
      body: message.slice(0, 6000),
    });
  if (recovered) {
    for (const issue of issues) {
      await comment(issue.number, `Recovered.\n\n${body}`);
      await api("PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    }
    return;
  }
  if (issues.length) {
    await comment(issues[0].number, `Still failing.\n\n${body}`);
    return;
  }
  try {
    await api("GET", "/labels/incident");
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await api("POST", "/labels", {
        name: "incident",
        color: "b60205",
        description: "Unattended release or staging failure",
      });
    } catch (conflict) {
      if (conflict.status !== 422) throw conflict;
      await api("GET", "/labels/incident");
    }
  }
  const created = await api("POST", "/issues", {
    title: title.slice(0, 200),
    body: `${body.slice(0, 5800)}\n\n${marker(key)}\n`,
    labels: ["incident"],
  });
  if (!Number.isSafeInteger(created?.number) || created.number <= 0) {
    throw new Error("Incident creation returned no issue number");
  }
  // The normal workflows serialize their own runs. Replays can race them:
  // converge on the oldest keyed issue rather than leaving duplicate alerts.
  const first = (await openIssues(api, key))[0];
  if (first && first.number < created.number) {
    await comment(first.number, `Still failing.\n\n${body}`);
    await comment(created.number, `Duplicate of #${first.number}.`);
    await api("PATCH", `/issues/${created.number}`, {
      state: "closed",
      state_reason: "not_planned",
    });
  }
}

export function heldProduction({ liveSha, mainSha, comparison, nowMs }) {
  if (!SHA.test(liveSha ?? "") || !SHA.test(mainSha ?? "") || !Number.isFinite(nowMs)) {
    throw new Error("Missing production hold identity");
  }
  if (liveSha === mainSha) return { held: false, heldSince: null, hours: 0 };
  const oldest = comparison?.commits?.[0];
  const since = Date.parse(oldest?.commit?.committer?.date ?? "");
  if (
    comparison?.status !== "ahead" ||
    comparison.base_commit?.sha !== liveSha ||
    comparison.merge_base_commit?.sha !== liveSha ||
    comparison.behind_by !== 0 ||
    !Number.isSafeInteger(comparison.ahead_by) ||
    comparison.ahead_by <= 0 ||
    comparison.total_commits !== comparison.ahead_by ||
    !SHA.test(oldest?.sha ?? "") ||
    !Number.isFinite(since) ||
    since > nowMs
  ) {
    throw new Error("Cannot establish production hold age");
  }
  const hours = (nowMs - since) / 3_600_000;
  return { held: hours > 6, heldSince: new Date(since).toISOString(), hours };
}

// Never copy logs to public issues. Extract only known audit identifiers and
// bounded numbers from LHCI assertion blocks; remote bodies, URLs and snippets stay private.
export function qualityMeasurements(log) {
  const measurements = [];
  const pattern =
    /\b(server-response-time|first-contentful-paint|largest-contentful-paint|total-blocking-time|cumulative-layout-shift|speed-index|categories:(?:performance|accessibility|best-practices|seo))\b[^\n]{0,160}\b(maxNumericValue|minScore)\b[^\n]*\n(?:[^\n]*\n){0,4}?[^\n]*expected:\s*(<=|>=|>|<|=)?\s*(\d+(?:\.\d+)?)[^\n]*\n[^\n]*found:\s*(\d+(?:\.\d+)?)/g;
  for (const match of log.matchAll(pattern)) {
    if (match[4].length > 12 || match[5].length > 12) continue;
    measurements.push(
      `${match[1]}: threshold ${match[3] || (match[2] === "maxNumericValue" ? "<=" : ">=")}${match[4]}; measured ${match[5]}`,
    );
    if (measurements.length === 20) break;
  }
  return measurements;
}

async function boundedText(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Incident evidence exceeded response size cap");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function githubApi(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid incident API path");
    const response = await fetchImpl(
      `https://api.github.com/repos/TogetherWeOwn/two-web-next${path}`,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) {
      const error = new Error(`Incident API ${method} failed (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(await boundedText(response, 2 * 1024 * 1024));
  };
}

export async function jobMeasurements(token, id, fetchImpl = fetch) {
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const response = await fetchImpl(
    `https://api.github.com/repos/TogetherWeOwn/two-web-next/actions/jobs/${id}/logs`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    },
  );
  if (response.status !== 302) throw new Error("Quality log redirect unavailable");
  const location = new URL(response.headers.get("location"));
  if (
    location.protocol !== "https:" ||
    location.username ||
    location.password ||
    !(
      location.hostname.endsWith(".blob.core.windows.net") ||
      location.hostname.endsWith(".actions.githubusercontent.com")
    )
  ) {
    throw new Error("Quality log redirect host refused");
  }
  // The signed log download gets no token and follows no further redirects.
  const download = await fetchImpl(location, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!download.ok) throw new Error("Quality log download unavailable");
  return qualityMeasurements(await boundedText(download, 8 * 1024 * 1024));
}

async function jobsFor(api, runId, attempt) {
  const jobs = [];
  for (let page = 1; page <= 5; page++) {
    const result = await api(
      "GET",
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result?.jobs) || result.jobs.length > 100)
      throw new Error("Malformed release jobs");
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
  throw new Error("Release job history exceeded page cap");
}

const STAGING_GATES = ["staging-quality", "staging-journeys"];
const gateJobs = (jobs, gate) =>
  jobs.filter((job) => job.name === gate || job.name.startsWith(`${gate} / `));
const gateGreen = (selected) =>
  selected.length > 0 && selected.every((job) => job.conclusion === "success");

function stagingObservations(jobs) {
  const keys = new Set();
  for (const gate of STAGING_GATES) {
    const selected = gateJobs(jobs, gate);
    if (selected.some((job) => RED.has(job.conclusion)) || gateGreen(selected)) keys.add(gate);
  }
  if (
    jobs.some((job) => RED.has(job.conclusion)) ||
    STAGING_GATES.every((gate) => gateGreen(gateJobs(jobs, gate)))
  )
    keys.add("e2e-staging");
  return keys;
}

// Observer retries retain the ORIGINAL source run/attempt, not the observer's
// chronology. Read authoritative source history, including successful observations
// that never needed an issue, before any sink write. Skips/pending jobs are not
// observations and must not erase a useful failure from an earlier attempt.
async function staleStagingKeys(api, source, runId, attempt) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const valid = (run) => positive(run?.id) && positive(run.run_number) && positive(run.run_attempt);
  const trusted = (run) =>
    run?.head_branch === "main" &&
    run.head_repository?.full_name === "TogetherWeOwn/two-web-next" &&
    run.path === ".github/workflows/e2e-staging.yml";
  if (
    !valid(source) ||
    source.id !== Number(runId) ||
    !positive(Number(attempt)) ||
    Number(attempt) > source.run_attempt
  )
    throw new Error("Invalid staging observation identity");
  const newer = new Map();
  let found = false;
  for (let page = 1; page <= 5; page++) {
    const result = await api(
      "GET",
      `/actions/workflows/e2e-staging.yml/runs?branch=main&exclude_pull_requests=true&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result?.workflow_runs) || result.workflow_runs.length > 100)
      throw new Error("Malformed staging observation history");
    for (const run of result.workflow_runs) {
      if (!trusted(run)) continue;
      if (!valid(run)) throw new Error("Malformed staging observation identity");
      if (run.id === source.id) {
        if (run.run_number !== source.run_number || run.run_attempt < Number(attempt))
          throw new Error("Inconsistent staging observation identity");
        found = true;
      }
      if (run.run_number >= source.run_number) {
        if (run.run_number === source.run_number && run.id !== source.id)
          throw new Error("Inconsistent staging observation sequence");
        newer.set(run.id, run);
      }
    }
    if (found || result.workflow_runs.length < 100) break;
  }
  if (!found) throw new Error("Staging observation history missing source or exceeded page cap");
  const stale = new Set();
  let snapshots = 0;
  for (const run of newer.values()) {
    const oldest = run.id === source.id ? Number(attempt) + 1 : 1;
    for (let number = run.run_attempt; number >= oldest; number--) {
      if (number === run.run_attempt && run.status !== "completed") continue;
      if (++snapshots > 20) throw new Error("Staging observation history exceeded attempt cap");
      for (const key of stagingObservations(await jobsFor(api, run.id, number))) stale.add(key);
      if (stale.size === 3) return stale;
    }
  }
  return stale;
}

export async function report(
  env,
  {
    api = githubApi(env.GITHUB_TOKEN),
    nowMs = Date.now(),
    readLive = readLiveProductionCommit,
    measurements = jobMeasurements,
  } = {},
) {
  if (
    env.GITHUB_REPOSITORY !== "TogetherWeOwn/two-web-next" ||
    !env.GITHUB_TOKEN ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "")
  )
    throw new Error("Missing incident reporter context");
  const runId = env.SOURCE_RUN_ID || env.GITHUB_RUN_ID;
  const attempt = env.SOURCE_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(runId)) throw new Error("Invalid source run identity");
  const link = `https://github.com/TogetherWeOwn/two-web-next/actions/runs/${runId}`;
  if (env.INCIDENT_MODE === "rehearsal") {
    if (!SHA.test(env.GITHUB_SHA ?? "") || !["true", "false"].includes(env.FORCE_FAIL)) {
      throw new Error("Invalid incident rehearsal input");
    }
    await syncIncident({
      api,
      key: "staging-rehearsal",
      title: "staging incident reporter rehearsal",
      body: `Report-only non-production rehearsal. No staging check or deploy was run.\n\nRun: ${link}\nSHA: ${env.GITHUB_SHA}\nCheck: simulated staging-quality server-response-time\nThreshold: <=600 ms; measured: ${env.FORCE_FAIL === "true" ? "660" : "500"} ms.`,
      recovered: env.FORCE_FAIL === "false",
    });
    return;
  }
  if (!["staging", "promotion", "hold"].includes(env.INCIDENT_MODE) || !/^\d+$/.test(attempt ?? ""))
    throw new Error("Invalid incident report mode");
  const run = await api("GET", `/actions/runs/${runId}`);
  const stagingSource = run.path === ".github/workflows/e2e-staging.yml";
  const expectedSource =
    env.INCIDENT_MODE === "hold"
      ? stagingSource || run.path === ".github/workflows/deploy-production.yml"
      : run.path ===
        `.github/workflows/${env.INCIDENT_MODE === "staging" ? "e2e-staging" : "deploy-production"}.yml`;
  if (
    run.head_branch !== "main" ||
    run.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
    !expectedSource
  ) {
    throw new Error("Incident source is not the expected main workflow");
  }
  const jobs = env.INCIDENT_MODE === "hold" ? [] : await jobsFor(api, runId, attempt);
  const sha =
    stagingSource && run.event === "workflow_run"
      ? /^e2e-staging deploy ([0-9a-f]{40})$/.exec(run.display_title ?? "")?.[1]
      : env.CANDIDATE_SHA || run.head_sha;
  if (!SHA.test(sha ?? "")) throw new Error("Missing tested commit identity");
  const evidence = `Run: ${link}/attempts/${attempt}\nSHA: ${sha}`;
  const failures = jobs.filter((job) => RED.has(job.conclusion));
  const details = failures
    .map((job) => {
      const failedSteps = (job.steps ?? []).filter((step) => RED.has(step.conclusion));
      return `- ${text(job.name)}: measured ${text(job.conclusion)}; required success. Steps: ${failedSteps.map((step) => text(step.name)).join(", ") || "job did not complete"}.`;
    })
    .slice(0, 20)
    .join("\n");
  if (env.INCIDENT_MODE === "staging") {
    const stale = await staleStagingKeys(api, run, runId, attempt);
    for (const gate of STAGING_GATES) {
      if (stale.has(gate)) continue;
      const selected = gateJobs(jobs, gate);
      const failed = selected.filter((job) => RED.has(job.conclusion));
      if (
        !failed.length &&
        !(selected.length && selected.every((job) => job.conclusion === "success"))
      )
        continue;
      const metrics = [];
      for (const job of failed) {
        if (gate !== "staging-quality") continue;
        try {
          metrics.push(...(await measurements(env.GITHUB_TOKEN, job.id)));
        } catch {
          // Still raise the incident when numeric evidence is unavailable. Never fabricate a measurement.
          metrics.push("Numeric evidence unavailable; inspect the linked failing job log.");
        }
      }
      await syncIncident({
        api,
        key: gate,
        title: `${gate} failed`,
        recovered: !failed.length,
        body: `${evidence}\n\n${details || "Required success; measured success."}\n${metrics.join("\n")}`,
      });
    }
    const green = STAGING_GATES.every((gate) => gateGreen(gateJobs(jobs, gate)));
    if (!stale.has("e2e-staging") && (failures.length || green))
      await syncIncident({
        api,
        key: "e2e-staging",
        title: "e2e-staging failed",
        body: `${evidence}\n\n${details || "Required critical journeys and quality gates executed successfully."}`,
        recovered: !failures.length && green,
      });
    return;
  }
  const results = JSON.parse(env.RESULTS_JSON ?? "{}");
  if (results.preflight?.result === "skipped") return; // Failed staging was not a promotion attempt.
  const promoted =
    results["deploy-production"]?.result === "success" &&
    results["post-deploy-watch"]?.result === "success" &&
    results["post-deploy-watch"]?.outputs?.verdict === "pass" &&
    results["auto-rollback"]?.result !== "success";
  const reason =
    env.INCIDENT_MODE === "hold"
      ? stagingSource
        ? "Staging qualification completed; production qualification, soak, approval or deployment concurrency may still be pending. See the source run for staging evidence."
        : `Promotion requested (status ${text(run.status ?? "unknown")}); qualification, approval or deployment concurrency may still be pending. See the source run for the active hold.`
      : results["post-deploy-watch"]?.outputs?.verdict === "superseded"
        ? "Promotion watch was superseded; candidate was not judged healthy."
        : failures.length
          ? details
          : env.ALREADY_LIVE === "true"
            ? "Resolved candidate is already live."
            : promoted
              ? "Promotion and post-deploy watch passed."
              : "Promotion held: no eligible soaked staging candidate (gate red, missing qualification or soak pending).";
  // Every attempt, including the existing scheduled backstop, observes backlog age.
  // Squash-only main is linear; the compare API's first commit is the oldest waiting main commit.
  let observation;
  try {
    const liveSha = await readLive();
    const mainSha = (await api("GET", "/commits/main"))?.sha;
    if (!SHA.test(liveSha ?? "") || !SHA.test(mainSha ?? ""))
      throw new Error("Unknown production identity");
    const comparison =
      liveSha === mainSha
        ? null
        : await api("GET", `/compare/${liveSha}...${mainSha}?per_page=1&page=1`);
    observation = { liveSha, mainSha, ...heldProduction({ liveSha, mainSha, comparison, nowMs }) };
  } catch {
    // A missing observation does not clear an existing held-production incident.
    observation = null;
  }
  const current = observation && observation.liveSha === observation.mainSha;
  if (env.INCIDENT_MODE !== "hold")
    await syncIncident({
      api,
      key: "production-promotion",
      title: "production promotion failed or held",
      body: `${evidence}\n\n${current ? "Production is current with main." : reason}\nRequired: successful promotion and watch, candidate already live, or no pending main commits.`,
      recovered: !failures.length && (promoted || env.ALREADY_LIVE === "true" || current),
    });
  await syncIncident({
    api,
    key: "production-hold-evidence",
    title: "production hold evidence unavailable",
    body: `${evidence}\n\n${observation ? "Production identity and backlog age were read successfully." : "Could not verify live identity, forward main ancestry or oldest pending commit time. Hold age is unknown, not healthy. Inspect /up and compare evidence; no deployment was attempted by this reporter."}`,
    recovered: !!observation,
  });
  if (!observation) throw new Error("Production hold evidence unavailable");
  await syncIncident({
    api,
    key: "production-held",
    title: "production held > 6h",
    recovered: !observation.held,
    body: `${evidence}\n\nHeld since: ${observation.heldSince ?? "not held"}\nLast promoted SHA (live /up revision): ${observation.liveSha}\nCurrent main SHA: ${observation.mainSha}\nThreshold: >6 h; measured: ${observation.hours.toFixed(2)} h.\nReason: ${reason}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Read only the standard event file to make malformed runtime context visible before any write.
    if (process.env.GITHUB_EVENT_PATH)
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    await report(process.env);
  } catch {
    console.error(
      "::error::Release incident reporting failed; inspect reporter and source run metadata",
    );
    process.exitCode = 1;
  }
}
