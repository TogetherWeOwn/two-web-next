import type {} from "./render-clock-build.d.ts";
import { fixtureRequest } from "./fixture-origin";

// Only the generated local fixture build defines this. Runtime bindings and
// request input cannot turn a shipped Worker into a capture build.
const captureBuild = typeof __TWO_LOCAL_CAPTURE__ !== "undefined" && __TWO_LOCAL_CAPTURE__ === true;
export const SSR_CAPTURE_INSTANT = "2098-12-31T20:00:00Z";
export const SSR_CAPTURE_HEADER = "x-two-ssr-clock";

export interface RenderClockEnv {
  APP_URL?: string;
  SSR_CAPTURE_FIXTURE?: string;
}

export function captureRequest(request: Request, env: RenderClockEnv): boolean {
  return (
    captureBuild &&
    env.SSR_CAPTURE_FIXTURE === "true" &&
    ["GET", "HEAD"].includes(request.method) &&
    fixtureRequest(request, env.APP_URL)
  );
}

// A fresh value per call: never put a mutable Date on env, an isolate global,
// a session, or a cache. Consumers may use it only for derived display state.
export function renderDate(request: Request, env: RenderClockEnv): Date {
  return captureRequest(request, env) ? new Date(SSR_CAPTURE_INSTANT) : new Date();
}

// Deliberately bounded coverage. Other frozen rows have unresolved source,
// privacy-window or operational-clock dependencies; they must not qualify.
export function capturePathCovered(path: string): boolean {
  return (
    ["/about", "/faq", "/rules", "/privacy", "/auth/recover"].includes(path) ||
    /^\/e\/[A-Za-z0-9_-]+$/.test(path) ||
    path === "/events/past"
  );
}

export function captureRefusal(request: Request, env: RenderClockEnv): Response | undefined {
  const path = new URL(request.url).pathname;
  // Asset loads are not capture rows and never carry the qualification marker.
  const asset = /\.(?:css|js|woff2?|png|svg|ico|webmanifest)$/.test(path);
  if (!captureRequest(request, env) || capturePathCovered(path) || asset) return;
  return new Response("SSR capture clock is not qualified for this route.\n", {
    status: 412,
    headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

export function captureResponse(
  request: Request,
  env: RenderClockEnv,
  response: Response,
): Response {
  if (!captureRequest(request, env)) return response;
  const headers = new Headers(response.headers);
  headers.delete(SSR_CAPTURE_HEADER);
  headers.set("cache-control", "private, no-store");
  // A missing event can render wall-time suggestions. Refusals, redirects,
  // framework data requests and outages are not proof of a frozen HTML view.
  if (
    capturePathCovered(new URL(request.url).pathname) &&
    [200, 410].includes(response.status) &&
    response.headers.get("content-type")?.includes("text/html")
  ) {
    headers.set(SSR_CAPTURE_HEADER, SSR_CAPTURE_INSTANT);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
