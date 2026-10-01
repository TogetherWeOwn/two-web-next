import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAuditWorker } from "./a11y-build.mjs";

// Discover real registration order offline; never invoke a request handler.
export async function loadAuditWorkerRoutes() {
  const scratch = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "a11y-route-test-"));
  try {
    await symlink(resolve("node_modules"), join(scratch, "node_modules"), "dir");
    const bundle = join(scratch, "worker.mjs");
    await buildAuditWorker(bundle);
    const { routes, coverage } = await import(pathToFileURL(bundle).href);
    return { routes, coverage };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
