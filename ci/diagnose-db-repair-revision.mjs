import { execFileSync } from "node:child_process";

const workflow = ".github/workflows/db-permissions-repair.yml";
const selector = ".github/scripts/select-db-repair-revision.sh";
const git = (...args) =>
  execFileSync("git", ["--no-replace-objects", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function report(approved, dispatch) {
  for (const sha of [approved, dispatch]) {
    if (!/^[a-f0-9]{40}$/.test(sha ?? "") || git("cat-file", "-t", sha).trim() !== "commit") {
      throw new Error("Expected two full commit SHAs.");
    }
  }
  git("merge-base", "--is-ancestor", approved, dispatch);
  for (const path of [workflow, selector]) git("cat-file", "-e", `${dispatch}:${path}`);
  const changedPaths = git(
    "diff",
    "--name-only",
    "-z",
    "--no-relative",
    "--no-renames",
    "--no-ext-diff",
    "--ignore-submodules=none",
    approved,
    dispatch,
    "--",
  )
    .split("\0")
    .slice(0, -1)
    .sort();
  const changedRecoveryPaths = changedPaths.filter(
    (path) => path === workflow || path === selector,
  );
  return {
    approved,
    dispatch,
    forward: approved === dispatch ? "SHA matches" : "Dispatch SHA differs from approval pin",
    undo: changedRecoveryPaths.length ? "Workflow or selector changed" : "Revision check matches",
    changedRecoveryPaths,
    changedPaths,
  };
}

try {
  if (process.argv.length !== 4) throw new Error("Expected two full commit SHAs.");
  console.log(JSON.stringify(report(process.argv[2], process.argv[3]), null, 2));
} catch {
  console.error(
    "Source comparison refused. Supply two available commit SHAs in main ancestry order.",
  );
  process.exitCode = 1;
}
