// Inactive installer primitive. The caller must hold the Kit lock for the
// entire call, including preparation and rollback. Design credit: Rick7C2.
import * as fs from "node:fs";

// `prepare` runs after exclusive staged-file creation and returns facade bytes.
// The caller validates paths and inputs before entering this transaction.
export async function installFacadeFiles({
  entry,
  companion,
  staged,
  ignoreFile,
  previous,
  prepare,
  io = {},
}) {
  const forward = { ...fs, ...io };
  const undoFs = { ...fs, ...io.undo };
  const undo = [];
  try {
    const fd = forward.openSync(staged, "wx");
    undo.push(() => undoFs.rmSync(staged, { force: true }));
    forward.closeSync(fd);
    const output = await prepare();
    forward.writeFileSync(staged, output);
    forward.renameSync(entry, companion);
    undo.push(() => undoFs.renameSync(companion, entry));
    forward.renameSync(staged, entry);
    undo.push(() => undoFs.renameSync(entry, staged));

    // latin1 round-trips arbitrary bytes in an existing ignore file.
    const base =
      previous === null ? `${entry.split(/[\\/]/).pop()}\n` : previous.toString("latin1");
    const name = companion.split(/[\\/]/).pop();
    if (!base.split(/\r?\n/).includes(name)) {
      const next = Buffer.from(`${base.replace(/\n?$/, "\n")}${name}\n`, "latin1");
      undo.push(() =>
        previous === null
          ? undoFs.rmSync(ignoreFile, { force: true })
          : undoFs.writeFileSync(ignoreFile, previous),
      );
      forward.writeFileSync(ignoreFile, next);
    }
    return output;
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
