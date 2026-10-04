// Guards for the GET-only guest journeys of the 48h post-flip watch
// (e2e/watch/guest-journeys.spec.ts, docs/48h-watch-spec.md). The suite reads
// the deployed staging Worker or the production apex, so two things are pinned
// before any browser starts: the origin (an exact allowlist) and the method
// (GET and HEAD only; anything else is aborted and fails the test). The one
// carve-out is Cloudflare's own edge telemetry (see EDGE_BEACONS below).

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
// the site, but a real browser sends them on every page, and the /join page
// embeds a Discord widget that sends the second one to discord.com. Aborting
// them fails every HTML journey (a blocked "write" plus a console error), so
// they are answered locally with a 204: the request never leaves the browser,
// and it is recorded in `stubbedBeacons` so the report still shows it. The rule
// is an exact host and path match on a POST, nothing broader.
const EDGE_BEACONS = Object.freeze([
  ...WATCH_ORIGINS.map((origin) => ({ origin, exact: "/cdn-cgi/rum" })),
  ...WATCH_ORIGINS.map((origin) => ({ origin, prefix: "/cdn-cgi/challenge-platform/" })),
  // The Discord widget on /join is a third-party frame; only its Cloudflare
  // bot-detection beacon is stubbed, never anything else on that host.
  { origin: "https://discord.com", prefix: "/cdn-cgi/challenge-platform/" },
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

// Installs a context-level route that lets GET/HEAD through, answers the
// Cloudflare edge beacons above with a local 204, and aborts every other method
// before it leaves the browser. Each abort is recorded, and assertClean()
// throws if any happened, so a write attempt fails the test instead of being
// swallowed as an ordinary failed request.
export async function installReadOnlyGuard(context) {
  const violations = [];
  const stubbedBeacons = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
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
    assertClean() {
      if (violations.length > 0) {
        throw new Error(
          `Watch journeys are GET-only; blocked ${violations.length} write attempt(s): ${violations.join(", ")}`,
        );
      }
    },
  };
}
