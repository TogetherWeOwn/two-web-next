// Inactive installer for the Kit Worker response facade. Nothing calls it: no
// Vite, package script or Wrangler wiring runs it yet.
//
// After adapter-cloudflare writes _worker.js, this moves the adapter to a
// same-directory companion and writes a facade at the canonical path. The
// facade wraps the adapter default export with createKitWorkerFacade
// (src/kit-worker-facade.ts), which keeps handler and fetch semantics and
// protects only fetch's returned Response (src/kit-worker-response.ts).
// Design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3
// (web/scripts/install-worker-facade.mjs).
//
// Every ambiguous input throws and leaves the directory as it was found, and
// a failure part-way through undoes each completed step in reverse order.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileKitFacade } from "./kit-facade-compiler.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const ENTRY_NAME = "_worker.js";
export const COMPANION_NAME = "kit-adapter.js";
export const FACADE_MARKER = "// two-web-kit-worker-facade v1";
export const DEFAULT_DIR = resolve(here, "../.svelte-kit/cloudflare");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stat = (path) => fs.lstatSync(path, { throwIfNoEntry: false });
const fail = (message) => {
  throw new Error(`worker facade: ${message}`);
};
function regularFile(path, label) {
  const found = stat(path);
  if (!found) fail(`missing ${label} at ${path}`);
  if (!found.isFile()) fail(`${label} is not a regular file`);
}

// Installs the facade into `dir`. `io` overrides the mutating fs calls (and
// `io.undo` the rollback calls) so tests can inject failures.
export async function installWorkerFacade({ dir = DEFAULT_DIR, io = {} } = {}) {
  const { writeFileSync, renameSync } = { ...fs, ...io };
  const undoFs = { ...fs, ...io.undo };
  const root = resolve(dir);
  const entry = join(root, ENTRY_NAME);
  const companion = join(root, COMPANION_NAME);
  const ignoreFile = join(root, ".assetsignore");
  const staged = join(root, `${ENTRY_NAME}.facade.tmp`);

  regularFile(entry, "generated adapter entry");
  if (stat(companion) || stat(staged))
    fail("companion or staged file exists (duplicate installation?)");
  const adapter = fs.readFileSync(entry);
  const text = adapter.toString("utf8");
  if (text.trim() === "") fail("generated adapter entry is empty");
  if (text.includes("two-web-kit-worker-facade"))
    fail("entry is already a facade (duplicate installation)");
  const ignoreStat = stat(ignoreFile);
  if (ignoreStat && !ignoreStat.isFile()) fail(".assetsignore is not a regular file");

  const adapterSha = sha256(adapter);
  let output;

  // Exact bytes: latin1 round-trips any byte sequence, so non-UTF-8 survives.
  const previous = ignoreStat ? fs.readFileSync(ignoreFile) : null;
  const base = previous ? previous.toString("latin1") : `${ENTRY_NAME}\n`;
  const nextIgnore = base.split(/\r?\n/).includes(COMPANION_NAME)
    ? null
    : Buffer.from(`${base.replace(/\n?$/, "\n")}${COMPANION_NAME}\n`, "latin1");

  const undo = [];
  try {
    // Own the staged file before rolling it back: exclusive creation that fails
    // with EEXIST means another actor made it, so it is never removed.
    const rmStaged = () => undoFs.rmSync(staged, { force: true });
    try {
      writeFileSync(staged, "", { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") undo.push(rmStaged);
      throw error;
    }
    undo.push(rmStaged);
    // A previous installer may have completed while this call was preparing.
    if (stat(companion) || !fs.readFileSync(entry).equals(adapter))
      fail("adapter changed or companion exists (duplicate installation?)");
    const compiled = await compileKitFacade(text);
    output = `${FACADE_MARKER} companion=${COMPANION_NAME} sha256=${adapterSha}\n${compiled.output}\nexport * from "./${COMPANION_NAME}";\n`;
    writeFileSync(staged, output);
    renameSync(entry, companion);
    undo.push(() => undoFs.renameSync(companion, entry));
    renameSync(staged, entry);
    undo.push(() => undoFs.renameSync(entry, staged));
    if (nextIgnore !== null) {
      undo.push(() =>
        previous === null
          ? undoFs.rmSync(ignoreFile, { force: true })
          : undoFs.writeFileSync(ignoreFile, previous),
      );
      writeFileSync(ignoreFile, nextIgnore);
    }
  } catch (error) {
    const failures = undo.reverse().flatMap((step) => {
      try {
        step();
        return [];
      } catch (rollbackError) {
        return [rollbackError];
      }
    });
    if (failures.length) {
      const detail = failures.map((failure) => failure?.message).join("; ");
      throw new AggregateError(
        [error, ...failures],
        `worker facade: rollback failed after "${error?.message}"; directory may be inconsistent: ${detail}`,
      );
    }
    throw error;
  }
  return { adapterSha256: adapterSha, facadeSha256: sha256(output), companion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const { adapterSha256 } = await installWorkerFacade({ dir });
  console.log(`installed Kit Worker facade in ${dir} (adapter sha256 ${adapterSha256})`);
}
