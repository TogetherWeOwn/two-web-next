// Guards for the GET-only guest journeys of the 48h post-flip watch
// (e2e/watch/guest-journeys.spec.ts, docs/48h-watch-spec.md). The suite reads
// the deployed staging Worker or the production apex, so two things are pinned
// before any browser starts: the origin (an exact allowlist) and the method
// (GET and HEAD only; anything else is aborted and fails the test). The one
// carve-outs are Cloudflare's own edge telemetry (EDGE_BEACONS) and Discord's
// widget frame (isDiscordWidgetFrame), both below.

export const WATCH_ORIGINS = Object.freeze([
  "https://next.togetherweown.com",
  "https://togetherweown.com",
  "https://www.togetherweown.com",
]);

export const WATCH_ORIGIN_ERROR =
  "Watch journeys run only against https://next.togetherweown.com, https://togetherweown.com or https://www.togetherweown.com.";

export function requireWatchOrigin(raw) {
  // https, an allowlisted host, no port, no credentials, no path, query or
  // hash. Anything else fails closed. The origin is always explicit: there is
  // no default, so a production run is never an accident.
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new Error(WATCH_ORIGIN_ERROR);
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !WATCH_ORIGINS.includes(url.origin)
  ) {
    throw new Error(WATCH_ORIGIN_ERROR);
  }
  return url.origin;
}

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

// Cloudflare injects two browser beacons into every HTML response it proxies:
// Web Analytics (`POST /cdn-cgi/rum`) and bot detection (`POST
// /cdn-cgi/challenge-platform/...`). The `/cdn-cgi/` namespace is answered at
// the Cloudflare edge and never reaches the Worker, so these are not writes to
// the site, but a real browser sends them on every page. Aborting them fails
// every HTML journey (a blocked "write" plus a console error), so they are
// answered locally with a 204: the request never leaves the browser, and it is
// recorded in `stubbedBeacons` so the report still shows it. The rule is an
// exact watch-origin and path match on a POST, nothing broader.
const EDGE_BEACONS = Object.freeze([
  ...WATCH_ORIGINS.map((origin) => ({ origin, exact: "/cdn-cgi/rum" })),
  ...WATCH_ORIGINS.map((origin) => ({ origin, prefix: "/cdn-cgi/challenge-platform/" })),
]);

export function isEdgeBeacon(method, rawUrl) {
  if (String(method).toUpperCase() !== "POST") return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // WHATWG URL parsing has already resolved `..` and `%2e%2e` segments, so
  // `/cdn-cgi/challenge-platform/../api` is seen here as `/api` and refused.
  return EDGE_BEACONS.some(
    (rule) =>
      url.origin === rule.origin &&
      (rule.exact !== undefined
        ? url.pathname === rule.exact
        : url.pathname.startsWith(rule.prefix)),
  );
}

// The /join page embeds Discord's own widget page in an iframe. Everything
// inside it (its scripts, its calls to the Discord API, its own bot-detection
// beacon) is Discord's, not the site's, and fails for reasons the site cannot
// control: a guild with the widget disabled answers 403 "Widget Disabled",
// which the frame logs as a console error and an uncaught page error. The site
// already probes that and renders a static fallback; the watch asserts the
// site, so this one document is answered locally and Discord is never
// contacted. The match is a GET on exactly https://discord.com/widget; the
// frame-src CSP and the iframe element on the page are still exercised.
const DISCORD_WIDGET_FRAME = Object.freeze({ origin: "https://discord.com", pathname: "/widget" });
const DISCORD_WIDGET_STUB = Object.freeze({
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: "<!doctype html><title>discord widget (stubbed by the watch)</title>",
});

export function isDiscordWidgetFrame(method, rawUrl) {
  if (String(method).toUpperCase() !== "GET") return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.origin === DISCORD_WIDGET_FRAME.origin && url.pathname === DISCORD_WIDGET_FRAME.pathname
  );
}

export function isReadOnlyMethod(method) {
  return READ_ONLY_METHODS.has(String(method).toUpperCase());
}

// A violation names the method and the path only; the query is dropped so a
// report never carries more than it needs to.
function describe(request) {
  const method = String(request.method()).toUpperCase();
  try {
    const url = new URL(request.url());
    return `${method} ${url.origin}${url.pathname}`;
  } catch {
    return `${method} (unparseable url)`;
  }
}

// Installs a context-level route that lets GET/HEAD through (answering only
// Discord's widget frame locally), answers the Cloudflare edge beacons above
// with a local 204, and aborts every other method
// before it leaves the browser. Each abort is recorded, and assertClean()
// throws if any happened, so a write attempt fails the test instead of being
// swallowed as an ordinary failed request.
export async function installReadOnlyGuard(context) {
  const violations = [];
  const stubbedBeacons = [];
  const stubbedFrames = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (isDiscordWidgetFrame(request.method(), request.url())) {
      stubbedFrames.push(describe(request));
      await route.fulfill({ ...DISCORD_WIDGET_STUB });
      return;
    }
    if (isReadOnlyMethod(request.method())) {
      await route.continue();
      return;
    }
    if (isEdgeBeacon(request.method(), request.url())) {
      stubbedBeacons.push(describe(request));
      await route.fulfill({ status: 204 });
      return;
    }
    violations.push(describe(request));
    await route.abort("blockedbyclient");
  });
  return {
    violations,
    stubbedBeacons,
    stubbedFrames,
    assertClean() {
      if (violations.length > 0) {
        throw new Error(
          `Watch journeys are GET-only; blocked ${violations.length} write attempt(s): ${violations.join(", ")}`,
        );
      }
    },
  };
}
