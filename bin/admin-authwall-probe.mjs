#!/usr/bin/env node
// Staging-only operator probe: admin POST auth-wall parity across the three
// legs — guest bounces to session recovery, member 403s on the moderator bit,
// moderator reads the dashboard. Mirrors bin/alert-probe.mjs conventions:
// staging-only target, QA_AUTH_TOKEN from env only (never argv), redacted
// JSON result (statuses, locations, body lengths — never tokens, cookies or
// bodies), nonzero exit claims nothing.
//
// Throttle budget: 2 qa-login hits (10/min shared) + 18 admin-write hits
// (30/min) per run. POST bodies are empty: every expectation is decided by
// the same-origin middleware or the admin guard, before any handler touches
// the database, so the probe writes nothing.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_URL = "https://next.togetherweown.com";
export const QA_HEADER = "X-TWO-QA-Auth";
const SESSION_COOKIE = "__Host-two_session=";

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

async function discard(res) {
  await res.body?.cancel();
}

function check(label, actual, expected) {
  const pass = actual === expected;
  return { label, actual, expected, pass };
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
    const location = res.headers.get("location") ?? "";
    await discard(res);
    checks.push(check(`guest POST ${path} status`, res.status, 303));
    checks.push({
      label: `guest POST ${path} recovery target`,
      actual: location.startsWith("/auth/recover?next=") ? "recovery" : location,
      expected: "recovery",
      pass: location.startsWith("/auth/recover?next="),
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
    await discard(res);
    checks.push(check("guest POST without trusted origin status", res.status, 403));
  }
  // Guest control B: the dashboard has no login page; guests fall into OAuth.
  {
    const res = await send(`${baseUrl}/admin`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await discard(res);
    checks.push(check("guest GET /admin status", res.status, 302));
    checks.push(check("guest GET /admin location", res.headers.get("location"), "/auth/discord"));
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
    await discard(res);
    if (res.status !== 204 || !cookie)
      throw new Error(`QA login as ${identity} refused (HTTP ${res.status}); no session claimed`);
    return cookie;
  };
  const memberCookie = await login("qa-member");
  for (const path of ADMIN_POST_PATHS) {
    const res = await unsafe(path, { Cookie: memberCookie });
    await discard(res);
    checks.push(check(`member POST ${path} status`, res.status, 403));
    checks.push(check(`member POST ${path} location`, res.headers.get("location"), null));
  }

  // Moderator control: the same wall admits qa-moderator to the dashboard.
  const moderatorCookie = await login("qa-moderator");
  {
    const res = await send(`${baseUrl}/admin`, {
      headers: { Cookie: moderatorCookie },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await discard(res);
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
