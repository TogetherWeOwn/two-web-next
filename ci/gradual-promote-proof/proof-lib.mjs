// Gradual-promotion proof harness: target lock, config generator and
// independent readback for exercising the pinned central gradual-promote
// action against one isolated synthetic Worker.
//
// The pinned action hardcodes `--env production` for its deployment list
// and version deploys, and runs rollback with `--name` and no environment
// flag. The generated config therefore makes the top-level name and
// env.production.name the same synthetic Worker, so both halves resolve
// to the isolated target and neither can reach a live Worker. Nothing in
// this file calls Cloudflare; the CLIs only print config/evidence JSON or
// parse `wrangler ... --json` output piped in by the workflow.
//
// Run the tests: node --test ci/gradual-promote-proof/proof.test.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PROOF_WORKER_NAME = "two-gradual-promote-proof";
export const PINNED_ACTION =
  "TogetherWeOwn/.github/actions/gradual-promote@89c290be20c0044efaf6916f28341c76e75fff06";
export const PROOF_MODES = ["ok", "fail-up"];
export const PROOF_RUN_MODES = ["success", "rollback"];

// Live Workers and hosts this harness must never target, even by typo.
const FORBIDDEN_WORKER_NAMES = new Set(["two-web-next", "two-web-next-production"]);
const FORBIDDEN_HOST_SUFFIXES = ["togetherweown.com"];

// Exact key allowlists per scope. A denylist of binding keys cannot keep up
// with Wrangler (workflows, ai, and future binding kinds would slip past it),
// and an environment-specific override such as env.production.main changes
// what `--env production` uploads, so anything not listed here refuses.
const PROOF_FIXTURE_MAIN = "ci/gradual-promote-proof/fixture.mjs";
const PROOF_COMPATIBILITY_DATE = "2026-09-29";
const SCOPE_KEYS = ["name", "workers_dev", "preview_urls", "version_metadata", "vars"];
const TOP_LEVEL_CONFIG_KEYS = new Set([
  ...SCOPE_KEYS,
  "main",
  "compatibility_date",
  "observability",
  "env",
]);
const ENV_CONFIG_KEYS = new Set(SCOPE_KEYS);

const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertProofWorkerName(name) {
  if (FORBIDDEN_WORKER_NAMES.has(name)) {
    throw new Error(`refusing live Worker name ${name}: the proof target is ${PROOF_WORKER_NAME}`);
  }
  if (name !== PROOF_WORKER_NAME) {
    throw new Error(`worker name must be exactly ${PROOF_WORKER_NAME}`);
  }
  return name;
}

export function assertProofDomain(domain, workerName = PROOF_WORKER_NAME) {
  assertProofWorkerName(workerName);
  if (typeof domain !== "string" || domain !== domain.toLowerCase()) {
    throw new Error("proof domain must be a lowercase workers.dev host");
  }
  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) {
      throw new Error(`refusing live host ${domain}: the proof runs on workers.dev only`);
    }
  }
  const match = domain.match(/^([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)\.workers\.dev$/);
  if (!match || match[1] !== workerName) {
    throw new Error(`proof domain must look like ${workerName}.<account-subdomain>.workers.dev`);
  }
  return domain;
}

export function assertProofRunMode(mode) {
  if (!PROOF_RUN_MODES.includes(mode)) {
    throw new Error(`run mode must be one of ${PROOF_RUN_MODES.join(", ")}`);
  }
  return mode;
}

// The candidate's fixture mode is derived from the run mode, never passed
// independently, so a rollback run cannot accidentally ship a healthy
// candidate (or a success run a broken one).
export function fixtureModeForRunMode(mode) {
  assertProofRunMode(mode);
  return mode === "rollback" ? "fail-up" : "ok";
}

export function assertProofLabel(label) {
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
    throw new Error("proof label must be 1-64 chars of letters, digits, dot, underscore or dash");
  }
  return label;
}

function proofScope(mode, label) {
  return {
    name: PROOF_WORKER_NAME,
    workers_dev: true,
    preview_urls: false,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: { PROOF_MODE: mode, PROOF_LABEL: label },
  };
}

export function buildProofConfig({ mode, label }) {
  if (!PROOF_MODES.includes(mode)) {
    throw new Error(`fixture mode must be one of ${PROOF_MODES.join(", ")}`);
  }
  assertProofLabel(label);
  const config = {
    ...proofScope(mode, label),
    main: PROOF_FIXTURE_MAIN,
    compatibility_date: PROOF_COMPATIBILITY_DATE,
    observability: { enabled: false },
    env: { production: proofScope(mode, label) },
  };
  assertProofConfig(config);
  return config;
}

function assertOnlyKeys(object, allowedKeys, where) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `refusing proof config: ${where}.${key} is not allowlisted for the isolated proof Worker`,
      );
    }
  }
}

function assertScope(scope, where, allowedKeys) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error(`${where} must be an object`);
  }
  assertOnlyKeys(scope, allowedKeys, where);
  assertProofWorkerName(scope.name);
  if (scope.workers_dev !== true) {
    throw new Error(`${where}.workers_dev must be true (the proof has no custom domain)`);
  }
  if (scope.preview_urls !== false) {
    throw new Error(`${where}.preview_urls must be false (the proof publishes no preview URLs)`);
  }
  if (
    !scope.version_metadata ||
    typeof scope.version_metadata !== "object" ||
    Array.isArray(scope.version_metadata)
  ) {
    throw new Error(`${where} must bind CF_VERSION_METADATA for version attribution`);
  }
  assertOnlyKeys(scope.version_metadata, new Set(["binding"]), `${where}.version_metadata`);
  if (scope.version_metadata.binding !== "CF_VERSION_METADATA") {
    throw new Error(`${where} must bind CF_VERSION_METADATA for version attribution`);
  }
  if (!scope.vars || typeof scope.vars !== "object" || Array.isArray(scope.vars)) {
    throw new Error(`${where}.vars must set exactly PROOF_MODE and PROOF_LABEL`);
  }
  assertOnlyKeys(scope.vars, new Set(["PROOF_MODE", "PROOF_LABEL"]), `${where}.vars`);
  if (!PROOF_MODES.includes(scope.vars.PROOF_MODE)) {
    throw new Error(`${where}.vars.PROOF_MODE must be one of ${PROOF_MODES.join(", ")}`);
  }
  assertProofLabel(scope.vars.PROOF_LABEL);
}

export function assertProofConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("proof config must be a JSON object");
  }
  assertScope(config, "config", TOP_LEVEL_CONFIG_KEYS);
  // The action's rollback step omits --env, so the top-level scope and
  // env.production must be the same Worker with the same fixture vars.
  assertScope(config.env?.production, "config.env.production", ENV_CONFIG_KEYS);
  const envKeys = Object.keys(config.env ?? {});
  if (envKeys.length !== 1 || envKeys[0] !== "production") {
    throw new Error("proof config must define exactly one environment: production");
  }
  if (
    config.env.production.vars.PROOF_MODE !== config.vars.PROOF_MODE ||
    config.env.production.vars.PROOF_LABEL !== config.vars.PROOF_LABEL
  ) {
    throw new Error("top-level and env.production fixture vars must match");
  }
  if (config.main !== PROOF_FIXTURE_MAIN) {
    throw new Error("proof config main must be the synthetic fixture entrypoint");
  }
  if (config.compatibility_date !== PROOF_COMPATIBILITY_DATE) {
    throw new Error(`proof config compatibility_date must be ${PROOF_COMPATIBILITY_DATE}`);
  }
  if (
    !config.observability ||
    typeof config.observability !== "object" ||
    Array.isArray(config.observability)
  ) {
    throw new Error("proof config observability must be exactly { enabled: false }");
  }
  assertOnlyKeys(config.observability, new Set(["enabled"]), "config.observability");
  if (config.observability.enabled !== false) {
    throw new Error("proof config observability must be exactly { enabled: false }");
  }
  return config;
}

// Independent readback: parse `wrangler deployments list --json` without
// importing the action's helper, so the evidence does not depend on the
// code under test. Newest deployment wins by created_on, never position.
export function latestDeployment(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("expected a non-empty deployments list");
  }
  let newest = deployments[0];
  for (const entry of deployments.slice(1)) {
    if (String(entry?.created_on ?? "") > String(newest?.created_on ?? "")) newest = entry;
  }
  if (!newest || !Array.isArray(newest.versions)) {
    throw new Error("latest deployment has no versions array");
  }
  return newest;
}

export function deployedVersionAt100(deployments) {
  const latest = latestDeployment(deployments);
  if (
    latest.versions.length !== 1 ||
    latest.versions[0]?.percentage !== 100 ||
    !VERSION_ID_PATTERN.test(latest.versions[0]?.version_id ?? "")
  ) {
    throw new Error("latest deployment is not a single version at 100%");
  }
  return {
    deploymentId: typeof latest.id === "string" ? latest.id : null,
    versionId: latest.versions[0].version_id,
    createdOn: typeof latest.created_on === "string" ? latest.created_on : null,
  };
}

export function versionIdForTag(versions, tag) {
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new Error("version tag must be 1-128 chars of letters, digits, dot, underscore or dash");
  }
  if (!Array.isArray(versions)) throw new Error("expected a versions array");
  const matches = versions.filter((v) => v?.annotations?.["workers/tag"] === tag);
  if (matches.length === 0) throw new Error(`no version found with tag "${tag}"`);
  if (matches.length > 1) throw new Error(`tag "${tag}" matches multiple versions`);
  if (!VERSION_ID_PATTERN.test(matches[0].id ?? "")) {
    throw new Error("matched version id is not a lowercase Worker Version UUID");
  }
  return matches[0].id;
}

// Stage sightings for the evidence record: every deployment that gave the
// candidate or the original a traffic share, in creation order.
export function deploymentSightings(deployments, { originalVersionId, candidateVersionId }) {
  if (!Array.isArray(deployments)) throw new Error("expected a deployments array");
  return deployments
    .filter((d) => Array.isArray(d?.versions))
    .map((d) => ({
      deploymentId: typeof d.id === "string" ? d.id : null,
      createdOn: typeof d.created_on === "string" ? d.created_on : null,
      versions: d.versions.map((v) => ({
        versionId: v?.version_id ?? null,
        percentage: v?.percentage ?? null,
        role:
          v?.version_id === candidateVersionId
            ? "candidate"
            : v?.version_id === originalVersionId
              ? "original"
              : "other",
      })),
    }))
    .sort((a, b) => String(a.createdOn ?? "").localeCompare(String(b.createdOn ?? "")));
}

export function buildEvidence(fields) {
  const {
    runMode,
    workerName,
    domain,
    repository,
    workflowSha,
    runId,
    runAttempt,
    original,
    candidate,
    actionOutcome,
    finalDeployedVersionId,
    sightings,
  } = fields;
  assertProofRunMode(runMode);
  assertProofWorkerName(workerName);
  assertProofDomain(domain, workerName);
  return {
    schema: "gradual-promote-proof/v1",
    action: PINNED_ACTION,
    runMode,
    workerName,
    domain,
    repository: repository ?? null,
    workflowSha: workflowSha ?? null,
    runId: runId ?? null,
    runAttempt: runAttempt ?? null,
    original: original ?? null,
    candidate: candidate ?? null,
    actionOutcome: actionOutcome ?? null,
    // The expected end state differs by run mode; a rollback run keeps the
    // action's failure as the outcome and proves the original is back.
    expectedFinalVersionId:
      runMode === "rollback" ? (original?.versionId ?? null) : (candidate?.versionId ?? null),
    finalDeployedVersionId: finalDeployedVersionId ?? null,
    sightings: sightings ?? [],
  };
}

function readStdinJson() {
  return JSON.parse(readFileSync(0, "utf8"));
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || typeof args[index + 1] !== "string") {
    throw new Error(`missing value for ${flag}`);
  }
  return args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const [command] = args;
  try {
    if (command === "--guard") {
      const workerName = argValue(args, "--worker");
      const confirm = argValue(args, "--confirm");
      assertProofWorkerName(workerName);
      if (confirm !== workerName) {
        throw new Error("confirm input must repeat the exact synthetic Worker name (target lock)");
      }
      if (args.includes("--domain")) assertProofDomain(argValue(args, "--domain"), workerName);
      if (args.includes("--run-mode")) assertProofRunMode(argValue(args, "--run-mode"));
      process.stdout.write("proof target lock ok\n");
    } else if (command === "--generate-config") {
      const mode = args.includes("--run-mode")
        ? fixtureModeForRunMode(argValue(args, "--run-mode"))
        : argValue(args, "--fixture-mode");
      const config = buildProofConfig({ mode, label: argValue(args, "--label") });
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    } else if (command === "--assert-config") {
      assertProofConfig(JSON.parse(readFileSync(argValue(args, "--file"), "utf8")));
      process.stdout.write("proof config ok\n");
    } else if (command === "--resolve-tag") {
      process.stdout.write(`${versionIdForTag(readStdinJson(), argValue(args, "--tag"))}\n`);
    } else if (command === "--assert-deployed") {
      const expected = argValue(args, "--version");
      const deployed = deployedVersionAt100(readStdinJson());
      if (deployed.versionId !== expected) {
        throw new Error(`expected version ${expected} at 100%, found ${deployed.versionId}`);
      }
      process.stdout.write(`${JSON.stringify(deployed)}\n`);
    } else if (command === "--readback") {
      process.stdout.write(`${JSON.stringify(deployedVersionAt100(readStdinJson()))}\n`);
    } else if (command === "--evidence") {
      const deployments = JSON.parse(readFileSync(argValue(args, "--deployments"), "utf8"));
      const original = {
        versionId: argValue(args, "--original-version"),
        tag: argValue(args, "--original-tag"),
      };
      const candidate = {
        versionId: argValue(args, "--candidate-version"),
        tag: argValue(args, "--candidate-tag"),
      };
      let finalDeployedVersionId = null;
      try {
        finalDeployedVersionId = deployedVersionAt100(deployments).versionId;
      } catch {
        finalDeployedVersionId = null;
      }
      const evidence = buildEvidence({
        runMode: argValue(args, "--run-mode"),
        workerName: argValue(args, "--worker"),
        domain: argValue(args, "--domain"),
        repository: process.env.GITHUB_REPOSITORY ?? null,
        workflowSha: process.env.GITHUB_SHA ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        original,
        candidate,
        actionOutcome: argValue(args, "--action-outcome"),
        finalDeployedVersionId,
        sightings: deploymentSightings(deployments, {
          originalVersionId: original.versionId,
          candidateVersionId: candidate.versionId,
        }),
      });
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } else {
      throw new Error(
        "Usage: proof-lib.mjs (--guard | --generate-config | --assert-config | --resolve-tag | --assert-deployed | --readback | --evidence) [flags]",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
