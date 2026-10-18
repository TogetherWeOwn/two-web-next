// Re-export barrel: branded pages live in ./error-pages, response builders and
// handlers in ./error-responses, app wiring in ./error-registration. The export
// list below is exactly the previous export list of this file, so all importers
// keep working untouched.
export {
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
  databaseUnavailable,
  forbidden,
  gone,
  internalErrorHandler,
  maintenanceHandler,
  notFoundHandler,
  notFoundResponse,
  payloadTooLarge,
  rateLimitExceeded,
} from "./error-responses";
