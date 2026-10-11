// Discord transients: shared contract (structural split of
// ./discord-transients; zero behavior change). The outcome vocabulary the
// runbook pins, the read deadline, and the source/failure types both readers
// and the request-level factory depend on.

import type { DiscordTransient } from "../islands/contracts";

/**
 * Every `outcome` value the `Discord snapshot outcome` log can emit. The
 * runbook documents this exact set; the drift test fails when code and doc
 * differ, so a new outcome cannot ship undocumented.
 */
export const DISCORD_SNAPSHOT_OUTCOMES = ["cold", "held", "fresh", "stale", "error"] as const;

/** One of {@link DISCORD_SNAPSHOT_OUTCOMES}. */
export type DiscordSnapshotOutcome = (typeof DISCORD_SNAPSHOT_OUTCOMES)[number];

/** SQLSTATE codes allowed to leave the snapshot store in the outcome log. */
export const SAFE_SNAPSHOT_SQLSTATES = ["42501", "42P01", "55P03", "57014"];

/** One budget for headers and the entire body, so Discord cannot hold the calendar open. */
export const DISCORD_READ_DEADLINE_MS = 1000;

/**
 * Why one read failed, for diagnostics and shared retry eligibility. Never carries a message, URL, header
 * or body: a driver message can echo the bot token. `exception` is a fixed safe
 * error category. The error body is deliberately not read: a stalled one must not hold the page.
 */
export type ReadFailure = {
  reason: "deadline" | "status" | "aborted" | "no_body" | "invalid_payload" | "exception";
  status?: number;
  retryAfter?: number;
  exception?: string;
};

export interface DiscordEventsSource {
  /** Scheduled/active guild events (display-only transients). */
  upcoming(now?: Date): Promise<DiscordTransient[]>;
  /** True when the read behind `upcoming` failed — drives the error state. */
  lastReadFailed(): boolean;
  /** Sanitized internal metadata from this read, never reparsed from logs. */
  lastReadFailure?(): ReadFailure | null;
}
