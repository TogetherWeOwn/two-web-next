#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { headerIndexingRules } from "../ci/robots-directives.mjs";

const html = [
  ["/", /The lobby is open/],
  ["/about", /About Together We Own/],
  ["/faq", /Frequently asked questions/],
  ["/rules", /id="rules-heading"/],
  ["/privacy", /Privacy policy/],
  ["/events", /id="events-heading"/],
  ["/events/past", /id="past-events-heading"/],
];
const routes = [
  { path: "/up", statuses: [200], type: "application/json", json: true },
  ...html.map(([path, body]) => ({ path, statuses: [200], type: "text/html", body })),
  { path: "/events.rss", statuses: [200], type: "application/rss+xml", body: /<rss\b/ },
  { path: "/events.ics", statuses: [200], type: "text/calendar", body: /BEGIN:VCALENDAR/ },
  { path: "/sitemap_index.xml", statuses: [200], type: "application/xml", body: /<urlset\b/ },
  { path: "/robots.txt", statuses: [200], type: "text/plain", body: /User-agent:/i },
  { path: "/discord", statuses: [302], redirect: "discord" },
  { path: "/profile", statuses: [302], redirect: "login" },
  { path: "/admin", statuses: [302, 403], redirect: "login" },
  {
    path: "/__smoke_unknown_route__",
    statuses: [404],
    type: "text/html",
    body: /We cannot find that page[\s\S]*Together We Own/,
  },
];

export async function smoke(baseUrl, { timeoutMs = 5_000, log = console.log } = {}) {
  const base = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "base-url must be an HTTP(S) origin without credentials, path, query or fragment",
    );
  }
  let failures = 0;
  for (const route of routes) {
    let routeFailures = 0;
    const check = (valid, expected, actual) => {
      if (!valid) {
        failures++;
        routeFailures++;
        log(`FAIL ${route.path}: expected ${expected}; actual ${actual}`);
      }
    };
    try {
      // Manual redirects keep guest checks unauthenticated and never visit Discord.
      // Node timeout also bounds reading the body: https://nodejs.org/docs/latest-v24.x/api/globals.html#static-method-abortsignaltimeoutdelay
      const response = await fetch(new URL(route.path, base), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      check(
        route.statuses.includes(response.status),
        `HTTP ${route.statuses.join(" or ")}`,
        `HTTP ${response.status}`,
      );
      const headers = response.headers;
      check(
        Boolean(headers.get("content-security-policy")?.trim()),
        "nonempty Content-Security-Policy",
        headers.get("content-security-policy") ? "empty" : "missing",
      );
      check(
        headers.get("x-content-type-options")?.toLowerCase() === "nosniff",
        "X-Content-Type-Options nosniff",
        headers.get("x-content-type-options") ?? "missing",
      );
      const contentType = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      // Staging noindex follows returned HTML, including guest denials (src/headers.ts).
      if (contentType === "text/html") {
        check(
          headerIndexingRules(headers.get("x-robots-tag")).some((rule) => rule.crawler === "*"),
          "staging X-Robots-Tag noindex/none (unscoped)",
          headers.get("x-robots-tag") ?? "missing",
        );
      }
      if (route.type) {
        check(contentType === route.type, `Content-Type ${route.type}`, contentType ?? "missing");
      }
      const body = await response.text();
      if (route.path === "/up") {
        // Cutover identity gate (TOG-12863): the deploy target must answer as
        // two-web-next with an uncacheable liveness envelope. A 500 (status
        // gate above) or a missing origin marker fails the gate; liveness
        // never becomes a DB gate beyond the db:ok shape below.
        check(
          headers.get("x-two-origin") === "two-web-next",
          "X-TWO-Origin two-web-next",
          headers.get("x-two-origin") ?? "missing",
        );
        const noStore = (headers.get("cache-control") ?? "")
          .split(",")
          .map((directive) => directive.trim().toLowerCase())
          .includes("no-store");
        check(noStore, "Cache-Control no-store", headers.get("cache-control") ?? "missing");
      }
      if (route.json) {
        try {
          const data = JSON.parse(body);
          // Healthy, degraded (warn 20 / critical 100, still degraded never
          // down) and unknown-ledger envelopes all pass; thresholds pinned to
          // src/up.ts QUEUE_WARN_AT / QUEUE_CRITICAL_AT.
          const valid =
            data?.db === "ok" &&
            data?.pending_migrations === 0 &&
            ["healthy", "degraded"].includes(data?.status) &&
            ["healthy", "degraded", "unknown"].includes(data?.queue?.status) &&
            data?.queue?.warn_at === 20 &&
            data?.queue?.critical_at === 100;
          check(
            valid,
            "JSON /up db:ok, pending_migrations:0, status and queue.status",
            "valid JSON with unexpected health shape",
          );
        } catch {
          check(false, "valid JSON object", "invalid JSON");
        }
      }
      if (route.path === "/robots.txt") {
        // Per-environment robots (W16b TOG-11942): the Sitemap line must name
        // this environment's own origin, never the apex or another env's host.
        const line = `Sitemap: ${base.origin}/sitemap_index.xml`;
        check(body.includes(line), `robots ${line}`, "Sitemap line missing or foreign");
      }
      if (route.path === "/sitemap_index.xml") {
        // Same-environment sitemap: every loc stays on the probed origin, and
        // the index is never empty (static leaves render even with the DB down).
        const locs = [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].trim());
        check(locs.length > 0, "at least one sitemap <loc>", `${locs.length} <loc> entries`);
        const foreign = locs.filter((loc) => !loc.startsWith(`${base.origin}/`)).length;
        check(foreign === 0, "same-origin sitemap locs", `${foreign} foreign locs`);
      }
      if (route.body)
        check(route.body.test(body), `body matching ${route.body}`, "body did not match");
      if (route.redirect && response.status === 302) {
        const location = headers.get("location");
        let target;
        try {
          if (location) target = new URL(location, base);
        } catch {
          /* Invalid Location fails below. */
        }
        const valid =
          route.redirect === "discord"
            ? target?.protocol === "https:" &&
              !target.port &&
              !target.username &&
              !target.password &&
              ((target.hostname === "discord.gg" && /^\/[\w-]+$/.test(target.pathname)) ||
                (target.hostname === "discord.com" && /^\/invite\/[\w-]+$/.test(target.pathname)))
            : target?.origin === base.origin && target.pathname === "/auth/discord";
        // Do not print OAuth/query values or response bodies into deploy logs.
        check(
          Boolean(valid),
          `Location to ${route.redirect === "discord" ? "HTTPS Discord invite" : "same-origin /auth/discord"}`,
          location ? "unexpected Location" : "missing Location",
        );
      }
      if (!routeFailures) log(`PASS ${route.path}`);
    } catch (error) {
      check(
        false,
        "HTTP response and body within timeout",
        error instanceof Error ? error.name : "request error",
      );
    }
  }
  log(`smoke: ${routes.length} routes, ${failures} failed assertions`);
  return failures === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error("Usage: node bin/smoke.mjs <staging-base-url>");
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = (await smoke(process.argv[2])) ? 0 : 1;
    } catch (error) {
      console.error(`smoke: ${error instanceof Error ? error.message : "invalid base-url"}`);
      process.exitCode = 2;
    }
  }
}
