import { BotTransportError } from "./types";

/**
 * Per-call bound for the queued internal-action bot round-trip (TOG-11628).
 *
 * Ledger/lock cleanup is already bounded; the BotClient promise itself was
 * awaited bare, so one hung call stalled the whole serial batch behind it.
 * Past this deadline the attempt fails as a transport wait (retry/backoff
 * below the tries cap, terminal above it) — the same disposition as "bot
 * down". The deadline never implies the remote call rolled back: the bot may
 * still apply it late, so announcement redelivery reuses the carrier's
 * original idempotency key and role.assign keeps its natural idempotency.
 *
 * Pinned so changes are deliberate. 10 s is far above a healthy bot
 * round-trip (a POST to the bot's /internal/actions) so it never
 * false-positives one, yet bounds each attempt for realistic drill-only
 * batch sizes. There is no owned transport to abort here — the BotClient
 * owns the fetch — so the helper bounds the wait and always clears its
 * timer; a signal-aware bot client can add its own abort later without
 * changing this contract.
 */
export const INTERNAL_ACTION_DEADLINE_MS = 10_000;

/**
 * Race `op` against the deadline. The timer is always cleared, and a late
 * settle after the deadline wins is ignored: it can never reclassify the
 * already-disposed outcome (Promise.race stays attached to both branches, so
 * a late rejection is handled, not unhandled).
 */
export async function withInternalActionDeadline<T>(
  op: Promise<T>,
  ms: number = INTERNAL_ACTION_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BotTransportError(`internal action timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([op, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
