// Inactive installer for the Kit Worker response facade. Nothing calls it: no
// Vite, package script or Wrangler wiring runs it yet.
// Design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileKitFacade } from "./kit-facade-compiler.mjs";
import {
  COMPANION_NAME,
  ENTRY_NAME,
  FACADE_MARKER,
  installFacadeFiles,
} from "./kit-facade-transaction.mjs";
import { withKitLock } from "./kit-lock.mjs";

export { COMPANION_NAME, ENTRY_NAME, FACADE_MARKER };
export const DEFAULT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.svelte-kit/cloudflare",
);

// Hold the lock through preparation, installation, and rollback.
export async function installWorkerFacade({ dir = DEFAULT_DIR, io = {} } = {}) {
  const root = resolve(dir);
  return withKitLock(root, () => installFacadeFiles({ root, prepare: compileKitFacade, io }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const { adapterSha256 } = await installWorkerFacade({ dir });
  console.log(`installed Kit Worker facade in ${dir} (adapter sha256 ${adapterSha256})`);
}
