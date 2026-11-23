export class KitLockAdmissionError extends Error {
  cleanupError?: unknown;
}
export interface KitLockRoot {
  readonly path: string;
  /** Re-verify the retained descriptor, ancestors, procfs and XFS; throws, and closes, on change. */
  recheck(): void;
  /** Close the retained descriptor; idempotent. */
  close(): void;
}
export function admitKitLockRoot(path: string): KitLockRoot;
