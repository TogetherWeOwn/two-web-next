// Inactive installer primitive. The caller must hold the Kit lock for the
// entire call, including preparation and rollback. A lock-release failure after
// this call succeeds is a post-commit error; do not roll back outside the lock.
// Design credit: Rick7C2.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

export const ENTRY_NAME = "_worker.js";
export const COMPANION_NAME = "kit-adapter.js";
export const FACADE_MARKER = "// two-web-kit-worker-facade v1";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stat = (path) => fs.lstatSync(path, { throwIfNoEntry: false });
const fail = (message) => {
  throw new Error(`worker facade: ${message}`);
};

// The caller holds the real Kit lock across inspection, preparation and rollback.
export async function installFacadeFiles({ root, prepare, io = {} }) {
  const entry = join(root, ENTRY_NAME);
  const companion = join(root, COMPANION_NAME);
  const staged = join(root, `${ENTRY_NAME}.facade.tmp`);
  const ignoreFile = join(root, ".assetsignore");
  const entryStat = stat(entry);
  if (!entryStat) fail(`missing generated adapter entry at ${entry}`);
  if (!entryStat.isFile()) fail("generated adapter entry is not a regular file");
  if (stat(companion) || stat(staged))
    fail("companion or staged file exists (duplicate installation?)");
  const adapter = fs.readFileSync(entry);
  const text = adapter.toString("utf8");
  if (text.trim() === "") fail("generated adapter entry is empty");
  if (text.includes("two-web-kit-worker-facade"))
    fail("entry is already a facade (duplicate installation)");
  const adapterSha = sha256(adapter);
  const ignoreStat = stat(ignoreFile);
  if (ignoreStat && !ignoreStat.isFile()) {
    throw new Error("worker facade: .assetsignore is not a regular file");
  }
  if (ignoreStat && ignoreStat.dev === entryStat.dev && ignoreStat.ino === entryStat.ino)
    fail(".assetsignore aliases the adapter");
  const previous = ignoreStat ? fs.readFileSync(ignoreFile) : null;
  const forward = { ...fs, ...io };
  const undoFs = { ...fs, ...io.undo };
  const undo = [];
  try {
    const fd = forward.openSync(staged, "wx");
    undo.push(() => undoFs.rmSync(staged, { force: true }));
    forward.closeSync(fd);
    const compiled = await prepare(text);
    const output = `${FACADE_MARKER} companion=${COMPANION_NAME} sha256=${adapterSha}\n${compiled.output}\nexport * from "./${COMPANION_NAME}";\n`;
    forward.writeFileSync(staged, output);
    if (stat(companion) || !fs.readFileSync(entry).equals(adapter))
      fail("adapter changed or companion exists (duplicate installation?)");
    forward.renameSync(entry, companion);
    undo.push(() => undoFs.renameSync(companion, entry));
    forward.renameSync(staged, entry);
    undo.push(() => undoFs.renameSync(entry, staged));

    // latin1 round-trips arbitrary bytes in an existing ignore file.
    const base =
      previous === null ? `${entry.split(/[\\/]/).pop()}\n` : previous.toString("latin1");
    const name = companion.split(/[\\/]/).pop();
    if (base.split(/\r?\n/).filter(Boolean).at(-1) !== name) {
      const next = Buffer.from(`${base.replace(/\n?$/, "\n")}${name}\n`, "latin1");
      undo.push(() =>
        previous === null
          ? undoFs.rmSync(ignoreFile, { force: true })
          : undoFs.writeFileSync(ignoreFile, previous),
      );
      forward.writeFileSync(ignoreFile, next);
    }
    return { adapterSha256: adapterSha, facadeSha256: sha256(output), companion };
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
}
