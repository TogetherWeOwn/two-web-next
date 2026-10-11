// Live HTTP client for the bot's POST /internal/actions. Ports two-web
// app/Services/Bot/InternalActionClient.php (wire format: two-bot
// docs/INTERNAL_ACTIONS.md) against the ported signer in ./signer.
//
// The client lives in ./client-*.ts, one leaf per concern: result types,
// per-call input validation, the retryable fallback table, envelope
// serialization, the signed transport, and the live-client factory. The
// export list below is exactly the previous export list of this file, so all
// importers keep working untouched.

export type {
  AnnouncementResult,
  BotClientOptions,
  EventCancelResult,
  EventUpsertResult,
  InternalActionAnswer,
  InternalActionResult,
  RoleAssignResult,
} from "./client-types";
export {
  validateAnnouncement,
  validateEventUpsert,
  validateRoleAssign,
} from "./client-validation";
export { retryableFallback } from "./client-retry";
export { assertBotConfigured } from "./client-transport";
export { createBotClient } from "./client-factory";
export type { BotActionClient } from "./client-factory";
