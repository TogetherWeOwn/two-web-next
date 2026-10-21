// Caller-supplied run identities for the internal-action probes
// (src/probes/bot-smoke.ts, src/probes/internal-action-drill.ts).
//
// A run identity makes a repeated apply replay the same operation instead of
// minting a fresh one: the same validated `--run-id` derives the same
// announcement/event idempotency carriers and the same generated event key,
// so a resume replays the original carriers rather than posting twice.
// Distinct identities derive distinct carriers. Runs without an identity keep
// the old behavior (fresh `crypto.randomUUID()` carriers per run).

import { createHash } from "node:crypto";
import { BotTerminalError } from "../jobs/types";

/** Run identities are 1-64 chars: letters, digits, `_` and `-`, leading alnum. */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const RUN_ID_RULE =
  "a run identity (--run-id) is 1-64 characters: letters, digits, underscore and hyphen, starting with a letter or digit";

/**
 * Validate a caller-supplied run identity. Throws BotTerminalError (exit 2:
 * misconfigured) on a malformed identity. Never echoes the value: even a
 * refused option can contain a credential that belongs in the environment.
 */
export function validateRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new BotTerminalError(`invalid run identity: ${RUN_ID_RULE}.`);
  }
}

const hash = (runId: string, purpose: string): Buffer =>
  createHash("sha256").update(runId, "utf8").update("\0", "utf8").update(purpose, "utf8").digest();

/**
 * Derive a stable UUIDv4-shaped idempotency carrier for one purpose within a
 * run (`"smoke:announcement"`, `"smoke:event"`, `"drill:announcement"`).
 * Same identity plus same purpose is the same carrier; anything else differs.
 */
export function deriveUuid(runId: string, purpose: string): string {
  const bytes = [...hash(runId, purpose).subarray(0, 16)];
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Derive the generated smoke event key for a run identity. Same shape as the
 * unkeyed generator (`tog10112-` plus 12 hex chars), stable per identity.
 */
export function deriveEventKey(runId: string): string {
  return `tog10112-${hash(runId, "smoke:event-key").toString("hex").slice(0, 12)}`;
}

// The payload clock for a named run: a fixed base plus a per-identity spread
// over one leap year, so the same identity replays the same instant and
// distinct identities spread across windows instead of sharing one.
const PAYLOAD_CLOCK_BASE_MS = Date.UTC(2030, 0, 1);
const PAYLOAD_CLOCK_SPAN_MS = 366 * 86_400_000;

/**
 * Derive the stable payload instant for a run identity. The probes stamp
 * announcement bodies and event windows with this instead of the wall clock
 * when a run identity is present, so a repeated apply signs byte-identical
 * payloads under the same carriers. Pure derivation, like deriveUuid.
 */
export function derivePayloadAt(runId: string): Date {
  const spread = Number(
    hash(runId, "probe:payload-clock").readBigUInt64BE() % BigInt(PAYLOAD_CLOCK_SPAN_MS),
  );
  return new Date(PAYLOAD_CLOCK_BASE_MS + spread);
}
