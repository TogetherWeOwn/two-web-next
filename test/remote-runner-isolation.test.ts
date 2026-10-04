import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  buildPreviewLaunch,
  createPreviewWorkspace,
  main,
} from "../spike/hyperdrive-semantics/remote-runner";
import { REMOTE_TARGET } from "../spike/hyperdrive-semantics/remote-target";

// All inputs are synthetic, local, and disposable. Never import/run the Wrangler
// CLI, use real alternate credentials, start a Worker, or contact any provider.
const root = process.cwd();
const fixtures: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(
    path.join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.tmpdir(),
      "w1-isolation-",
    ),
  );
  fixtures.push(dir);
  return dir;
};
function makeWritable(dir: string) {
  chmodSync(dir, 0o700);
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) makeWritable(path.join(dir, item.name));
    // Never follow the snapshot's dependency symlink while removing fixtures.
  }
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of fixtures.splice(0)) {
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function sourceBetween(source: string, start: string, end: string) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  expect(first, `missing pinned source start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(last, `missing pinned source end: ${end}`).toBeGreaterThan(first);
  return source.slice(first, last);
}

// Execute ONLY the pinned CLI's pure dotenv implementation and exact CLI check,
// in a VM with synthetic process.env/cwd. Its bundled dotenv/expand dependencies
// only require built-ins; no Wrangler initialization/auth/telemetry runs here.
function loadViaPinnedWrangler(cwd: string, env: NodeJS.ProcessEnv, envFiles?: string[]) {
  const source = readFileSync(
    path.join(root, "node_modules/wrangler/wrangler-dist/cli.js"),
    "utf8",
  );
  expect(
    JSON.parse(readFileSync(path.join(root, "node_modules/wrangler/package.json"), "utf8")).version,
  ).toBe("4.145.0");
  const require = createRequire(import.meta.url);
  const context = vm.createContext({
    process: { env: { ...env }, cwd: () => cwd, platform: "linux" },
    __require: (name: string) => {
      if (!["fs", "path", "os", "crypto"].includes(name))
        throw new Error("non_builtin_require_refused");
      return require(name);
    },
    Buffer,
    URL,
    args: envFiles === undefined ? {} : { "env-file": envFiles },
    logger2: { debug() {}, log() {} },
  });
  vm.runInContext(
    `
    const __name = (value) => value;
    const init_import_meta_url = () => {};
    const __commonJS = (callbacks) => {
      let module;
      return () => {
        if (!module) { module = { exports: {} }; Object.values(callbacks)[0](module.exports, module); }
        return module.exports;
      };
    };
    const path28 = { resolve: (...parts) => __require("path").resolve(process.cwd(), ...parts) };
    const path28__namespace = { default: __require("path") };
    ${sourceBetween(source, "var require_package = __commonJS({", "function validateFileSecrets(")}
    ${sourceBetween(source, "var require_main2 = __commonJS({", "// src/config/case-insensitive-env.ts")}
    ${sourceBetween(source, "function getDefaultEnvFiles(", "var import_dotenv2, import_dotenv_expand, isWindows5;")}
    const isWindows5 = false;
    const import_dotenv2 = { default: require_main() };
    const import_dotenv_expand = { default: require_main2() };
    ${sourceBetween(source, '    const resolvedEnvFilePaths = (args["env-file"]', "    writeOutput({")}
  `,
    context,
    { timeout: 1000 },
  );
  return (context.process as { env: NodeJS.ProcessEnv }).env;
}

describe("remote runner dotenv/credential isolation (offline)", () => {
  it("demonstrates that the CLI-wide loader ignores the dev-vars disable flag", () => {
    const repo = fixture();
    writeFileSync(
      path.join(repo, ".env"),
      "CLOUDFLARE_API_KEY=synthetic-key-not-a-grant\nCLOUDFLARE_EMAIL=fixture@example.invalid\nEXTRA_TARGET=synthetic-env\n",
    );
    writeFileSync(path.join(repo, ".env.local"), "EXTRA_TARGET=synthetic-env-local\n");
    const loaded = loadViaPinnedWrangler(repo, {
      CLOUDFLARE_API_TOKEN: "synthetic-assigned-token",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    });
    expect(loaded.CLOUDFLARE_API_TOKEN).toBe("synthetic-assigned-token");
    expect(loaded.CLOUDFLARE_API_KEY).toBe("synthetic-key-not-a-grant");
    expect(loaded.CLOUDFLARE_EMAIL).toBe("fixture@example.invalid");
    expect(loaded.EXTRA_TARGET).toBe("synthetic-env-local");
  });

  it("uses an isolated cwd/home AND explicit empty env-file, preserving only the whitelist", async () => {
    const repo = fixture();
    writeFileSync(path.join(repo, ".env"), "CLOUDFLARE_API_KEY=synthetic-repo-key\n");
    writeFileSync(path.join(repo, ".env.local"), "EXTRA_TARGET=synthetic-repo-target\n");
    const preview = await createPreviewWorkspace(repo);
    expect(readFileSync(path.join(preview, "empty.env"), "utf8")).toBe("");
    expect(statSync(preview).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(preview, "home")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(preview, "empty.env")).mode & 0o777).toBe(0o600);
    const launch = buildPreviewLaunch(
      "/synthetic/wrangler",
      preview,
      path.join(preview, "wrangler.json"),
      12345,
      {
        PATH: "/synthetic/bin",
        HOME: "/synthetic/ambient-home",
        CLOUDFLARE_API_TOKEN: "synthetic-assigned-token",
        CLOUDFLARE_API_KEY: "synthetic-ambient-key",
        DATABASE_URL: "synthetic-not-a-url",
        QA_TOKEN: "synthetic-qa",
        NODE_OPTIONS: "synthetic-do-not-pass",
        WRANGLER_API_BASE_URL: "https://example.invalid",
      },
    );
    expect(launch.options).toMatchObject({ cwd: preview, detached: false });
    expect(launch.options.env).toEqual({
      PATH: "/synthetic/bin",
      HOME: path.join(preview, "home"),
      TMPDIR: preview,
      CLOUDFLARE_API_TOKEN: "synthetic-assigned-token",
      CLOUDFLARE_ACCOUNT_ID: REMOTE_TARGET.accountId,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      WRANGLER_LOG_PATH: preview,
    });
    expect(launch.args).toContain("--remote");
    expect(
      launch.args.slice(launch.args.indexOf("--env-file"), launch.args.indexOf("--env-file") + 2),
    ).toEqual(["--env-file", path.join(preview, "empty.env")]);
    expect(launch.args.slice(launch.args.indexOf("--ip"), launch.args.indexOf("--ip") + 2)).toEqual(
      ["--ip", "127.0.0.1"],
    );
    expect(
      launch.args.slice(
        launch.args.indexOf("--inspector-ip"),
        launch.args.indexOf("--inspector-ip") + 2,
      ),
    ).toEqual(["--inspector-ip", "127.0.0.1"]);
    const envFile = launch.args[launch.args.indexOf("--env-file") + 1]!;
    expect(loadViaPinnedWrangler(launch.options.cwd, launch.options.env, [envFile])).toEqual(
      launch.options.env,
    );
    // Also prove the explicit file prevents defaults if a stray dotenv file is
    // present in the isolated cwd: isolation alone is not the regression fix.
    writeFileSync(path.join(preview, ".env"), "CLOUDFLARE_API_KEY=synthetic-preview-key\n");
    writeFileSync(path.join(preview, ".env.local"), "EXTRA_TARGET=synthetic-preview-target\n");
    expect(loadViaPinnedWrangler(preview, launch.options.env).CLOUDFLARE_API_KEY).toBe(
      "synthetic-preview-key",
    );
    expect(loadViaPinnedWrangler(preview, launch.options.env, [envFile])).toEqual(
      launch.options.env,
    );
  });

  it("refuses unsupervised mutable-tree execution before any provider read", async () => {
    vi.stubEnv("W1_REMOTE_RUN_DIR", "");
    const fetch = vi.fn(() => {
      throw new Error("offline_no_network");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(main()).rejects.toThrow("remote_supervised_snapshot_required");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function supervisor(dir: string) {
  const wrapper = readFileSync(
    path.join(root, "spike/hyperdrive-semantics/remote-checks.sh"),
    "utf8",
  );
  const source = wrapper.match(/<<'PY'\n([\s\S]+)\nPY\n/)?.[1];
  expect(source).toBeDefined();
  const file = path.join(dir, "supervisor.py");
  writeFileSync(file, source!);
  return file;
}
function python(file: string, body: string, args: string[] = []) {
  // Import definitions only, not production main: no provider/Worker process.
  const result = execFileSync(
    "python3",
    [
      "-c",
      `import json, os, pathlib, runpy, sys\nn = runpy.run_path(sys.argv[1])\n${body}`,
      file,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH },
    },
  );
  return JSON.parse(result);
}
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: "Synthetic Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}
function committedFixture(dir: string) {
  // Git objects/HEAD exist only in this disposable fixture, never this worktree.
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  mkdirSync(path.join(repo, "spike/hyperdrive-semantics"), { recursive: true });
  writeFileSync(
    path.join(repo, "spike/hyperdrive-semantics/remote-worker.ts"),
    'import { value } from "./source"; export default { value };\n',
  );
  writeFileSync(
    path.join(repo, "spike/hyperdrive-semantics/source.ts"),
    'export const value = "committed-synthetic-source";\n',
  );
  const packages = Object.fromEntries(
    ["esbuild", "wrangler", "postgres"].map((name) => [
      "node_modules/" + name,
      { version: "0.0.0-fixture" },
    ]),
  );
  writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ packages }));
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", ".");
  const tree = git(repo, "write-tree");
  const revision = git(repo, "commit-tree", tree, "-m", "disposable synthetic snapshot fixture");
  git(repo, "update-ref", "HEAD", revision);
  for (const name of ["esbuild", "wrangler", "postgres"]) {
    mkdirSync(path.join(repo, "node_modules", name), { recursive: true });
    writeFileSync(
      path.join(repo, "node_modules", name, "package.json"),
      JSON.stringify({ version: "0.0.0-fixture" }),
    );
  }
  const run = path.join(dir, "run");
  mkdirSync(run);
  return { repo, run, revision };
}

describe("committed source provenance (offline disposable Git fixtures)", () => {
  it.each(["tracked", "untracked"])("refuses a %s dirty tree before bundling", (kind) => {
    const dir = fixture();
    const script = supervisor(dir);
    const { repo, run } = committedFixture(dir);
    writeFileSync(
      path.join(repo, kind === "tracked" ? "spike/hyperdrive-semantics/source.ts" : "untracked.ts"),
      "synthetic-dirty-source",
    );
    const result = python(
      script,
      `
try:
    n["snapshot_source"](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
    print(json.dumps({"refused": False}))
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))`,
      [repo, run],
    );
    expect(result).toEqual({ error: "remote_source_tree_not_clean" });
    expect(existsSync(path.join(run, "source"))).toBe(false);
  });

  it("refuses source drift during archive creation", () => {
    const dir = fixture();
    const script = supervisor(dir);
    const { repo, run } = committedFixture(dir);
    const result = python(
      script,
      `
original_git = n["snapshot_source"].__globals__["git"]
def drifting_git(repo, *args):
    result = original_git(repo, *args)
    if args[0] == "archive":
        (repo / "spike/hyperdrive-semantics/source.ts").write_text("synthetic-concurrent-edit")
    return result
n["snapshot_source"].__globals__["git"] = drifting_git
try:
    n["snapshot_source"](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
    print(json.dumps({"refused": False}))
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))`,
      [repo, run],
    );
    expect(result).toEqual({ error: "remote_source_tree_not_clean" });
  });

  it("bundles the recorded immutable snapshot even if the working tree changes afterwards", () => {
    const dir = fixture();
    const script = supervisor(dir);
    const { repo, run, revision } = committedFixture(dir);
    const result = python(
      script,
      `
source, revision = n["snapshot_source"](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
print(json.dumps({"source": str(source), "revision": revision}))`,
      [repo, run],
    );
    expect(result.revision).toBe(revision);
    expect(readFileSync(path.join(result.source, ".w1-source-revision"), "utf8").trim()).toBe(
      revision,
    );
    expect(statSync(result.source).mode & 0o222).toBe(0);
    expect(
      statSync(path.join(result.source, "spike/hyperdrive-semantics/source.ts")).mode & 0o222,
    ).toBe(0);
    writeFileSync(
      path.join(repo, "spike/hyperdrive-semantics/source.ts"),
      'export const value = "mutable-worktree-race";\n',
    );
    writeFileSync(
      path.join(repo, "spike/hyperdrive-semantics/remote-worker.ts"),
      'export default { value: "mutable-entrypoint-race" };\n',
    );
    const bundle = path.join(run, "fixture-bundle.mjs");
    execFileSync(
      path.join(root, "node_modules/.bin/esbuild"),
      [
        path.join(result.source, "spike/hyperdrive-semantics/remote-worker.ts"),
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--outfile=" + bundle,
      ],
      { stdio: "pipe", env: { PATH: process.env.PATH } },
    );
    const built = readFileSync(bundle, "utf8");
    expect(built).toContain("committed-synthetic-source");
    expect(built).not.toContain("mutable-worktree-race");
    expect(built).not.toContain("mutable-entrypoint-race");
  });

  it("refuses installed dependency versions that drift from the snapshot lockfile", () => {
    const dir = fixture();
    const script = supervisor(dir);
    const { repo, run } = committedFixture(dir);
    writeFileSync(
      path.join(repo, "node_modules/wrangler/package.json"),
      JSON.stringify({ version: "synthetic-mismatch" }),
    );
    const result = python(
      script,
      `
try:
    n["snapshot_source"](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
    print(json.dumps({"refused": False}))
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))`,
      [repo, run],
    );
    expect(result).toEqual({ error: "remote_installed_dependency_mismatch" });
  });
});

describe("supervisor failure evidence (benign local processes only)", () => {
  it.each([
    "SIGKILL",
    "deadline",
    "invalid artifact",
    "valid artifact",
    "valid refusal artifact",
    "zero exit",
  ])("persists sanitized evidence after %s", (kind) => {
    const dir = fixture();
    const script = supervisor(dir);
    const result = python(
      script,
      `
revision = "c" * 40
schema = "w1_staging_" + "d" * 32
captured = {}
g = n["main"].__globals__
original_bounded = g["run_bounded"]
def snapshot(repo, run_dir):
    captured["run_dir"] = run_dir
    source = run_dir / "fixture-source"
    (source / "node_modules/wrangler").mkdir(parents=True)
    (source / "node_modules/wrangler/package.json").write_text(json.dumps({"version": "4.143.1"}))
    return source, revision
expected = {"revision": revision, "wranglerVersion": "4.143.1",
            "runtime": "ephemeral-remote-preview-not-deployed-worker",
            "receipt": {}, "result": {"ok": False, "error": "remote_staging_preflight_refused", "cleanup": True}}
if sys.argv[3] == "valid refusal artifact": expected["result"]["refusal"] = ["binding_user_mismatch", "receipt_target_mismatch"]
def bounded(command, cwd, env, timeout_s, grace_s=10, output=None):
    if command[0].endswith("/esbuild"):
        runner = pathlib.Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--outfile=")))
        runner.write_text(r'''import { writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.env.W1_REMOTE_RUN_DIR;
writeFileSync(path.join(dir, "private-wrangler.log"), "private synthetic-token-not-evidence\\nW1_SCHEMA " + JSON.stringify({schema: "%s", created: true, cleanup: "not_verified"}) + "\\nW1_SCHEMA {\\"schema\\":\\"invalid-synthetic-token-not-evidence\\"}\\n");
if ("%s" === "invalid artifact") writeFileSync(path.join(dir, "result.json"), "null");
if ("%s".startsWith("valid ")) writeFileSync(path.join(dir, "result.json"), %s);
if ("%s" === "deadline") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else if ("%s" !== "zero exit") process.kill(process.pid, "SIGKILL");
''' % (schema, sys.argv[3], sys.argv[3], json.dumps(json.dumps(expected)), sys.argv[3], sys.argv[3]))
        return 0
    return original_bounded(command, cwd, env, timeout_s=0.5, grace_s=0.1, output=output)
g["snapshot_source"] = snapshot
g["run_bounded"] = bounded
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()):
    status = n["main"](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[2]))
run_dir = captured["run_dir"]
evidence = json.loads((run_dir / "result.json").read_text())
try:
    os.waitpid(-1, os.WNOHANG)
    reaped = False
except ChildProcessError:
    reaped = True
print(json.dumps({"status": status, "evidence": evidence, "expected": expected,
                  "reaped": reaped, "mode": (run_dir / "result.json").stat().st_mode & 0o777}))`,
      [dir, kind],
    );
    expect(result.status).toBe(kind === "deadline" ? 124 : kind === "zero exit" ? 1 : 137);
    expect(result.reaped).toBe(true);
    expect(result.mode).toBe(0o600);
    if (kind.startsWith("valid ")) expect(result.evidence).toEqual(result.expected);
    else
      expect(result.evidence).toMatchObject({
        revision: "c".repeat(40),
        wranglerVersion: "4.143.1",
        runnerExitStatus: kind === "zero exit" ? 0 : result.status,
        result: { ok: false, cleanup: "not_verified", schema: "w1_staging_" + "d".repeat(32) },
      });
    expect(JSON.stringify(result.evidence)).not.toContain("synthetic-token-not-evidence");
  });
});

describe("independent timeout process ownership (benign local processes only)", () => {
  it.each(["supervisor deadline", "GNU timeout SIGKILL of runner"])(
    "kills and actually reaps all descendants after %s",
    (kind) => {
      const dir = fixture();
      const script = supervisor(dir);
      const runner = path.join(dir, "benign-runner.mjs");
      const pidFile = path.join(dir, "pids");
      const detached = buildPreviewLaunch("unused", dir, "unused", 12345, {}).options.detached;
      writeFileSync(
        runner,
        `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
process.on("SIGTERM", () => {});
appendFileSync(process.argv[2], process.pid + "\\n");
const level = Number(process.argv[3]);
if (level < 2) spawn(process.execPath, [import.meta.filename, process.argv[2], String(level + 1)], { detached: ${detached}, stdio: "ignore" });
setInterval(() => {}, 1000);
`,
      );
      try {
        const result = python(
          script,
          `
n["enable_subreaper"]()
command = [sys.argv[2], sys.argv[3], sys.argv[4], "0"]
if sys.argv[5] == "gnu":
    # --foreground makes GNU timeout SIGKILL only Node; its descendants really
    # are left orphaned for OUR independent supervisor to kill and reap.
    command = ["timeout", "--foreground", "--kill-after=0.2s", "0.6s", *command]
status = n["run_bounded"](command, pathlib.Path(sys.argv[3]).parent, {"PATH": os.environ["PATH"]},
                           timeout_s=2 if sys.argv[5] == "gnu" else 0.6, grace_s=0.2)
pids = [int(pid) for pid in pathlib.Path(sys.argv[4]).read_text().splitlines()]
try:
    os.waitpid(-1, os.WNOHANG)
    children_reaped = False
except ChildProcessError:
    children_reaped = True
print(json.dumps({"status": status, "pids": pids, "childrenReaped": children_reaped,
                  "remaining": [pid for pid in pids if pathlib.Path("/proc", str(pid)).exists()]}))`,
          [process.execPath, runner, pidFile, kind === "supervisor deadline" ? "outer" : "gnu"],
        );
        expect(result.status).toBe(kind === "supervisor deadline" ? 124 : 137);
        expect(result.pids).toHaveLength(3);
        expect(result.childrenReaped).toBe(true);
        // Do not count zombie states as success: waitpid removes /proc entries.
        expect(result.remaining).toEqual([]);
      } finally {
        // Prevent survivors if a regression breaks the supervisor itself.
        if (existsSync(pidFile))
          for (const pid of readFileSync(pidFile, "utf8").trim().split("\n")) {
            try {
              process.kill(Number(pid), "SIGKILL");
            } catch {
              /* Already reaped. */
            }
          }
      }
    },
    10_000,
  );
});
