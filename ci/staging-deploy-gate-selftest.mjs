import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { kitRouteFlagsForFamily, requireEnabledEmberRoutes } from "./kit-route-flags.mjs";
import { deploymentTarget, requireSuccessfulCi } from "./staging-deploy-gate.mjs";
import { requireForwardStaging } from "./staging-forward.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "TogetherWeOwn/two-web-next";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const run = {
  id: 42,
  run_attempt: 1,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};
function context(eventName) {
  return {
    eventName,
    repository,
    ref: "refs/heads/main",
    checkoutSha: sha,
    // Deliberately newer default-branch tip for workflow_run.
    sha: eventName === "workflow_run" ? otherSha : sha,
    event: { repository: { full_name: repository }, workflow_run: structuredClone(run) },
  };
}
function fixture() {
  return {
    runs: { total_count: 1, workflow_runs: [structuredClone(run)] },
    jobs: {
      total_count: 2,
      jobs: ["a11y", "check"].map((name) => ({
        name,
        run_id: run.id,
        run_attempt: run.run_attempt,
        head_sha: sha,
        status: "completed",
        conclusion: "success",
      })),
    },
    current: structuredClone(run),
  };
}

const ciEvidencePaths = ["/workflows/ci.yml/runs", "/runs/42/jobs", "/runs/42"];

test("bounded CI admission accepts a successful exact attempt", async () => {
  const seen = [];
  const evidence = Object.values(fixture());
  const admitted = await requireSuccessfulCi(context("workflow_run"), {
    token: "offline-stub",
    fetchImpl: async (url) => {
      seen.push(new URL(url).pathname);
      return Response.json(evidence[seen.length - 1]);
    },
  });

  assert.deepEqual(admitted, { sha, runId: run.id, runAttempt: run.run_attempt });
  assert.deepEqual(
    seen,
    ciEvidencePaths.map((path) => `/repos/${repository}/actions${path}`),
  );
});

test("main push CI admits only the expected PR admission skip", async () => {
  const evidence = fixture();
  const admission = {
    ...evidence.jobs.jobs[0],
    name: "pr-admission",
    conclusion: "skipped",
  };
  evidence.jobs.jobs.push(admission);
  evidence.jobs.total_count += 1;
  const admit = () => {
    const responses = Object.values(evidence);
    return requireSuccessfulCi(context("workflow_run"), {
      token: "offline-stub",
      fetchImpl: async () => Response.json(responses.shift()),
    });
  };

  assert.deepEqual(await admit(), { sha, runId: run.id, runAttempt: run.run_attempt });

  admission.name = "dependency-admission";
  await assert.rejects(admit(), /Full CI jobs are not successful/);
  admission.name = "pr-admission";
  admission.conclusion = "failure";
  await assert.rejects(admit(), /Full CI jobs are not successful/);
  admission.conclusion = "skipped";
  evidence.jobs.jobs.push({ ...admission });
  evidence.jobs.total_count += 1;
  await assert.rejects(admit(), /Ambiguous PR admission job/);
});

test("bounded CI admission refuses and cancels oversized evidence at every read", async () => {
  const evidence = Object.values(fixture());
  for (const [overLimit, path] of ciEvidencePaths.entries()) {
    let cancelled = false;
    let requests = 0;
    let pulls = 0;
    const prefix = new TextEncoder().encode(JSON.stringify(evidence[overLimit]));
    const padding = new Uint8Array(1024 * 1024).fill(32);
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(prefix);
          else if (pulls === 2) controller.enqueue(padding);
          else controller.close();
        },
        cancel() {
          cancelled = true;
          // A source can stall during cleanup. The refusal must still settle.
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );

    await assert.rejects(
      requireSuccessfulCi(context("workflow_run"), {
        token: "offline-stub",
        fetchImpl: async (url) => {
          const index = requests++;
          assert.ok(new URL(url).pathname.endsWith(ciEvidencePaths[index]));
          return index === overLimit ? new Response(body) : Response.json(evidence[index]);
        },
      }),
      /GitHub metadata response exceeds the byte limit/,
      path,
    );
    assert.equal(requests, overLimit + 1, path);
    assert.equal(pulls, 2, path);
    assert.equal(cancelled, true, path);
    assert.equal(body.locked, false, path);
  }
});

const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
function stepBlock(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert.ok(block, `Missing workflow step: ${name}`);
  return block;
}

function step(name) {
  const block = stepBlock(name);
  assert.doesNotMatch(
    block,
    /^        if:/m,
    "The gate and mutations must use default success semantics",
  );
  const match = block.match(/^        run: (.+)(?:\n|$)/m);
  assert.ok(match);
  if (match[1] !== "|") return match[1];
  return block
    .split("        run: |\n")[1]
    .split(/^        \S/m)[0]
    .replace(/^          /gm, "")
    .trim();
}

test("deploy receipt uses the admission outputs and completed Worker step", () => {
  assert.match(
    stepBlock("Re-verify exact-SHA full CI before Worker deploy"),
    /^        id: web-deploy-ci$/m,
  );
  assert.match(stepBlock("Deploy to Cloudflare Workers"), /^        id: web-deploy$/m);
  const receipt = stepBlock("Summarize staging deploy evidence");
  assert.ok(
    workflow.trimEnd().endsWith(receipt.trimEnd()),
    "the receipt runs after all deploy steps",
  );
  assert.match(
    receipt,
    /if: \$\{\{ !cancelled\(\) && steps\.web-deploy-ci\.outputs\.sha != '' && hashFiles\('ci\/staging-receipt\.mjs'\) != '' \}\}/,
  );
  assert.match(
    receipt,
    /run: \|\n +node ci\/staging-receipt\.mjs deploy \|\| printf .*::warning::/,
  );
  for (const [key, source] of Object.entries({
    STAGING_JOB_STATUS: "job.status",
    STAGING_WEB_DEPLOY_OUTCOME: "steps.web-deploy.outcome",
    STAGING_CANDIDATE: "steps.web-deploy-ci.outputs.sha",
    STAGING_CI_RUN_ID: "steps.web-deploy-ci.outputs.run_id",
    STAGING_CI_RUN_ATTEMPT: "steps.web-deploy-ci.outputs.run_attempt",
  })) {
    assert.ok(receipt.split("\n").includes(`          ${key}: \${{ ${source} }}`));
  }
});

const gateCommand = step("Require successful exact-SHA full CI");
const queueCommand = step("Ensure queues exist");
const tailCommand = `${step("Re-verify exact-SHA full CI before Tail Worker deploy")}\n${step("Deploy alert Tail Worker before attaching the app")}`;
const deployGateCommand = step("Re-verify exact-SHA full CI before Worker deploy");
const workerDeployCommand = step("Deploy to Cloudflare Workers");
const deployCommand = `GITHUB_OUTPUT="$TEST_WEB_ADMISSION_OUTPUT" ${deployGateCommand}\n${workerDeployCommand}`;

function executeStaging(ctx, evidence, changes = {}, routeFamily = "hono") {
  const flags = kitRouteFlagsForFamily(routeFamily);
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "staging-gate-"));
  try {
    const webAdmissionOutput = join(dir, "web-admission.txt");
    writeFileSync(webAdmissionOutput, "");
    writeFileSync(join(dir, "event.json"), JSON.stringify(ctx.event));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence));
    writeFileSync(join(dir, "changes.json"), JSON.stringify(changes));
    writeFileSync(
      join(dir, "transition.mjs"),
      `
      import { readFileSync, writeFileSync } from "node:fs";
      const changes = JSON.parse(readFileSync(process.env.TEST_CHANGES, "utf8"));
      if (changes[process.argv[2]]) writeFileSync(process.env.TEST_EVIDENCE, JSON.stringify(changes[process.argv[2]]));
    `,
    );
    writeFileSync(
      join(dir, "git"),
      '#!/bin/sh\n[ "$*" = "rev-parse HEAD" ] || [ "$*" = "-c safe.directory=$PWD rev-parse HEAD" ] || exit 1\nprintf "%s\\n" "$TEST_CHECKOUT_SHA"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "npx"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\nnode "$TEST_TRANSITION" "$*"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "fetch.mjs"),
      `
      import { readFileSync } from "node:fs";
      const evidence = JSON.parse(readFileSync(process.env.TEST_EVIDENCE, "utf8"));
      let finalReadTimeouts = evidence.finalReadTimeouts ?? 0;
      let deadline;
      if (finalReadTimeouts) {
        AbortSignal.timeout = (delay) => {
          if (delay !== 10_000) throw new Error("Unexpected CI read deadline");
          deadline = new AbortController();
          return deadline.signal;
        };
      }
      globalThis.fetch = async (url, options) => {
        if (evidence.networkError) throw new Error("Stubbed network failure");
        const parsed = new URL(url);
        if (parsed.origin !== "https://api.github.com" || options.method && options.method !== "GET") throw new Error("Unexpected API call");
        let data;
        if (parsed.pathname.endsWith("/workflows/ci.yml/runs")) {
          if (parsed.searchParams.get("head_sha") !== "${sha}" || parsed.searchParams.get("branch") !== "main" || parsed.searchParams.get("event") !== "push" || parsed.searchParams.has("status")) throw new Error("Unsafe CI query");
          data = evidence.runs;
        } else if (parsed.pathname.endsWith("/runs/42/jobs")) {
          if (parsed.searchParams.get("filter") !== "latest") throw new Error("Stale jobs query");
          data = evidence.jobs;
        } else if (parsed.pathname.endsWith("/runs/42")) {
          if (finalReadTimeouts > 0) {
            finalReadTimeouts--;
            deadline.abort(new DOMException("Fixture deadline expired", "TimeoutError"));
            options.signal.throwIfAborted();
          }
          data = evidence.current;
        } else throw new Error("Unexpected API path");
        const status = evidence.httpError ?? 200;
        return evidence.invalidJson ? new Response("{", { status }) : Response.json(data, { status });
      };
    `,
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -e\n${gateCommand}\nnode "$TEST_TRANSITION" afterPreparation\n${queueCommand}\n${tailCommand}\n${deployCommand}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          NODE_OPTIONS: `--import=${join(dir, "fetch.mjs")}`,
          GITHUB_EVENT_NAME: ctx.eventName,
          GITHUB_EVENT_PATH: join(dir, "event.json"),
          GITHUB_REPOSITORY: ctx.repository,
          GITHUB_REF: ctx.ref,
          GITHUB_SHA: ctx.sha,
          DEPLOY_SHA: ctx.checkoutSha,
          KIT_ROUTE_ARCHIVE: flags.archive,
          KIT_ROUTE_STATIC: flags.static,
          KIT_ROUTE_EVENTS: flags.events,
          KIT_ROUTE_HOME: flags.home,
          KIT_ROUTE_JOIN: flags.join,
          GITHUB_TOKEN: "offline-stub",
          TEST_CHECKOUT_SHA: ctx.checkoutSha,
          TEST_EVIDENCE: join(dir, "evidence.json"),
          TEST_CALLS: join(dir, "calls"),
          TEST_TRANSITION: join(dir, "transition.mjs"),
          TEST_CHANGES: join(dir, "changes.json"),
          TEST_WEB_ADMISSION_OUTPUT: webAdmissionOutput,
        },
      },
    );
    let calls = [];
    try {
      calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ...result, calls, webAdmission: readFileSync(webAdmissionOutput, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const emberRoutes = Object.entries({ events: "/events", home: "/", join: "/join" });

test("Kit route-family selection emits validated flags and fails closed", async () => {
  const { tsImport } = await import("tsx/esm/api");
  const { ROUTE_MANIFEST } = await tsImport("../src/route-ownership.ts", import.meta.url);
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-route-flags-"),
  );
  try {
    for (const [family, expected, eventName = "workflow_dispatch"] of [
      ["", []],
      ["hono", []],
      ["archive", ["archive"]],
      ["archive-static", ["archive", "static"]],
      ["events", ["events"]],
      ["home", ["home"]],
      ["events-join", ["events", "join"]],
      ["events-home", ["events", "home"]],
      ["join", ["join"]],
      ["ember-pages", ["events", "home", "join"]],
      ["all", null],
      ["events", ["events"], "workflow_run"],
      ["events-join", ["events", "join"], "workflow_run"],
      ["events-home", ["events", "home"], "workflow_run"],
      ["ember-pages", ["events", "home", "join"], "workflow_run"],
      [undefined, [], "workflow_run"],
      ["", [], "workflow_run"],
      ["all", [], "workflow_run"],
      ["EVENTS", [], "workflow_run"],
      ["unknown", [], "workflow_run"],
    ]) {
      const automatic = eventName === "workflow_run";
      const disabled = emberRoutes.some(
        ([flag, path]) =>
          expected?.includes(flag) &&
          !ROUTE_MANIFEST.some(
            (entry) => entry.method === "GET" && entry.path === path && entry.enabled,
          ),
      );
      const output = join(dir, "github-output");
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, ["--import", "tsx", "ci/kit-route-flags.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: eventName,
          KIT_ROUTE_FAMILY: automatic ? "archive" : family,
          KIT_STAGING_ROUTE_FAMILY: automatic ? family : "archive",
        },
      });
      const flags = ["archive", "static", "events", "home", "join"]
        .map((name) => `${name}=${expected?.includes(name) ?? false}\n`)
        .join("");
      const success = expected && !disabled;
      const label = `${eventName} family ${JSON.stringify(family)}`;
      assert.equal(result.status, success ? 0 : 1, `${label}: ${result.stderr}`);
      assert.equal(readFileSync(output, "utf8"), success ? flags : "", label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the combined selection refuses any disabled or non-GET Ember entry", async () => {
  const flags = kitRouteFlagsForFamily("ember-pages");
  const routes = emberRoutes.map(([, path]) => ({ method: "GET", path, enabled: true }));
  await requireEnabledEmberRoutes(flags, routes);
  for (const entry of routes) {
    const rest = routes.filter((route) => route !== entry);
    for (const invalid of [[], [{ ...entry, method: "POST" }], [{ ...entry, enabled: false }]]) {
      await assert.rejects(requireEnabledEmberRoutes(flags, [...rest, ...invalid]), /not enabled/);
    }
  }
});

test("events-join turns on only /events and /join and refuses either disabled GET", async () => {
  const flags = kitRouteFlagsForFamily("events-join");
  assert.deepEqual(flags, {
    archive: "false",
    static: "false",
    events: "true",
    home: "false",
    join: "true",
  });
  const routes = ["/events", "/join"].map((path) => ({ method: "GET", path, enabled: true }));
  await requireEnabledEmberRoutes(flags, routes);
  for (const entry of routes) {
    const rest = routes.filter((route) => route !== entry);
    await assert.rejects(
      requireEnabledEmberRoutes(flags, [...rest, { ...entry, enabled: false }]),
      new RegExp(`GET ${entry.path} is not enabled`),
    );
  }
});

test("events-home turns on only /events and / and refuses either disabled GET", async () => {
  const flags = kitRouteFlagsForFamily("events-home");
  assert.deepEqual(flags, {
    archive: "false",
    static: "false",
    events: "true",
    home: "true",
    join: "false",
  });
  const routes = ["/events", "/"].map((path) => ({ method: "GET", path, enabled: true }));
  await requireEnabledEmberRoutes(flags, routes);
  for (const entry of routes) {
    const rest = routes.filter((route) => route !== entry);
    await assert.rejects(
      requireEnabledEmberRoutes(flags, [...rest, { ...entry, enabled: false }]),
      new RegExp(`GET ${entry.path} is not enabled`),
    );
  }
});

function runKitProbe(path, fetchStub, env = process.env) {
  // Record requested delays before shortening the retry wait in the offline subprocess.
  const setup = `const retryDelays = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      retryDelays.push(delay);
      return realSetTimeout(callback, delay === 10_000 ? 0 : delay, ...args);
    };
    ${fetchStub}`;
  return spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(setup)}`,
      "ci/staging-kit-route-check.mjs",
      path,
    ],
    { cwd: root, encoding: "utf8", timeout: 5_000, env },
  );
}

test("each Ember opt-in probes the exact staging GET after revision verification", () => {
  const preflight = workflow.indexOf("run: node --import tsx ci/kit-route-flags.mjs");
  assert.ok(preflight > workflow.indexOf("- name: Require successful exact-SHA full CI"));
  assert.ok(preflight > workflow.indexOf("run: npm run build --prefix web"));
  assert.ok(preflight < workflow.indexOf("- name: Plan staging web migrations"));
  for (const [flag, path] of emberRoutes) {
    const probeOffset = workflow.indexOf(`- name: Verify staging Kit ${flag} renderer`);
    assert.ok(probeOffset > workflow.indexOf("- name: Verify deployed revision"));
    assert.ok(probeOffset < workflow.indexOf("- name: Scope post-deploy smoke"));
    const [probe] = workflow.slice(probeOffset).split("\n      - ");
    const lines = probe.split("\n");
    assert.ok(lines.includes(`        if: steps.kit-route-flags.outputs.${flag} == 'true'`));
    assert.ok(lines.includes(`        run: node ci/staging-kit-route-check.mjs ${path}`));
  }
  const smokeStep = workflow
    .split("\n      - ")
    .find((step) => step.startsWith("name: Smoke test staging public routes\n"));
  assert.ok(
    smokeStep?.includes(
      "SMOKE_EXPECT_JOIN_RENDERER: ${{ steps.kit-route-flags.outputs.join == 'true' && 'kit' || 'hono' }}",
    ),
  );
  const cases = emberRoutes.flatMap(([, path]) => [
    [path, 200, "kit", 0],
    [path, 200, null, 1],
    [path, 200, "hono", 1],
    [path, 302, "kit", 1],
    [path, 503, "kit", 1],
  ]);
  for (const [path, status, marker, expected] of [...cases, ["/join/callback", 200, "kit", 1]]) {
    const stub = `const timeout = AbortSignal.timeout;
    let probeSignal;
    AbortSignal.timeout = (ms) => {
      if (ms !== 10_000) throw new Error("Unexpected probe timeout");
      probeSignal = timeout(ms);
      return probeSignal;
    };
    globalThis.fetch = async (url, options) => {
      if (url !== "https://next.togetherweown.com${path}" || options.method !== "GET" ||
          options.credentials !== "omit" || options.headers ||
          options.redirect !== "manual" || options.cache !== "no-store" ||
          !probeSignal || options.signal !== probeSignal) {
        throw new Error("Unexpected probe request");
      }
      return new Response(null, {status: ${status}, headers: ${JSON.stringify(marker ? { "x-two-renderer": marker } : {})}});
    };`;
    const result = runKitProbe(path, stub);
    assert.equal(result.status, expected, `${status} / ${marker}: ${result.stderr}`);
    if (expected === 0) assert.match(result.stdout, /HTTP 200, x-two-renderer: kit/);
    else {
      assert.equal(result.stdout, "");
      const refusal = path === "/join/callback" ? /Unsupported Kit probe path/ : null;
      assert.match(result.stderr, refusal ?? (status === 200 ? /did not return/ : /expected 200/));
    }
  }
});

test("the staging Kit renderer probe recovers on attempt three", () => {
  const result = runKitProbe(
    "/",
    `let calls = 0; globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, {status: 200, headers: calls < 3 ? {"x-two-renderer": "hono"} : {"x-two-renderer": "kit"}});
    };
    process.on("exit", () => console.error("Retry delays:", retryDelays.join(",")));`,
    { ...process.env, KIT_ROUTE_CHECK_DELAY_MS: "0" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /x-two-renderer: kit \(attempt 3\)/);
  assert.match(result.stderr, /^Retry delays: 10000,10000$/m);
});

test("the staging Kit renderer probe fails after six Hono responses", () => {
  const result = runKitProbe(
    "/",
    `let calls = 0; globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, {status: 200, headers: {"x-two-renderer": "hono"}});
    };
    process.on("exit", () => {
      console.error("Probe requests:", calls);
      console.error("Retry delays:", retryDelays.join(","));
    });`,
    { ...process.env, KIT_ROUTE_CHECK_ATTEMPTS: "", KIT_ROUTE_CHECK_DELAY_MS: "1" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GET \/ did not return x-two-renderer: kit/);
  assert.match(result.stderr, /^Probe requests: 6$/m);
  assert.match(result.stderr, /^Retry delays: 10000,10000,10000,10000,10000$/m);
});

test("the staging Kit renderer probe preserves observations when body cancellation rejects", async (t) => {
  const cases = [
    { status: 200, renderer: "kit", failure: null },
    { status: 200, renderer: "hono", failure: "did not return x-two-renderer: kit" },
    { status: 503, renderer: "kit", failure: "returned HTTP 503; expected 200" },
  ];
  for (const { status, renderer, failure } of cases) {
    await t.test(`HTTP ${status} / ${renderer}`, () => {
      const result = runKitProbe(
        "/join",
        `let calls = 0;
        let cancellations = 0;
        globalThis.fetch = async () => {
          calls += 1;
          return new Response(new ReadableStream({
            cancel() {
              cancellations += 1;
              throw new Error("synthetic cancellation detail");
            }
          }), {status: ${status}, headers: {"x-two-renderer": ${JSON.stringify(renderer)}}});
        };
        process.on("exit", () => {
          console.error("Probe requests:", calls);
          console.error("Body cancellations:", cancellations);
          console.error("Retry delays:", JSON.stringify(retryDelays));
        });`,
        {},
      );
      const attempts = failure ? 6 : 1;
      assert.ifError(result.error);
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      assert.equal(
        result.stdout,
        failure ? "" : "GET /join: HTTP 200, x-two-renderer: kit (attempt 1)\n",
      );
      assert.deepEqual(result.stderr.trimEnd().split("\n"), [
        ...Array(attempts).fill("Warning: could not cancel the staging Kit response body"),
        ...(failure ? [`Staging Kit renderer check failed: GET /join ${failure}`] : []),
        `Probe requests: ${attempts}`,
        `Body cancellations: ${attempts}`,
        `Retry delays: ${failure ? "[10000,10000,10000,10000,10000]" : "[]"}`,
      ]);
    });
  }
});

const denied = [
  [
    "missing",
    (f) => {
      f.runs = { total_count: 0, workflow_runs: [] };
    },
  ],
  [
    "ambiguous",
    (f) => {
      f.runs.total_count = 2;
      f.runs.workflow_runs.push(structuredClone(run));
    },
  ],
  [
    "truncated runs",
    (f) => {
      f.runs.total_count = 2;
    },
  ],
  [
    "wrong SHA",
    (f) => {
      f.runs.workflow_runs[0].head_sha = otherSha;
    },
  ],
  [
    "wrong branch",
    (f) => {
      f.runs.workflow_runs[0].head_branch = "topic";
    },
  ],
  [
    "PR evidence",
    (f) => {
      f.runs.workflow_runs[0].event = "pull_request";
    },
  ],
  [
    "wrong workflow",
    (f) => {
      f.runs.workflow_runs[0].path = ".github/workflows/deploy.yml";
    },
  ],
  [
    "foreign repository",
    (f) => {
      f.runs.workflow_runs[0].head_repository.full_name = "foreign/repo";
    },
  ],
  ...["queued", "in_progress", "waiting"].map((status) => [
    status,
    (f) => {
      f.runs.workflow_runs[0].status = status;
    },
  ]),
  ...["failure", "cancelled", "skipped", "neutral", "timed_out", null].map((conclusion) => [
    String(conclusion),
    (f) => {
      f.runs.workflow_runs[0].conclusion = conclusion;
    },
  ]),
  [
    "missing a11y",
    (f) => {
      f.jobs.jobs.shift();
      f.jobs.total_count = 1;
    },
  ],
  [
    "missing check",
    (f) => {
      f.jobs.jobs.pop();
      f.jobs.total_count = 1;
    },
  ],
  [
    "duplicate check",
    (f) => {
      f.jobs.jobs.push(structuredClone(f.jobs.jobs[1]));
      f.jobs.total_count = 3;
    },
  ],
  [
    "truncated jobs",
    (f) => {
      f.jobs.total_count = 101;
    },
  ],
  [
    "wrong job SHA",
    (f) => {
      f.jobs.jobs[1].head_sha = otherSha;
    },
  ],
  [
    "skipped check",
    (f) => {
      f.jobs.jobs[1].conclusion = "skipped";
    },
  ],
  [
    "failed a11y",
    (f) => {
      f.jobs.jobs[0].conclusion = "failure";
    },
  ],
  [
    "pending check",
    (f) => {
      f.jobs.jobs[1].status = "in_progress";
    },
  ],
  [
    "rerun started",
    (f) => {
      f.current.status = "in_progress";
    },
  ],
  [
    "attempt changed",
    (f) => {
      f.current.run_attempt = 2;
    },
  ],
  [
    "HTTP 403",
    (f) => {
      f.httpError = 403;
    },
  ],
  [
    "network unavailable",
    (f) => {
      f.networkError = true;
    },
  ],
  [
    "malformed response",
    (f) => {
      f.invalidJson = true;
    },
  ],
];

for (const eventName of ["workflow_run", "workflow_dispatch"]) {
  for (const [name, mutate] of denied) {
    test(`${eventName}: ${name} makes no queue/deploy calls`, () => {
      const evidence = fixture();
      mutate(evidence);
      const result = executeStaging(context(eventName), evidence);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.calls, []);
      assert.match(result.stderr, /Staging gate refused:/);
    });
  }
  test(`${eventName}: successful same-SHA full CI allows exactly the staging commands`, () => {
    const result = executeStaging(context(eventName), fixture());
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      "wrangler queues create two-sync-event",
      "wrangler queues create two-internal-action",
      "wrangler deploy --config tail/wrangler.jsonc",
      `wrangler deploy --config web/wrangler.staging.jsonc --tag ${sha} --var KIT_ROUTE_ARCHIVE:false --var KIT_ROUTE_STATIC:false --var KIT_ROUTE_EVENTS:false --var KIT_ROUTE_HOME:false --var KIT_ROUTE_JOIN:false`,
    ]);
    assert.match(result.stdout, new RegExp(`Staging gate passed: ${sha}`));
  });
  test(`${eventName}: checkout mismatch makes no queue/deploy calls`, () => {
    const ctx = context(eventName);
    ctx.checkoutSha = otherSha;
    const result = executeStaging(ctx, fixture());
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr, /Checkout does not match deployment SHA/);
  });
}

test("a successful prior CI attempt cannot supply jobs for the selected attempt", () => {
  const ctx = context("workflow_run");
  const evidence = fixture();
  ctx.event.workflow_run.run_attempt = 2;
  evidence.runs.workflow_runs[0].run_attempt = 2;
  evidence.current.run_attempt = 2;
  for (const job of evidence.jobs.jobs) job.run_attempt = 2;

  // A later workflow definition SHA still deploys the CI source when its jobs match.
  const accepted = executeStaging(ctx, evidence);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(accepted.calls, mutationCalls);
  assert.match(
    accepted.stdout,
    new RegExp(`Staging gate passed: ${sha}, full CI run 42, attempt 2`),
  );

  const check = evidence.jobs.jobs[1];
  for (const mismatch of [{ run_attempt: 1 }, { run_id: 43 }, { run_attempt: undefined }]) {
    evidence.jobs.jobs[1] = { ...check, ...mismatch };
    const refused = executeStaging(ctx, evidence);
    assert.equal(refused.status, 1, refused.stdout);
    assert.deepEqual(refused.calls, []);
    assert.match(refused.stderr, /CI job run or attempt mismatch/);
  }
});

const mutationCalls = [
  "wrangler queues create two-sync-event",
  "wrangler queues create two-internal-action",
  "wrangler deploy --config tail/wrangler.jsonc",
  `wrangler deploy --config web/wrangler.staging.jsonc --tag ${sha} --var KIT_ROUTE_ARCHIVE:false --var KIT_ROUTE_STATIC:false --var KIT_ROUTE_EVENTS:false --var KIT_ROUTE_HOME:false --var KIT_ROUTE_JOIN:false`,
];

test("truncated CI jobs after preparation stop staging before the first queue", () => {
  const ctx = context("workflow_run");
  const complete = fixture();
  const truncated = structuredClone(complete);
  truncated.jobs.total_count = truncated.jobs.jobs.length + 1;

  const refused = executeStaging(ctx, complete, { afterPreparation: truncated });
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(
    refused.stdout.trim(),
    `Staging gate passed: ${sha}, full CI run ${run.id}, attempt ${run.run_attempt}`,
  );
  assert.match(refused.stderr, /^Staging gate refused: Incomplete CI job evidence$/m);
  assert.deepEqual(refused.calls, []);

  const accepted = executeStaging(ctx, complete, { afterPreparation: complete });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(accepted.calls, mutationCalls);
});

test("a failed duplicate required job makes same-attempt CI evidence ambiguous", () => {
  const ctx = context("workflow_run");
  const evidence = fixture();
  evidence.jobs.jobs = evidence.jobs.jobs.map((job, index) => ({ ...job, id: 101 + index }));

  const accepted = executeStaging(ctx, evidence);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(accepted.calls, mutationCalls);
  assert.match(
    accepted.stdout,
    new RegExp(`Staging gate passed: ${sha}, full CI run ${run.id}, attempt ${run.run_attempt}`),
  );

  const check = evidence.jobs.jobs[1];
  evidence.jobs.jobs.push({ ...check, id: 103, conclusion: "failure" });
  evidence.jobs.total_count = evidence.jobs.jobs.length;

  const refused = executeStaging(ctx, evidence);
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.calls, []);
  assert.match(refused.stderr, /^Staging gate refused: Missing or ambiguous check job$/m);
});

for (const [family, archiveFlag, staticFlag, eventsFlag, homeFlag, joinFlag] of [
  ["archive", "true", "false", "false", "false", "false"],
  ["archive-static", "true", "true", "false", "false", "false"],
  ["events", "false", "false", "true", "false", "false"],
  ["home", "false", "false", "false", "true", "false"],
  ["events-join", "false", "false", "true", "false", "true"],
  ["events-home", "false", "false", "true", "true", "false"],
  ["join", "false", "false", "false", "false", "true"],
  ["ember-pages", "false", "false", "true", "true", "true"],
]) {
  test(`workflow_dispatch: ${family} passes the selected route flags to the Worker deploy`, () => {
    const result = executeStaging(context("workflow_dispatch"), fixture(), {}, family);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      ...mutationCalls.slice(0, 3),
      `wrangler deploy --config web/wrangler.staging.jsonc --tag ${sha} --var KIT_ROUTE_ARCHIVE:${archiveFlag} --var KIT_ROUTE_STATIC:${staticFlag} --var KIT_ROUTE_EVENTS:${eventsFlag} --var KIT_ROUTE_HOME:${homeFlag} --var KIT_ROUTE_JOIN:${joinFlag}`,
    ]);
  });
}
for (const eventName of ["workflow_run", "workflow_dispatch"]) {
  for (const [phase, allowedCalls] of [
    ["afterPreparation", 0],
    [mutationCalls[0], 1],
    [mutationCalls[1], 2],
    [mutationCalls[2], 3],
  ]) {
    for (const [name, mutate] of denied.filter(([name]) =>
      ["missing", "wrong SHA", "in_progress", "failure", "cancelled"].includes(name),
    )) {
      test(`${eventName}: ${name} after ${phase} stops the next mutation`, () => {
        const changed = fixture();
        mutate(changed);
        if (changed.runs.workflow_runs.length) {
          changed.runs.workflow_runs[0].run_attempt = 2;
          changed.current = structuredClone(changed.runs.workflow_runs[0]);
        }
        const result = executeStaging(context(eventName), fixture(), { [phase]: changed });
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(result.calls, mutationCalls.slice(0, allowedCalls));
        assert.match(result.stderr, /Staging gate refused:/);
      });
    }
  }
}

test("the automatic app Worker command retries one timeout after Tail and writes only fresh proof", () => {
  for (const [eventName, finalReadTimeouts, retry, output] of [
    ["workflow_run", 1, true, `sha=${sha}\nrun_id=${run.id}\nrun_attempt=${run.run_attempt}\n`],
    ["workflow_run", 2, true, ""],
    ["workflow_dispatch", 1, false, ""],
  ]) {
    const result = executeStaging(context(eventName), fixture(), {
      [mutationCalls[2]]: { ...fixture(), finalReadTimeouts },
    });
    assert.equal(result.status, output ? 0 : 1, result.stderr);
    assert.equal(result.webAdmission, output);
    assert.deepEqual(result.calls, output ? mutationCalls : mutationCalls.slice(0, 3));
    assert.equal(
      (result.stderr.match(/Rechecking exact CI evidence once\./g) ?? []).length,
      retry ? 1 : 0,
    );
    if (!output) {
      assert.match(result.stderr, /Staging gate refused: CI evidence final run read timed out/);
    }
  }
});

test("real Git accepts only the current checkout despite a container owner mismatch", () => {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "staging-gate-owner-"),
  );
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    function git(args) {
      const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    git(["init", "--quiet"]);
    git([
      "-c",
      "user.name=Offline Test",
      "-c",
      "user.email=offline@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const checkoutSha = git(["rev-parse", "HEAD"]);
    env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    const bare = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(bare.status, 128, bare.stderr);
    assert.match(bare.stderr, /dubious ownership/);
    const ctx = context("workflow_dispatch");
    ctx.sha = checkoutSha;
    const evidence = fixture();
    evidence.runs.workflow_runs[0].head_sha = checkoutSha;
    evidence.current.head_sha = checkoutSha;
    for (const job of evidence.jobs.jobs) job.head_sha = checkoutSha;
    writeFileSync(join(dir, "event.json"), JSON.stringify(ctx.event));
    writeFileSync(
      join(dir, "fetch.mjs"),
      `
      const evidence = ${JSON.stringify(evidence)};
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/workflows/ci.yml/runs")) return Response.json(evidence.runs);
        if (path.endsWith("/runs/42/jobs")) return Response.json(evidence.jobs);
        if (path.endsWith("/runs/42")) return Response.json(evidence.current);
        throw new Error("Unexpected API path");
      };
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "ci/staging-deploy-gate.mjs")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...env,
        NODE_OPTIONS: `--import=${join(dir, "fetch.mjs")}`,
        GITHUB_EVENT_NAME: ctx.eventName,
        GITHUB_EVENT_PATH: join(dir, "event.json"),
        GITHUB_OUTPUT: join(dir, "outputs.txt"),
        GITHUB_REPOSITORY: repository,
        GITHUB_REF: ctx.ref,
        GITHUB_SHA: checkoutSha,
        GITHUB_TOKEN: "offline-stub",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Staging gate passed: ${checkoutSha}`));
    assert.equal(
      readFileSync(join(dir, "outputs.txt"), "utf8"),
      `sha=${checkoutSha}\nrun_id=42\nrun_attempt=${evidence.current.run_attempt}\n`,
    );
    // Trust is command-scoped: the next bare Git call still refuses this repo.
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).status, 128);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejected completion events never enter staging job concurrency", () => {
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(
    workflow,
    /    concurrency:\n      group: deploy-staging\n      cancel-in-progress: false/,
  );
  const expression = workflow.match(/    if: >-\n((?:      .*\n)+)/)[1];
  const accepts = new Function("github", `return ${expression}`);
  const github = { event_name: "workflow_run", repository, event: context("workflow_run").event };
  assert.equal(accepts(github), true);
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    github.event.workflow_run.conclusion = conclusion;
    assert.equal(accepts(github), false);
  }
  assert.equal(accepts({ event_name: "workflow_dispatch", ref: "refs/heads/main" }), true);
  assert.equal(accepts({ event_name: "workflow_dispatch", ref: "refs/heads/topic" }), false);
});

test("trigger identity is pinned, main-only and never taken from PR or fork evidence", () => {
  assert.equal(deploymentTarget(context("workflow_run")), sha);
  assert.equal(deploymentTarget(context("workflow_dispatch")), sha);
  const ctx = context("workflow_dispatch");
  ctx.ref = "refs/heads/topic";
  assert.throws(() => deploymentTarget(ctx), /main-only/);
  for (const mutate of [
    (c) => {
      c.event.workflow_run.event = "pull_request";
    },
    (c) => {
      c.event.workflow_run.head_repository.full_name = "foreign/repo";
    },
    (c) => {
      c.event.workflow_run.conclusion = "failure";
    },
    (c) => {
      c.event.repository.full_name = "foreign/repo";
    },
    (c) => {
      c.eventName = "push";
    },
    (c) => {
      c.event.workflow_run.head_sha = "main";
    },
  ]) {
    const automatic = context("workflow_run");
    mutate(automatic);
    assert.throws(() => deploymentTarget(automatic));
  }
});

test("automatic staging refuses a different CI run ID on the final read", () => {
  const ctx = context("workflow_run");
  const evidence = fixture();
  const accepted = executeStaging(ctx, evidence);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(accepted.calls, mutationCalls);

  evidence.current.id = run.id + 1;
  const refused = executeStaging(ctx, evidence);
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.calls, []);
  assert.match(refused.stderr, /^Staging gate refused: CI changed while checking evidence$/m);
});

test("a stale automatic run ID/attempt or missing token refuses before Cloudflare", async () => {
  for (const field of ["id", "run_attempt"]) {
    const ctx = context("workflow_run");
    ctx.event.workflow_run[field]++;
    const result = executeStaging(ctx, fixture());
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  }
  await assert.rejects(
    requireSuccessfulCi(context("workflow_dispatch"), {
      fetchImpl: () => assert.fail("No request without token"),
    }),
    /Missing read-only/,
  );
});

test("a failed CI jobs HTTP read stops proof collection with a status-only diagnostic", async () => {
  const evidence = fixture();
  const jobsFailure = Response.json(
    { ...evidence.jobs, message: "Synthetic provider response detail\n".repeat(100) },
    { status: 503 },
  );
  const requests = [];
  const base = `https://api.github.com/repos/${repository}/actions`;
  const runsUrl = `${base}/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`;
  const jobsUrl = `${base}/runs/${run.id}/jobs?filter=latest&per_page=100`;

  await assert.rejects(
    requireSuccessfulCi(context("workflow_run"), {
      token: "offline-stub",
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === runsUrl) return Response.json(evidence.runs);
        if (url === jobsUrl) return jobsFailure;
        assert.fail(`Unexpected CI evidence request: ${url}`);
      },
    }),
    { name: "Error", message: "CI evidence request failed (HTTP 503)" },
  );
  assert.deepEqual(requests, [runsUrl, jobsUrl]);
  assert.equal(jobsFailure.bodyUsed, false);
});

test("the staging CI timeout retry requires a fresh exact proof and stops after one retry", async (t) => {
  let controller;
  t.mock.method(AbortSignal, "timeout", (delay) => {
    assert.equal(delay, 10_000);
    controller = new AbortController();
    return controller.signal;
  });
  const paths = {
    runs: `/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`,
    jobs: `/runs/${run.id}/jobs?filter=latest&per_page=100`,
    current: `/runs/${run.id}`,
  };
  const { runs, jobs, current } = fixture();
  const beforeFinalRead = [
    ["runs", runs],
    ["jobs", jobs],
  ];
  const fullProof = [...beforeFinalRead, ["current", current]];
  const jobsTimeout = [
    ["runs", runs],
    ["jobs", "body timeout"],
  ];
  const expectRetry = "CI evidence run jobs read timed out after 10000 ms";
  const cases = [
    {
      name: "final read timeout then exact success",
      plan: [...beforeFinalRead, ["current", "timeout"], ...fullProof],
      retry: "CI evidence final run read timed out after 10000 ms",
    },
    {
      name: "jobs body timeout then exact success",
      plan: [...jobsTimeout, ...fullProof],
      retry: expectRetry,
    },
    {
      name: "persistent timeout on the fresh final read",
      plan: [...jobsTimeout, ...beforeFinalRead, ["current", "timeout"]],
      retry: expectRetry,
      refusal: /CI evidence final run read timed out after 10000 ms/,
    },
    {
      name: "stale run attempt on the fresh list",
      plan: [...jobsTimeout, ["runs", { ...runs, workflow_runs: [{ ...run, run_attempt: 2 }] }]],
      retry: expectRetry,
      refusal: /Stale or mismatched CI trigger/,
    },
    {
      name: "ambiguous jobs on the fresh read",
      plan: [
        ...jobsTimeout,
        ["runs", runs],
        ["jobs", { total_count: 3, jobs: [...jobs.jobs, jobs.jobs[1]] }],
      ],
      retry: expectRetry,
      refusal: /Missing or ambiguous check job/,
    },
    {
      name: "replaced run on the fresh final read",
      plan: [...jobsTimeout, ...beforeFinalRead, ["current", { ...current, id: 43 }]],
      retry: expectRetry,
      refusal: /CI changed while checking evidence/,
    },
    {
      name: "provenance change on the first pass",
      plan: [...beforeFinalRead, ["current", { ...current, run_attempt: 2 }]],
      refusal: /CI changed while checking evidence/,
    },
    {
      name: "lookalike timeout from a different source",
      plan: [["runs", new DOMException("Unrelated timeout", "TimeoutError")]],
      refusal: /Unrelated timeout/,
    },
    {
      name: "oversized evidence is terminal",
      plan: [["runs", "oversized body"]],
      refusal: /GitHub metadata response exceeds the byte limit/,
    },
    {
      name: "manual staging is single-pass",
      eventName: "workflow_dispatch",
      plan: jobsTimeout,
      refusal: /CI evidence run jobs read timed out after 10000 ms/,
    },
    ...[401, 403, 429, 503].map((status) => ({
      name: `HTTP ${status} is terminal`,
      plan: [["runs", status]],
      refusal: new RegExp(`CI evidence request failed \\(HTTP ${status}\\)`),
    })),
  ];
  for (const { name, plan, retry, refusal, eventName = "workflow_run" } of cases) {
    const signals = new Set();
    const retries = [];
    let index = 0;
    const verification = requireSuccessfulCi(context(eventName), {
      token: "offline-stub",
      onTimeoutRetry: (message) => retries.push(message),
      fetchImpl: async (url, { signal }) => {
        assert.ok(index < plan.length, `${name}: unexpected GET`);
        const [read, result] = plan[index++];
        assert.equal(url, `https://api.github.com/repos/${repository}/actions${paths[read]}`);
        assert.equal(signal, controller.signal);
        assert.equal(signal.aborted, false);
        signals.add(signal);
        const timeOut = () => {
          controller.abort(new DOMException("Fixture deadline expired", "TimeoutError"));
          signal.throwIfAborted();
        };
        if (result === "timeout") timeOut();
        if (result instanceof Error) throw result;
        if (typeof result === "number") {
          return {
            ok: false,
            status: result,
            get body() {
              assert.fail("HTTP error body was read");
            },
          };
        }
        if (result === "body timeout") {
          return new Response(new ReadableStream({ pull: timeOut }, { highWaterMark: 0 }));
        }
        if (result === "oversized body") {
          return new Response(new Uint8Array(1024 * 1024 + 1));
        }
        return Response.json(result);
      },
    });
    if (refusal) {
      await assert.rejects(verification, refusal, name);
    } else {
      assert.deepEqual(
        await verification,
        { sha, runId: run.id, runAttempt: run.run_attempt },
        name,
      );
    }
    assert.equal(index, plan.length, name);
    assert.equal(signals.size, plan.length, name);
    assert.deepEqual(retries, retry ? [retry] : [], name);
  }
});

test("workflow wires the tested gate before both mutations and preserves staging isolation", () => {
  assert.match(
    workflow,
    /workflow_run:\n    workflows: \[ci\]\n    types: \[completed\]\n    branches: \[main\]/,
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /kit_route_family:\n        description: Kit staging route family; the default keeps all routes on Hono\n        type: choice\n        required: true\n        default: hono\n        options:\n          - hono\n          - archive\n          - archive-static\n          - events\n          - home\n          - events-join\n          - events-home\n          - join\n          - ember-pages\n/,
  );
  assert.match(
    workflow,
    /KIT_ROUTE_FAMILY: \$\{\{ inputs\.kit_route_family \}\}\n          KIT_STAGING_ROUTE_FAMILY: \$\{\{ github\.event_name == 'workflow_run' && vars\.KIT_STAGING_ROUTE_FAMILY \|\| '' \}\}/,
  );
  assert.match(workflow, /run: node --import tsx ci\/kit-route-flags\.mjs/);
  assert.match(workflow, /run: npm run build --prefix web/);
  assert.match(workerDeployCommand, /--config web\/wrangler\.staging\.jsonc/);
  assert.match(
    workerDeployCommand,
    /--var "KIT_ROUTE_ARCHIVE:\$KIT_ROUTE_ARCHIVE" --var "KIT_ROUTE_STATIC:\$KIT_ROUTE_STATIC" --var "KIT_ROUTE_EVENTS:\$KIT_ROUTE_EVENTS" --var "KIT_ROUTE_HOME:\$KIT_ROUTE_HOME" --var "KIT_ROUTE_JOIN:\$KIT_ROUTE_JOIN"/,
  );
  assert.doesNotMatch(workerDeployCommand, /\$\{\{/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(
    workflow,
    /ref: \$\{\{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha \|\| github.sha \}\}/,
  );
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github.event.workflow_run.event == 'push'/);
  assert.match(
    workflow,
    /github.event.workflow_run.head_repository.full_name == github.repository/,
  );
  assert.match(workflow, /github.event.workflow_run.conclusion == 'success'/);
  assert.match(workflow, /contents: read\n  actions: read/);
  assert.equal((workflow.match(/^    runs-on: ubuntu-latest$/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^    runs-on:/gm) ?? []).length, 1);
  // Digest-pinned, never the bare mutable tag: the named tag stays readable
  // and any refreshed sha256 passes, but dropping the pin fails here.
  assert.match(workflow, /container:\n(?:.*\n)*?      image: node:24-bookworm@sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(workflow, /image: node:24-bookworm\n/);
  assert.match(
    workflow,
    /environment:\n      name: staging\n      url: https:\/\/next.togetherweown.com/,
  );
  assert.match(workflow, /name: Smoke test staging/);
  assert.equal(gateCommand, "node ci/staging-deploy-gate.mjs");
  const gateOffset = workflow.indexOf("- name: Require successful exact-SHA full CI");
  assert.ok(gateOffset < workflow.indexOf("- name: Ensure queues exist"));
  assert.ok(gateOffset < workflow.indexOf("- name: Deploy to Cloudflare Workers"));
  assert.equal(deployGateCommand, "node ci/staging-deploy-gate.mjs --retry-ci-timeout");
  assert.equal(workflow.match(/--retry-ci-timeout\b/g)?.length, 1);
  assert.match(
    workflow,
    /- name: Re-verify exact-SHA full CI before Worker deploy\n(?:(?!      - ).*\n)*      - name: Deploy to Cloudflare Workers\n/,
    "Deploy gate must be the step immediately before the deploy",
  );
  assert.equal(
    step("Re-verify exact-SHA full CI before Tail Worker deploy"),
    "node ci/staging-deploy-gate.mjs",
  );
  assert.match(
    workflow,
    /- name: Re-verify exact-SHA full CI before Tail Worker deploy\n(?:(?!      - ).*\n)*      - name: Deploy alert Tail Worker before attaching the app\n(?:(?!      - ).*\n)*      - name: Re-verify exact-SHA full CI before Worker deploy\n/,
    "Tail gate must be the step immediately before the Tail deploy, which precedes the app deploy gate",
  );
  assert.match(
    workflow,
    /- name: Re-verify exact-SHA full CI before detaching web consumers\n(?:(?!      - ).*\n)*      - name: Detach staging web queue consumers \(idempotent\)\n/,
    "Detach gate must be the step immediately before the detach",
  );
  assert.match(
    step("Detach staging web queue consumers (idempotent)"),
    /out=\$\(npx wrangler queues consumer list "\$q"\) \|\| exit 1/,
    "Detach must capture the consumer list so a failed list fails instead of reading as no consumer",
  );
  assert.doesNotMatch(
    step("Detach staging web queue consumers (idempotent)"),
    /consumer list "\$q" \|/,
    "Detach must not pipe a possibly-failed list into grep: capture first with || exit 1",
  );
  assert.match(
    step("Detach staging web queue consumers (idempotent)"),
    /queues consumer remove "\$q" two-web-next/,
    "Detach must remove the web Worker consumer explicitly: a consumer-free deploy never detaches it",
  );
  assert.ok(
    workflow.includes("two-sync-event") && workflow.includes("two-internal-action"),
    "Detach must cover both staging queues",
  );
  assert.ok(
    workflow.indexOf("- name: Detach staging web queue consumers (idempotent)") <
      workflow.indexOf("- name: Re-verify exact-SHA full CI before jobs Worker deploy"),
    "Detach must precede the jobs gate so the attach cannot collide",
  );
  assert.ok(
    workflow.indexOf("run: node ci/check-jobs-secrets.mjs") <
      workflow.indexOf("- name: Ensure queues exist"),
    "Jobs-secrets preflight must run before the first Cloudflare mutation so a missing BOT_* secret fails before any web deploy or detach",
  );
  assert.ok(
    workflow.indexOf("run: node ci/check-jobs-secrets.mjs") <
      workflow.indexOf("- name: Re-verify exact-SHA full CI before jobs Worker deploy"),
    "Jobs-secrets preflight must run before the jobs gate so a missing BOT_* secret fails before any attach",
  );
  assert.match(
    workflow,
    /- name: Re-verify exact-SHA full CI before jobs Worker deploy\n(?:(?!      - ).*\n)*      - name: Deploy staging jobs Worker \(queues \+ cron owner\)\n/,
    "Jobs Worker gate must immediately precede its deploy",
  );
  assert.equal(
    (workflow.match(/npx wrangler/g) ?? []).length,
    6,
    "Every Cloudflare mutation is explicitly accounted for: queues create, Tail deploy, web deploy, detach list, detach remove, jobs deploy",
  );
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /run: node --test ci\/staging-deploy-gate-selftest.mjs/);
});

test("different main push SHAs cannot replace each other in the single pending queue", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const block = ci.match(/^concurrency:\n  group: (.+)\n  cancel-in-progress: \$\{\{ (.+) \}\}\n/m);
  assert(
    block,
    "ci.yml concurrency must isolate main pushes and exempt them from cancel-in-progress",
  );
  // GitHub expression dereference is null-safe (missing pull_request reads as
  // null); emulate that with optional chaining so main-push contexts evaluate.
  const nullSafe = (expr) =>
    expr.replaceAll("github.event.pull_request.number", "github.event.pull_request?.number");
  const groupOf = new Function(
    "github",
    `return \`${nullSafe(block[1]).replaceAll("${{ ", "${").replaceAll(" }}", "}")}\`;`,
  );
  const cancelsOf = new Function("github", `return (${nullSafe(block[2])});`);
  const context = (event_name, sha, ref = "refs/heads/main", event = {}) => ({
    workflow: "ci",
    event,
    event_name,
    ref,
    sha,
  });
  const pr = (number, sha) =>
    context("pull_request", sha, `refs/pull/${number}/merge`, { pull_request: { number } });
  const mainPush = context("push", sha);
  const manualRef = "refs/heads/check-ci";
  const mergeRef = "refs/heads/gh-readonly-queue/main/pr-7";
  const stateOf = (github) => [groupOf(github), cancelsOf(github)];

  assert.deepEqual(stateOf(mainPush), [`ci-${sha}`, false]);
  assert.deepEqual(stateOf({ ...mainPush, run_id: 42, run_attempt: 2 }), [`ci-${sha}`, false]);
  assert.deepEqual(stateOf(context("push", otherSha)), [`ci-${otherSha}`, false]);

  assert.deepEqual(stateOf(context("schedule", sha)), ["ci-nightly", false]);
  assert.deepEqual(stateOf(context("workflow_dispatch", sha)), ["ci-refs/heads/main", false]);
  assert.deepEqual(stateOf(context("workflow_dispatch", sha, manualRef)), [
    `ci-${manualRef}`,
    true,
  ]);
  assert.deepEqual(stateOf(context("push", sha, manualRef)), [`ci-${manualRef}`, true]);
  assert.deepEqual(stateOf(context("merge_group", sha, mergeRef)), [`ci-${mergeRef}`, false]);

  assert.deepEqual(stateOf(pr(7, sha)), ["ci-7", true]);
  assert.deepEqual(stateOf(pr(7, otherSha)), ["ci-7", true]);
  assert.deepEqual(stateOf(pr(8, sha)), ["ci-8", true]);
});

test("staging guard runs from the workflow revision inside the existing lane before writes", () => {
  assert.equal(step("Require a forward staging rollout"), "node ci/staging-forward.mjs");
  assert.match(
    workflow,
    /ref: \$\{\{ github\.workflow_sha \}\}[\s\S]*?- name: Staging admission hold[\s\S]*?- name: Require a forward staging rollout[\s\S]*?CANDIDATE_SHA: (\$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\})[\s\S]*?ref: \1/,
  );
});

const activeVersion = "12345678-1234-1234-1234-123456789abc";
const stagingGuardEnv = {
  CANDIDATE_SHA: sha,
  GITHUB_REPOSITORY: repository,
  GITHUB_TOKEN: "fake-github",
  CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
  CLOUDFLARE_API_TOKEN: "fake-cloudflare",
};
const forward = {
  status: "ahead",
  ahead_by: 2,
  total_commits: 2,
  behind_by: 0,
  base_commit: { sha: otherSha },
  merge_base_commit: { sha: otherSha },
};
const stagedDeployment = {
  created_on: "2026-11-25T07:00:00+01:00",
  versions: [{ version_id: activeVersion, percentage: 100 }],
};
function stagingReads({
  live = otherSha,
  served = activeVersion,
  compare = forward,
  deployments = [stagedDeployment],
  deploymentResponse,
  compareResponse,
} = {}) {
  return async (url, options) => {
    switch (String(url)) {
      case `https://api.cloudflare.com/client/v4/accounts/${stagingGuardEnv.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/two-web-next/deployments`:
        assert.equal(options.headers.Authorization, "Bearer fake-cloudflare");
        return deploymentResponse ?? Response.json({ success: true, result: { deployments } });
      case "https://next.togetherweown.com/up":
        assert.equal(Object.hasOwn(options.headers, "Authorization"), false);
        return Response.json({ revision: { version_id: served, commit: live } });
      case `https://api.github.com/repos/${repository}/compare/${otherSha}...${sha}?per_page=1`:
        assert.equal(options.headers.Authorization, "Bearer fake-github");
        assert.notEqual(compare, null, "Equal SHA or a mismatched version must avoid comparing");
        return compareResponse ?? Response.json(compare);
      default:
        assert.fail(`Unexpected request ${url}`);
    }
  };
}

function stagingProviderStream(chunks, { abandon = false, cancel } = {}) {
  let index = 0;
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else if (!abandon) controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
}

const rolloutProviderCases = [
  {
    field: "deploymentResponse",
    source: "Cloudflare deployment state",
    limit: 1024 * 1024,
    valid: { success: true, result: { deployments: [stagedDeployment] } },
  },
  {
    field: "compareResponse",
    source: "GitHub commit ancestry",
    limit: 8 * 1024 * 1024,
    valid: forward,
  },
];

test("staging bounds chunked provider replies and cancels unfinished bodies", {
  timeout: 2_000,
}, async (t) => {
  for (const { field, source, limit, valid } of rolloutProviderCases) {
    await t.test(source, async () => {
      const admit = (response) =>
        requireForwardStaging(stagingGuardEnv, stagingReads({ [field]: response }));
      const error = { message: `Cannot read ${source} for staging rollout` };
      const prefix = Buffer.from(JSON.stringify(valid));
      const remainder = Buffer.alloc(limit - prefix.byteLength, 0x20);
      const atLimit = stagingProviderStream([prefix, remainder]);
      assert.equal(await admit(atLimit), otherSha);

      const oversized = stagingProviderStream([prefix, remainder, Buffer.from(" ")]);
      await assert.rejects(admit(oversized), error);

      let cancelled = false;
      const abandoned = stagingProviderStream([prefix, remainder, Buffer.from(" ")], {
        abandon: true,
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      });
      await assert.rejects(admit(abandoned), error);
      assert.equal(cancelled, true);
      assert.equal(abandoned.body.locked, false);
    });
  }
});

test("staging sanitizes abandoned and malformed provider replies", {
  timeout: 2_000,
}, async (t) => {
  for (const { field, source, valid } of rolloutProviderCases) {
    await t.test(source, async (t) => {
      const admit = (response) =>
        requireForwardStaging(stagingGuardEnv, stagingReads({ [field]: response }));
      const reason = (error) => {
        assert.equal(error.message, `Cannot read ${source} for staging rollout`);
        assert.equal(error.cause, undefined);
        return true;
      };
      await assert.rejects(admit(new Response(null)), reason);
      await assert.rejects(admit(stagingProviderStream([])), reason);
      await assert.rejects(admit(new Response("provider-private invalid JSON")), reason);

      const deadline = new AbortController();
      t.mock.method(AbortSignal, "timeout", () => deadline.signal);
      let cancelled = false;
      const response = new Response(
        new ReadableStream(
          {
            start(controller) {
              controller.enqueue(Buffer.from(JSON.stringify(valid)));
            },
            pull(controller) {
              deadline.abort(new Error("provider-private timeout"));
              // Simulate EOF arriving after the deadline if the reader leaves the stream open.
              queueMicrotask(() => {
                if (!cancelled) controller.close();
              });
            },
            cancel() {
              cancelled = true;
              return Promise.reject(new Error("provider-private cancellation"));
            },
          },
          { highWaterMark: 0 },
        ),
      );
      await assert.rejects(admit(response), reason);
      assert.equal(cancelled, true);
      assert.equal(response.body.locked, false);
    });
  }
});

test("staging admits the same SHA or a forward candidate independent of the main tip", async () => {
  const deployments = Array.from({ length: 99 }, (_, index) => ({
    created_on: new Date(Date.UTC(2026, 10, 24, 0, index)).toISOString(),
    versions: [
      { version_id: activeVersion, percentage: 50 },
      { version_id: "23456789-2345-2345-2345-23456789abcd", percentage: 50 },
    ],
    annotations: { "workers/message": "é".repeat(500) },
  }));
  const addedLine = `+${"x".repeat(170)}${"\\".repeat(22)}\n`;
  const compare = {
    ...forward,
    commits: [{ sha: "d".repeat(40) }],
    files: Array.from({ length: 300 }, (_, index) => ({
      filename: `synthetic-${index}.txt`,
      patch: `@@ -0,0 +1,100 @@\n${addedLine.repeat(100)}`,
    })),
  };
  assert.equal(
    await requireForwardStaging(
      stagingGuardEnv,
      stagingReads({ deployments: [...deployments, stagedDeployment], compare }),
    ),
    otherSha,
  );
  assert.equal(
    await requireForwardStaging(stagingGuardEnv, stagingReads({ live: sha, compare: null })),
    sha,
  );
});

test("staging refuses an older or divergent candidate and a lagging edge", async () => {
  for (const compare of [
    { ...forward, status: "behind", ahead_by: 0, behind_by: 2, merge_base_commit: { sha } },
    { ...forward, status: "diverged", behind_by: 2 },
    { ...forward, merge_base_commit: { sha } },
  ]) {
    await assert.rejects(
      requireForwardStaging(stagingGuardEnv, stagingReads({ compare })),
      /not a verified descendant/,
    );
  }
  await assert.rejects(
    requireForwardStaging(stagingGuardEnv, stagingReads({ served: null, compare: null })),
    /does not identify the active Cloudflare version/,
  );
});

test("staging refuses a newer split deployment and ambiguous or malformed timestamps", async () => {
  await assert.rejects(
    requireForwardStaging(stagingGuardEnv, stagingReads({ deployments: [], compare: null })),
    /Missing active staging deployment/,
  );
  const split = {
    created_on: "2026-11-25T01:00:00.000001-05:00",
    versions: [{ version_id: activeVersion, percentage: 40 }],
  };
  for (const [entry, reason] of [
    [split, /not a single-version 100% deployment/],
    [{ ...split, created_on: "2026-11-25T06:00:00.0Z" }, /Cannot determine the newest/],
    [{ ...split, created_on: "2026-02-30T06:00:00Z" }, /Invalid staging deployment timestamp/],
    [{ ...split, created_on: undefined }, /Invalid staging deployment timestamp/],
  ]) {
    await assert.rejects(
      requireForwardStaging(
        stagingGuardEnv,
        stagingReads({ deployments: [stagedDeployment, entry] }),
      ),
      reason,
    );
  }
});

function recordStagingReads(calls, overrides) {
  const read = stagingReads();
  return async (url, options) => {
    const host = new URL(url).hostname;
    calls.push(host);
    const response = await read(url, options);
    return overrides[host] ?? response;
  };
}

test("staging stops before reading the edge when Cloudflare deployment evidence is unavailable or incomplete", async () => {
  const deployment = { success: true, result: { deployments: [stagedDeployment] } };
  for (const [name, response, message] of [
    [
      "HTTP failure with a valid envelope",
      Response.json(deployment, { status: 503 }),
      "Cannot read Cloudflare deployment state for staging rollout",
    ],
    [
      "unsuccessful envelope with deployment data",
      Response.json({ ...deployment, success: false }),
      "Missing active staging deployment",
    ],
    [
      "successful envelope without deployments",
      Response.json({ success: true, result: {} }),
      "Missing active staging deployment",
    ],
  ]) {
    const calls = [];
    const read = recordStagingReads(calls, { "api.cloudflare.com": response });
    await assert.rejects(requireForwardStaging(stagingGuardEnv, read), { message }, name);
    assert.deepEqual(calls, ["api.cloudflare.com"], name);
  }
});

test("staging refuses incomplete or inconsistent ahead evidence from GitHub", async () => {
  for (const [name, changes] of [
    ["missing base commit", { base_commit: undefined }],
    ["missing behind count", { behind_by: undefined }],
    ["missing total count", { total_commits: undefined }],
    ["positive behind count", { behind_by: 1 }],
    ["zero ahead count", { ahead_by: 0, total_commits: 0 }],
    ["non-integer ahead count", { ahead_by: 1.5, total_commits: 1.5 }],
    ["mismatched total count", { total_commits: 3 }],
  ]) {
    const calls = [];
    const response = Response.json({ ...forward, ...changes });
    const read = recordStagingReads(calls, { "api.github.com": response });
    await assert.rejects(
      requireForwardStaging(stagingGuardEnv, read),
      { message: `Staging rollout refused: ${sha} is not a verified descendant of ${otherSha}` },
      name,
    );
    assert.deepEqual(
      calls,
      ["api.cloudflare.com", "next.togetherweown.com", "api.github.com"],
      name,
    );
  }
});
