import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { admitKitLockRoot } from "../web/scripts/kit-lock-admission.mjs";

async function regularBuildPath(path) {
  const stat = await lstat(path);
  assert.ok(
    stat.isDirectory() || stat.isFile(),
    "built Kit output must not link outside the fixture",
  );
  return true;
}

// This tree has one producer and one consumer. The hosted fixture owns it
// until both Workers stop; nothing publishes or reuses it outside that job.
export async function prepareInstalledKitWorker(repo) {
  const root = process.env.XFS_FIXTURE_ROOT;
  assert.ok(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      root,
    "installed Kit output requires the hosted XFS fixture",
  );
  const admission = admitKitLockRoot(root);
  try {
    const { COMPANION_NAME, ENTRY_NAME, FACADE_MARKER, installWorkerFacade } = await import(
      "../web/scripts/install-worker-facade.mjs"
    );
    const checkout = await mkdtemp(join(root, "kit-runtime-"));
    const kitBuild = join(checkout, "web", ".svelte-kit");
    const stockBuild = join(repo, "web", ".svelte-kit");
    await mkdir(kitBuild, { recursive: true, mode: 0o700 });
    for (const name of ["cloudflare", "cloudflare-tmp", "output"]) {
      const source = join(stockBuild, name);
      assert.ok((await lstat(source)).isDirectory(), `missing Kit build directory ${name}`);
      await mkdir(join(kitBuild, name), { mode: 0o700 });
      await cp(source, join(kitBuild, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: regularBuildPath,
      });
    }
    // Keep the same ESM package scopes and resolve against the job's locked
    // dependencies. These links are outside the generated tree and assets.
    for (const directory of ["", "web"]) {
      await copyFile(
        join(repo, directory, "package.json"),
        join(checkout, directory, "package.json"),
      );
      await symlink(
        join(repo, directory, "node_modules"),
        join(checkout, directory, "node_modules"),
      );
    }
    await symlink(join(repo, "web", "src"), join(checkout, "web", "src"));

    const assets = join(kitBuild, "cloudflare");
    const worker = join(assets, ENTRY_NAME);
    admission.recheck();
    const installed = await installWorkerFacade({ dir: assets });
    const adapter = await readFile(join(assets, COMPANION_NAME));
    const facade = await readFile(worker);
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.ok(adapter.equals(await readFile(join(stockBuild, "cloudflare", ENTRY_NAME))));
    assert.equal(hash(adapter), installed.adapterSha256);
    assert.equal(hash(facade), installed.facadeSha256);
    assert.ok(
      facade
        .toString()
        .startsWith(
          `${FACADE_MARKER} companion=${COMPANION_NAME} sha256=${installed.adapterSha256}\n`,
        ),
    );
    assert.ok((await lstat(join(assets, "favicon.ico"))).isFile(), "missing installed Kit assets");
    admission.recheck();
    console.log(`PASS admitted XFS Kit facade (sha256 ${installed.facadeSha256})`);
    return { worker, assets };
  } finally {
    admission.close();
  }
}
