import type { Tx } from "./types";

/** Per-statement bounds, not a transaction-duration bound on bot observation awaits. */
export async function setIngressDeadlines(tx: Tx, lockWaitMs: number): Promise<void> {
  const timeoutMs = Math.max(1, Math.floor(lockWaitMs));
  await tx.unsafe(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
  await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
}

export function isIngressBusy(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "55P03" || code === "57014";
}
