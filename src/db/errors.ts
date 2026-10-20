// postgres transport errors can be wrapped in DrizzleQueryError.cause. Match
// structured driver codes, never query/message text (which may contain secrets).
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
]);
// Lock/statement cancellation is retryable too. Moderator mutations await
// transaction rollback before propagating it to the existing outage response.
const SERVER_UNAVAILABLE_CODES = new Set(["57P01", "57P02", "57P03", "53300", "55P03", "57014"]);
const QUERY_CANCELLATION_CODES = new Set(["55P03", "57014"]);

export function isDatabaseQueryCancellation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!(current instanceof Error)) return false;
    const coded = current as Error & { code?: unknown };
    if (
      current.name === "PostgresError" &&
      typeof coded.code === "string" &&
      QUERY_CANCELLATION_CODES.has(coded.code)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function isDatabaseUnavailable(error: unknown): boolean {
  // Bound traversal also handles cyclic causes. Syntax, constraint and ordinary
  // programming errors deliberately remain 500s, not maintenance responses.
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!(current instanceof Error)) return false;
    const coded = current as Error & { code?: unknown };
    if (typeof coded.code === "string") {
      if (TRANSPORT_CODES.has(coded.code)) return true;
      if (
        current.name === "PostgresError" &&
        (/^08[0-9A-Z]{3}$/.test(coded.code) || SERVER_UNAVAILABLE_CODES.has(coded.code))
      ) {
        return true;
      }
    }
    current = current.cause;
  }
  return false;
}
