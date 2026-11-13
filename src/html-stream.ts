// HTML wire encoding (TWO-7591/TWO-8089): staging Lighthouse flagged every
// HTML response served uncompressed while CSS/JSON carried Content-Encoding.
// Live probes of the deployed remote-placement lane
// (cf-placement: remote-*) show the platform marking text/html responses
// `cache-control: no-transform` on the wire regardless of declared
// Content-Length — unknown-length streams included — while the same lane
// compresses JSON, CSS, SVG and markdown. A locally placed worker (the apex
// lane, placement.mode: off, and wrangler dev) lets the edge br/gzip HTML
// itself, but the remote lane's edge pass marks HTML untransformable and
// skips encoding; dropping the declared length (#2174) removed the marker
// trigger without removing the mark.
//
// Because the platform marks the remote lane untransformable, the Worker
// must encode the document itself: when the client advertises gzip via
// Accept-Encoding the document body pipes through CompressionStream("gzip")
// and answers Content-Encoding: gzip with Vary: accept-encoding. encodeBody
// stays "manual" so the platform's second negotiation never re-encodes the
// payload (double compression); a gzip-less Accept-Encoding gets the plain
// unknown-length stream instead, with the same vary already covering the
// negotiated axis. CompressionStream has no br format, so in-worker br is
// not an option; gzip satisfies the wire contract the lane left open.
//
// Scope stays text/html + unencoded bodies only: JSON, feeds and text routes
// already compress on the wire through the platform pass, and a pre-encoded
// response (any future passthrough asset) must never be wrapped into double
// compression. Private responses keep their existing cache-control; only
// the entity encoding is added.

/** True when this response is the HTML document the Worker must encode. */
function needsHtmlWireEncoding(response: Response): boolean {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return false;
  if (response.headers.get("content-encoding")) return false;
  if (!response.body) return false;
  // An already-consumed or reader-locked body cannot be piped into the wrap;
  // serve it as-is rather than throw on the dispatch path.
  if (response.bodyUsed || response.body.locked) return false;
  // WebSocket upgrade responses own their frame stream; never wrap them.
  if ((response as { webSocket?: unknown }).webSocket) return false;
  return true;
}

// Accept-Encoding token parse: gzip or * counts unless the client refused
// it outright with q=0 (any other q-weight still means "accepted"). The lane
// offers no way to emit br from Worker code (CompressionStream is
// gzip/deflate only), so brotli-only clients get the plain stream — the same
// outcome the edge pass would give them on this lane.
function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("accept-encoding");
  if (!header) return false;
  for (const token of header.split(",")) {
    const [coding, ...params] = token.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") continue;
    const q = params
      .map((param) => param.trim())
      .find((param) => param.startsWith("q="))
      ?.slice(2);
    if (q === undefined || Number(q) > 0) return true;
  }
  return false;
}

/** Append accept-encoding to Vary unless the response already varies on it. */
function varyAcceptEncoding(headers: Headers): void {
  const vary = headers.get("vary");
  if (!vary) {
    headers.set("vary", "accept-encoding");
    return;
  }
  if (vary.split(",").some((name) => ["accept-encoding", "*"].includes(name.trim().toLowerCase())))
    return;
  headers.set("vary", `${vary}, accept-encoding`);
}

/**
 * Encode an HTML document for the wire on the remote-placement lane. When
 * the client accepts gzip the body streams through CompressionStream with
 * Content-Encoding: gzip; otherwise it streams plain at unknown length.
 * Either way encodeBody is "manual" because the app now owns encoding — the
 * platform's pass stays out of a payload it must not re-encode. Status,
 * statusText and every other header (except the stale Content-Length) are
 * preserved; non-HTML and already-encoded responses return the same object
 * untouched.
 */
export function withStreamedBody(response: Response, request: Request): Response {
  if (!needsHtmlWireEncoding(response)) return response;
  const headers = new Headers(response.headers);
  // The encoded body has no declared length; a stale Content-Length would
  // describe the identity representation the body no longer matches.
  headers.delete("content-length");
  varyAcceptEncoding(headers);
  const gzip = acceptsGzip(request);
  if (gzip) headers.set("content-encoding", "gzip");
  const body = gzip ? response.body!.pipeThrough(new CompressionStream("gzip")) : response.body!;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    // The app owns encoding on this lane: identity streams must not be
    // re-encoded by the platform pass, and the gzip body is already final.
    encodeBody: "manual",
  });
}
