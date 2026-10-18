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
  ["/join", /One click with Discord/],
];
// HTML leaves that stay non-indexable even on the indexable apex: the archive
// and the branded 404 carry their noindex in <meta>, so the deploy smoke
// asserts the X-Robots-Tag header only on the indexable leaves.
const nonIndexableHtml = new Set(["/events/past", "/__smoke_unknown_route__"]);

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

// versionOverride pins gradual-promotion probes to the new Worker version
// through Cloudflare's version-override header, so a 5% canary is tested
// directly instead of through sampled traffic. Format:
// <worker-name>="<lowercase version uuid>".
export const VERSION_OVERRIDE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}="[0-9a-f-]{36}"$/;

// Queue thresholds shared with src/up-queue.ts (re-exported by src/up.ts).
// This file runs on plain node with no TS loader, so the values are
// duplicated here and pinned by the drift guard in test/smoke.test.mjs: a
// threshold change in src/up-queue.ts fails `npm run test:smoke` at PR time
// with a drift message; update the values below to match.
export const SMOKE_QUEUE_WARN_AT = 20;
export const SMOKE_QUEUE_CRITICAL_AT = 100;

export function assertVersionOverride(value) {
  if (
    typeof value !== "string" ||
    !VERSION_OVERRIDE_PATTERN.test(value) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/.test(
      value.slice(value.indexOf('="') + 2),
    )
  ) {
    throw new Error(
      'version-override must look like worker-name="12345678-1234-1234-1234-123456789abc"',
    );
  }
  return value;
}

export async function smoke(
  baseUrl,
  { timeoutMs = 5_000, log = console.log, allowIndexable = false, versionOverride } = {},
) {
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
  if (versionOverride !== undefined) assertVersionOverride(versionOverride);
  const overrideHeaders =
    versionOverride === undefined
      ? {}
      : { "Cloudflare-Workers-Version-Overrides": versionOverride };
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
        headers: overrideHeaders,
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
      // Indexing posture follows the probed origin (src/headers.ts robotsTagFor):
      // staging and other non-apex hosts send X-Robots-Tag noindex on returned
      // HTML, including guest denials; the apex omits it on indexable leaves.
      // The archive and branded 404 stay non-indexable via <meta> in every
      // env, which this header probe does not assert (ci/cutover-check.mjs
      // owns the meta half of the gate).
      if (contentType === "text/html") {
        const universalNoindex = headerIndexingRules(headers.get("x-robots-tag")).some(
          (rule) => rule.crawler === "*",
        );
        if (allowIndexable && !nonIndexableHtml.has(route.path)) {
          check(
            !universalNoindex,
            "no universal X-Robots-Tag noindex on indexable apex HTML",
            headers.get("x-robots-tag") ?? "missing",
          );
        } else if (!allowIndexable) {
          check(
            universalNoindex,
            "staging X-Robots-Tag noindex/none (unscoped)",
            headers.get("x-robots-tag") ?? "missing",
          );
        }
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
          // Healthy, degraded (warn/critical, still degraded never down)
          // and unknown-ledger envelopes all pass; thresholds pinned to
          // src/up.ts QUEUE_WARN_AT / QUEUE_CRITICAL_AT via the exported
          // SMOKE_QUEUE_* constants above (drift guard in test/smoke.test.mjs).
          const valid =
            data?.db === "ok" &&
            data?.pending_migrations === 0 &&
            ["healthy", "degraded"].includes(data?.status) &&
            ["healthy", "degraded", "unknown"].includes(data?.queue?.status) &&
            data?.queue?.warn_at === SMOKE_QUEUE_WARN_AT &&
            data?.queue?.critical_at === SMOKE_QUEUE_CRITICAL_AT;
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
  const args = process.argv.slice(2);
  const [baseUrl, ...flags] = args;
  let allowIndexable = false;
  let versionOverride;
  let usage = false;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === "--allow-indexable") {
      allowIndexable = true;
    } else if (flags[i] === "--version-override") {
      const value = flags[i + 1];
      if (value === undefined) {
        usage = true;
      } else {
        versionOverride = value;
      }
      i += 1;
    } else {
      usage = true;
    }
  }
  if (typeof baseUrl !== "string" || usage) {
    console.error(
      'Usage: node bin/smoke.mjs <base-url> [--allow-indexable] [--version-override worker-name="<version-uuid>"]',
    );
    process.exitCode = 2;
  } else {
    try {
      if (versionOverride !== undefined) assertVersionOverride(versionOverride);
      process.exitCode = (await smoke(baseUrl, { allowIndexable, versionOverride })) ? 0 : 1;
    } catch (error) {
      console.error(`smoke: ${error instanceof Error ? error.message : "invalid base-url"}`);
      process.exitCode = 2;
    }
  }
}
