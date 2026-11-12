import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { classifyStatus, parseStatus, validateRaw } from "./asset-output-boundary.mjs";

// Collect only; this does not run a generator, write an artifact, or issue a verdict.
// The caller must provide an isolated checkout with no concurrent writers. Like
// git diff, intent-to-add updates its index for newly generated files.
export function collectAssetPatch({ root, sourceSha, allowed }) {
  if (typeof root !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw new Error("expected checkout and exact source SHA");
  }
  // Do not inherit repository, index, configuration or pathspec selectors.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_LITERAL_PATHSPECS = "1";
  // Bound each Git response; oversized output fails closed rather than being truncated.
  const runGit = (...args) =>
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.filemode=true", ...args], {
      cwd: root,
      env,
      maxBuffer: 1024 * 1024,
    });
  const git = (...args) => runGit(...args).toString("utf8");
  const head = () => git("rev-parse", "--verify", "HEAD").trim();
  if (
    realpathSync(git("rev-parse", "--show-toplevel").replace(/\n$/, "")) !== realpathSync(root) ||
    head() !== sourceSha
  ) {
    throw new Error("checkout does not match source SHA or root");
  }
  // Validate the allowlist before passing its paths to Git or the filesystem.
  classifyStatus([], allowed);
  if (allowed.length) {
    // check-attr cannot distinguish sentinel strings from identically named drivers.
    for (const name of ["unset", "unspecified"]) {
      for (const action of ["clean", "process"]) {
        try {
          git("config", "--get", `filter.${name}.${action}`);
          throw new Error("ambiguous conversion filter");
        } catch (error) {
          if (error.status !== 1) throw error;
        }
      }
    }
    const attrs = git(
      "check-attr",
      "-z",
      "text",
      "crlf",
      "eol",
      "filter",
      "ident",
      "working-tree-encoding",
      "--",
      ...allowed,
    ).split("\0");
    if (attrs.pop() !== "" || attrs.length !== allowed.length * 18)
      throw new Error("malformed attributes");
    for (let i = 2; i < attrs.length; i += 3) {
      if (attrs[i] !== "unspecified" && attrs[i] !== "unset")
        throw new Error("unsupported conversion attribute");
    }
    for (const path of allowed) {
      let entry;
      try {
        entry = lstatSync(join(root, path));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!entry.isFile() || entry.mode & 0o111) {
        throw new Error(`unsafe diff: non-regular or executable output: ${path}`);
      }
    }
    if (git("ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...allowed)) {
      throw new Error("ignored allowed output");
    }
  }

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
    "--no-color",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    ...files,
  );
  if (!patch.length || head() !== sourceSha) throw new Error("empty patch or changed source SHA");
  return { sourceSha, files, patch };
}
