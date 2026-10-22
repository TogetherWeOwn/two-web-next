#!/usr/bin/env node
// Staging-only operator probe: admin POST auth-wall parity across the three
// legs — guest bounces to session recovery, member 403s on the moderator bit,
// moderator reads the dashboard. Mirrors bin/alert-probe.mjs conventions:
// staging-only target, QA_AUTH_TOKEN from env only (never argv), redacted
// JSON result (statuses and fixed redirect classes — never raw locations,
// tokens, cookies or bodies), nonzero exit claims nothing.
//
// Throttle budget: 2 qa-login hits (10/min shared) + 18 admin-write hits
// (30/min) per run. POST bodies are empty: every expectation is decided by
// the same-origin middleware or the admin guard, before any handler touches
// the database, so the probe writes nothing.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";

export const STAGING_URL = STAGING_ORIGIN;
export const QA_HEADER = "X-TWO-QA-Auth";
const SESSION_COOKIE = "__Host-two_session=";

const USAGE = `Usage: node bin/admin-authwall-probe.mjs [--help]

Staging-only operator probe: admin POST auth-wall parity across the three
legs — guest bounces to session recovery, member 403s on the moderator bit,
moderator reads the dashboard.

Environment:
  QA_AUTH_TOKEN  staging QA login token (required; never pass it as a CLI argument)

The probe target is pinned to ${STAGING_URL}; there are no other options.
POST bodies are empty: every expectation is decided by the same-origin
middleware or the admin guard, before any handler touches the database, so
the probe writes nothing. Output is a redacted JSON result on stdout;
failures print one generic line to stderr and claim nothing.

Exit codes:
  exit 0  every auth-wall check passed
  exit 1  any check failed, a QA login was refused, an argument was passed,
          or the probe errored`;

// All nine admin mutation routes behind the admin guard (src/admin/routes.tsx).
export const ADMIN_POST_PATHS = [
  "/admin/events",
  "/admin/events/ZZZ",
  "/admin/events/ZZZ/publish",
  "/admin/events/ZZZ/cancel",
  "/admin/events/ZZZ/rsvp-pause",
  "/admin/events/ZZZ/rsvp-reopen",
  "/admin/featured",
  "/admin/featured/1",
  "/admin/featured/1/delete",
];

/** First session-cookie value from a login response, or null. */
export function sessionCookieValue(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    if (raw.startsWith(SESSION_COOKIE)) return raw.split(";")[0];
  }
  return null;
}

function discard(res) {
  // Disposal is best-effort: never wait for it or expose its exception text.
  try {
    void Promise.resolve(res.body?.cancel()).catch(() => undefined);
  } catch {
    // A synchronous cancellation failure must not decide the auth-wall verdict.
    return;
  }
}

function check(label, actual, expected) {
  const pass = actual === expected;
  return { label, actual, expected, pass };
}

function locationShape(location) {
  // Fixed vocabulary only: no provider-controlled bytes enter the report.
  if (location === null) return null;
  if (location === "") return "empty";
  if (location.startsWith("//")) return "network-path";
  if (location.startsWith("/")) return "root-relative";
  return "other-location";
}

function checkLocation(label, actual, expected) {
  const result = check(label, actual, expected);
  return { ...result, actual: result.pass ? expected : locationShape(actual) };
}

export async function runProbe({ baseUrl = STAGING_URL, token, fetch: send = fetch }) {
  if (baseUrl !== STAGING_URL) throw new Error("Refusing non-staging auth-wall probe target");
  if (!token) throw new Error("QA_AUTH_TOKEN is required; do not pass it as a CLI argument");
  const checks = [];
  const unsafe = (path, extra = {}) =>
    send(`${baseUrl}${path}`, {
      method: "POST",
      headers: { origin: baseUrl, "Content-Type": "application/x-www-form-urlencoded", ...extra },
      body: "",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

  // Guest leg: every mutation POST bounces to session recovery with an empty body.
  for (const path of ADMIN_POST_PATHS) {
    const res = await unsafe(path);
    const location = res.headers.get("location");
    const recovery = location?.startsWith("/auth/recover?next=") ?? false;
    discard(res);
    checks.push(check(`guest POST ${path} status`, res.status, 303));
    checks.push({
      label: `guest POST ${path} recovery target`,
      actual: recovery ? "recovery" : locationShape(location),
      expected: "recovery",
      pass: recovery,
    });
  }
  // Guest control A: forged cross-origin write keeps the 403, never a bounce.
  {
    const res = await send(`${baseUrl}${ADMIN_POST_PATHS[0]}`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    discard(res);
    checks.push(check("guest POST without trusted origin status", res.status, 403));
  }
  // Guest control B: the dashboard has no login page; guests fall into OAuth.
  {
    const res = await send(`${baseUrl}/admin`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    discard(res);
    checks.push(check("guest GET /admin status", res.status, 302));
    checks.push(
      checkLocation("guest GET /admin location", res.headers.get("location"), "/auth/discord"),
    );
  }

  // Member leg: qa-member signs in, then every mutation POST 403s on the
  // moderator bit — never a login loop, never a write.
  const login = async (identity) => {
    const res = await send(`${baseUrl}/auth/qa/${identity}`, {
      method: "POST",
      headers: { origin: baseUrl, [QA_HEADER]: token },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const cookie = sessionCookieValue(res);
    discard(res);
    if (res.status !== 204 || !cookie)
      throw new Error(`QA login as ${identity} refused (HTTP ${res.status}); no session claimed`);
    return cookie;
  };
  const memberCookie = await login("qa-member");
  for (const path of ADMIN_POST_PATHS) {
    const res = await unsafe(path, { Cookie: memberCookie });
    discard(res);
    checks.push(check(`member POST ${path} status`, res.status, 403));
    checks.push(checkLocation(`member POST ${path} location`, res.headers.get("location"), null));
  }

  // Moderator control: the same wall admits qa-moderator to the dashboard.
  const moderatorCookie = await login("qa-moderator");
  {
    const res = await send(`${baseUrl}/admin`, {
      headers: { Cookie: moderatorCookie },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    discard(res);
    checks.push(check("moderator GET /admin status", res.status, 200));
  }

  const failures = checks.filter((c) => !c.pass);
  return {
    target: baseUrl,
    legs: { guest: "303 recovery", member: "403 forbidden", moderator: "200 dashboard" },
    passed: checks.length - failures.length,
    failed: failures.length,
    failures: failures.slice(0, 10),
  };
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    // Discovery only: usage to stdout, exit 0, zero side effects — no token
    // read, no login, no probe. Checked before the argv refusal so --help is
    // never parsed as a positional.
    console.log(USAGE);
    return;
  }
  if (process.argv.length !== 2) throw new Error("Usage: node bin/admin-authwall-probe.mjs");
  const result = await runProbe({ token: process.env.QA_AUTH_TOKEN });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print fetch exceptions: they may contain request headers or credentials.
    console.error(
      "Admin auth-wall probe failed. Check the staging QA gate, throttle budget and deployment; no outcome claimed.",
    );
    process.exitCode = 1;
  });
}
