// Internal response marker, never read from a Request. The successful upcoming
// renderer sets it; cache entries retain it as metadata. The outer CSP consumer
// removes it before release. Replacement errors cannot inherit a render decision.
export const EVENTS_INLINE_CSS_MARKER = "x-two-events-inline-css";

export function isEventsInlineCssResponse(response: Response): boolean {
  return (
    response.headers.get(EVENTS_INLINE_CSS_MARKER) === "true" &&
    (response.status === 200 || response.status === 422) &&
    (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim() === "text/html"
  );
}

export function takeEventsInlineCssResponse(response: Response): boolean {
  const classified = isEventsInlineCssResponse(response);
  response.headers.delete(EVENTS_INLINE_CSS_MARKER);
  return classified;
}

export function markEventsInlineCssResponse(response: Response): Response {
  response.headers.set(EVENTS_INLINE_CSS_MARKER, "true");
  return response;
}
