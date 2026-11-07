import {
  isKitFallbackDocument,
  robotsTagFor,
  securityHeadersFor,
  withKitFallbackStyleCsp,
} from "./headers";
import { newRequestId, safeRequestId } from "./request-log";

// Kit can replace a hook response, or render error.html after the hook throws.
// This boundary runs AFTER adapter.fetch, not inside handle/resolve. Complete
// Hono, Kit and asset envelopes pass through untouched, including their CSP,
// cookies, cache policy and renderer label. It never retries a failed request.
export async function protectKitWorkerResponse(
  request: Request,
  response: Response,
  env: { APP_URL: string; FEATURED_IMAGE_HOSTS?: string },
): Promise<Response> {
  const url = new URL(request.url);
  const security = securityHeadersFor(
    { path: url.pathname, method: request.method },
    env.FEATURED_IMAGE_HOSTS,
  );
  if (security.every(([name]) => response.headers.get(name))) return response;

  // ASSETS/fetch responses may have immutable headers. Preserve the stream and
  // every non-security header, especially separate Set-Cookie values.
  const headers = new Headers(response.headers);
  for (const [name, value] of security) headers.set(name, value);
  headers.set("cache-control", "no-store");
  headers.set("x-two-renderer", "kit");
  headers.set("x-two-origin", "two-web-next");
  headers.set(
    "x-request-id",
    safeRequestId(response.headers.get("x-request-id")) ??
      safeRequestId(request.headers.get("cf-ray")) ??
      newRequestId(),
  );
  const contentType = headers.get("content-type") ?? "";
  if (contentType === "text/html" || contentType.toLowerCase() === "text/html; charset=utf-8") {
    headers.set("content-type", "text/html; charset=UTF-8");
  }
  if (contentType.includes("text/html")) {
    const tag = robotsTagFor(env.APP_URL, url.hostname);
    if (tag) headers.set("x-robots-tag", tag);
    if (response.status >= 400 && response.body !== null) {
      // Reuse the existing exact-template style allowlist. Do not inspect JSON,
      // redirects or successful streamed pages. Unreadable errors retain the
      // restrictive CSP, just like the in-hook fallback protection.
      try {
        if (isKitFallbackDocument(await response.clone().text())) {
          headers.set(
            "content-security-policy",
            withKitFallbackStyleCsp(headers.get("content-security-policy")!),
          );
        }
      } catch (error) {
        console.warn("kit edge fallback style probe unreadable; serving without the style hash.", {
          exception: (error as Error)?.constructor?.name ?? "unknown",
        });
      }
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
