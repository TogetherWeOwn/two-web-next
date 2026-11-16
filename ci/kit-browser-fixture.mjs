// Build a caller-supplied route in a disposable copy, never in the source tree.
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Never traverse a copied link while creating a destination.
async function rejectLinkAncestors(root, path) {
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(`Fixture symlink in destination: ${relative(root, current)}`);
  }
}

// Reject absolute, escaping, and dangling links before any copied code executes.
async function validateLinks(root, path = root) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    if (isAbsolute(target) || !inside(root, await realpath(path))) {
      throw new Error(`Fixture symlink escapes copy: ${relative(root, path)}`);
    }
  } else if (stat.isDirectory()) {
    for (const name of await readdir(path)) await validateLinks(root, join(path, name));
  }
}

/** The callback receives { root, output }; its fixture route exists only in root. */
export async function withKitBrowserFixture({ source = process.cwd(), page }, callback) {
  source = await realpath(source);
  const scratch = await realpath(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir());
  if (scratch === source || inside(source, scratch))
    throw new Error("Fixture scratch must be outside source");
  const root = await mkdtemp(join(scratch, "kit-browser-"));
  try {
    const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: source })
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const file of files) {
      const dest = resolve(root, file);
      if (!inside(root, dest)) throw new Error(`Invalid tracked path: ${file}`);
      await rejectLinkAncestors(root, dirname(dest));
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(source, file), dest, { verbatimSymlinks: true });
    }
    for (const dir of ["node_modules", "web/node_modules"]) {
      const dest = join(root, dir);
      await rejectLinkAncestors(root, dest);
      await cp(join(source, dir), dest, { recursive: true, verbatimSymlinks: true });
    }
    await validateLinks(root);
    const route = join(root, "web/src/routes/__browser_fixture__");
    await mkdir(route, { recursive: true });
    await writeFile(join(route, "+page.svelte"), page);
    await writeFile(join(route, "+page.ts"), "export const csr = false;\n");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      XDG_CACHE_HOME: join(root, ".cache"),
      npm_config_cache: join(root, ".npm-cache"),
    };
    execFileSync("npm", ["run", "build", "--prefix", "web"], { cwd: root, env, stdio: "inherit" });
    return await callback({ root, output: join(root, "web/.svelte-kit/output") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
