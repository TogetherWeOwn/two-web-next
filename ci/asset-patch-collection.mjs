import { execFileSync } from "node:child_process";
import { classifyStatus, parseStatus, validateRaw } from "./asset-output-boundary.mjs";

// Collect only; this does not run a generator, write an artifact, or issue a verdict.
// The caller must provide an isolated checkout with no concurrent writers. Like
// git diff, intent-to-add updates its index for newly generated files.
export function collectAssetPatch({ root, sourceSha, allowed }) {
  if (typeof root !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw new Error("expected checkout and exact source SHA");
  }
  // Bound each Git response; oversized output fails closed rather than being truncated.
  const runGit = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 1024 * 1024 });
  const git = (...args) => runGit(...args).toString("utf8");
  const head = () => git("rev-parse", "--verify", "HEAD").trim();
  if (head() !== sourceSha) throw new Error("checkout does not match source SHA");

  const status = parseStatus(git("status", "--porcelain=v1", "-z", "--untracked-files=all"));
  const { files, unexpected } = classifyStatus(status, allowed);
  if (unexpected.length) throw new Error(`unexpected outputs: ${unexpected.join(", ")}`);
  if (!files.length) return { sourceSha, files, patch: Buffer.alloc(0) };

  git("add", "--intent-to-add", "--", ...files);
  const raw = git("diff", "--raw", "-z", "--no-renames", "--full-index", "--", ...files);
  const problems = validateRaw(raw, allowed);
  if (problems.length) throw new Error(`unsafe diff: ${problems.join(", ")}`);
  const rawPaths = raw
    .split("\0")
    .filter((_, i) => i % 2 === 1)
    .sort();
  if (rawPaths.length !== files.length || rawPaths.some((path, i) => path !== files[i])) {
    throw new Error("status and diff paths differ");
  }
  const patch = runGit(
    "diff",
    "--binary",
    "--full-index",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    ...files,
  );
  if (!patch.length || head() !== sourceSha) throw new Error("empty patch or changed source SHA");
  return { sourceSha, files, patch };
}
