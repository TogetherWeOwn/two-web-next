// Re-export barrel: branded pages live in ./error-pages, response builders and
// handlers in ./error-responses, app wiring in ./error-registration. Existing
// imports stay supported alongside the shared negotiation helpers.
export {
  BadRequestPage,
  ForbiddenPage,
  GonePage,
  InternalErrorPage,
  MaintenancePage,
  NotFoundPage,
  PayloadTooLargePage,
  RateLimitedPage,
} from "./error-pages";
export { registerErrorHandlers } from "./error-registration";
export {
  badRequest,
  databaseUnavailable,
  forbidden,
  gone,
  internalErrorHandler,
  maintenanceHandler,
  MCP_TRANSPORT_ERROR_CODE,
  notFoundHandler,
  notFoundResponse,
  payloadTooLarge,
  prefersHtmlError,
  rateLimitExceeded,
  varyAccept,
} from "./error-responses";
