// Fixed-pair build evidence only; this never changes canonical budget accounting.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { KIT_CLIENT_DIR, KIT_SERVER_DIR, KIT_WORKER_PATH } from "./bundle-inventory.mjs";

const refs = {
  base: "10099ce45e7f6a4f1ade945bbbca85278982109e",
  head: "97fdc74e2fd8053420c0420d6db15c8c2d12b7cc",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function exitStatus(result) {
  return result.error || result.signal || result.status === null ? 2 : result.status;
}

export function collectInventory(root) {
  const rows = [];
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    assert(!stat.isSymbolicLink(), `unexpected output symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else {
      assert(stat.isFile(), `unexpected output type: ${relative}`);
      const bytes = fs.readFileSync(absolute);
      const row = { path: relative, raw: bytes.length, sha256: hash(bytes) };
      if (relative.endsWith(".js")) row.gzip = gzipSync(bytes).length;
      // Keep map identities, not source content or served sourcemap copies.
      if (relative.endsWith(".map")) row.sources = JSON.parse(bytes.toString()).sources;
      rows.push(row);
    }
  }
  for (const relative of [KIT_WORKER_PATH, KIT_SERVER_DIR, "web/.svelte-kit/output/client"]) {
    visit(relative);
  }
  assert(rows.some((row) => row.path.startsWith(`${KIT_CLIENT_DIR}/`) && row.gzip));
  assert(rows.some((row) => row.path.startsWith(`${KIT_SERVER_DIR}/`) && row.gzip));
  return rows;
}

function runPair(pair, evidence) {
  fs.mkdirSync(evidence, { recursive: false });
  const summary = { qualification: false, complete: false, results: {} };
  const saveSummary = () => json(path.join(evidence, "summary.json"), summary);
  saveSummary();
  for (const [name, sha] of Object.entries(refs)) {
    const root = path.resolve(pair, name);
    const out = path.join(evidence, name);
    fs.mkdirSync(out);
    const env = {
      ...process.env,
      npm_config_ignore_scripts: "true",
      npm_config_min_release_age: "3",
      npm_config_cache: path.join(root, ".diagnostic-npm"),
    };
    const capture = (command, args) => {
      const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
      assert.equal(exitStatus(result), 0, `${command} ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    assert.equal(capture("git", ["rev-parse", "HEAD"]), sha);
    for (const relative of ["node_modules", "web/node_modules", "web/.svelte-kit"]) {
      assert(!fs.existsSync(path.join(root, relative)), `not a clean install/output: ${relative}`);
    }
    const inputs = [
      "package.json",
      "package-lock.json",
      "web/package.json",
      "web/package-lock.json",
      "web/vite.config.ts",
      "ci/check-kit-perf.mjs",
      "ci/bundle-inventory.mjs",
    ];
    json(path.join(out, "identity.json"), {
      sha,
      tree: capture("git", ["rev-parse", "HEAD^{tree}"]),
      node: process.version,
      versions: process.versions,
      npm: capture("npm", ["--version"]),
      nodeSha256: hash(fs.readFileSync(process.execPath)),
      npmSha256: hash(fs.readFileSync(fs.realpathSync(capture("which", ["npm"])))),
      runner: { os: process.env.ImageOS, image: process.env.ImageVersion, arch: process.arch },
      inputs: Object.fromEntries(
        inputs.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
      ),
      install: { ignoreScripts: true, minReleaseAgeDays: 3, frozenLocks: true },
    });
    const log = fs.openSync(path.join(out, "build.log"), "w");
    try {
      for (const args of [["ci/deps-audit.mjs"], ["ci/check-dependency-pins.mjs"]]) {
        const result = spawnSync(process.execPath, args, {
          cwd: root,
          env,
          stdio: ["ignore", log, log],
        });
        assert.equal(exitStatus(result), 0, `pre-install gate failed; see ${name}/build.log`);
      }
      for (const args of [
        ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        ["ci", "--prefix", "web", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      ]) {
        const result = spawnSync("npm", args, { cwd: root, env, stdio: ["ignore", log, log] });
        assert.equal(exitStatus(result), 0, `install failed; see ${name}/build.log`);
      }
      for (const [command, args] of [
        [process.execPath, ["ci/build-leaf-css.mjs"]],
        ["npm", ["run", "build", "--prefix", "web"]],
      ]) {
        const result = spawnSync(command, args, { cwd: root, env, stdio: ["ignore", log, log] });
        assert.equal(exitStatus(result), 0, `build failed; see ${name}/build.log`);
      }
    } finally {
      fs.closeSync(log);
    }
    const checker = spawnSync(process.execPath, ["ci/check-kit-perf.mjs", "--format", "json"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    fs.writeFileSync(path.join(out, "checker.json"), checker.stdout ?? "");
    fs.writeFileSync(path.join(out, "checker.stderr"), checker.stderr ?? "");
    summary.results[name] = { sha, checkerExitCode: exitStatus(checker) };
    saveSummary();
    json(path.join(out, "inventory.json"), collectInventory(root));
    capture("tar", [
      "--exclude=*.map",
      "-czf",
      path.join(out, "generated.tar.gz"),
      KIT_WORKER_PATH,
      KIT_SERVER_DIR,
      "web/.svelte-kit/output/client",
    ]);
    assert.equal(capture("git", ["status", "--porcelain", "--untracked-files=no"]), "");
  }
  summary.complete = true;
  saveSummary();
  return (
    Object.values(summary.results).find((result) => result.checkerExitCode !== 0)?.checkerExitCode ?? 0
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    4,
    "usage: kit-budget-diagnostic.mjs <pair-directory> <new-evidence-directory>",
  );
  process.exitCode = runPair(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
}
