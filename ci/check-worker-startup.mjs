#!/usr/bin/env node
// Local V8 sampling diagnostic, NOT Cloudflare startup_time_ms or startup CPU.
// Exit 0: local pass/warning; 1: local breach; 2: unavailable/invalid evidence.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { runnerIdentity } from "./worker-startup-runner.mjs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const METRIC = "local_startup_non_idle_sample_ms";
export const LIMITS = Object.freeze({
  profileBytes: 8 * 1024 * 1024,
  nodes: 50000,
  samples: 100000,
  windowUs: 15000000,
});
const CONFIG = "web/wrangler.staging.jsonc";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function keys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...expected].sort())
  );
}
export function validateBudget(budget) {
  requireValue(
    keys(budget, ["version", "metric", "runs", "warnMs", "failMs", "tools"]) &&
      budget.version === 1 &&
      budget.metric === METRIC &&
      budget.runs === 3 &&
      budget.warnMs === 400 &&
      budget.failMs === 700 &&
      keys(budget.tools, ["wrangler", "miniflare", "workerd"]) &&
      Object.values(budget.tools).every((v) => typeof v === "string" && /^[\w.+-]{1,64}$/.test(v)),
    "Invalid local startup budget",
  );
  return budget;
}
function sampleValue(value) {
  let rendered;
  try {
    rendered = typeof value === "number" ? String(value) : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return (rendered ?? String(value)).slice(0, 64);
}
export function summarizeProfile(profile) {
  requireValue(
    profile &&
      Array.isArray(profile.nodes) &&
      profile.nodes.length > 0 &&
      profile.nodes.length <= LIMITS.nodes &&
      Array.isArray(profile.samples) &&
      profile.samples.length > 0 &&
      profile.samples.length <= LIMITS.samples &&
      Array.isArray(profile.timeDeltas) &&
      profile.timeDeltas.length === profile.samples.length &&
      finite(profile.startTime) &&
      finite(profile.endTime) &&
      profile.endTime > profile.startTime &&
      profile.endTime - profile.startTime <= LIMITS.windowUs,
    "Invalid or incomplete CPU profile",
  );
  const nodes = new Map();
  for (const node of profile.nodes) {
    requireValue(
      node &&
        Number.isSafeInteger(node.id) &&
        node.id > 0 &&
        !nodes.has(node.id) &&
        node.callFrame &&
        typeof node.callFrame.functionName === "string" &&
        node.callFrame.functionName.length <= 4096,
      "Invalid CPU profile node",
    );
    nodes.set(node.id, node);
  }
  for (const node of nodes.values()) {
    requireValue(
      node.children === undefined ||
        (Array.isArray(node.children) &&
          node.children.length <= LIMITS.nodes &&
          node.children.every((id) => nodes.has(id))),
      "Unknown CPU profile child node",
    );
  }
  let sampledUs = 0;
  let reversals = 0;
  let maxReversalUs = 0;
  let previousTimestamp = profile.startTime;
  const maxReversals = Math.min(3, Math.floor(0.02 * profile.samples.length));
  const samples = [];
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const delta = profile.timeDeltas[i];
    if (!Number.isSafeInteger(id))
      throw new Error(
        `Invalid CPU profile sample: non-integer node id at sample ${i} (${sampleValue(id)})`,
      );
    if (!nodes.has(id))
      throw new Error(`Invalid CPU profile sample: unknown node ${id} at sample ${i}`);
    if (typeof delta !== "number" || !Number.isFinite(delta))
      throw new Error(
        `Invalid CPU profile sample: non-finite timeDelta at sample ${i} (${sampleValue(delta)})`,
      );
    sampledUs += delta;
    const timestamp = profile.startTime + sampledUs;
    if (timestamp < profile.startTime || timestamp > profile.endTime)
      throw new Error(
        `Invalid CPU profile sample: timestamp outside profile window at sample ${i}`,
      );
    if (timestamp < previousTimestamp) {
      const reversalUs = previousTimestamp - timestamp;
      if (reversalUs > 1000)
        throw new Error(
          `Invalid CPU profile sample: reversal ${reversalUs} us exceeds 1000 us at sample ${i}`,
        );
      reversals++;
      maxReversalUs = Math.max(maxReversalUs, reversalUs);
      if (reversals > maxReversals)
        throw new Error(
          `Invalid CPU profile sample: reversal count ${reversals} exceeds ${maxReversals} at sample ${i}`,
        );
    }
    samples.push({ timestamp, id, sampleIndex: i });
    previousTimestamp = timestamp;
  }
  // V8 drains samples by code-event id, not timestamp. Preserve ties' original order.
  samples.sort((a, b) => a.timestamp - b.timestamp || a.sampleIndex - b.sampleIndex);
  let idleUs = 0;
  let gcUs = 0;
  previousTimestamp = profile.startTime;
  for (const sample of samples) {
    const delta = sample.timestamp - previousTimestamp;
    const node = nodes.get(sample.id);
    if (node.callFrame.functionName === "(idle)") idleUs += delta;
    if (node.callFrame.functionName === "(garbage collector)") gcUs += delta;
    previousTimestamp = sample.timestamp;
  }
  const windowUs = profile.endTime - profile.startTime;
  requireValue(
    finite(sampledUs) && sampledUs > 0 && sampledUs <= windowUs + 1000 && sampledUs > idleUs,
    "Incomplete CPU profile timing",
  );
  return {
    [METRIC]: (sampledUs - idleUs) / 1000,
    sampledMs: sampledUs / 1000,
    idleMs: idleUs / 1000,
    gcMs: gcUs / 1000,
    windowMs: windowUs / 1000,
    // Sampling may leave a valid unsampled tail; retain it, do not call it CPU.
    unsampledMs: Math.max(0, windowUs - sampledUs) / 1000,
    samples: profile.samples.length,
    reversals,
    maxReversalUs,
  };
}
function readBounded(file, max) {
  const stat = lstatSync(file);
  requireValue(
    stat.isFile() && stat.size > 0 && stat.size <= max,
    "Missing, empty or oversized startup evidence",
  );
  return readFileSync(file);
}
export function validateEvidence(evidence, expected, profiles, budget) {
  validateBudget(budget);
  requireValue(
    keys(evidence, [
      "version",
      "metric",
      "authoritativeStartup",
      "productionMargin",
      "identity",
      "runs",
      "maximumMs",
      "status",
    ]) &&
      evidence.version === 1 &&
      evidence.metric === METRIC &&
      evidence.authoritativeStartup === "unavailable" &&
      evidence.productionMargin === "unmet" &&
      equal(evidence.identity, expected),
    "Wrong build/tool/runner identity",
  );
  requireValue(
    Array.isArray(evidence.runs) && evidence.runs.length === 3 && profiles.length === 3,
    "Exactly three cold profiles required",
  );
  const ids = new Set();
  const values = evidence.runs.map((run, i) => {
    requireValue(
      keys(run, [
        "invocation",
        "completed",
        "uploadSha256",
        "profile",
        "profileSha256",
        "measurement",
      ]) &&
        run.invocation === i + 1 &&
        !ids.has(run.invocation) &&
        run.completed === true &&
        run.uploadSha256 === expected.uploadSha256 &&
        run.profile === `cold-${i + 1}.cpuprofile` &&
        run.profileSha256 === sha256(profiles[i]),
      "Incomplete or mismatched cold invocation",
    );
    ids.add(run.invocation);
    requireValue(
      profiles[i].length > 0 && profiles[i].length <= LIMITS.profileBytes,
      "Invalid profile size",
    );
    const measured = summarizeProfile(JSON.parse(profiles[i].toString("utf8")));
    requireValue(equal(run.measurement, measured), "Mismatched numeric profile evidence");
    return measured[METRIC];
  });
  const maximumMs = Math.max(...values);
  const status = maximumMs >= budget.failMs ? "fail" : maximumMs >= budget.warnMs ? "warn" : "pass";
  requireValue(
    evidence.maximumMs === maximumMs && evidence.status === status,
    "Incorrect local startup verdict",
  );
  return status;
}

// Cancellation is sticky: a caller cannot catch it and accept a later profile.
let cancelled = false;
// Kill the whole owned process group on cancellation/timeout/output overflow.
// Child output is bounded in memory, not published: build tools may print bindings.
export function runCommand(
  command,
  args,
  { cwd = root, timeoutMs = 30000, maxBytes = 2 * 1024 * 1024 } = {},
) {
  return new Promise((resolvePromise, reject) => {
    requireValue(!cancelled, "Startup measurement cancelled");
    const env = { ...process.env };
    // A version/hash is meaningless if inherited overrides execute another runtime.
    for (const key of Object.keys(env)) {
      if (
        /^(MINIFLARE_|WORKERD_|WRANGLER_)/.test(key) ||
        ["NODE_OPTIONS", "NODE_PATH", "ESBUILD_BINARY_PATH"].includes(key)
      )
        delete env[key];
    }
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      },
    });
    let size = 0;
    let failed = false;
    let cleanupTimer;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    const stop = () => {
      failed = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          cleanup();
          reject(new Error("Cannot terminate startup measurement process group"));
          return;
        }
      }
      // Do not depend indefinitely on pipe-close/reaping after SIGKILL.
      cleanupTimer ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        cleanup();
        reject(new Error("Startup measurement process cleanup exceeded bound"));
      }, 1000);
    };
    const cancel = (exitCode) => {
      cancelled = true;
      process.exitCode = exitCode;
      stop();
    };
    const onInterrupt = () => cancel(130);
    const onTerminate = () => cancel(143);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const timer = setTimeout(stop, timeoutMs);
    const observe = (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !failed) stop();
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.on("error", () => {
      cleanup();
      reject(new Error("Startup measurement command unavailable"));
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (failed || cancelled || code !== 0 || signal)
        reject(new Error("Startup measurement command failed, timed out or exceeded output cap"));
      else resolvePromise();
    });
  });
}
function git(...args) {
  return execFileSync("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 })
    .toString()
    .trim();
}
function sourceIdentity() {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  })
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  let total = 0;
  for (const file of files) {
    const path = join(root, file);
    const stat = lstatSync(path);
    requireValue(
      stat.isFile() && stat.size <= 32 * 1024 * 1024,
      "Invalid startup source inventory file",
    );
    const bytes = readFileSync(path);
    total += bytes.length;
    requireValue(total <= 256 * 1024 * 1024, "Startup source inventory exceeds cap");
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return {
    sha: git("rev-parse", "HEAD"),
    sourceSha256: hash.digest("hex"),
    rootLockSha256: sha256(readBounded(join(root, "package-lock.json"), 8 * 1024 * 1024)),
    webLockSha256: sha256(readBounded(join(root, "web/package-lock.json"), 8 * 1024 * 1024)),
    configSha256: sha256(readBounded(join(root, CONFIG), 1024 * 1024)),
  };
}
function toolIdentity(budget) {
  const wranglerPackage = join(root, "node_modules/wrangler/package.json");
  const require = createRequire(wranglerPackage);
  const paths = {
    wrangler: wranglerPackage,
    miniflare: require.resolve("miniflare/package.json"),
    workerd: require.resolve("workerd/package.json"),
  };
  const versions = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [
      name,
      JSON.parse(readBounded(path, 65536)).version,
    ]),
  );
  requireValue(
    equal(versions, budget.tools),
    "Startup profiler tool version differs from pinned budget",
  );
  const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
  return {
    cli,
    evidence: {
      versions,
      cliSha256: sha256(
        readBounded(join(root, "node_modules/wrangler/wrangler-dist/cli.js"), 32 * 1024 * 1024),
      ),
      miniflareSha256: sha256(readBounded(require.resolve("miniflare"), 32 * 1024 * 1024)),
      workerdSha256: sha256(
        readBounded(require.resolve("@cloudflare/workerd-linux-64/bin/workerd"), 256 * 1024 * 1024),
      ),
    },
  };
}
export async function validateUpload(bytes) {
  const boundary = bytes.subarray(2, bytes.indexOf(10)).toString().trim();
  requireValue(/^[\w-]{1,128}$/.test(boundary), "Invalid serialized upload boundary");
  const form = await new Response(bytes, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const metadata = JSON.parse(form.get("metadata"));
  requireValue(
    typeof metadata.main_module === "string" &&
      form.get(metadata.main_module) instanceof Blob &&
      Array.isArray(metadata.bindings) &&
      metadata.bindings.some((b) => b.type === "hyperdrive"),
    "Unsupported startup upload shape",
  );
  // Pinned Wrangler throws on failed evaluation when any unsupported binding exists.
  // Hyperdrive is deliberately unsupported by that profiler. Do not remove this
  // requirement without replacing its positive completion/failure guarantee.
}
function checkpoint(outdir, identity, runs) {
  writeFileSync(
    join(outdir, "checkpoint.json"),
    `${JSON.stringify(
      {
        version: 1,
        metric: METRIC,
        status: "unavailable",
        identity,
        runs,
      },
      null,
      2,
    )}\n`,
  );
}
export async function collect({ outdir, budget, identity, cli, run = runCommand }) {
  requireValue(!cancelled, "Startup measurement cancelled");
  const upload = join(outdir, "worker.bundle");
  // Global Wrangler middleware otherwise reloads ignored .env/.env.local after
  // runCommand strips inherited runtime overrides. Bind an owned empty file.
  const envFile = join(outdir, "empty.env");
  writeFileSync(envFile, "", { flag: "wx", mode: 0o400 });
  const verifyEnv = () => {
    const stat = lstatSync(envFile);
    requireValue(stat.isFile() && stat.size === 0, "Startup dotenv control changed");
  };
  const serializeArgs = [
    cli,
    "deploy",
    "--env-file",
    envFile,
    "--config",
    CONFIG,
    "--dry-run",
    "--outfile",
    upload,
  ];
  const profileArgs = [1, 2, 3].map((i) => [
    cli,
    "check",
    "startup",
    "--env-file",
    envFile,
    "--worker",
    upload,
    "--outfile",
    join(outdir, `cold-${i}.cpuprofile`),
  ]);
  const boundIdentity = {
    ...identity,
    uploadSha256: null,
    commands: {
      build: ["npm", "run", "build", "--prefix", "web"],
      serialize: [process.execPath, ...serializeArgs],
      profile: profileArgs.map((args) => [process.execPath, ...args]),
      workingDirectory: root,
      dotenv: { file: envFile, sha256: sha256(Buffer.alloc(0)) },
      sanitizedRuntimeEnvironment: true,
      config: CONFIG,
      WRANGLER_SEND_METRICS: "false",
      CI: "true",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      buildTimeoutMs: 240000,
      serializeTimeoutMs: 60000,
      profileTimeoutMs: 30000,
      outputCapBytes: 2097152,
    },
  };
  const runs = [];
  const profiles = [];
  checkpoint(outdir, boundIdentity, runs);
  verifyEnv();
  await run(process.execPath, serializeArgs, { timeoutMs: 60000 });
  verifyEnv();
  const uploadBytes = readBounded(upload, 32 * 1024 * 1024);
  boundIdentity.uploadSha256 = sha256(uploadBytes);
  checkpoint(outdir, boundIdentity, runs);
  await validateUpload(uploadBytes);
  for (let i = 1; i <= 3; i++) {
    const profile = `cold-${i}.cpuprofile`;
    verifyEnv();
    await run(process.execPath, profileArgs[i - 1]);
    verifyEnv();
    requireValue(!cancelled, "Startup measurement cancelled");
    requireValue(
      sha256(readBounded(upload, 32 * 1024 * 1024)) === boundIdentity.uploadSha256,
      "Upload changed between cold profiles",
    );
    const bytes = readBounded(join(outdir, profile), LIMITS.profileBytes);
    profiles.push(bytes);
    const numeric = {
      invocation: i,
      completed: true,
      uploadSha256: boundIdentity.uploadSha256,
      profile,
      profileSha256: sha256(bytes),
      measurement: summarizeProfile(JSON.parse(bytes.toString("utf8"))),
    };
    runs.push(numeric);
    writeFileSync(join(outdir, `cold-${i}.json`), `${JSON.stringify(numeric, null, 2)}\n`);
    checkpoint(outdir, boundIdentity, runs);
  }
  const maximumMs = Math.max(...runs.map((r) => r.measurement[METRIC]));
  const evidence = {
    version: 1,
    metric: METRIC,
    authoritativeStartup: "unavailable",
    productionMargin: "unmet",
    identity: boundIdentity,
    runs,
    maximumMs,
    status: maximumMs >= budget.failMs ? "fail" : maximumMs >= budget.warnMs ? "warn" : "pass",
  };
  validateEvidence(evidence, boundIdentity, profiles, budget);
  return evidence;
}
export function summary(evidence) {
  const numeric = evidence.runs.map((r) => r.measurement[METRIC].toFixed(3)).join(", ");
  const reversals = evidence.runs
    .map(
      (r) =>
        `Cold ${r.invocation}: ${r.measurement.reversals} reversals; largest ${r.measurement.maxReversalUs} us.`,
    )
    .join("\n");
  return `## Worker local startup diagnostic\n\n${METRIC}: **${evidence.status}**, maximum **${evidence.maximumMs.toFixed(3)} ms** of exactly 3 cold runs (${numeric} ms). Warning >=400 ms; failure >=700 ms.\n\n${reversals}\n\nAuthoritative Cloudflare startup_time_ms: **unavailable**. Production margin: **unmet**. This local sampling diagnostic is not provider startup CPU or validation.\n\nSource: \`${evidence.identity.sha}\`; upload SHA-256: \`${evidence.identity.uploadSha256}\`. Original profiles and build/tool/runner-bound numeric evidence are in the worker-startup-local artifact.\n`;
}
async function main() {
  const args = process.argv.slice(2);
  requireValue(
    args.length === 0 || (args.length === 2 && args[0] === "--outdir" && args[1]),
    "Usage: node ci/check-worker-startup.mjs [--outdir <new-directory>]",
  );
  requireValue(
    platform() === "linux" &&
      arch() === "x64" &&
      Number(process.versions.node.split(".")[0]) === 24,
    "Startup diagnostic requires controlled Linux x64 Node 24 runner",
  );
  const outdir = resolve(root, args[1] ?? "artifacts/worker-startup-local");
  requireValue(
    relative(root, outdir).startsWith("artifacts/"),
    "Startup output must be a new directory under artifacts/",
  );
  mkdirSync(join(root, "artifacts"), { recursive: true });
  mkdirSync(outdir, { recursive: false });
  let stage = "identity";
  try {
    const budget = validateBudget(
      JSON.parse(readBounded(join(root, "ci/worker-startup-budget.json"), 4096)),
    );
    const tools = toolIdentity(budget);
    const source = sourceIdentity();
    const runner = runnerIdentity();
    checkpoint(
      outdir,
      {
        ...source,
        tools: tools.evidence,
        runner,
        build: {
          command: ["npm", "run", "build", "--prefix", "web"],
          timeoutMs: 240000,
          outputCapBytes: 2097152,
        },
      },
      [],
    );
    stage = "build";
    await runCommand("npm", ["run", "build", "--prefix", "web"], { timeoutMs: 240000 });
    stage = "serialize/profile";
    const evidence = await collect({
      outdir,
      budget,
      cli: tools.cli,
      identity: { ...source, tools: tools.evidence, runner },
    });
    stage = "verify";
    requireValue(
      !cancelled &&
        equal(source, sourceIdentity()) &&
        equal(tools.evidence, toolIdentity(budget).evidence) &&
        equal(runner, runnerIdentity()),
      "Build source, tools or runner changed during profiling",
    );
    writeFileSync(join(outdir, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    const text = summary(evidence);
    writeFileSync(join(outdir, "summary.md"), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
    if (evidence.status === "warn")
      console.error(`::warning::${METRIC} >=400 ms (local diagnostic only)`);
    process.exitCode = evidence.status === "fail" ? 1 : 0;
  } catch (error) {
    // Do not publish child output, arbitrary exception text, env or binding values.
    const failure = {
      version: 1,
      metric: METRIC,
      status: "unavailable",
      stage,
      authoritativeStartup: "unavailable",
      productionMargin: "unmet",
      provenanceCheckpoint: stage === "identity" ? null : "checkpoint.json",
    };
    writeFileSync(join(outdir, "report.json"), `${JSON.stringify(failure, null, 2)}\n`);
    const text = `## Worker local startup diagnostic\n\n**Unavailable** at ${stage}; no local pass. Cloudflare startup_time_ms unavailable; production margin unmet.\n`;
    writeFileSync(join(outdir, "summary.md"), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    console.error(
      `worker-startup: cannot enforce local diagnostic at ${stage} (${error instanceof SyntaxError ? "malformed JSON" : "invalid or unavailable evidence"})`,
    );
    process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("worker-startup: invalid invocation or runner/output unavailable");
    process.exitCode = 2;
  });
}
