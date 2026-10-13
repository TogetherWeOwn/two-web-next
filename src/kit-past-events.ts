import { Hono } from "hono";
import type { Env } from "./env";
import {
  ANON_PAST_TTL_MS,
  anonCacheGeneration,
  anonCacheSource,
  anonPastKey,
  isAnonCacheEligible,
  readAnonCache,
  writeAnonCache,
} from "./events/anon-cache";
import { normalizePastPage } from "./events/reads";
import { publicReadGuard } from "./events/routes-shared";

export type KitPublicReadGuard = (request: Request, env: Env) => Promise<Response | null>;

const guardApp = new Hono<{ Bindings: Env }>();
guardApp.all("*", async (c) => {
  const limited = await publicReadGuard(c);
  return limited ?? c.body(null, 204);
});

/** Reuse the public Hono read budget for the native Kit route. */
export async function kitPublicReadGuard(request: Request, env: Env): Promise<Response | null> {
  const response = await guardApp.fetch(request, env);
  return response.status === 204 ? null : response;
}

/** Apply the Hono archive's guard and anonymous HTML cache around Kit SSR. */
export async function dispatchPastArchiveRequest(
  request: Request,
  env: Env,
  resolve: () => Promise<Response>,
  guard: KitPublicReadGuard = kitPublicReadGuard,
  now: number = Date.now(),
): Promise<Response> {
  const limited = await guard(request, env);
  if (limited) return limited;

  const url = new URL(request.url);
  // Kit data requests still execute the read guard/load but their JSON payload
  // is not the HTML representation cached by Hono.
  const htmlRequest = url.pathname === "/events/past";
  const page = normalizePastPage(Number.parseInt(url.searchParams.get("page") ?? "1", 10));
  const eligible =
    htmlRequest &&
    isAnonCacheEligible({
      method: request.method,
      hasCookie: request.headers.has("cookie"),
      hasSession: false,
      searching: false,
      flashed: false,
    });
  const source = eligible ? anonCacheSource(env) : null;
  const key = eligible ? anonPastKey(request.method, page) : null;
  if (source && key) {
    const hit = readAnonCache(key, source, now);
    if (hit) {
      const headers = new Headers({ "cache-control": hit.cacheControl });
      headers.set(
        "cache-control",
        hit.cacheControl.replace(/max-age=\d+/, `max-age=${hit.maxAgeSeconds}`),
      );
      // The entry stores no content type and a string body defaults to
      // text/plain; name the cached HTML exactly as Hono's c.html() does so
      // repeat guests render the page instead of its source.
      headers.set("content-type", "text/html; charset=UTF-8");
      if (hit.vary) headers.set("vary", hit.vary);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  const generation = source ? anonCacheGeneration() : 0;
  const response = await resolve();
  const cacheable = response.headers.get("x-two-past-cacheable") === "true";
  const headers = new Headers(response.headers);
  headers.delete("x-two-past-cacheable");
  const cleanResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  if (
    source &&
    key &&
    cacheable &&
    cleanResponse.status === 200 &&
    anonCacheGeneration() === generation
  ) {
    writeAnonCache(
      key,
      source,
      {
        status: cleanResponse.status,
        cacheControl: cleanResponse.headers.get("cache-control") ?? "public, max-age=300",
        vary: cleanResponse.headers.get("vary"),
        body: await cleanResponse.clone().text(),
      },
      ANON_PAST_TTL_MS,
      now,
    );
  }

  return cleanResponse;
}
