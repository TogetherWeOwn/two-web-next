import type { Context } from "hono";
import { safeRequestId } from "./request-log";

// Fixed categories only: even an error name/constructor can carry member data
// or a throwing getter. Diagnostics must not turn an accepted fallback into 500.
function admissionExceptionClass(err: unknown): string {
  try {
    if (err instanceof TypeError) return "TypeError";
    if (err instanceof RangeError) return "RangeError";
    if (err instanceof ReferenceError) return "ReferenceError";
    if (err instanceof SyntaxError) return "SyntaxError";
    if (err instanceof URIError) return "URIError";
    if (err instanceof EvalError) return "EvalError";
    if (err instanceof AggregateError) return "AggregateError";
    if (err instanceof Error) return "Error";
  } catch {
    // A rejected proxy can throw during prototype inspection; do not inspect it again.
    return "unknown";
  }
  return "unknown";
}

/** Only the two existing throw-to-allow admissions use these warning codes. */
export function warnAdmissionStoreFailure(
  c: Context,
  throttle: "join" | "profile-write",
  err: unknown,
): void {
  const requestId = safeRequestId(c.get("requestId"));
  console.warn(
    JSON.stringify({
      event: throttle === "join" ? "join.throttle.store_failed" : "profile.throttle.store_failed",
      throttle,
      exception: admissionExceptionClass(err),
      ...(requestId ? { request_id: requestId } : {}),
    }),
  );
}
