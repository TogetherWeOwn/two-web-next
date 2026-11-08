// Run a trusted caller-owned module, never a shell expression. This is a
// freshness boundary, not a sandbox or an implementation of recovery policy.
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertErrorRateIdentifiers, assertRollbackVersionId, assertVersionTag, GRADUAL_STEPS } from "./gradual-promote.mjs";

async function trackedEntry(workspace, path, env) {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const child = spawn("git", ["-C", workspace, "ls-files", "--stage", "-z", "--error-unmatch", "--", path], {
      env, shell: false, detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let output = "";
    let size = 0;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
      // Hard-kill the entire metadata group, including descendants retaining pipes.
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ }
      }
      child.stdout.destroy();
      if (success) resolve(output);
      else reject(new Error("metadata lookup refused"));
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) finish(false);
      else output += chunk;
    });
    child.once("error", cancel);
    child.once("close", (code, signal) => finish(code === 0 && !signal && performance.now() < deadline));
  });
}

export async function verifierConfig(env, platform = process.platform) {
  const required = env.REQUIRE_PRE_PROMOTION_VERIFIER ?? "false";
  if (!["true", "false"].includes(required)) throw new Error("invalid verifier requirement");
  const timeout = env.PRE_PROMOTION_TIMEOUT_SECONDS ?? "120";
  if (!/^[1-9][0-9]{0,2}$/.test(timeout) || Number(timeout) > 300) {
    throw new Error("verifier timeout must be an integer from 1 to 300 seconds");
  }
  const path = env.PRE_PROMOTION_VERIFIER ?? "";
  if (!path && required === "false") return null;
  if (platform === "win32") throw new Error("configured verification requires POSIX process groups");
  // No absolute paths, traversal, empty components, option/pathspec syntax,
  // shell metacharacters or non-module executables. Check every component.
  const parts = path.split("/");
  if (!path.endsWith(".mjs") || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === "." || p === ".." || p === ".git")) {
    throw new Error("verifier must be a repository-relative checked-in .mjs module");
  }
  if (!env.GITHUB_WORKSPACE || !isAbsolute(env.GITHUB_WORKSPACE)) {
    throw new Error("verifier requires an absolute GITHUB_WORKSPACE");
  }
  let file;
  let workspace;
  try {
    workspace = realpathSync(env.GITHUB_WORKSPACE);
    file = workspace;
    for (const [index, part] of parts.entries()) {
      file = join(file, part);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error("unsafe file type");
      }
    }
    // Git's index proves the entry is checked in. Ignore ambient GIT_* overrides
    // so a caller's unrelated worktree settings cannot select another index.
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
    const indexed = (await trackedEntry(workspace, path, gitEnv)).split("\0");
    // A pathspec also matches descendants; exit zero alone is insufficient.
    const entry = indexed[0]?.match(/^(100644|100755) [0-9a-f]+ 0\t(.+)$/);
    if (indexed.length !== 2 || indexed[1] !== "" || !entry || entry[2] !== path) {
      throw new Error("not an exact tracked regular-file entry");
    }
  } catch {
    throw new Error("verifier is unavailable, unsafe or not checked in");
  }
  assertErrorRateIdentifiers({ accountId: env.CLOUDFLARE_ACCOUNT_ID, scriptName: env.WORKER_NAME, versionId: env.NEW_VERSION });
  assertRollbackVersionId(env.PREV_VERSION);
  assertVersionTag(env.VERSION_TAG);
  const percentage = Number(env.PROMOTION_PERCENTAGE);
  if (!GRADUAL_STEPS.includes(percentage) || String(percentage) !== env.PROMOTION_PERCENTAGE) {
    throw new Error("invalid verifier promotion stage");
  }
  return {
    workspace, file, timeoutMs: Number(timeout) * 1000,
    args: ["--candidate-version-id", env.NEW_VERSION, "--candidate-tag", env.VERSION_TAG,
      "--worker-name", env.WORKER_NAME, "--account-id", env.CLOUDFLARE_ACCOUNT_ID,
      "--environment", "production", "--percentage", String(percentage),
      "--previous-version-id", env.PREV_VERSION],
  };
}

export async function runPrePromotionCheck(env, spawnImpl = spawn, monotonicNow = () => performance.now()) {
  const config = await verifierConfig(env);
  if (!config) return;
  await new Promise((resolve, reject) => {
    const deadline = monotonicNow() + config.timeoutMs;
    let child;
    try {
      child = spawnImpl(process.execPath, ["--", config.file, ...config.args], {
        cwd: config.workspace, env, shell: false, detached: true, stdio: "ignore",
      });
    } catch {
      reject(new Error("pre-promotion verifier could not start"));
      return;
    }
    let failureReason;
    const kill = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ }
      }
    };
    const abort = (reason) => { failureReason ??= reason; kill(); };
    const cancel = () => abort("was cancelled");
    const timer = setTimeout(() => abort("timed out"), Math.max(0, deadline - monotonicNow()));
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
      kill(); // A verifier must not leave background descendants behind.
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("pre-promotion verifier could not start"));
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (!failureReason && monotonicNow() >= deadline) failureReason = "timed out";
      if (failureReason || signal || code !== 0) reject(new Error(`pre-promotion verifier ${failureReason ?? "failed"}`));
      else resolve();
    });
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runPrePromotionCheck(process.env).catch(() => {
    // Neither module output nor exception details may disclose recovery secrets.
    console.error("::error::pre-promotion verification refused; no promotion permitted");
    process.exitCode = 1;
  });
}
