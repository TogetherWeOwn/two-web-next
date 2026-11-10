import type { Tx } from "./types";

/** Per-statement bounds, not a transaction-duration bound on bot observation awaits. */
export async function setIngressDeadlines(tx: Tx, lockWaitMs: number): Promise<void> {
  const timeoutMs = Math.max(1, Math.floor(lockWaitMs));
  await tx.unsafe(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
  await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
}

export function isIngressBusy(error: unknown): boolean {
  // Drizzle wraps driver failures (dispatch's pg-proxy update path): a real
  // PostgreSQL 57014 arrives as DrizzleQueryError with no outer code and the
  // PostgresError in `cause`. Walk a bounded cause chain matching structured
  // codes only — never message text, which may contain secrets — so wrapped
  // cancellations map to operation_busy like top-level ones. Depth 8 also
  // terminates on cyclic causes.
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || current === undefined) return false;
    const code = (current as { code?: unknown }).code;
    if (code === "55P03" || code === "57014") return true;
    if (typeof current !== "object") return false;
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined) return false;
    current = next;
  }
  return false;
}
