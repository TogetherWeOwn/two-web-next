#!/usr/bin/env node
import { pathToFileURL } from "node:url";

// Staging-only post-deploy probe for the session-gated event JSON contract
// (TOG-11769; route contract from PR #109): collection paging envelope,
// JSON show shape, cancelled 410 envelope. Authenticates through the staging
// QA seam (POST /auth/qa/qa-member with X-TWO-QA-Auth, same-origin POST) as
// the non-moderator qa-member identity, so drafts stay hidden and the first
// collection row is always viewer-visible. Never probes production or unknown
// hosts, and never logs the token, cookies or response bodies.
//
// Session lifecycle: after the event checks the probe also pins the QA
// session's cookie attributes (login Set-Cookie for both the session and the
// auth-status probe cookie), one-shot rotation on an authenticated page view
// (the replayed old cookie stops authenticating on /auth/status, the new one
// does), server-side logout revocation with both cookies cleared, and that the
// QA bad-token 404 is indistinguishable from a missing-route 404. Failure
// output names attributes and states only, never a token or cookie value.
//
// Contract gate: PR #109 (GET /events/:key show route + collection `meta`
// envelope) may not be deployed yet. The collection response decides: a 200
// without the `meta` envelope means the contract is pending, so the
// contract-dependent checks SKIP visibly instead of failing the deploy.
// Probes that already hold on main (guest collection 401, QA login, malformed
// event_key 422) stay unconditional.

export const STAGING_ORIGIN = "https://next.togetherweown.com";
const QA_IDENTITY = "qa-member";
const QA_HEADER = "X-TWO-QA-Auth";
const SESSION_COOKIE = "__Host-two_session";
const STATUS_COOKIE = "__Host-two_session_status";
// Never a real credential: the 404-parity probe must be unable to log in.
const BAD_TOKEN = "json-smoke-bad-token";
const MISSING_ROUTE = "/auth/json-smoke-missing-route";
// Well-formed Crockford key with no fixture behind it: the guest gate runs
// before the row lookup, so this proves guest 401 without staging data.
const ABSENT_KEY = "0".repeat(26);
// PR #109 row shape, asserted as a required subset (never exact order) so
// additive fields stay deploy-safe. `id` must never leave the server.
const REQUIRED_SHOW_KEYS = [
  "event_key",
  "title",
  "game",
  "description",
  "starts_at",
  "ends_at",
  "timezone",
  "location",
  "capacity",
  "status",
  "rsvp_open",
  "going_count",
  "waitlist_position",
];
const PRIVATE_KEYS = ["id", "attendees", "user_id", "session", "token"];

const isJson = (response) =>
  (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() ===
  "application/json";

const errorName = (error) => (error instanceof Error ? error.name : "request error");

const setCookiesOf = (response) =>
  typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];

/** Parses one Set-Cookie header into `{name, value, attrs}`; attribute names are lower-cased. */
export function parseSetCookie(raw) {
  const [first = "", ...rest] = raw.split(";");
  const eq = first.indexOf("=");
  if (eq < 1) return null;
  const attrs = new Map();
  for (const part of rest) {
    const [key = "", ...value] = part.split("=");
    const name = key.trim().toLowerCase();
    if (name) attrs.set(name, value.join("=").trim());
  }
  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim(), attrs };
}

const cookieNamed = (response, name) => {
  const cookies = setCookiesOf(response)
    .map(parseSetCookie)
    .filter((cookie) => cookie?.name === name);
  // Duplicates fail the gate, but retain the last value for best-effort cleanup.
  return cookies.length ? { ...cookies.at(-1), duplicate: cookies.length > 1 } : undefined;
};

// Attribute names only: a violation list can never carry a cookie value.
function hostCookieProblems(cookie) {
  const problems = [];
  if (cookie.duplicate) problems.push("duplicate Set-Cookie");
  if (!cookie.name.startsWith("__Host-")) problems.push("__Host- prefix");
  if (cookie.attrs.get("path") !== "/") problems.push("Path=/");
  if (!cookie.attrs.has("secure")) problems.push("Secure");
  if (cookie.attrs.has("domain")) problems.push("no Domain");
  return problems;
}

export function sessionCookieProblems(cookie) {
  const problems = hostCookieProblems(cookie);
  if (!cookie.attrs.has("httponly")) problems.push("HttpOnly");
  if ((cookie.attrs.get("samesite") ?? "").toLowerCase() !== "lax") problems.push("SameSite=Lax");
  const maxAge = cookie.attrs.get("max-age") ?? "";
  if (!/^\d+$/.test(maxAge) || Number(maxAge) <= 0) problems.push("positive Max-Age");
  return problems;
}

export function clearedCookieProblems(cookie) {
  const problems = hostCookieProblems(cookie);
  if (cookie.value !== "") problems.push("empty value");
  if (cookie.attrs.get("max-age") !== "0") problems.push("Max-Age=0");
  return problems;
}

const CLOUDFLARE_SCRIPT_START =
  "<script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;" +
  "if(b){var d=b.createElement('script');d.innerHTML=\"window.__CF$cv$params={r:'";
const CLOUDFLARE_SCRIPT_END =
  "'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';" +
  "document.getElementsByTagName('head')[0].appendChild(a);\";b.getElementsByTagName('head')[0].appendChild(d)}}" +
  "if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;" +
  "a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';" +
  "document.body.appendChild(a);if('loading'!==document.readyState)c();" +
  "else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);" +
  "else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);" +
  "'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script>";

/** Comparison only, not HTML sanitization. Unknown injections remain byte-for-byte. */
export function stripCloudflareSnippet(html) {
  let output = "";
  let offset = 0;
  for (;;) {
    const start = html.indexOf(CLOUDFLARE_SCRIPT_START, offset);
    if (start < 0) return output + html.slice(offset);
    const valuesStart = start + CLOUDFLARE_SCRIPT_START.length;
    // Only the bounded ray and timestamp fields can vary; the whole wrapper must match.
    const values = html
      .slice(valuesStart, valuesStart + 160)
      .match(/^[a-f0-9]{16}',t:'[A-Za-z0-9+/]{1,128}={0,2}/i);
    const valuesEnd = valuesStart + (values?.[0].length ?? 0);
    output += html.slice(offset, start);
    if (values && html.startsWith(CLOUDFLARE_SCRIPT_END, valuesEnd)) {
      offset = valuesEnd + CLOUDFLARE_SCRIPT_END.length;
    } else {
      output += CLOUDFLARE_SCRIPT_START;
      offset = valuesStart;
    }
  }
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function jsonSmoke(baseUrl, { token, timeoutMs = 5_000, log = console.log } = {}) {
  if (typeof token !== "string" || !token) {
    throw new Error("QA_AUTH_TOKEN is required (staging QA login token)");
  }
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
  const loopback =
    base.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
  if (base.origin !== STAGING_ORIGIN && !loopback) {
    throw new Error(
      `staging-only: refusing ${base.origin} (production and unknown hosts are never probed)`,
    );
  }

  let checks = 0;
  let failures = 0;
  let skipped = 0;
  const pass = (label) => {
    checks++;
    log(`PASS ${label}`);
  };
  const skip = (label, reason) => {
    checks++;
    skipped++;
    log(`SKIP ${label}: ${reason}`);
  };
  const fail = (label, expected, actual) => {
    checks++;
    failures++;
    log(`FAIL ${label}: expected ${expected}; actual ${actual}`);
  };

  const get = (path, cookie) =>
    fetch(new URL(path, base), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
      },
    });

  // Guest refusals run before login and carry no cookie. The collection 401
  // gate exists on main already; the show 401 only exists once PR #109's
  // GET /events/:key route is deployed (before that, an unknown path returns
  // the app's branded 404), so it is contract-gated below.
  try {
    const response = await get("/events.json");
    const body = parseBody(await response.text());
    const ok =
      response.status === 401 &&
      isJson(response) &&
      body?.error === "unauthenticated" &&
      response.headers.get("location") === null;
    if (ok) pass("guest collection refusal");
    else
      fail(
        "guest collection refusal",
        "HTTP 401 JSON {error: unauthenticated}",
        `HTTP ${response.status}`,
      );
  } catch (error) {
    fail(
      "guest collection refusal",
      "HTTP response and body within timeout",
      error instanceof Error ? error.name : "request error",
    );
  }

  // Contract probe: PR #109's show route. 401 means the route (and its auth
  // gate) is deployed; the app's branded 404 means the route is not there yet
  // and the contract-dependent checks below must skip instead of fail. Any
  // other outcome (503, timeout, …) is a real failure, never a pass.
  let contractPending = false;
  const contractPendingNote = "event JSON contract not deployed yet (PR #109 pending)";
  try {
    const response = await get(`/events/${ABSENT_KEY}`);
    const body = parseBody(await response.text());
    if (
      response.status === 401 &&
      isJson(response) &&
      body?.error === "unauthenticated" &&
      response.headers.get("location") === null
    ) {
      pass("guest show refusal");
    } else if (response.status === 404) {
      contractPending = true;
      skip("guest show refusal", contractPendingNote);
    } else {
      fail(
        "guest show refusal",
        "HTTP 401 JSON {error: unauthenticated}",
        `HTTP ${response.status}`,
      );
    }
  } catch (error) {
    fail(
      "guest show refusal",
      "HTTP response and body within timeout",
      error instanceof Error ? error.name : "request error",
    );
  }

  // Same-origin QA login: the server's cross-origin gate needs an explicit
  // Origin, and the QA seam needs its header. The token travels in the header
  // only, never in a URL, and is never logged.
  let cookie = null;
  let loginResponse = null;
  try {
    const response = await fetch(new URL(`/auth/qa/${QA_IDENTITY}`, base), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { origin: base.origin, [QA_HEADER]: token },
    });
    await response.text();
    const issued = cookieNamed(response, SESSION_COOKIE);
    if (response.status === 204 && issued?.value) {
      cookie = issued.value;
      loginResponse = response;
      pass("QA login issues a session cookie");
    } else {
      fail(
        "QA login",
        "HTTP 204 with a session cookie",
        `HTTP ${response.status} ${issued ? "with session cookie" : "without session cookie"}`,
      );
    }
  } catch (error) {
    fail(
      "QA login",
      "HTTP response within timeout",
      error instanceof Error ? error.name : "request error",
    );
  }

  const authed = [];
  const checkAuthed = (label, fn) => authed.push([label, fn]);

  // PR #109 pending means the collection has no `meta` paginator. A healthy
  // pre-contract 200 ({data, page, limit}) skips visibly; anything else still
  // fails so a genuinely broken staging deploy stays red.
  checkAuthed("collection paging envelope", async () => {
    try {
      const response = await get("/events.json", cookie);
      const body = parseBody(await response.text());
      const meta = body?.meta;
      if (contractPending) {
        if (
          response.status === 200 &&
          isJson(response) &&
          Array.isArray(body?.data) &&
          typeof body?.page === "number" &&
          typeof body?.limit === "number"
        ) {
          skip("collection paging envelope", contractPendingNote);
        } else {
          fail(
            "collection paging envelope",
            "HTTP 200 {data, page, limit} pre-contract envelope",
            `HTTP ${response.status}`,
          );
        }
        return null;
      }
      const ok =
        response.status === 200 &&
        isJson(response) &&
        Array.isArray(body?.data) &&
        typeof body?.page === "number" &&
        typeof body?.limit === "number" &&
        meta &&
        typeof meta.current_page === "number" &&
        typeof meta.per_page === "number" &&
        typeof meta.total === "number" &&
        typeof meta.last_page === "number" &&
        meta.last_page >= 1 &&
        meta.total >= body.data.length &&
        body.data.length <= body.limit;
      if (ok) pass("collection paging envelope");
      else
        fail(
          "collection paging envelope",
          "HTTP 200 {data, page, limit, meta.current_page/per_page/total/last_page}",
          `HTTP ${response.status}`,
        );
      return ok ? body : null;
    } catch (error) {
      fail(
        "collection paging envelope",
        "HTTP response and body within timeout",
        error instanceof Error ? error.name : "request error",
      );
      return null;
    }
  });

  checkAuthed("malformed event_key filter", async () => {
    try {
      const response = await get("/events.json?event_key=not-a-key", cookie);
      const body = parseBody(await response.text());
      if (response.status === 422 && isJson(response) && body?.error === "invalid_event_key") {
        pass("malformed event_key filter");
      } else {
        fail(
          "malformed event_key filter",
          "HTTP 422 JSON {error: invalid_event_key}",
          `HTTP ${response.status}`,
        );
      }
    } catch (error) {
      fail(
        "malformed event_key filter",
        "HTTP response and body within timeout",
        error instanceof Error ? error.name : "request error",
      );
    }
  });

  checkAuthed("JSON show", async (collection) => {
    if (contractPending) {
      skip("JSON show", contractPendingNote);
      return;
    }
    const rows = collection?.data ?? [];
    if (!rows.length) {
      const empty = collection && collection.meta?.total === 0 && collection.meta?.last_page === 1;
      if (empty) skip("JSON show", "staging has no events");
      else
        fail(
          "JSON show",
          "first collection row with an event_key",
          "no usable collection envelope",
        );
      return;
    }
    const key = rows[0]?.event_key;
    if (typeof key !== "string" || !key) {
      fail("JSON show", "first collection row with an event_key", "row without event_key");
      return;
    }
    try {
      const response = await get(`/events/${key}`, cookie);
      const body = parseBody(await response.text());
      if (response.status === 200 && isJson(response) && body?.data) {
        const data = body.data;
        const missing = REQUIRED_SHOW_KEYS.filter((field) => !(field in data));
        const leaked = PRIVATE_KEYS.filter((field) => field in data);
        if (
          !missing.length &&
          !leaked.length &&
          data.event_key === key &&
          typeof data.status === "string"
        ) {
          pass("JSON show");
        } else {
          fail(
            "JSON show",
            `200 show for ${key} with the contract keys and no private fields`,
            `missing [${missing.join(",")}] leaked [${leaked.join(",")}]`,
          );
        }
      } else if (
        response.status === 410 &&
        isJson(response) &&
        body &&
        body.reason === "event_cancelled" &&
        body.message === "This event was cancelled." &&
        body.event_key === key &&
        body.status === "cancelled" &&
        Object.keys(body).length === 4
      ) {
        pass("JSON show");
      } else {
        fail("JSON show", `HTTP 200 show or 410 Gone for ${key}`, `HTTP ${response.status}`);
      }
    } catch (error) {
      fail(
        "JSON show",
        "HTTP response and body within timeout",
        error instanceof Error ? error.name : "request error",
      );
    }
  });

  checkAuthed("cancelled show", async () => {
    if (contractPending) {
      skip("cancelled show", contractPendingNote);
      return;
    }
    try {
      const response = await get("/events.json?per_page=100", cookie);
      const body = parseBody(await response.text());
      const cancelled = Array.isArray(body?.data)
        ? body.data.find((row) => row?.status === "cancelled" && typeof row?.event_key === "string")
        : undefined;
      if (!cancelled) {
        skip("cancelled show", "no cancelled event on the first page");
        return;
      }
      const show = await get(`/events/${cancelled.event_key}`, cookie);
      const gone = parseBody(await show.text());
      if (
        show.status === 410 &&
        isJson(show) &&
        gone &&
        gone.reason === "event_cancelled" &&
        gone.message === "This event was cancelled." &&
        gone.event_key === cancelled.event_key &&
        gone.status === "cancelled" &&
        Object.keys(gone).length === 4
      ) {
        pass("cancelled show");
      } else {
        fail(
          "cancelled show",
          `HTTP 410 Gone envelope for ${cancelled.event_key}`,
          `HTTP ${show.status}`,
        );
      }
    } catch (error) {
      fail(
        "cancelled show",
        "HTTP response and body within timeout",
        error instanceof Error ? error.name : "request error",
      );
    }
  });

  checkAuthed("malformed show key", async () => {
    // Pre-contract this path hits the app's branded HTML 404, not the JSON
    // show route's {error: not_found}.
    if (contractPending) {
      skip("malformed show key", contractPendingNote);
      return;
    }
    try {
      const response = await get("/events/bad-key", cookie);
      const body = parseBody(await response.text());
      if (response.status === 404 && isJson(response) && body?.error === "not_found") {
        pass("malformed show key");
      } else {
        fail("malformed show key", "HTTP 404 JSON {error: not_found}", `HTTP ${response.status}`);
      }
    } catch (error) {
      fail(
        "malformed show key",
        "HTTP response and body within timeout",
        error instanceof Error ? error.name : "request error",
      );
    }
  });

  if (!cookie) {
    for (const [label] of authed) skip(label, "no QA session");
  } else {
    // The show check reads the first row of the collection envelope, so the
    // collection check returns its body and every check runs in order.
    let collection = null;
    for (const [, fn] of authed) {
      const returned = await fn(collection);
      if (returned && typeof returned === "object" && Array.isArray(returned.data))
        collection = returned;
    }
  }

  // Session lifecycle. Runs after the event checks because rotation and logout
  // consume the QA session. Replays send the session cookie alone: /auth/status
  // prefers the probe cookie, whose key is stable across rotation, so a replay
  // that carried it would prove the live session rather than the old token.
  const call = (path, { method = "GET", session, headers = {} } = {}) =>
    fetch(new URL(path, base), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}), ...headers },
    });

  // true/false only for a 200 JSON verdict; an outage or odd reply is `null`,
  // never read as "logged out".
  const authenticates = async (session) => {
    const response = await call("/auth/status", {
      session,
      headers: { accept: "application/json" },
    });
    const body = parseBody(await response.text());
    const verdict =
      response.status === 200 && isJson(response) && typeof body?.authenticated === "boolean"
        ? body.authenticated
        : null;
    return { verdict, status: response.status };
  };
  const describeReplay = ({ verdict, status }, wanted) =>
    verdict === null ? `status probe HTTP ${status}` : wanted ? "rejected" : "still authenticates";

  const flagsExpected =
    "__Host- prefix, Path=/, Secure, HttpOnly, SameSite=Lax, positive Max-Age, no Domain";
  const lifecycleLabels = [
    "session cookie flags",
    "status cookie flags",
    "session rotation replay",
    "logout revokes session",
    "logout clears cookies",
  ];

  if (!cookie || !loginResponse) {
    for (const label of lifecycleLabels) skip(label, "no QA session");
  } else {
    for (const [label, name] of [
      ["session cookie flags", SESSION_COOKIE],
      ["status cookie flags", STATUS_COOKIE],
    ]) {
      const issued = cookieNamed(loginResponse, name);
      if (!issued) {
        fail(label, `login Set-Cookie ${name}`, "cookie not issued");
        continue;
      }
      const problems = sessionCookieProblems(issued);
      if (problems.length) fail(label, flagsExpected, `violated ${problems.join(", ")}`);
      else pass(label);
    }

    // One authenticated page view rotates the token: the old value is revoked
    // in the same statement that mints its replacement.
    let current = cookie;
    try {
      const page = await call("/", { session: cookie, headers: { accept: "text/html" } });
      const replacement = cookieNamed(page, SESSION_COOKIE);
      // The server may already have rotated. Cleanup must track the issued value
      // even when reading the page or checking either status response fails.
      if (replacement?.value) current = replacement.value;
      await page.text();
      const problems = [];
      if (page.status !== 200) problems.push(`page HTTP ${page.status}`);
      if (!replacement || !replacement.value) problems.push("no replacement session cookie");
      else if (replacement.value === cookie) problems.push("replacement cookie unchanged");
      else {
        const flags = sessionCookieProblems(replacement);
        if (flags.length) problems.push(`replacement cookie violated ${flags.join(", ")}`);
      }
      const old = await authenticates(cookie);
      if (old.verdict !== false) problems.push(`old cookie ${describeReplay(old, false)}`);
      if (replacement?.value && replacement.value !== cookie) {
        const fresh = await authenticates(replacement.value);
        if (fresh.verdict !== true)
          problems.push(`replacement cookie ${describeReplay(fresh, true)}`);
      }
      if (problems.length)
        fail(
          "session rotation replay",
          "old cookie unauthenticated and replacement authenticated on /auth/status",
          problems.join("; "),
        );
      else pass("session rotation replay");
    } catch (error) {
      fail("session rotation replay", "HTTP responses within timeout", errorName(error));
    }

    // Logout needs the correct Origin (same-origin gate) and must revoke the
    // row server-side, not only clear the browser cookie.
    let logout = null;
    let logoutError = null;
    try {
      logout = await call("/logout", {
        method: "POST",
        session: current,
        headers: { origin: base.origin },
      });
      await logout.text();
    } catch (error) {
      logoutError = errorName(error);
    }
    if (!logout || logoutError) {
      fail("logout revokes session", "HTTP 303 within timeout", logoutError ?? "request error");
      fail("logout clears cookies", "HTTP 303 within timeout", logoutError ?? "request error");
    } else {
      const problems = [];
      if (logout.status !== 303) problems.push(`logout HTTP ${logout.status}`);
      try {
        const replay = await authenticates(current);
        if (replay.verdict !== false)
          problems.push(`pre-logout cookie ${describeReplay(replay, false)}`);
      } catch (error) {
        problems.push(`status probe ${errorName(error)}`);
      }
      if (problems.length)
        fail(
          "logout revokes session",
          "HTTP 303 and the pre-logout cookie unauthenticated on /auth/status",
          problems.join("; "),
        );
      else pass("logout revokes session");

      const unclear = [];
      for (const [short, name] of [
        ["session", SESSION_COOKIE],
        ["status", STATUS_COOKIE],
      ]) {
        const cleared = cookieNamed(logout, name);
        if (!cleared) unclear.push(`${short} cookie not cleared`);
        else {
          const problems = clearedCookieProblems(cleared);
          if (problems.length) unclear.push(`${short} cookie violated ${problems.join(", ")}`);
        }
      }
      if (unclear.length)
        fail(
          "logout clears cookies",
          "both cookies empty with __Host- prefix, Path=/, Secure, Max-Age=0, no Domain",
          unclear.join("; "),
        );
      else pass("logout clears cookies");
    }
  }

  // Needs no session: a wrong token must be indistinguishable from a route
  // that does not exist (staging-only seam, so the seam is not discoverable).
  try {
    const attempt = { method: "POST", headers: { origin: base.origin } };
    const bad = await call(`/auth/qa/${QA_IDENTITY}`, {
      ...attempt,
      headers: { ...attempt.headers, [QA_HEADER]: BAD_TOKEN },
    });
    const missing = await call(MISSING_ROUTE, attempt);
    const [badBody, missingBody] = (await Promise.all([bad.text(), missing.text()])).map((text) =>
      stripCloudflareSnippet(text),
    );
    const contentType = (response) => (response.headers.get("content-type") ?? "").trim();
    const sameContentType = contentType(bad) === contentType(missing);
    if (
      bad.status === 404 &&
      missing.status === 404 &&
      badBody === missingBody &&
      sameContentType
    ) {
      pass("QA bad-token 404 matches missing route");
    } else {
      fail(
        "QA bad-token 404 matches missing route",
        "identical HTTP 404 status, content type and body (Cloudflare snippet excluded)",
        `HTTP ${bad.status} vs HTTP ${missing.status}${sameContentType ? "" : "; content types differ"}${
          badBody === missingBody
            ? ""
            : `; bodies differ (${badBody.length} vs ${missingBody.length} chars)`
        }`,
      );
    }
  } catch (error) {
    fail(
      "QA bad-token 404 matches missing route",
      "HTTP responses within timeout",
      errorName(error),
    );
  }

  log(`json-smoke: ${checks} checks, ${failures} failed, ${skipped} skipped`);
  return failures === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error(
      "Usage: QA_AUTH_TOKEN=<staging QA token> node bin/json-smoke.mjs <staging-base-url>",
    );
    process.exitCode = 2;
  } else {
    const token = process.env.QA_AUTH_TOKEN;
    if (!token) {
      console.error("json-smoke: QA_AUTH_TOKEN is required (staging QA login token)");
      process.exitCode = 2;
    } else {
      try {
        process.exitCode = (await jsonSmoke(process.argv[2], { token })) ? 0 : 1;
      } catch (error) {
        console.error(`json-smoke: ${error instanceof Error ? error.message : "invalid base-url"}`);
        process.exitCode = 2;
      }
    }
  }
}
