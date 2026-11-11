// Standalone npm enforcement fixtures, extracted from #2133.
// Only synthetic packages and harmless marker hooks are installed in scratch space.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_NPM = "11.10.0";
function compareVersions(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

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
  writeFileSync(join(scratch, "user.npmrc"), "");
  writeFileSync(join(scratch, "global.npmrc"), "");
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    npm_config_userconfig: join(scratch, "user.npmrc"),
    npm_config_globalconfig: join(scratch, "global.npmrc"),
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
    const cfg = async (key) => (await runNpm(["config", "get", key], scratch, probeEnv)).out.trim();
    const reportedAge = await cfg("min-release-age");
    const reportedScripts = await cfg("ignore-scripts");
    must("npm reports min-release-age=3", reportedAge === "3", reportedAge);
    must("npm reports ignore-scripts=true", reportedScripts === "true", reportedScripts);

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
    for (const marker of MARKERS) rmSync(join(hooksOff.root, marker), { force: true });
    const ciOff = await runNpm(["ci", "--include=dev"], hooksOff.root, hooksOff.e);
    const seen = markersIn(hooksOff.root);
    must(
      "control: with scripts enabled the root and dependency hooks do run",
      ciOff.status === 0 && MARKERS.every((marker) => seen.includes(marker)),
      `${ciOff.out} markers=${seen.join(",")}`,
    );
  } catch (error) {
    must("fixtures completed", false, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      if (registry) {
        await new Promise((resolve, reject) =>
          registry.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// Usage: node ci/npm-policy-fixtures.mjs <result.json>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node ci/npm-policy-fixtures.mjs <result.json>");
    process.exitCode = 2;
  } else {
    const result = await runNpmFixtures();
    writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
