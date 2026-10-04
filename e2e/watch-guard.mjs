// Guards for the GET-only guest journeys of the 48h post-flip watch
// (e2e/watch/guest-journeys.spec.ts, docs/48h-watch-spec.md). The suite reads
// the deployed staging Worker or the production apex, so two things are pinned
// before any browser starts: the origin (an exact allowlist) and the method
// (GET and HEAD only; anything else is aborted and fails the test).

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

// Installs a context-level route that lets GET/HEAD through and aborts every
// other method before it leaves the browser. Each abort is recorded, and
// assertClean() throws if any happened, so a write attempt fails the test
// instead of being swallowed as an ordinary failed request.
export async function installReadOnlyGuard(context) {
  const violations = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (isReadOnlyMethod(request.method())) {
      await route.continue();
      return;
    }
    violations.push(describe(request));
    await route.abort("blockedbyclient");
  });
  return {
    violations,
    assertClean() {
      if (violations.length > 0) {
        throw new Error(
          `Watch journeys are GET-only; blocked ${violations.length} write attempt(s): ${violations.join(", ")}`,
        );
      }
    },
  };
}
