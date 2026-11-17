import type { KitLockRoot } from "./kit-lock-admission.mjs";

type LockOperation = <T>(
  root: string,
  operation: () => Promise<T> | T,
  rollback?: (failure: unknown) => Promise<void> | void,
) => Promise<T>;

type LockStat = {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** Test seam. The same private-tree and cooperative-process prerequisites apply. */
export function createKitLock(env: {
  admit(path: string): KitLockRoot;
  mkdir(path: string, options: { mode: number }): void;
  lstat(path: string): LockStat;
  rmdir(path: string): void;
}): LockOperation;

/** Hold an exclusive lock through the operation and any awaited rollback. */
export const withKitLock: LockOperation;
