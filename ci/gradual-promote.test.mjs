// Gradual production promotion helpers: deterministic wrangler
// versions math plus JSON parsing for the rollback target and the promoted
// version id. No network, no Cloudflare credentials: the action pipes
// `wrangler ... --json` output into the CLI vendored alongside it. The
// helper is exercised through its canonical action path, the same path the
// composite action resolves, so caller-relative drift fails here first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  configFromEnv,
  runErrorRateGate,
} from "../.github/actions/gradual-promote/error-rate-gate.mjs";
import {
  GRADUAL_STEPS,
  assertVersionTag,
  buildErrorRateQuery,
  errorRateWindowSince,
  evaluateErrorRate,
  latestDeployment,
  parseErrorRateResponse,
  rollbackTarget,
  splitDeploySpecs,
  versionIdForTag,
} from "../.github/actions/gradual-promote/gradual-promote.mjs";

const GATE_PATH = fileURLToPath(
  new URL("../.github/actions/gradual-promote/error-rate-gate.mjs", import.meta.url),
);
const GATE_DIR = fileURLToPath(new URL("../.github/actions/gradual-promote/", import.meta.url));
const PREV = "12345678-1234-1234-1234-123456789abc";
const NEXT = "22345678-1234-1234-1234-123456789abc";
const TAG = "abc123-456-1";

function deployments(versions, created = "2026-10-15T00:00:00Z") {
  return [{ id: "d1", created_on: created, versions }];
}

test("gradual steps are exactly 5, 50 and 100 percent", () => {
  assert.deepEqual(GRADUAL_STEPS, [5, 50, 100]);
});

test("split specs name both versions so traffic totals exactly 100", () => {
  assert.deepEqual(splitDeploySpecs({ tag: TAG, percentage: 5, previousVersionId: PREV }), {
    positional: [`${PREV}@95`],
    versionTag: `${TAG}@5%`,
  });
  assert.deepEqual(splitDeploySpecs({ tag: TAG, percentage: 50, previousVersionId: PREV }), {
    positional: [`${PREV}@50`],
    versionTag: `${TAG}@50%`,
  });
});

test("the 100 percent step promotes the tag alone", () => {
  assert.deepEqual(splitDeploySpecs({ tag: TAG, percentage: 100, previousVersionId: PREV }), {
    positional: [],
    versionTag: `${TAG}@100%`,
  });
});

test("split specs refuse unknown percentages and bad inputs", () => {
  for (const percentage of [0, 1, 10, 25, 99, 101, Number.NaN]) {
    assert.throws(
      () => splitDeploySpecs({ tag: TAG, percentage, previousVersionId: PREV }),
      /percentage must be one of 5, 50, 100/,
    );
  }
  assert.throws(
    () => splitDeploySpecs({ tag: "", percentage: 5, previousVersionId: PREV }),
    /version tag/,
  );
  assert.throws(
    () => splitDeploySpecs({ tag: `${TAG};id`, percentage: 5, previousVersionId: PREV }),
    /version tag/,
  );
  assert.throws(
    () => splitDeploySpecs({ tag: TAG, percentage: 5, previousVersionId: "not-a-uuid" }),
    /previous version id/,
  );
});

test("version tags refuse shell metacharacters", () => {
  for (const tag of ["", "a b", "a@b", "a;b", "a$(b)", "a`b`", "a$b", "a*b", "-lead"]) {
    assert.throws(() => assertVersionTag(tag), /version tag/);
  }
  assert.doesNotThrow(() => assertVersionTag(TAG));
});

test("rollback target is the live version of a single-version deployment", () => {
  assert.equal(rollbackTarget(deployments([{ version_id: PREV, percentage: 100 }])), PREV);
});

test("rollback target refuses split deployments and non-100 traffic", () => {
  assert.throws(
    () =>
      rollbackTarget(
        deployments([
          { version_id: PREV, percentage: 95 },
          { version_id: NEXT, percentage: 5 },
        ]),
      ),
    /single-version 100% deployment/,
  );
  assert.throws(() => rollbackTarget(deployments([{ version_id: PREV, percentage: 50 }])), /100/);
  assert.throws(() => rollbackTarget([]), /deployment/);
  assert.throws(() => rollbackTarget("nope"), /deployment/);
});

test("latest deployment wins by created_on, not array order", () => {
  const older = {
    id: "d1",
    created_on: "2026-10-14T00:00:00Z",
    versions: [{ version_id: PREV, percentage: 100 }],
  };
  const newer = {
    id: "d2",
    created_on: "2026-10-15T00:00:00Z",
    versions: [{ version_id: NEXT, percentage: 100 }],
  };
  assert.equal(latestDeployment([older, newer]).id, "d2");
  assert.equal(latestDeployment([newer, older]).id, "d2");
  assert.throws(() => latestDeployment([]), /deployment/);
});

test("CLI resolves a deploy spec for the workflow without shell interpolation", () => {
  const good = spawnSync(
    process.execPath,
    [".github/actions/gradual-promote/gradual-promote.mjs", "--deploy-spec", TAG, "5", PREV],
    { encoding: "utf8" },
  );
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(good.stdout.split("\n").slice(0, 2), [`${PREV}@95`, `${TAG}@5%`]);
  const full = spawnSync(
    process.execPath,
    [".github/actions/gradual-promote/gradual-promote.mjs", "--deploy-spec", TAG, "100", PREV],
    { encoding: "utf8" },
  );
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(full.stdout.split("\n").slice(0, 2), ["", `${TAG}@100%`]);
  const hostile = spawnSync(
    process.execPath,
    [
      ".github/actions/gradual-promote/gradual-promote.mjs",
      "--deploy-spec",
      `${TAG};printf HARMLESS`,
      "5",
      PREV,
    ],
    { encoding: "utf8" },
  );
  assert.equal(hostile.status, 1);
  assert.match(hostile.stderr, /version tag/);
  assert.ok(!hostile.stdout.includes("HARMLESS") && !hostile.stderr.includes("HARMLESS"));
});

test("CLI captures the rollback target and resolves tags from piped wrangler JSON", () => {
  const target = spawnSync(
    process.execPath,
    [".github/actions/gradual-promote/gradual-promote.mjs", "--capture-rollback-target"],
    {
      input: JSON.stringify([
        { created_on: "2026-10-15T00:00:00Z", versions: [{ version_id: PREV, percentage: 100 }] },
      ]),
      encoding: "utf8",
    },
  );
  assert.equal(target.status, 0, target.stderr);
  assert.equal(target.stdout.trim(), PREV);
  const refused = spawnSync(
    process.execPath,
    [".github/actions/gradual-promote/gradual-promote.mjs", "--capture-rollback-target"],
    {
      input: JSON.stringify([{ created_on: "2026-10-15T00:00:00Z", versions: [] }]),
      encoding: "utf8",
    },
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
});

test("tag resolution needs exactly one matching version", () => {
  const versions = [
    {
      id: PREV,
      metadata: { created_on: "2026-10-14T00:00:00Z" },
      annotations: { "workers/tag": "old" },
    },
    {
      id: NEXT,
      metadata: { created_on: "2026-10-15T00:00:00Z" },
      annotations: { "workers/tag": TAG },
    },
  ];
  assert.equal(versionIdForTag(versions, TAG), NEXT);
  assert.throws(() => versionIdForTag(versions, "missing"), /No deployable version found with tag/);
  assert.throws(
    () =>
      versionIdForTag(
        [...versions, { ...versions[1], id: "32345678-1234-1234-1234-123456789abc" }],
        TAG,
      ),
    /matches multiple versions/,
  );
  assert.throws(() => versionIdForTag([], TAG), /No deployable version/);
});

// --- Live error-rate gate (workersInvocationsAdaptive, per scriptVersion) ---

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SINCE = "2026-10-17T00:00:00.000Z";
const UNTIL = "2026-10-17T00:10:00.000Z";

function envelope(sum, version = NEXT) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: sum
              ? [{ sum, dimensions: { scriptVersion: version } }]
              : [],
          },
        ],
      },
    },
    errors: null,
  };
}

test("error-rate query filters invocations to the promoted version in a window", () => {
  const body = buildErrorRateQuery({
    accountId: ACCOUNT,
    scriptName: "two-web-next-production",
    versionId: NEXT,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });
  assert.match(body.query, /workersInvocationsAdaptive/);
  assert.match(body.query, /scriptVersion:\s*\$versionId/);
  assert.ok(!body.query.includes(NEXT), "version id travels as a variable, never interpolated");
  assert.ok(!body.query.includes(ACCOUNT), "account id travels as a variable");
  assert.deepEqual(body.variables, {
    accountTag: ACCOUNT,
    scriptName: "two-web-next-production",
    versionId: NEXT,
    since: SINCE,
    until: UNTIL,
  });
});

test("error-rate window starts at the smoke finish, capped by the lookback", () => {
  const until = new Date(UNTIL);
  // The stage's smoke probes ran before the recorded start, so they sit
  // outside the judged window: they neither satisfy the minimum sample
  // nor dilute the rate.
  assert.equal(
    errorRateWindowSince({
      windowStartIso: "2026-10-17T00:08:00.000Z",
      until,
      windowMinutes: 10,
    }).toISOString(),
    "2026-10-17T00:08:00.000Z",
  );
  // A long soak/retry ladder never stretches the window past the lookback.
  assert.equal(
    errorRateWindowSince({
      windowStartIso: SINCE,
      until: new Date("2026-10-17T00:25:00.000Z"),
      windowMinutes: 10,
    }).toISOString(),
    "2026-10-17T00:15:00.000Z",
  );
  // No recorded start (direct CLI use): the trailing window, as before.
  assert.equal(errorRateWindowSince({ until, windowMinutes: 10 }).toISOString(), SINCE);
  assert.throws(
    () => errorRateWindowSince({ windowStartIso: "soon", until, windowMinutes: 10 }),
    /window start/,
  );
  // No timezone: Date.parse would read it in the runner's local timezone,
  // judging the wrong interval.
  assert.throws(
    () => errorRateWindowSince({ windowStartIso: "2026-10-17T00:08:00", until, windowMinutes: 10 }),
    /window start/,
  );
  // Not a calendar date: Date.parse rolls Feb 31 into March.
  assert.throws(
    () =>
      errorRateWindowSince({ windowStartIso: "2026-02-31T00:08:00Z", until, windowMinutes: 10 }),
    /window start/,
  );
  // An explicit offset is fine and names the same instant as its Z form.
  assert.equal(
    errorRateWindowSince({
      windowStartIso: "2026-10-17T02:08:00+02:00",
      until,
      windowMinutes: 10,
    }).toISOString(),
    "2026-10-17T00:08:00.000Z",
  );
});

test("error-rate query refuses untrusted identifiers and inverted windows", () => {
  const base = {
    accountId: ACCOUNT,
    scriptName: "two-web-next-production",
    versionId: NEXT,
    sinceIso: SINCE,
    untilIso: UNTIL,
  };
  assert.throws(() => buildErrorRateQuery({ ...base, accountId: "nope" }), /account id/);
  assert.throws(
    () => buildErrorRateQuery({ ...base, scriptName: 'x",datetime_geq:"0' }),
    /script name/,
  );
  // Valid Cloudflare names the gate must ACCEPT: underscores and lengths
  // past the workers.dev-only 63-char cap, up to the API's 255. A stricter
  // pattern would fail-close every promotion for such a Worker.
  for (const scriptName of ["my_worker", "a".repeat(100), "a".repeat(255)]) {
    assert.equal(buildErrorRateQuery({ ...base, scriptName }).variables.scriptName, scriptName);
  }
  assert.throws(() => buildErrorRateQuery({ ...base, scriptName: "a".repeat(256) }), /script name/);
  assert.throws(() => buildErrorRateQuery({ ...base, versionId: "not-a-uuid" }), /Version ID/);
  assert.throws(() => buildErrorRateQuery({ ...base, sinceIso: UNTIL, untilIso: SINCE }), /window/);
  assert.throws(() => buildErrorRateQuery({ ...base, sinceIso: "soon" }), /window/);
});

test("error-rate response parser reads sums and fails closed on bad payloads", () => {
  assert.deepEqual(parseErrorRateResponse(envelope({ requests: 200, errors: 3 }), NEXT), {
    requests: 200,
    errors: 3,
  });
  assert.deepEqual(parseErrorRateResponse(envelope(null), NEXT), { requests: 0, errors: 0 });
  assert.throws(
    () =>
      parseErrorRateResponse(
        { data: null, errors: [{ message: "auth detail must not leak" }] },
        NEXT,
      ),
    (error) => /GraphQL/.test(error.message) && !error.message.includes("auth detail"),
  );
  assert.throws(() => parseErrorRateResponse({}, NEXT), /error-rate response/);
  assert.throws(() => parseErrorRateResponse("nope", NEXT), /error-rate response/);
  assert.throws(
    () => parseErrorRateResponse(envelope({ requests: -1, errors: 0 }), NEXT),
    /error-rate response/,
  );
  assert.throws(
    () => parseErrorRateResponse(envelope({ requests: 10, errors: 1 }, PREV), NEXT),
    /version/,
  );
});

test("error-rate evaluation needs a minimum sample, then judges the rate", () => {
  const gate = { threshold: 0.05, minRequests: 20 };
  assert.equal(evaluateErrorRate({ requests: 19, errors: 19, ...gate }).verdict, "insufficient");
  assert.equal(evaluateErrorRate({ requests: 100, errors: 5, ...gate }).verdict, "pass");
  assert.equal(evaluateErrorRate({ requests: 100, errors: 6, ...gate }).verdict, "fail");
  assert.equal(evaluateErrorRate({ requests: 100, errors: 5, ...gate }).rate, 0.05);
  assert.throws(
    () => evaluateErrorRate({ requests: 1, errors: 0, threshold: 2, minRequests: 1 }),
    /threshold/,
  );
  assert.throws(
    () => evaluateErrorRate({ requests: 1, errors: 0, threshold: 0.1, minRequests: 0 }),
    /minRequests/,
  );
});

function gateConfig(overrides = {}) {
  return {
    accountId: ACCOUNT,
    scriptName: "two-web-next-production",
    versionId: NEXT,
    threshold: 0.05,
    minRequests: 20,
    windowMinutes: 10,
    soakSeconds: 0,
    attempts: 3,
    retrySeconds: 0,
    ...overrides,
  };
}

function gateDeps(responses) {
  const sleeps = [];
  let call = 0;
  return {
    sleeps,
    deps: {
      now: () => new Date(UNTIL),
      sleep: async (seconds) => {
        sleeps.push(seconds);
      },
      fetchJson: async () => {
        const next = responses[Math.min(call, responses.length - 1)];
        call += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      log: () => {},
    },
  };
}

test("live gate halts on an elevated error rate and passes a healthy version", async () => {
  const elevated = gateDeps([envelope({ requests: 100, errors: 40 })]);
  const halted = await runErrorRateGate(gateConfig(), elevated.deps);
  assert.equal(halted.code, 1);
  assert.equal(halted.verdict, "fail");
  const healthy = gateDeps([envelope({ requests: 100, errors: 1 })]);
  const passed = await runErrorRateGate(gateConfig(), healthy.deps);
  assert.equal(passed.code, 0);
  assert.equal(passed.verdict, "pass");
});

test("live gate judges only post-smoke invocations when a window start is given", async () => {
  const seen = [];
  const depsFor = (sum) => ({
    now: () => new Date(UNTIL),
    sleep: async () => {},
    fetchJson: async (body) => {
      seen.push(body.variables);
      return envelope(sum);
    },
    log: () => {},
  });
  const config = gateConfig({ attempts: 1, windowStartIso: "2026-10-17T00:08:00.000Z" });
  // 10 post-smoke requests with 2 errors is a 20% live rate, but the sample
  // is below the floor: the verdict must be the warned "insufficient", never
  // a judged pass padded by the smoke probes that ran before the start.
  const warned = await runErrorRateGate(config, depsFor({ requests: 10, errors: 2 }));
  assert.equal(seen[0].since, "2026-10-17T00:08:00.000Z");
  assert.equal(warned.verdict, "insufficient");
  assert.equal(warned.code, 0);
  // Once post-smoke traffic alone clears the floor, its rate decides: 4/25
  // is 16%, over the 5% threshold, so the stage halts.
  const halted = await runErrorRateGate(config, depsFor({ requests: 25, errors: 4 }));
  assert.equal(halted.verdict, "fail");
  assert.equal(halted.code, 1);
});

test("live gate retries an insufficient sample, then warns instead of blocking", async () => {
  const warming = gateDeps([
    envelope({ requests: 2, errors: 0 }),
    envelope({ requests: 3, errors: 0 }),
    envelope({ requests: 50, errors: 0 }),
  ]);
  const passed = await runErrorRateGate(gateConfig(), warming.deps);
  assert.equal(passed.code, 0);
  assert.equal(passed.attempts, 3);
  const quiet = gateDeps([envelope(null)]);
  const warned = await runErrorRateGate(gateConfig({ attempts: 2 }), quiet.deps);
  assert.equal(warned.code, 0);
  assert.equal(warned.verdict, "insufficient");
});

test("live gate fails closed when the analytics query keeps failing", async () => {
  const down = gateDeps([new Error("socket detail must not leak")]);
  const result = await runErrorRateGate(gateConfig({ attempts: 2 }), down.deps);
  assert.equal(result.code, 1);
  assert.equal(result.verdict, "error");
});

test("gate CLI in fixture mode halts on a simulated elevated rate, passes healthy", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-rate-gate-"));
  const fixture = (name, sum) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(envelope(sum)));
    return path;
  };
  // Pin every gate setting: the child inherits the shell env, and an
  // ambient ERROR_RATE_* value must not change the fixture verdict.
  const run = (path, script = GATE_PATH) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKER_NAME: "two-web-next-production",
        NEW_VERSION: NEXT,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        ERROR_RATE_FIXTURE: path,
        ERROR_RATE_SOAK_SECONDS: "0",
        ERROR_RATE_ATTEMPTS: "1",
        ERROR_RATE_RETRY_SECONDS: "0",
        ERROR_RATE_THRESHOLD: "0.05",
        ERROR_RATE_MIN_REQUESTS: "20",
        ERROR_RATE_WINDOW_MINUTES: "10",
      },
    });
  const elevated = run(fixture("elevated.json", { requests: 100, errors: 40 }));
  assert.equal(elevated.status, 1, elevated.stdout + elevated.stderr);
  assert.match(elevated.stdout, /verdict=fail/);
  // A fixture verdict announces itself, so it cannot pass as a live one.
  assert.match(elevated.stdout, /::warning::.*fixture/);
  const healthy = run(fixture("healthy.json", { requests: 100, errors: 0 }));
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /verdict=pass/);
  assert.match(healthy.stdout, /::warning::.*fixture/);
  // Through a symlinked action path (self-hosted runners with a symlinked
  // _work directory) the CLI must still run: a no-op exits 0 silently,
  // indistinguishable from a pass.
  const link = join(dir, "link");
  symlinkSync(GATE_DIR, link, "dir");
  const viaSymlink = run(
    fixture("elevated2.json", { requests: 100, errors: 40 }),
    join(link, "error-rate-gate.mjs"),
  );
  assert.equal(viaSymlink.status, 1, viaSymlink.stdout + viaSymlink.stderr);
  assert.match(viaSymlink.stdout, /verdict=fail/);
});

test("gate config rejects static misconfiguration before any soak", () => {
  const base = {
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    WORKER_NAME: "two-web-next-production",
    NEW_VERSION: NEXT,
  };
  assert.equal(configFromEnv(base).threshold, 0.05);
  assert.equal(
    configFromEnv({ ...base, ERROR_RATE_WINDOW_START: "2026-10-17T00:08:00Z" }).windowStartIso,
    "2026-10-17T00:08:00Z",
  );
  assert.equal(configFromEnv({ ...base, ERROR_RATE_WINDOW_START: "" }).windowStartIso, undefined);
  assert.throws(
    () => configFromEnv({ ...base, ERROR_RATE_WINDOW_START: "soon" }),
    /ERROR_RATE_WINDOW_START/,
  );
  assert.throws(
    () => configFromEnv({ ...base, ERROR_RATE_WINDOW_START: "2026-10-17T00:08:00" }),
    /ERROR_RATE_WINDOW_START/,
  );
  assert.throws(
    () => configFromEnv({ ...base, ERROR_RATE_WINDOW_START: "2026-02-31T00:08:00Z" }),
    /ERROR_RATE_WINDOW_START/,
  );
  assert.throws(
    () => configFromEnv({ ...base, ERROR_RATE_THRESHOLD: "5" }),
    /ERROR_RATE_THRESHOLD/,
  );
  assert.throws(() => configFromEnv({ ...base, CLOUDFLARE_ACCOUNT_ID: "" }), /account id/);
  assert.throws(() => configFromEnv({ ...base, WORKER_NAME: "" }), /script name/);
  assert.throws(() => configFromEnv({ ...base, NEW_VERSION: "not-a-uuid" }), /Version ID/);
  assert.throws(() => configFromEnv({ ...base, CLOUDFLARE_API_TOKEN: "" }), /CLOUDFLARE_API_TOKEN/);
});
