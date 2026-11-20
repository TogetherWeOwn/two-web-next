import { lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { admitKitLockRoot } from "./kit-lock-admission.mjs";

// Only cooperative processes may mutate the admitted private, stable tree. In particular,
// the identity check and rmdir are not an atomic compare-and-remove against hostile actors.
export function createKitLock({ admit, mkdir, lstat, rmdir }) {
  return async function withKitLock(root, operation, rollback) {
    const handle = admit(root);
    const lock = join(handle.path, ".kit-install.lock");
    let owned;
    let result;
    let failed = false;
    let failure;
    const cleanupErrors = [];
    try {
      handle.recheck();
      mkdir(lock, { mode: 0o700 }); // EEXIST, including a stale lock, fails closed.
      const stat = lstat(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("lock is not a directory");
      owned = { dev: stat.dev, ino: stat.ino };
      handle.recheck();
      const current = lstat(lock);
      if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) {
        throw new Error("lock identity changed before operation");
      }
      try {
        result = await operation();
      } catch (error) {
        failed = true;
        failure = error;
        if (rollback) {
          try {
            await rollback(error);
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
          }
        }
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (owned) {
      try {
        handle.recheck();
        const current = lstat(lock);
        if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) {
          throw new Error("lock identity changed before release");
        }
        rmdir(lock); // Nonrecursive: unexpected contents prevent release.
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        failed ? [failure, ...cleanupErrors] : cleanupErrors,
        "kit lock failed",
      );
    }
    if (failed) throw failure;
    return result;
  };
}

// Inactive until a separately reviewed installer calls it.
export const withKitLock = createKitLock({
  admit: admitKitLockRoot,
  mkdir: mkdirSync,
  lstat: (path) => lstatSync(path, { bigint: true }),
  rmdir: rmdirSync,
});
