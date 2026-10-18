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
  { path: "/.well-known/security.txt", statuses: [200], type: "text/plain", body: /Contact:/ },
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

// Pinned review date shared with src/security-txt.ts (re-exported expiry).
// This file runs on plain node with no TS loader, so the value is duplicated
// here and pinned by the drift guard in test/smoke.test.mjs: an expiry change
// in src/security-txt.ts fails `npm run test:smoke` at PR time with a drift
// message; update the value below to match.
export const SMOKE_SECURITY_TXT_EXPIRES = "2027-10-01T00:00:00Z";

// Previously reviewed Expires values, oldest last. The rollback smoke runs
// HEAD's checker against the rolled-back Worker, so after a renewal it would
// fail the Expires assertion although the rollback worked. Accepting the
// outgoing reviewed pin keeps that emergency path green; the renewal procedure
// (docs/runbook.md) moves the outgoing pin here when it bumps the pin above.
// Empty today: the pin dates to the route's introduction and has never been
// renewed. Versions predating the route cannot pass this probe; covering those
// needs the target version's own checker in rollback-production, which is
// outside this slice (no deployment changes).
export const SMOKE_SECURITY_TXT_PREVIOUS_EXPIRES = [];

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

export function assertFailedBaseline(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim())) {
    throw new Error("failed-baseline must be a non-negative integer");
  }
  const parsed = Number.parseInt(text.trim(), 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("failed-baseline must be a non-negative integer");
  }
  return parsed;
}

// Candidate UUID pinned by a validated version-override header value:
// worker-name="<lowercase version uuid>". A green HTTP response does not
// prove which Worker version served it (Cloudflare falls back to normal
// routing when the override is ignored), so the /up revision.version_id
// must equal this UUID or the probe fails.
export function versionIdFromOverride(value) {
  assertVersionOverride(value);
  return value.slice(value.indexOf('="') + 2, -1);
}

// Lowercase Worker Version UUID expected on ordinary (unpinned) routing.
// Validated before any probe request is sent; malformed values are a usage
// error, never a serving failure.
export const EXPECTED_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertExpectedVersionId(value) {
  if (typeof value !== "string" || !EXPECTED_VERSION_ID_PATTERN.test(value)) {
    throw new Error(
      'expected-version-id must be a lowercase UUID like "22345678-1234-1234-1234-123456789abc"',
    );
  }
  return value;
}

// RFC 9116 field parsing for the security.txt probe: "#" lines are comments,
// field names are case-insensitive, and matching is on whole field values, so
// a commented-out or foreign line cannot satisfy an assertion by substring.
export function securityTxtFields(body) {
  const fields = [];
  for (const rawLine of String(body).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fields.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return fields;
}

// Pure core of the security.txt route assertion, unit-tested in
// test/smoke.test.mjs across both protocols. Returns [expected, actual] pairs
// for each failing assertion; smoke() feeds each pair to check().
export function securityTxtAssertions(
  body,
  base,
  previousExpires = SMOKE_SECURITY_TXT_PREVIOUS_EXPIRES,
) {
  const failures = [];
  const fields = securityTxtFields(body);
  const expiresValues = fields.filter(([name]) => name === "expires").map(([, value]) => value);
  if (
    expiresValues.length !== 1 ||
    (expiresValues[0] !== SMOKE_SECURITY_TXT_EXPIRES && !previousExpires.includes(expiresValues[0]))
  ) {
    failures.push([
      `security Expires: ${SMOKE_SECURITY_TXT_EXPIRES}`,
      "Expires line missing or stale",
    ]);
  }
  const canonicalValues = fields.filter(([name]) => name === "canonical").map(([, value]) => value);
  if (base.protocol === "https:") {
    // Same-origin Canonical, mirroring the robots.txt Sitemap pattern.
    const canonical = `Canonical: ${base.origin}/.well-known/security.txt`;
    if (
      canonicalValues.length !== 1 ||
      canonicalValues[0] !== `${base.origin}/.well-known/security.txt`
    ) {
      failures.push([`security ${canonical}`, "Canonical line missing or foreign"]);
    }
  } else {
    // The producer omits Canonical on http origins (RFC 9116 §2.5.2;
    // src/security-txt.ts), so an http probe asserts its absence.
    if (canonicalValues.length !== 0) {
      failures.push(["security no Canonical on http origin", "unexpected Canonical line"]);
    }
  }
  return failures;
}

export async function smoke(
  baseUrl,
  {
    timeoutMs = 5_000,
    log = console.log,
    allowIndexable = false,
    versionOverride,
    expectedVersionId,
    failedBaseline,
    allowMissingBaseline = false,
    failOnReadyWaitCritical = false,
  } = {},
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
  if (expectedVersionId !== undefined) assertExpectedVersionId(expectedVersionId);
  const baseline = failedBaseline === undefined ? undefined : assertFailedBaseline(failedBaseline);
  const overrideVersionId =
    versionOverride === undefined ? undefined : versionIdFromOverride(versionOverride);
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
          // A stuck staging queue is not promotable: with
          // failOnReadyWaitCritical (S6, staging deploy only),
          // ready_wait_severity critical fails closed, as does a blind
          // queue-observability path (queue.status or ready_wait_severity
          // unknown). The flag is
          // staging-only by design: the age derives from the shared
          // queue_jobs table (src/jobs/postgres.ts min(available_at)), not
          // the Worker version under test, so a production canary probed
          // with --version-override would report the same critical and a
          // fail-closed production gate would block its own fix from
          // shipping (and fail post-rollback smoke after a good rollback).
          // Without the flag, critical logs WARN and passes; healthy /
          // warning pass, and unknown / missing severity pass to preserve
          // the production/rollback posture.
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
          // Dead letters are not promotable. Ad-hoc runs without a baseline
          // fail closed on any positive numeric queue.failed with the count
          // in the output. Promotion workflows capture the retained-rows
          // count from /up before the deploy/promote (SMOKE_FAILED_BASELINE)
          // and fail only on growth past it, so history never blocks a
          // deploy while new dead letters still do. When the workflows could
          // not read a baseline (SMOKE_ALLOW_MISSING_BASELINE) the gate is
          // skipped with a notice instead of falling back to the absolute
          // gate, so a transient /up blip never reds on retained history.
          // failed 0/null (an unreadable ledger, or an envelope without the
          // field) does not fail this gate on its own.
          const failed = data?.queue?.failed;
          if (baseline === undefined && allowMissingBaseline) {
            log("SKIP /up dead-letter gate: no baseline (unreadable /up), not failing on history");
          } else {
            const failedIsNew =
              typeof failed === "number" &&
              (baseline === undefined ? failed > 0 : failed > baseline);
            check(
              !failedIsNew,
              baseline === undefined
                ? "queue.failed 0 (no dead letters)"
                : `queue.failed <= ${baseline} (no new dead letters; baseline ${baseline})`,
              `queue.failed ${typeof failed === "number" ? failed : "unknown"}`,
            );
          }
          // Version attribution (S4/M35): when the probe pins a candidate
          // version, /up.revision.version_id must equal its UUID. Cloudflare
          // falls back to normal routing when the override is ignored, so a
          // healthy old version (or a missing/malformed revision) fails even
          // though every readiness assertion above would pass. Commit equality
          // is not identity: only the exact version UUID passes.
          if (versionOverride !== undefined) {
            const served =
              data?.revision !== null &&
              typeof data?.revision === "object" &&
              !Array.isArray(data?.revision)
                ? data.revision.version_id
                : undefined;
            check(
              served === overrideVersionId,
              `revision.version_id ${overrideVersionId}`,
              served === undefined
                ? "missing revision.version_id"
                : `revision.version_id ${served}`,
            );
          }
          // Ordinary-traffic identity (rollback): when the caller records an
          // expected version, /up.revision.version_id must equal it even
          // though no version-override header pins the probe. During
          // propagation a healthy unwanted version can satisfy every
          // readiness assertion above without proving the recorded target
          // serves normal routing, so a missing, malformed or different
          // identity fails. Commit equality is not identity: only the exact
          // version UUID passes. Sends no routing header; exact identity
          // still requires every existing health/security check.
          if (expectedVersionId !== undefined) {
            const served =
              data?.revision !== null &&
              typeof data?.revision === "object" &&
              !Array.isArray(data?.revision)
                ? data.revision.version_id
                : undefined;
            check(
              served === expectedVersionId,
              `revision.version_id ${expectedVersionId}`,
              served === undefined
                ? "missing revision.version_id"
                : `revision.version_id ${served}`,
            );
          }
          const severity = data?.queue?.ready_wait_severity;
          const queueStatus = data?.queue?.status;
          const readyAge = data?.queue?.oldest_ready_wait_age_seconds;
          const readyAgeLabel = typeof readyAge === "number" ? readyAge : "unknown";
          if (failOnReadyWaitCritical) {
            const unknownReadiness = queueStatus === "unknown" || severity === "unknown";
            if (unknownReadiness) {
              check(
                false,
                "known queue.status and ready_wait_severity (not unknown)",
                `unknown (queue.status: ${queueStatus ?? "missing"}, ready_wait_severity: ${severity ?? "missing"})`,
              );
            } else {
              check(
                severity !== "critical",
                "ready_wait_severity not critical",
                `critical (oldest_ready_wait_age_seconds: ${readyAgeLabel})`,
              );
            }
          } else if (severity === "critical") {
            log(
              `WARN ${route.path}: ready_wait_severity critical (oldest_ready_wait_age_seconds: ${readyAgeLabel})`,
            );
          }
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
      if (route.path === "/.well-known/security.txt") {
        // RFC 9116 publication (S8): field-parsed assertions shared with the
        // unit tests (securityTxtAssertions above). Do not print response
        // bodies into deploy logs: the actual side stays a fixed string.
        for (const [expected, actual] of securityTxtAssertions(body, base)) {
          check(false, expected, actual);
        }
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
  let expectedVersionId;
  let failedBaseline;
  let allowMissingBaseline = false;
  let failOnReadyWaitCritical = false;
  let usage = false;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === "--allow-indexable") {
      allowIndexable = true;
    } else if (flags[i] === "--allow-missing-baseline") {
      allowMissingBaseline = true;
    } else if (flags[i] === "--fail-on-ready-wait-critical") {
      failOnReadyWaitCritical = true;
    } else if (flags[i] === "--version-override") {
      const value = flags[i + 1];
      if (value === undefined) {
        usage = true;
      } else {
        versionOverride = value;
      }
      i += 1;
    } else if (flags[i] === "--expected-version-id") {
      const value = flags[i + 1];
      if (value === undefined) {
        usage = true;
      } else {
        expectedVersionId = value;
      }
      i += 1;
    } else if (flags[i] === "--failed-baseline") {
      const value = flags[i + 1];
      if (value === undefined) {
        usage = true;
      } else {
        failedBaseline = value;
      }
      i += 1;
    } else {
      usage = true;
    }
  }
  if (typeof baseUrl !== "string" || usage) {
    console.error(
      'Usage: node bin/smoke.mjs <base-url> [--allow-indexable] [--fail-on-ready-wait-critical] [--version-override worker-name="<version-uuid>"] [--expected-version-id <lowercase-uuid>] [--failed-baseline <n>] [--allow-missing-baseline]',
    );
    process.exitCode = 2;
  } else {
    try {
      if (versionOverride !== undefined) assertVersionOverride(versionOverride);
      if (expectedVersionId !== undefined) assertExpectedVersionId(expectedVersionId);
      // Promotion workflows export the pre-deploy/promote retained-rows count
      // as SMOKE_FAILED_BASELINE so the gate fails only on growth; an
      // explicit --failed-baseline flag wins over the environment. An empty
      // SMOKE_FAILED_BASELINE means the capture could not read /up and maps
      // to no baseline. SMOKE_ALLOW_MISSING_BASELINE=1 (or the flag) makes
      // that no-baseline state skip the dead-letter gate instead of failing
      // on any positive count; ad-hoc runs without it keep the absolute gate.
      const baselineRaw = failedBaseline ?? process.env.SMOKE_FAILED_BASELINE;
      const baseline =
        baselineRaw === undefined || baselineRaw === ""
          ? undefined
          : assertFailedBaseline(baselineRaw);
      const allowMissingRaw = process.env.SMOKE_ALLOW_MISSING_BASELINE;
      const allowMissing =
        allowMissingBaseline ||
        allowMissingRaw === "1" ||
        allowMissingRaw?.toLowerCase() === "true";
      process.exitCode = (await smoke(baseUrl, {
        allowIndexable,
        versionOverride,
        expectedVersionId,
        failedBaseline: baseline,
        allowMissingBaseline: allowMissing,
        failOnReadyWaitCritical,
      }))
        ? 0
        : 1;
    } catch (error) {
      console.error(`smoke: ${error instanceof Error ? error.message : "invalid base-url"}`);
      process.exitCode = 2;
    }
  }
}
