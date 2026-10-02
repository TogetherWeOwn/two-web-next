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
// Well-formed Crockford key with no fixture behind it: the guest gate runs
// before the row lookup, so this proves guest 401 without staging data.
const ABSENT_KEY = "0".repeat(26);
// PR #109 row shape, asserted as a required subset (never exact order) so
// additive fields stay deploy-safe. `id` must never leave the server.
const REQUIRED_SHOW_KEYS = [
  "event_key", "title", "game", "description", "starts_at", "ends_at",
  "timezone", "location", "capacity", "status", "rsvp_open", "going_count",
  "waitlist_position",
];
const PRIVATE_KEYS = ["id", "attendees", "user_id", "session", "token"];

const isJson = (response) =>
  (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";

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
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("base-url must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  const loopback = base.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
  if (base.origin !== STAGING_ORIGIN && !loopback) {
    throw new Error(`staging-only: refusing ${base.origin} (production and unknown hosts are never probed)`);
  }

  let checks = 0;
  let failures = 0;
  let skipped = 0;
  const pass = (label) => { checks++; log(`PASS ${label}`); };
  const skip = (label, reason) => { checks++; skipped++; log(`SKIP ${label}: ${reason}`); };
  const fail = (label, expected, actual) => { checks++; failures++; log(`FAIL ${label}: expected ${expected}; actual ${actual}`); };

  const get = (path, cookie) => fetch(new URL(path, base), {
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
    const ok = response.status === 401 && isJson(response) &&
      body?.error === "unauthenticated" && response.headers.get("location") === null;
    if (ok) pass("guest collection refusal");
    else fail("guest collection refusal", "HTTP 401 JSON {error: unauthenticated}", `HTTP ${response.status}`);
  } catch (error) {
    fail("guest collection refusal", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
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
    if (response.status === 401 && isJson(response) &&
        body?.error === "unauthenticated" && response.headers.get("location") === null) {
      pass("guest show refusal");
    } else if (response.status === 404) {
      contractPending = true;
      skip("guest show refusal", contractPendingNote);
    } else {
      fail("guest show refusal", "HTTP 401 JSON {error: unauthenticated}", `HTTP ${response.status}`);
    }
  } catch (error) {
    fail("guest show refusal", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
  }

  // Same-origin QA login: the server's cross-origin gate needs an explicit
  // Origin, and the QA seam needs its header. The token travels in the header
  // only, never in a URL, and is never logged.
  let cookie = null;
  try {
    const response = await fetch(new URL(`/auth/qa/${QA_IDENTITY}`, base), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { origin: base.origin, [QA_HEADER]: token },
    });
    await response.text();
    const raw = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
    const pair = raw.map((header) => header.split(";")[0]?.trim())
      .find((candidate) => candidate?.startsWith(`${SESSION_COOKIE}=`));
    if (response.status === 204 && pair && pair.length > SESSION_COOKIE.length + 1) {
      cookie = pair.slice(SESSION_COOKIE.length + 1);
      pass("QA login issues a session cookie");
    } else {
      fail("QA login", "HTTP 204 with a session cookie",
        `HTTP ${response.status} ${pair ? "with session cookie" : "without session cookie"}`);
    }
  } catch (error) {
    fail("QA login", "HTTP response within timeout", error instanceof Error ? error.name : "request error");
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
        if (response.status === 200 && isJson(response) && Array.isArray(body?.data) &&
            typeof body?.page === "number" && typeof body?.limit === "number") {
          skip("collection paging envelope", contractPendingNote);
        } else {
          fail("collection paging envelope", "HTTP 200 {data, page, limit} pre-contract envelope", `HTTP ${response.status}`);
        }
        return null;
      }
      const ok = response.status === 200 && isJson(response) && Array.isArray(body?.data) &&
        typeof body?.page === "number" && typeof body?.limit === "number" &&
        meta && typeof meta.current_page === "number" && typeof meta.per_page === "number" &&
        typeof meta.total === "number" && typeof meta.last_page === "number" &&
        meta.last_page >= 1 && meta.total >= body.data.length && body.data.length <= body.limit;
      if (ok) pass("collection paging envelope");
      else fail("collection paging envelope", "HTTP 200 {data, page, limit, meta.current_page/per_page/total/last_page}", `HTTP ${response.status}`);
      return ok ? body : null;
    } catch (error) {
      fail("collection paging envelope", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
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
        fail("malformed event_key filter", "HTTP 422 JSON {error: invalid_event_key}", `HTTP ${response.status}`);
      }
    } catch (error) {
      fail("malformed event_key filter", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
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
      else fail("JSON show", "first collection row with an event_key", "no usable collection envelope");
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
        if (!missing.length && !leaked.length && data.event_key === key && typeof data.status === "string") {
          pass("JSON show");
        } else {
          fail("JSON show", `200 show for ${key} with the contract keys and no private fields`,
            `missing [${missing.join(",")}] leaked [${leaked.join(",")}]`);
        }
      } else if (response.status === 410 && isJson(response) && body &&
          body.reason === "event_cancelled" && body.message === "This event was cancelled." &&
          body.event_key === key && body.status === "cancelled" && Object.keys(body).length === 4) {
        pass("JSON show");
      } else {
        fail("JSON show", `HTTP 200 show or 410 Gone for ${key}`, `HTTP ${response.status}`);
      }
    } catch (error) {
      fail("JSON show", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
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
      if (show.status === 410 && isJson(show) && gone &&
          gone.reason === "event_cancelled" && gone.message === "This event was cancelled." &&
          gone.event_key === cancelled.event_key && gone.status === "cancelled" && Object.keys(gone).length === 4) {
        pass("cancelled show");
      } else {
        fail("cancelled show", `HTTP 410 Gone envelope for ${cancelled.event_key}`, `HTTP ${show.status}`);
      }
    } catch (error) {
      fail("cancelled show", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
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
      fail("malformed show key", "HTTP response and body within timeout", error instanceof Error ? error.name : "request error");
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
      if (returned && typeof returned === "object" && Array.isArray(returned.data)) collection = returned;
    }
  }

  log(`json-smoke: ${checks} checks, ${failures} failed, ${skipped} skipped`);
  return failures === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error("Usage: QA_AUTH_TOKEN=<staging QA token> node bin/json-smoke.mjs <staging-base-url>");
    process.exitCode = 2;
  } else {
    const token = process.env.QA_AUTH_TOKEN;
    if (!token) {
      console.error("json-smoke: QA_AUTH_TOKEN is required (staging QA login token)");
      process.exitCode = 2;
    } else {
      try {
        process.exitCode = await jsonSmoke(process.argv[2], { token }) ? 0 : 1;
      } catch (error) {
        console.error(`json-smoke: ${error instanceof Error ? error.message : "invalid base-url"}`);
        process.exitCode = 2;
      }
    }
  }
}
