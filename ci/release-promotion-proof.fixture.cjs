"use strict";

// Test-only provider boundary. Every gh request is answered from disk; unknown
// commands fail rather than reaching GitHub. The real request builder and local
// git history remain under test. Run/attempt hints select evidence, never authorize it.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = "o/r";
const RUN = 700;
const ATTEMPT = 2;
const VERSION = "12345678-1234-4234-8234-123456789abc";
const DIGEST = `sha256:${"4".repeat(64)}`;
const artifactName = (sha) => `production-promotion-${sha}-${RUN}-${ATTEMPT}`;
const SCRIPT = path.resolve(
  process.env.RELEASE_REQUEST || path.join(__dirname, "release-request.cjs"),
);

function fakeGh() {
  const root = process.env.PROOF_FIXTURE;
  const argv = process.argv.slice(3);
  fs.appendFileSync(path.join(root, "calls.jsonl"), `${JSON.stringify(argv)}\n`);
  const statePath = path.join(root, "provider.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const fail = (message, status = 1) => {
    process.stderr.write(`${message}\n`);
    process.exit(status);
  };
  const json = (value) => {
    process.stdout.write(JSON.stringify(value));
    process.exit(0);
  };
  const receipt = () => {
    if (state.proofError === "download") fail("gh: Service Unavailable (HTTP 503)");
    return state.receiptText ?? JSON.stringify(state.receipt);
  };
  if (argv[0] === "api") {
    const endpoint = argv.find((arg) => arg.startsWith("repos/") || arg.startsWith("/repos/"));
    if (!endpoint) fail("fixture: missing API endpoint", 2);
    const url = new URL(endpoint.replace(/^\//, ""), "https://fixture.invalid/");
    const route = url.pathname.slice(1);
    // Evidence lookups are read-only, even though gh -f normally implies POST.
    const fields = argv.flatMap((arg, i) =>
      ["-f", "-F", "--field", "--raw-field"].includes(arg) ? [argv[i + 1]] : [],
    );
    const method =
      argv.indexOf("--method") >= 0
        ? argv[argv.indexOf("--method") + 1]
        : argv.indexOf("-X") >= 0
          ? argv[argv.indexOf("-X") + 1]
          : fields.length
            ? "POST"
            : "GET";
    if (method !== "GET") fail("fixture: mutating API request forbidden", 2);
    for (const field of fields) {
      const equals = field.indexOf("=");
      url.searchParams.set(field.slice(0, equals), field.slice(equals + 1));
    }
    if (!route.startsWith(`repos/${REPO}/actions/`))
      fail(`fixture: unexpected API route ${route}`, 2);
    if (state.proofError === "unavailable") fail("gh: Service Unavailable (HTTP 503)");
    if (state.proofError === "forbidden")
      fail("gh: Resource not accessible by integration (HTTP 403)");
    if (state.proofError === "malformed-api") {
      process.stdout.write("{not-json");
      process.exit(0);
    }
    if (/\/actions\/(?:workflows\/[^/]+\/)?runs$/.test(route)) {
      const runs = state.runs.filter((run) =>
        [...url.searchParams].every(([key, value]) => {
          if (key === "head_sha") return run.head_sha === value;
          if (key === "branch") return run.head_branch === value;
          if (key === "event") return run.event === value;
          if (key === "status") return run.status === value || run.conclusion === value;
          return true;
        }),
      );
      json({ total_count: runs.length, workflow_runs: runs });
    }
    if (
      route === `repos/${REPO}/actions/workflows/deploy-production.yml` ||
      route === `repos/${REPO}/actions/workflows/17`
    ) {
      json({
        id: 17,
        name: "deploy-production",
        path: ".github/workflows/deploy-production.yml",
        state: "active",
      });
    }
    if (
      route === `repos/${REPO}/actions/runs/${RUN}` ||
      route === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`
    ) {
      if (!state.runs.length) fail("gh: Not Found (HTTP 404)");
      json(state.runs[0]);
    }
    if (
      route === `repos/${REPO}/actions/runs/${RUN}/jobs` ||
      route === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs`
    ) {
      json({ total_count: state.jobs.length, jobs: state.jobs });
    }
    if (
      route === `repos/${REPO}/actions/runs/${RUN}/artifacts` ||
      route === `repos/${REPO}/actions/artifacts`
    ) {
      const artifacts = state.artifacts.filter(
        (artifact) =>
          !url.searchParams.has("name") || artifact.name === url.searchParams.get("name"),
      );
      json({ total_count: artifacts.length, artifacts });
    }
    if (route === `repos/${REPO}/actions/artifacts/800`) json(state.artifacts[0]);
    if (route === `repos/${REPO}/actions/artifacts/800/zip`) {
      // A real ZIP with a single JSON member, not arbitrary JSON masquerading as
      // the GitHub download response. Python's standard library needs no tools.
      const encoded = Buffer.from(receipt()).toString("base64");
      const zip = spawnSync("python3", [
        "-c",
        "import base64,io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('promotion.json',base64.b64decode(sys.argv[1])); z.close(); sys.stdout.buffer.write(b.getvalue())",
        encoded,
      ]);
      if (zip.status !== 0) fail(String(zip.stderr), 2);
      process.stdout.write(zip.stdout);
      process.exit(0);
    }
    fail(`fixture: unexpected API route ${route}`, 2);
  }
  fail(`fixture: unexpected gh command ${JSON.stringify(argv)}`, 2);
}

function fixture(t) {
  const parent =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "release-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("commit", "-q", "--allow-empty", "-m", "chore: release baseline");
  git("tag", "v0.8.0");
  const commit = (subject) => {
    git("commit", "-q", "--allow-empty", "-m", subject);
    const sha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  const historical = commit("feat: historical release");
  git("tag", "v0.9.0");
  commit("feat: newest tagged release");
  git("tag", "v0.10.0");
  const sha = commit("fix: promoted candidate");
  const run = {
    id: RUN,
    run_attempt: ATTEMPT,
    workflow_id: 17,
    name: "deploy-production",
    path: ".github/workflows/deploy-production.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "failure",
    repository: { id: 100, full_name: REPO },
    head_repository: { id: 100, full_name: REPO },
    html_url: `https://github.com/${REPO}/actions/runs/${RUN}`,
  };
  const success = (name, number) => ({ name, number, status: "completed", conclusion: "success" });
  const state = {
    runs: [run],
    jobs: [
      {
        id: 701,
        run_id: RUN,
        run_attempt: ATTEMPT,
        name: "deploy-production",
        status: "completed",
        conclusion: "success",
        steps: [
          success("Gradual promotion 5-50-100 with automatic rollback", 7),
          success("Verify public routes on the promoted version", 8),
          success("Record successful production promotion", 9),
          success("Upload production promotion proof", 10),
        ],
      },
      {
        id: 702,
        run_id: RUN,
        run_attempt: ATTEMPT,
        name: "release / tag-release",
        status: "completed",
        conclusion: "failure",
        steps: [],
      },
    ],
    artifacts: [
      {
        id: 800,
        name: artifactName(sha),
        digest: DIGEST,
        expired: false,
        size_in_bytes: 512,
        workflow_run: {
          id: RUN,
          repository_id: 100,
          head_repository_id: 100,
          head_branch: "main",
          head_sha: sha,
        },
      },
    ],
    receipt: {
      schema: 1,
      repository: REPO,
      workflow: ".github/workflows/deploy-production.yml",
      job: "deploy-production",
      sha,
      promoted_version_id: VERSION,
      run_id: String(RUN),
      run_attempt: String(ATTEMPT),
    },
  };
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${__filename}" --fake-gh "$@"\n`,
    { mode: 0o755 },
  );
  for (const command of ["curl", "wget", "wrangler", "npx", "npm"]) {
    fs.writeFileSync(
      path.join(bin, command),
      '#!/bin/sh\nprintf "%s\\n" "acceptance forbids network or deploy commands" >&2\nexit 2\n',
      { mode: 0o755 },
    );
  }
  const callsFile = path.join(root, "calls.jsonl");
  const provider = path.join(root, "provider.json");
  // No inherited tokens, database URLs or provider configuration. The publisher
  // can only read fixtures. Native network attempts are errors, not real probes.
  const guard = path.join(root, "no-network.cjs");
  fs.writeFileSync(
    guard,
    'const deny=()=>{throw new Error("acceptance forbids network")}; globalThis.fetch=deny; for(const m of ["http","https"]){const a=require("node:"+m);a.request=deny;a.get=deny;} require("node:net").Socket.prototype.connect=deny;',
  );
  const environment = ({ workflowCall = false, hints = true, extraEnv = {} } = {}) => ({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: root,
    TMPDIR: root,
    NODE_OPTIONS: `--require=${guard}`,
    PROOF_FIXTURE: root,
    GH_REPO: REPO,
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_ID: "100",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: workflowCall ? "workflow_run" : "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/${workflowCall ? "deploy-production" : "release"}.yml@refs/heads/main`,
    GITHUB_RUN_ID: workflowCall ? String(RUN) : "900",
    GITHUB_RUN_ATTEMPT: workflowCall ? String(ATTEMPT) : "1",
    GITHUB_SHA: sha,
    GITHUB_REF: "refs/heads/main",
    RELEASE_SHA: sha,
    GITHUB_OUTPUT: path.join(root, "output"),
    RUNNER_TEMP: root,
    ...(hints ? { PROMOTION_RUN_ID: String(RUN), PROMOTION_RUN_ATTEMPT: String(ATTEMPT) } : {}),
    ...extraEnv,
  });
  const runPublisher = (options = {}) => {
    if (options.save !== false) fs.writeFileSync(provider, JSON.stringify(state));
    fs.writeFileSync(callsFile, "");
    const output = path.join(root, "output");
    fs.writeFileSync(output, "");
    const result = spawnSync(process.execPath, ["--require", guard, SCRIPT], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: environment(options),
    });
    const calls = fs
      .readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const text = fs.readFileSync(output, "utf8");
    const line = /^request=(.*)$/m.exec(text);
    return { ...result, calls, output: text, request: line ? JSON.parse(line[1]) : null };
  };
  return { root, git, sha, historical, state, run: runPublisher, commit, environment };
}

if (process.argv[2] === "--fake-gh") fakeGh();
module.exports = { fixture, REPO, RUN, ATTEMPT, VERSION, DIGEST, artifactName };
