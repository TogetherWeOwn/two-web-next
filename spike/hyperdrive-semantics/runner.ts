// Shared plumbing for the finite W1 local control runner (TOG-9680).
//
// A Promise.race alone cannot terminate a hung unstable_dev/workerd startup:
// the underlying dev process keeps running after the race settles. So startup
// has two bounds: this module fails fast under a wall-clock budget with a
// distinct exit code, and worker-checks.sh owns the runner's process group and
// TERM/KILLs it, so a never-ready startup cannot be orphaned.
//
// Plain TypeScript only (no enums/namespaces): worker-checks.mjs runs under
// plain node, which strips types. No Cloudflare credentials, no remote targets.
export const STARTUP_TIMEOUT_MS = 180_000;
export const STARTUP_FAILURE_EXIT = 2;
export const CHECK_FAILURE_EXIT = 1;

export interface Stoppable {
  stop(): Promise<void>;
}

/** Race a startup promise against a wall-clock budget. Never hangs. */
export function withStartupTimeout<T>(
  startup: Promise<T>,
  opts?: { timeoutMs?: number; onTimeout?: () => void },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? STARTUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        opts?.onTimeout?.();
      } finally {
        reject(new Error(`worker_startup_timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    // Do NOT unref: a never-resolving startup holds no event-loop handles, so
    // an unref'd timer would let the process exit 0 instead of firing.
  });
  return Promise.race([startup, timeout]).finally(() => clearTimeout(timer));
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  error?: unknown;
}

/**
 * Start one worker, run checks, always stop the worker.
 * - startup never resolves -> { exitCode: 2 } (shell wrapper reaps the group)
 * - checks throw -> { exitCode: 1 } after worker.stop()
 * - checks pass -> { exitCode: 0 } after worker.stop()
 */
export async function runWithWorker<W extends Stoppable>(opts: {
  startWorker: () => Promise<W>;
  runChecks: (worker: W) => Promise<void>;
  timeoutMs?: number;
  onStartupTimeout?: () => void;
}): Promise<RunResult> {
  let worker: W | undefined;
  try {
    worker = await withStartupTimeout(opts.startWorker(), {
      timeoutMs: opts.timeoutMs,
      onTimeout: opts.onStartupTimeout,
    });
  } catch (error) {
    return { exitCode: STARTUP_FAILURE_EXIT as 2, error };
  }
  try {
    await opts.runChecks(worker);
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: CHECK_FAILURE_EXIT as 1, error };
  } finally {
    await worker.stop();
  }
}
