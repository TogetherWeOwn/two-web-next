import type { BotFailure, BotSuccess } from "../jobs/types";

export type RoleAssignResult = BotSuccess<{ outcome: "assigned" | "already_held" }>;
export type AnnouncementResult = BotSuccess<{ messageId: string; replayed: boolean }>;
export type EventUpsertResult = BotSuccess<{
  outcome: "created" | "updated";
  discordEventId: string;
  replayed: boolean;
}>;

export type EventCancelResult = BotSuccess<{ outcome: "cancelled"; discordEventId: string }>;

export type InternalActionResult =
  | RoleAssignResult
  | AnnouncementResult
  | EventUpsertResult
  | EventCancelResult;
export type InternalActionAnswer = InternalActionResult | BotFailure;

export type BotClientOptions = {
  url: string | undefined;
  secret: string | undefined;
  keyId: string | undefined;
  timeoutSeconds?: number;
  fetchFn?: typeof fetch;
  /**
   * Keep stdout clean for machine callers: the per-call success diagnostic
   * moves to stderr (alongside refusals) instead of stdout. The
   * internal-action CLIs set this in `--json` mode so stdout carries exactly
   * one document.
   */
  stderrDiagnostics?: boolean;
};
