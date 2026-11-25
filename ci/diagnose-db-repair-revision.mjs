import { execFileSync } from "node:child_process";

const recoveryPaths = [
  ".github/workflows/db-permissions-repair.yml",
  ".github/scripts/select-db-repair-revision.sh",
];
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
  const availableDispatchPaths = git(
    "ls-tree",
    "--full-tree",
    "-z",
    dispatch,
    "--",
    ...recoveryPaths,
  )
    .split("\0")
    .filter((entry) => /^100(?:644|755) blob /.test(entry))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const unavailableDispatchPaths = recoveryPaths.filter(
    (path) => !availableDispatchPaths.includes(path),
  );
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
  const changedRecoveryPaths = changedPaths.filter((path) => recoveryPaths.includes(path));
  const unavailable = unavailableDispatchPaths.length
    ? "Workflow or selector unavailable at dispatch"
    : null;
  return {
    approved,
    dispatch,
    forward:
      unavailable ??
      (approved === dispatch ? "SHA matches" : "Dispatch SHA differs from approval pin"),
    undo:
      unavailable ??
      (changedRecoveryPaths.length ? "Workflow or selector changed" : "Revision check matches"),
    unavailableDispatchPaths,
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
