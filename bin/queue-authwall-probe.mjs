#!/usr/bin/env node
// Staging-only operator probe: queue auth-wall parity across the three
// operator legs — preview admission, redispatch admission and the
// source-evidence bearer wall. Mirrors bin/admin-authwall-probe.mjs
// conventions: staging-only target, QA_AUTH_TOKEN from env only (never
// argv), redacted JSON result (statuses and fixed redirect classes — never
// raw locations, tokens, cookies or bodies), nonzero exit claims nothing.
//
// QA identities can never satisfy the operator boundary, so the probe never
// holds an operator session and never expects 200: each route reports its
// own admission state from the guest leg (disabled 404 or walled), and the
// member/moderator legs must agree with it. Preview and redispatch share
// one flag and one operator ID, so their states must agree too;
// source-evidence is independently flagged. When a guest leg is unexpected
// (neither walled nor disabled), the member/moderator legs still assert the
// walled expectation, so a leak reads as failures, not silence.
//
// Throttle budget: 2 qa-login hits (10/min shared) + 0 admin-write hits.
// Every redispatch POST refuses before the shared throttle (guest/member in
// the panel gate, non-operator moderator in the pre-throttle refusal), both
// controls refuse before any throttle or flag read, and preview,
// source-evidence and the login gate spend nothing else. Bodies are empty:
// every expectation is decided by the same-origin middleware, the admission
// gates or the panel/operator guards, before any handler touches the
// database, so the probe writes nothing beyond the two QA sessions.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_URL = "https://next.togetherweown.com";
export const QA_HEADER = "X-TWO-QA-Auth";
const SESSION_COOKIE = "__Host-two_session=";

// One canonical failure selector per operator route. The shape is valid, so
// a 404 on these legs means disabled admission, never a malformed id: the
// guest/member/moderator legs refuse before any id lookup.
export const PREVIEW_PATH = "/admin/queue/failed/7/preview";
export const REDISPATCH_PATH = "/admin/queue/failed/7/redispatch";
export const SOURCE_EVIDENCE_PATH = "/admin/queue/source-evidence/7";

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
  const get = (path, extra = {}) =>
    send(`${baseUrl}${path}`, {
      headers: { ...extra },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  // Preview GETs assert their own explicit same-origin Origin (GET has no
  // global guard); source-evidence GETs send none (the bearer wall ignores
  // it, and the path has no other middleware).
  const previewGet = (path, extra = {}) => get(path, { origin: baseUrl, ...extra });
  const unsafe = (path, origin, extra = {}) =>
    send(`${baseUrl}${path}`, {
      method: "POST",
      headers: { origin, "Content-Type": "application/x-www-form-urlencoded", ...extra },
      body: "",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

  // Guest legs first: no session needed, and each one names its route's
  // admission state for the member/moderator legs below.
  const guestPreview = await previewGet(PREVIEW_PATH);
  const guestPreviewLocation = guestPreview.headers.get("location");
  discard(guestPreview);
  const previewState =
    guestPreview.status === 302
      ? "enabled"
      : guestPreview.status === 404
        ? "disabled"
        : "unexpected";
  const previewWalled = previewState !== "disabled";
  checks.push(check("guest GET preview status", guestPreview.status, previewWalled ? 302 : 404));
  if (previewWalled) {
    checks.push(checkLocation("guest GET preview location", guestPreviewLocation, "/auth/discord"));
  } else {
    checks.push(checkLocation("guest GET preview location", guestPreviewLocation, null));
  }

  const guestRedispatch = await unsafe(REDISPATCH_PATH, baseUrl);
  const guestRedispatchLocation = guestRedispatch.headers.get("location");
  const guestRecovery = guestRedispatchLocation?.startsWith("/auth/recover?next=") ?? false;
  discard(guestRedispatch);
  const redispatchState =
    guestRedispatch.status === 303
      ? "enabled"
      : guestRedispatch.status === 404
        ? "disabled"
        : "unexpected";
  const redispatchWalled = redispatchState !== "disabled";
  checks.push(
    check("guest POST redispatch status", guestRedispatch.status, redispatchWalled ? 303 : 404),
  );
  if (redispatchWalled) {
    checks.push({
      label: "guest POST redispatch recovery target",
      actual: guestRecovery ? "recovery" : locationShape(guestRedispatchLocation),
      expected: "recovery",
      pass: guestRecovery,
    });
  } else {
    checks.push(checkLocation("guest POST redispatch location", guestRedispatchLocation, null));
  }

  const guestEvidence = await get(SOURCE_EVIDENCE_PATH);
  discard(guestEvidence);
  const evidenceState =
    guestEvidence.status === 403
      ? "enabled"
      : guestEvidence.status === 404
        ? "disabled"
        : "unexpected";
  const evidenceWalled = evidenceState !== "disabled";
  checks.push(
    check("guest GET source-evidence status", guestEvidence.status, evidenceWalled ? 403 : 404),
  );

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

  // Member leg: a signed-in non-moderator meets the panel gate (403) on the
  // session routes and the bearer wall (403) on the session-free route —
  // never advice, never a dispatch, never evidence.
  const memberCookie = await login("qa-member");
  {
    const res = await previewGet(PREVIEW_PATH, { Cookie: memberCookie });
    discard(res);
    checks.push(check("member GET preview status", res.status, previewWalled ? 403 : 404));
    checks.push(checkLocation("member GET preview location", res.headers.get("location"), null));
  }
  {
    const res = await unsafe(REDISPATCH_PATH, baseUrl, { Cookie: memberCookie });
    discard(res);
    checks.push(check("member POST redispatch status", res.status, redispatchWalled ? 403 : 404));
    checks.push(
      checkLocation("member POST redispatch location", res.headers.get("location"), null),
    );
  }
  {
    const res = await get(SOURCE_EVIDENCE_PATH, { Cookie: memberCookie });
    discard(res);
    checks.push(check("member GET source-evidence status", res.status, evidenceWalled ? 403 : 404));
  }

  // Moderator leg: qa-moderator is a general moderator, never the dedicated
  // operator, so the same 403s prove the operator boundary holds without an
  // operator session. Status-only: the 403 source (panel gate vs operator
  // boundary) is pinned by the route tests, not this drill.
  const moderatorCookie = await login("qa-moderator");
  {
    const res = await previewGet(PREVIEW_PATH, { Cookie: moderatorCookie });
    discard(res);
    checks.push(check("moderator GET preview status", res.status, previewWalled ? 403 : 404));
    checks.push(checkLocation("moderator GET preview location", res.headers.get("location"), null));
  }
  {
    const res = await unsafe(REDISPATCH_PATH, baseUrl, { Cookie: moderatorCookie });
    discard(res);
    checks.push(
      check("moderator POST redispatch status", res.status, redispatchWalled ? 403 : 404),
    );
    checks.push(
      checkLocation("moderator POST redispatch location", res.headers.get("location"), null),
    );
  }
  {
    const res = await get(SOURCE_EVIDENCE_PATH, { Cookie: moderatorCookie });
    discard(res);
    checks.push(
      check("moderator GET source-evidence status", res.status, evidenceWalled ? 403 : 404),
    );
  }

  // Control A: a forged cross-origin write keeps the outer 403, never a
  // bounce and never a disabled 404 — the global guard runs first.
  {
    const res = await unsafe(REDISPATCH_PATH, "https://evil.example");
    discard(res);
    checks.push(check("guest POST without trusted origin status", res.status, 403));
  }
  // Control B: the evidence path refuses write verbs before any flag,
  // session or source read, enabled or not.
  {
    const res = await unsafe(SOURCE_EVIDENCE_PATH, baseUrl);
    discard(res);
    checks.push(check("guest POST source-evidence status", res.status, 405));
  }

  // Preview and redispatch share one flag and one operator ID: their guest
  // legs must agree. Source-evidence is independently flagged.
  checks.push({
    label: "preview/redispatch admission agreement",
    actual: `${previewState}/${redispatchState}`,
    expected: "matching states",
    pass: previewState === redispatchState,
  });

  const failures = checks.filter((c) => !c.pass);
  return {
    target: baseUrl,
    admission: {
      preview: previewState,
      redispatch: redispatchState,
      sourceEvidence: evidenceState,
    },
    legs: {
      guest: "oauth / recovery / bearer wall, or disabled 404",
      member: "403 wall, or disabled 404",
      moderator: "403 operator wall, or disabled 404",
    },
    hits: { qaLogin: 2, preview: 3, redispatch: 4, sourceEvidence: 4 },
    passed: checks.length - failures.length,
    failed: failures.length,
    failures: failures.slice(0, 10),
  };
}

async function main() {
  if (process.argv.length !== 2) {
    console.error("Usage: node bin/queue-authwall-probe.mjs");
    process.exitCode = 1;
    return;
  }
  const result = await runProbe({ token: process.env.QA_AUTH_TOKEN });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print fetch exceptions: they may contain request headers or credentials.
    console.error(
      "Queue auth-wall probe failed. Check the staging QA gate, throttle budget and deployment; no outcome claimed.",
    );
    process.exitCode = 1;
  });
}
