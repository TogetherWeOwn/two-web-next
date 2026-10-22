// Source evidence only; never imports inventory data or touches a database.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const PROTECTED_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "ci/db-migrate.mjs",
  "ci/migration-admission.mjs",
  "ci/migration-runtime-rights.mjs",
  "ci/staging-rights-inventory.mjs",
  "ci/staging-rights-inventory.test.mjs",
  "ci/staging-rights-inventory/fixtures.mjs",
  "ci/staging-rights-inventory/manifest.mjs",
  "ci/staging-rights-inventory/reads.mjs",
  "ci/staging-rights-inventory/synthetic.mjs",
  "ci/staging-rights-inventory/workflow.yml.disabled",
  "docs/staging-rights-inventory.md",
  "package-lock.json",
  "package.json",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });

export function sourceManifest({ head, tree, entries, readBlob }) {
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(tree))
    throw new Error("inventory stopped");
  const treeManifest = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (new Set(treeManifest.map((r) => r.path)).size !== treeManifest.length)
    throw new Error("inventory stopped");
  const files = PROTECTED_PATHS.map((path) => {
    const row = treeManifest.find((r) => r.path === path);
    if (
      !row ||
      row.type !== "blob" ||
      !["100644", "100755"].includes(row.mode) ||
      !/^[a-f0-9]{40}$/.test(row.oid)
    )
      throw new Error("inventory stopped");
    const bytes = readBlob(row.oid);
    if (!Buffer.isBuffer(bytes)) throw new Error("inventory stopped");
    return { path, mode: row.mode, gitBlob: row.oid, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    format: "source-git-blobs-v1",
    head,
    tree,
    canonicalization: "raw git cat-file blob bytes; no checkout filters or newline normalization",
    sourceOnly: true,
    liveAdmissionImplemented: false,
    treeManifestSha256: sha256(Buffer.from(JSON.stringify(treeManifest))),
    treeManifest,
    files,
  };
}

export function manifestForHead() {
  const head = git("rev-parse", "HEAD").toString("utf8").trim();
  const tree = git("rev-parse", `${head}^{tree}`).toString("utf8").trim();
  const entries = git("ls-tree", "-r", "-z", head)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const split = line.indexOf("\t");
      if (split < 0) throw new Error("inventory stopped");
      const [mode, type, oid] = line.slice(0, split).split(" ");
      return { path: line.slice(split + 1), mode, type, oid };
    });
  return sourceManifest({ head, tree, entries, readBlob: (oid) => git("cat-file", "blob", oid) });
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(manifestForHead(), null, 2)}\n`);
  } catch {
    process.stdout.write("inventory stopped\n");
    process.exitCode = 1;
  }
}
