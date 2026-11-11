// Controlled draft asset-generation helpers (.github/workflows/asset-generation.yml).
//
// The workflow runs the reviewed generator (ci/minify-assets.mjs) on Actions
// against the exact PR head and uploads the allowed public/ diff plus a
// provenance manifest. This file holds the fail-closed pieces around it:
//   inventory     record root and locked-dependency install hooks
//   npm-fixtures  prove the installed npm supports AND enforces
//                 min-release-age and ignore-scripts, on loopback fixtures
//   verify-esbuild  locked esbuild runs from its platform package, scripts off
//   collect       validate the generated tree, write patch + manifest
//   verdict       exit 1 when the committed output was stale
// It never installs, updates or rebuilds anything in the repository tree, never
// writes to git history, and never reads credentials: the manifest takes only
// named GITHUB_* values, not the environment.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Nothing here imports repository code that needs installed dependencies:
// build-ember-tokens.mjs imports esbuild, so it is loaded lazily and only by
// collect, after the install. inventory, npm-fixtures and the self-test run on
// a clean checkout.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Reviewed minimum: the first npm line with the native min-release-age config.
// The fixtures, not this number, are the proof; this only fails early.
export const MIN_NPM = "11.10.0";
export const LOCKED_ESBUILD = "0.28.2";
// Every root install, prepare, pack and publish lifecycle script name.
const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
  "prepublishOnly",
  "publish",
  "postpublish",
];
// The root package's actual hooks today: exactly one, `postinstall`, which runs
// two named first-party generators. Every other lifecycle name above is empty.
// A change fails closed so a new hook or generator is reviewed before this
// job's policy is trusted to cover it. With --ignore-scripts neither generator
// runs in this job; the asset generator never needs their output.
export const REVIEWED_ROOT_HOOKS = {
  postinstall: "node ci/build-ember-tokens.mjs --check && node ci/build-leaf-css.mjs",
};
export const REVIEWED_FIRST_PARTY_GENERATORS = [
  "ci/build-ember-tokens.mjs",
  "ci/build-leaf-css.mjs",
];
const REGISTRY_PREFIX = "https://registry.npmjs.org/";
const GENERATOR_FILES = [
  "ci/minify-assets.mjs",
  "ci/build-ember-tokens.mjs",
  "ci/budget-fragments.mjs",
  "ci/build-leaf-css.mjs",
  "ci/asset-generation.mjs",
];
const PATCH_NAME = "public-assets.patch";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function compareVersions(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const git = (root, args, opts = {}) =>
  execFileSync("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });

// ---------------------------------------------------------------- inventory

export function inventoryHooks(root = repoRoot) {
  const pick = (rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return null;
    const scripts = JSON.parse(readFileSync(path, "utf8")).scripts ?? {};
    return Object.fromEntries(LIFECYCLE.filter((n) => n in scripts).map((n) => [n, scripts[n]]));
  };
  const lockBytes = readFileSync(join(root, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const hooks = [];
  const unpinned = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (meta.hasInstallScript) {
      hooks.push({
        path,
        version: meta.version ?? null,
        integrity: meta.integrity ?? null,
        optional: Boolean(meta.optional),
      });
    }
    if (typeof meta.resolved !== "string" || !meta.resolved.startsWith(REGISTRY_PREFIX)) {
      unpinned.push({ path, resolved: meta.resolved ?? null, link: Boolean(meta.link) });
    }
  }
  const rootHooks = pick("package.json") ?? {};
  const problems = [];
  const reviewed = JSON.stringify(REVIEWED_ROOT_HOOKS);
  if (JSON.stringify(rootHooks) !== reviewed) {
    problems.push(
      `root install hooks differ from the reviewed set ${reviewed}: ${JSON.stringify(rootHooks)}`,
    );
  }
  // Classify each script the root hooks name: reviewed first-party generator
  // (identity recorded) or unreviewed (fails closed).
  const rootHookGenerators = [];
  for (const [name, command] of Object.entries(rootHooks)) {
    for (const path of command.match(/\b[\w./-]+\.(?:mjs|cjs|js|ts|sh)\b/g) ?? []) {
      const isReviewed = REVIEWED_FIRST_PARTY_GENERATORS.includes(path);
      const file = join(root, path);
      rootHookGenerators.push({
        hook: name,
        path,
        reviewed: isReviewed,
        sha256: existsSync(file) ? sha256(readFileSync(file)) : null,
      });
      if (!isReviewed) problems.push(`root hook ${name} runs unreviewed script ${path}`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    lockSha256: sha256(lockBytes),
    rootHooks,
    rootHookGenerators,
    kitHooks: pick("web/package.json"),
    lockedDependencyHooks: hooks.sort((a, b) => a.path.localeCompare(b.path)),
    nonRegistrySources: unpinned,
  };
}

// ------------------------------------------------------------- npm fixtures

const MARKERS = "root-pre root-install root-post dep-post".split(" ");

function tarball(dir, name, files) {
  const pkgDir = join(dir, name, "package");
  mkdirSync(pkgDir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(pkgDir, file), text);
  const out = join(dir, `${name}.tgz`);
  execFileSync("tar", ["-czf", out, "-C", join(dir, name), "package"]);
  return readFileSync(out);
}

const markerScript = (marker) =>
  `node -e "require('fs').writeFileSync(require('path').join(process.env.INIT_CWD, '${marker}'), '1')"`;

// A loopback registry with fixed publication times. Harmless by construction:
// it serves two tiny packages, never forwards, and listens on 127.0.0.1 only.
function startRegistry(scratch, now) {
  const day = 24 * 3600 * 1000;
  const packages = {};
  const add = (name, version, files, published) => {
    const bytes = tarball(scratch, `${name}-${version}`, {
      "package.json": JSON.stringify({ name, version, ...files.manifest }),
      "index.js": "module.exports = 1;\n",
    });
    (packages[name] ??= { versions: {}, time: {} }).versions[version] = { bytes, files };
    packages[name].time[version] = new Date(published).toISOString();
  };
  add("age-probe", "1.0.0", { manifest: {} }, now - 30 * day);
  add("age-probe", "2.0.0", { manifest: {} }, now - 3600 * 1000);
  add(
    "hook-dep",
    "1.0.0",
    { manifest: { scripts: { postinstall: markerScript("dep-post") } }, hasInstallScript: true },
    now - 30 * day,
  );
  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const tgz = url.pathname.match(/^\/([\w-]+)\/-\/[\w-]+-(\d+\.\d+\.\d+)\.tgz$/);
    if (tgz && packages[tgz[1]]?.versions[tgz[2]]) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(packages[tgz[1]].versions[tgz[2]].bytes);
      return;
    }
    const pkg = packages[url.pathname.slice(1)];
    if (!pkg) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const versions = Object.keys(pkg.versions).sort(compareVersions);
    const doc = {
      name: url.pathname.slice(1),
      "dist-tags": { latest: versions[versions.length - 1] },
      time: {
        created: pkg.time[versions[0]],
        modified: pkg.time[versions[versions.length - 1]],
        ...pkg.time,
      },
      versions: Object.fromEntries(
        versions.map((v) => {
          const { bytes, files } = pkg.versions[v];
          const name = url.pathname.slice(1);
          return [
            v,
            {
              name,
              version: v,
              ...files.manifest,
              ...(files.hasInstallScript ? { hasInstallScript: true } : {}),
              dist: {
                tarball: `${base}/${name}/-/${name}-${v}.tgz`,
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                shasum: createHash("sha1").update(bytes).digest("hex"),
              },
            },
          ];
        }),
      ),
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(doc));
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      ok({ server, base });
    });
  });
}

function npmEnv(scratch, registry, policy) {
  // No inherited tokens, user config or cache: the fixtures see only loopback.
  mkdirSync(join(scratch, "home"), { recursive: true });
  writeFileSync(join(scratch, "empty.npmrc"), "");
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    npm_config_userconfig: join(scratch, "empty.npmrc"),
    npm_config_globalconfig: join(scratch, "empty.npmrc"),
    npm_config_cache: join(scratch, "cache"),
    npm_config_registry: registry,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: policy.ignoreScripts,
    npm_config_min_release_age: policy.minReleaseAge,
  };
}

// Asynchronous on purpose: the loopback registry lives in this process, so a
// blocking spawn would starve its event loop and every request would hang.
function runNpm(args, cwd, env) {
  return new Promise((ok) => {
    const child = spawn("npm", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (chunk) => {
      out = (out + chunk).slice(-4000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      ok({ status: null, out: String(error) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      ok({ status, out: out.slice(-2000) });
    });
  });
}

function project(dir, name) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      private: true,
      scripts: {
        preinstall: markerScript("root-pre"),
        install: markerScript("root-install"),
        postinstall: markerScript("root-post"),
      },
      dependencies: { "age-probe": "*", "hook-dep": "1.0.0" },
    }),
  );
  return root;
}

const markersIn = (root) => MARKERS.filter((m) => existsSync(join(root, m)));
const lockedVersion = (root, pkg) =>
  JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages?.[
    `node_modules/${pkg}`
  ]?.version;

export function jobPolicyProblems(env) {
  const problems = [];
  if (env.npm_config_ignore_scripts !== "true") {
    problems.push("npm_config_ignore_scripts is not true");
  }
  if (env.npm_config_min_release_age !== "3") {
    problems.push("npm_config_min_release_age is not 3");
  }
  return problems;
}

export async function runNpmFixtures({ log = console.log, env = process.env } = {}) {
  const checks = [];
  const must = (name, ok, detail = "") => {
    checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
    log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
  };
  const scratch = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "asset-gen-npm-"));
  let registry;
  try {
    // 1. the job must carry the native policy, and npm must report it back.
    const missing = jobPolicyProblems(env);
    must("job sets ignore-scripts=true and min-release-age=3", !missing.length, missing.join("; "));
    const policy = { ignoreScripts: "true", minReleaseAge: "3" };
    const off = { ignoreScripts: "false", minReleaseAge: "0" };
    const probeEnv = npmEnv(scratch, "http://127.0.0.1:9", policy);
    const version = (await runNpm(["--version"], scratch, probeEnv)).out.trim();
    must(
      `npm ${version} >= ${MIN_NPM}`,
      /^\d+\.\d+\.\d+/.test(version) && compareVersions(version, MIN_NPM) >= 0,
      version,
    );
    const cfg = async (key) =>
      (await runNpm(["config", "get", key], scratch, probeEnv)).out.trim();
    const reportedAge = await cfg("min-release-age");
    const reportedScripts = await cfg("ignore-scripts");
    must("npm reports min-release-age=3", reportedAge === "3", reportedAge);
    must(
      "npm reports ignore-scripts=true",
      reportedScripts === "true",
      reportedScripts,
    );

    // 2. enforcement: a config value alone is not proof.
    registry = await startRegistry(scratch, Date.now());
    const run = async (name, pol, args) => {
      const root = project(scratch, name);
      const e = npmEnv(scratch, registry.base, pol);
      return { root, e, ...(await runNpm(args, root, e)) };
    };
    const ageOn = await run("age-on", policy, ["install", "--package-lock-only"]);
    must("age policy: install resolves", ageOn.status === 0, ageOn.out);
    must(
      "age policy selects the old publication (1.0.0), not the new one",
      lockedVersion(ageOn.root, "age-probe") === "1.0.0",
      String(lockedVersion(ageOn.root, "age-probe")),
    );
    const ageOff = await run("age-off", off, ["install", "--package-lock-only"]);
    must(
      "control: without the policy the new publication (2.0.0) is selected",
      ageOff.status === 0 && lockedVersion(ageOff.root, "age-probe") === "2.0.0",
      ageOff.out,
    );

    const hooksOn = await run("hooks-on", policy, ["install", "--package-lock-only"]);
    must("hook fixture lock created", hooksOn.status === 0, hooksOn.out);
    const ci = await runNpm(["ci", "--include=dev"], hooksOn.root, hooksOn.e);
    must("npm ci under the policy installs the fixture", ci.status === 0, ci.out);
    must(
      "scripts off: no root or dependency hook marker exists",
      markersIn(hooksOn.root).length === 0,
      markersIn(hooksOn.root).join(","),
    );
    must(
      "dependency installed without running its hook",
      existsSync(join(hooksOn.root, "node_modules/hook-dep/index.js")),
    );
    const hooksOff = await run("hooks-off", off, ["install", "--package-lock-only"]);
    const ciOff = await runNpm(["ci", "--include=dev"], hooksOff.root, hooksOff.e);
    const seen = markersIn(hooksOff.root);
    must(
      "control: with scripts enabled the root and dependency hooks do run",
      ciOff.status === 0 && seen.includes("root-post") && seen.includes("dep-post"),
      `${ciOff.out} markers=${seen.join(",")}`,
    );
  } catch (error) {
    must("fixtures completed", false, error instanceof Error ? error.message : String(error));
  } finally {
    registry?.server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ------------------------------------------------------------ esbuild proof

export function verifyEsbuild(root = repoRoot) {
  const problems = [];
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const locked = lock.packages?.["node_modules/esbuild"]?.version;
  if (locked !== LOCKED_ESBUILD) {
    problems.push(`lock esbuild is ${locked}, reviewed ${LOCKED_ESBUILD}`);
  }
  if (pkg.devDependencies?.esbuild !== LOCKED_ESBUILD) {
    problems.push("package.json esbuild pin changed");
  }
  const platform = `@esbuild/${process.platform}-${process.arch}`;
  const platformManifest = join(root, "node_modules", platform, "package.json");
  let platformVersion = null;
  if (existsSync(platformManifest)) {
    platformVersion = JSON.parse(readFileSync(platformManifest, "utf8")).version;
  }
  if (platformVersion !== LOCKED_ESBUILD) {
    problems.push(`${platform} is ${platformVersion}, expected ${LOCKED_ESBUILD}`);
  }
  const bin = join(root, "node_modules", ".bin", "esbuild");
  let version = null;
  let shim = false;
  let minified = null;
  if (existsSync(bin)) {
    const head = readFileSync(realpathSync(bin)).subarray(0, 4);
    // esbuild's postinstall replaces this JS shim with the native binary, so a
    // shim proves the install script did not run.
    shim = !(head[0] === 0x7f && head[1] === 0x45);
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    version = v.status === 0 ? v.stdout.trim() : null;
    const m = spawnSync(bin, ["--minify", "--loader=js"], {
      input: "let   answer = 1 ;\n",
      encoding: "utf8",
      timeout: 30_000,
    });
    minified = m.status === 0 ? m.stdout : null;
  }
  if (version !== LOCKED_ESBUILD) problems.push(`esbuild --version is ${version}`);
  if (!shim) {
    problems.push("esbuild bin is not the JS shim: its install script appears to have run");
  }
  if (minified !== "let answer=1;\n") {
    problems.push(`esbuild minify probe returned ${JSON.stringify(minified)}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    version,
    platformPackage: platform,
    platformVersion,
    jsShim: shim,
  };
}

// ----------------------------------------------------------------- collect

// The generator's public outputs: budgeted entries with an assets/ source,
// plus the public/ Ember adapters. Anything else it changes is unexpected.
export async function allowedOutputs(root = repoRoot) {
  const { loadBundleBudgets } = await import("./budget-fragments.mjs");
  const { ARTIFACTS } = await import("./build-ember-tokens.mjs");
  const entries = Object.keys(loadBundleBudgets(root))
    .filter(
      (e) => e.startsWith("public/") && existsSync(join(root, e.replace(/^public\//, "assets/"))),
    )
    .concat(ARTIFACTS.filter((a) => a.startsWith("public/")));
  return [...new Set(entries)].sort();
}

// Parse `git status --porcelain=v1 -z`. Each entry is "XY path" with the
// path in the rest; renames carry a second NUL-separated path, kept as `from`.
export function parseStatus(text) {
  const parts = text.split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const xy = parts[i].slice(0, 2);
    const entry = { xy, path: parts[i].slice(3) };
    if (xy[0] === "R" || xy[0] === "C") entry.from = parts[(i += 1)];
    out.push(entry);
  }
  return out;
}

export function classifyStatus(entries, allowed) {
  const ok = new Set(allowed);
  const unexpected = [];
  const files = [];
  for (const { xy, path } of entries) {
    if (ok.has(path) && (xy === " M" || xy === "??")) files.push(path);
    else unexpected.push(`${xy.trim() || xy} ${path}`);
  }
  return { files: files.sort(), unexpected };
}

// `git diff --raw -z --no-renames --full-index`: ":oldmode newmode oldsha newsha S\0path\0".
export function validateRaw(raw, allowed) {
  const ok = new Set(allowed);
  const fields = raw.split("\0").filter(Boolean);
  const problems = [];
  for (let i = 0; i < fields.length; i += 2) {
    const meta = fields[i].split(" ");
    const path = fields[i + 1];
    const status = meta[4];
    const oldMode = meta[0].replace(/^:/, "");
    if (!ok.has(path)) problems.push(`path not allowed: ${path}`);
    if (status !== "M" && status !== "A") problems.push(`status ${status} not allowed: ${path}`);
    if (meta[1] !== "100644" || (status === "M" && oldMode !== "100644")) {
      problems.push(`mode change or non-regular file: ${path}`);
    }
  }
  return problems;
}

function treeIdentity(root, paths) {
  const hash = createHash("sha256");
  const listed = git(root, ["ls-files", "-z", "--", ...paths], { encoding: "utf8" });
  for (const p of listed.split("\0").filter(Boolean)) {
    hash.update(`${p}\0${sha256(readFileSync(join(root, p)))}\0`);
  }
  return hash.digest("hex");
}

export function collect({ root = repoRoot, outDir, work, env = process.env, allowed }) {
  if (!Array.isArray(allowed)) throw new Error("collect needs the allowed output list");
  mkdirSync(outDir, { recursive: true });
  const read = (name) => JSON.parse(readFileSync(join(work, name), "utf8"));
  const text = (name) => readFileSync(join(work, name), "utf8").trim();
  const head = git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(env.PR_HEAD_SHA ?? "") || head !== env.PR_HEAD_SHA) {
    problems.push(`checked-out HEAD ${head} is not the PR head ${env.PR_HEAD_SHA}`);
  }
  const status = parseStatus(
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" }),
  );
  const { files, unexpected } = classifyStatus(status, allowed);
  if (unexpected.length) {
    problems.push(`unexpected tracked or untracked output: ${unexpected.join(", ")}`);
  }
  let patch = null;
  if (!unexpected.length && files.length) {
    // Intent-to-add makes new files appear in the diff; index-only, workspace-local.
    git(root, ["add", "--intent-to-add", "--", ...files]);
    const raw = git(root, ["diff", "--raw", "-z", "--no-renames", "--full-index", "--", ...files], {
      encoding: "utf8",
    });
    problems.push(...validateRaw(raw, allowed));
    patch = git(root, ["diff", "--binary", "--full-index", "--no-renames", "--", ...files]);
  }
  const initialExit = Number(text("initial.exit"));
  const postExit = Number(text("post.exit"));
  if (postExit !== 0) problems.push("canonical --check failed on the generated tree");
  if (initialExit === 0 && patch) {
    problems.push("initial check passed but regeneration changed bytes (non-deterministic)");
  }
  if (initialExit !== 0 && !patch && !unexpected.length) {
    problems.push("initial check failed but regeneration changed nothing");
  }
  if (!problems.length && patch) writeFileSync(join(outDir, PATCH_NAME), patch);
  const outputs = Object.fromEntries(
    allowed.filter((p) => existsSync(join(root, p))).map((p) => {
      const bytes = readFileSync(join(root, p));
      return [p, { sha256: sha256(bytes), bytes: bytes.length, changed: files.includes(p) }];
    }),
  );
  const nodeVersion = process.version;
  const run = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const manifest = {
    schema: "asset-generation/v1",
    status: problems.length ? "failed" : patch ? "drift-patch" : "no-drift",
    problems,
    repository: env.GITHUB_REPOSITORY,
    pullRequest: Number(env.PR_NUMBER) || null,
    sourceSha: head,
    baseSha: env.PR_BASE_SHA ?? null,
    sourceTree: git(root, ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    initialDrift: {
      exitCode: initialExit,
      drifted: initialExit !== 0,
      output: text("initial.log").slice(0, 8000),
    },
    canonicalCheckAfterGeneration: { exitCode: postExit },
    patch: patch ? { file: PATCH_NAME, sha256: sha256(patch), bytes: patch.length, files } : null,
    unexpectedOutputs: unexpected,
    allowedPaths: allowed,
    outputs,
    identities: {
      lockSha256: sha256(readFileSync(join(root, "package-lock.json"))),
      generators: Object.fromEntries(
        GENERATOR_FILES.map((f) => [f, sha256(readFileSync(join(root, f)))]),
      ),
      inputsSha256: treeIdentity(root, ["assets", "vendor", "ci/budgets/bundle", "tsconfig.json"]),
    },
    tooling: { node: nodeVersion, npm: text("npm.version"), esbuild: read("esbuild.json").version },
    hookInventory: read("inventory.json"),
    npmEnforcement: read("npm-fixtures.json"),
    esbuildProof: read("esbuild.json"),
    limitations: [
      "min-release-age does not apply to versions pinned in package-lock.json under npm ci; " +
        "the lock is not retrospective provenance proof.",
      "Packages without registry publication timestamps and non-registry sources are not " +
        "age-checked.",
      "Install scripts are disabled, not reviewed; no hook was run and no hook exception exists.",
    ],
    run: {
      url: run,
      id: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      job: env.GITHUB_JOB,
      workflowRef: env.GITHUB_WORKFLOW_REF,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
    },
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verdict(manifest) {
  if (manifest.status === "failed") {
    return { code: 1, message: `asset generation failed: ${manifest.problems.join("; ")}` };
  }
  if (manifest.initialDrift.drifted) {
    return {
      code: 1,
      message:
        "committed public/ output is stale for this head. The artifact patch is repair evidence " +
        "only; apply it, push once and require fresh exact-head CI.",
    };
  }
  return { code: 0, message: "no drift: the committed output matches regeneration." };
}

// --------------------------------------------------------------------- cli

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "inventory") {
    const inv = inventoryHooks();
    writeFileSync(target, JSON.stringify(inv, null, 2));
    console.log(`root hooks: ${JSON.stringify(inv.rootHooks)}`);
    const hooked = inv.lockedDependencyHooks.map((h) => `${h.path}@${h.version}`);
    console.log(`locked dependency hooks: ${hooked.join(", ") || "none"}`);
    console.log(`non-registry lock sources: ${inv.nonRegistrySources.length}`);
    for (const p of inv.problems) console.error(`::error::${p}`);
    return inv.ok ? 0 : 1;
  }
  if (command === "npm-fixtures") {
    const result = await runNpmFixtures();
    writeFileSync(target, JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (command === "verify-esbuild") {
    const result = verifyEsbuild();
    writeFileSync(target, JSON.stringify(result, null, 2));
    for (const p of result.problems) console.error(`::error::${p}`);
    console.log(
      `esbuild ${result.version} via ${result.platformPackage}@${result.platformVersion}`,
    );
    return result.ok ? 0 : 1;
  }
  if (command === "collect") {
    const allowed = await allowedOutputs();
    const manifest = collect({ outDir: arg("out"), work: arg("work"), allowed });
    console.log(`asset generation: ${manifest.status}`);
    for (const p of manifest.problems) console.error(`::error::${p}`);
    return manifest.status === "failed" ? 1 : 0;
  }
  if (command === "verdict") {
    const v = verdict(JSON.parse(readFileSync(target, "utf8")));
    console[v.code ? "error" : "log"](v.code ? `::error::${v.message}` : v.message);
    return v.code;
  }
  console.error(
    "Usage: node ci/asset-generation.mjs <inventory|npm-fixtures|verify-esbuild> <out.json> | " +
      "collect --out DIR --work DIR | verdict manifest.json",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
