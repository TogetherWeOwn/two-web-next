// HTML wire encoding (TWO-7591): staging Lighthouse flagged every HTML
// response served uncompressed while CSS/JSON carried Content-Encoding. The
// production probe shows the platform signature for an untransformable body:
// a fixed Content-Length plus an edge-appended `cache-control: no-transform`
// pair on every text/html response — the same pair the assets layer emits for
// pre-encoded files. Streaming the document removes the declared length, so
// the edge treats the response as transformable and applies its own
// br/gzip negotiation (the platform mechanism: no compression middleware in
// the Worker). The compression layer already appends Vary: accept-encoding on
// encoded variants; the app never sets Content-Encoding itself.
//
// Scope is deliberately text/html + unencoded bodies only: JSON, feeds and
// text routes already compress on the wire, and a pre-encoded response (any
// future passthrough asset) must never be wrapped into double compression.

/** True when the edge should treat this response body as transformable HTML. */
function needsStreamedBody(response: Response): boolean {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return false;
  if (response.headers.get("content-encoding")) return false;
  if (!response.body) return false;
  // WebSocket upgrade responses own their frame stream; never wrap them.
  if ((response as { webSocket?: unknown }).webSocket) return false;
  return true;
}

/**
 * Re-wrap an HTML response so its body streams at unknown length. Status,
 * statusText, every header (except the stale Content-Length) and the
 * streaming body are preserved; encodeBody stays the automatic default so a
 * streamed body is never marked manual. Non-HTML and already-encoded
 * responses return the same object untouched.
 */
export function withStreamedBody(response: Response): Response {
  if (!needsStreamedBody(response)) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(response.body!.pipeThrough(new TransformStream()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
