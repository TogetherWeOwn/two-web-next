import { type Context, Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import postgres from "postgres";
import { adminApp } from "./admin/routes";
import { registerAuthRoutes, SESSION_COOKIE } from "./auth/routes";
import { agentEventsAdmission, agentEventsRoute } from "./agent-events/route";
import { registerAlertProbe } from "./alert-probe";
import { requestBodyLimit } from "./body-limit";
import { readCounts } from "./counts";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  isValidSessionToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
  type Sql,
} from "./sessions";
import { databaseUrl, perRequestDatabaseOptions } from "./db/connection";
import { isDatabaseUnavailable } from "./db/errors";
import { upsertRosterUser } from "./db/roster";
import { pgQueueDepth } from "./jobs/postgres";
import type { Env, Session } from "./env";
import { imageHosts } from "./image-policy";
import { Join, Home, type Notice } from "./pages";
import { renderHtmlOutcome } from "./html-outcome";
import { honoRecoveryRenderer } from "./recovery-hono";
import { recoveryOutcome } from "./recovery-outcome";
import { internalErrorHandler, registerErrorHandlers } from "./errors";
import { registerEventRoutes } from "./events/routes";
import { registerHotzoneRoutes } from "./hotzones/routes";
import { discordEventsSource } from "./events/discord-transients";
import { dbFor } from "./admin/db";
import { cachedFeatured, cachedHomeUpcoming } from "./home-cache";
import { leafInlineStyleCsp, robotsTag, SECURITY_HEADERS } from "./headers";
import { registerJoinRoutes } from "./join/route";
import { registerAiFriendlyRoutes } from "./ai-friendly/routes";
import { registerSeoLeaves } from "./seo-leaves";
import { registerStaticLeaves } from "./static-leaves";
import { safeNext } from "./join/service";
import { profilesApp } from "./profiles/routes";
import { registerMcpRoutes } from "./mcp/routes";
import { registerPublicApiRoutes } from "./public-data/routes";
import { takeJoinResult } from "./return-journey";
import { buildSecurityTxt } from "./security-txt";
import { enforceOn } from "./access-log";
import {
  configReadiness,
  revisionReadiness,
  upBody,
  upHttpStatus,
  withHealthReadTimeout,
} from "./up";
import { requestLog, safeRequestId } from "./request-log";
import { sameOrigin } from "./same-origin";
import { trustHosts } from "./trust-hosts";
import { authStatusScript, enableAuthStatus } from "./auth-status";
import { expiredWriteBanner } from "./write-recovery";
import { freezeBanner } from "./freeze-banner";
import { webmcpPilot } from "./webmcp-pilot";

export { rulesLastUpdated } from "./rules-last-updated";

// The session cookie name is defined once in ./session-cookie (re-exported by ./auth/routes, which owns logout).
// The OAuth state lifetime stays defined here: the privacy-numbers pin only
// allows STATE_TTL_SECONDS to originate from this module (or join/route).
export const STATE_TTL_SECONDS = 600;

const app = new Hono<{ Bindings: Env }>();

// The violation sink (TOG-10107): the CSP report-to directive selects the
// Reporting-Endpoints group. No report-uri: it is deprecated (ZAP 10055
// notices flag it) and report-to is Baseline in current browsers.
// Omit the deprecated Report-To header: unlike Reporting-Endpoints, it
// requires absolute HTTPS URLs, not this same-origin relative destination.
const CSP_REPORT_ENDPOINT = "/csp-reports";

// The four static headers (fonts byte-identical to SECURITY_HEADERS in
// src/headers.ts — the tested copy; the parity test pins both sides so drift
// fails the build). X-Frame-Options is DENY: nothing frames this site
// (TOG-5469). Registered globally, not on a route group: the DB-free funnel
// leaves and the mounted admin/profile sub-apps inherit it from the outer
// dispatch. The CSP shape + report sink belong to the CSP-report slice
// (TOG-10107) and are configured above; the staging X-Robots-Tag lives in
// the robotsTag middleware below. Strict-Transport-Security is explicitly
// disabled here (strictTransportSecurity: false below): the edge owns it
// (TOG-8729) — Hono defaults it on, and emitting it from the app would pin
// local dev machines to HTTPS. The absence is pinned in test/seo-headers.
// One security-header wrapper (the exposure inventory in
// test/member-exposure.test.ts pins middleware multiplicity): secureHeaders
// plus the staging X-Robots-Tag plus the content-leaf inline-style hash.
// Mounted sub-apps inherit all three from this outer dispatch, including
// refusals from the same-origin guard.
const staticSecurityHeaders = secureHeaders({
  // Edge-owned (TOG-8729): emitting HSTS from the app would pin local dev
  // machines to HTTPS, so the Hono default is explicitly off.
  strictTransportSecurity: false,
  // ZAP 90004; credentialless, not require-corp: cross-origin embeds are credential-free.
  crossOriginEmbedderPolicy: "credentialless",
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    // Restored legacy directives (W16b TOG-11942): object-src 'none' (no
    // <object>/<embed> anywhere in src/), base-uri 'self', connect-src
    // 'self' (island fetch targets are same-origin paths). The remaining
    // legacy delta — upgrade-insecure-requests — is left out: every source
    // list is 'self' or an explicit https:// host, so an http: subresource is
    // blocked rather than upgraded, and HTTPS itself is edge-owned (TOG-8729).
    baseUri: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    imgSrc: [
      "'self'",
      (c) =>
        imageHosts((c.env as Env).FEATURED_IMAGE_HOSTS)
          .map((host) => `https://${host}`)
          .join(" "),
    ],
    // Only join reads embed the widget; other routes cannot frame anything.
    frameSrc: [
      (c) =>
        c.req.path === "/join" && ["GET", "HEAD"].includes(c.req.method)
          ? "https://discord.com/widget"
          : "'none'",
    ],
    // The static policy stays 'self'-only on every route. Inline styles on /
    // and content leaves are allowlisted per-route by leafInlineStyleCsp
    // below; other routes keep the self-only style policy.
    styleSrc: ["'self'"],
    scriptSrc: ["'self'"],
    fontSrc: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    reportTo: "csp-endpoint",
  },
  xContentTypeOptions: SECURITY_HEADERS["X-Content-Type-Options"],
  referrerPolicy: SECURITY_HEADERS["Referrer-Policy"],
  xFrameOptions: SECURITY_HEADERS["X-Frame-Options"],
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
  },
  reportingEndpoints: [{ name: "csp-endpoint", url: CSP_REPORT_ENDPOINT }],
});

app.use("*", (c, next) =>
  requestLog(c, async () => {
    try {
      await staticSecurityHeaders(c, next);
      await robotsTag(c, async () => {});
      leafInlineStyleCsp(c);
    } catch (err) {
      // Handler errors already became responses; one thrown by this
      // post-processing would skip requestLog, so settle the final 500 here.
      c.res = await internalErrorHandler(err, c);
    }
  }),
);

// TrustHosts re-expression (W16: TOG-10110): refuse foreign Host values
// before routing. Mounted after secureHeaders (refusals leave hardened) and
// before every route; absolute URLs never derive from Host (all from APP_URL).
app.use("*", trustHosts());

// Before throttles, session rotation, body parsing, or any mounted handler.
app.use("*", sameOrigin);
app.use("*", authStatusScript);
app.use("*", expiredWriteBanner);
app.use("*", freezeBanner);
app.use("*", webmcpPilot);

// OAuth and login routes live in ./auth/routes; the app module only wires them.
registerAuthRoutes(app, {
  storeFor: (c) => storeFor(c),
  issueSession: (c, store, row) => issueSession(c, store, row),
});

// The Discord invite floor lives in ./invite so the join journey's recovery
// page can share it (same file the /discord redirect uses).
export { FALLBACK_INVITE, inviteDestination } from "./invite";

// Test seam: tests carry a SessionStore on the env object (`{...env, SESSION_STORE: store}`,
// cast at the call site). Production bindings never set it, so this branch is dead in
// production. It keeps per-request store isolation without module-global state.
type EnvWithStore = Env & { SESSION_STORE?: SessionStore };

// Test seam for the roster write: tests inject a Sql double (`{...env, ROSTER_STORE: sql}`).
// Production bindings never set it.
type EnvWithRoster = Env & { ROSTER_STORE?: Sql };

// The cookie never carries identity claims. It carries a random token; the row
// in Postgres is the session. A stolen DB dump yields hashes, not logins, and
// rotation/revocation are a row delete, not waiting for a signature to expire.
//
// No DDL here (TOG-19721): web_sessions comes from the migrate workflow
// (drizzle/1022), so the runtime role stays read/write-only. A database that
// predates that migration surfaces as a query failure, like any other outage.
async function storeFor(c: Context<{ Bindings: Env }>): Promise<SessionStore> {
  return storeForEnv(c.env);
}

// Shared with the Kit hook: the same DB selection Hono uses, so
// Kit reads the sessions Hono writes. Same lifecycle too — a short-lived
// per-request client, Hyperdrive pooling underneath, idle_timeout reaping.
export async function storeForEnv(env: Env): Promise<SessionStore> {
  const injected = (env as EnvWithStore).SESSION_STORE;
  if (injected) return injected;
  const url = databaseUrl(env);
  // No DB configuration: a fresh memory store per request fails closed to guest.
  if (!url) return createMemorySessionStore();
  // Short-lived per-request client; Hyperdrive pools underneath in the Worker.
  // Keep it alive while the store uses it; idle_timeout closes idle sockets.
  const sql = postgres(url, perRequestDatabaseOptions()) as unknown as Sql;
  return createPostgresSessionStore(sql);
}

// Roster persistence shares storeFor's DB selection so signed-in profiles
// read the same users sign-in writes. Tests may inject ROSTER_STORE; no DB
// configuration means a no-op upsert so DB-free sign-in tests still work.
// No DDL here either (TOG-19721): the users table is drizzle/0000, owned by
// the migrate workflow.
function rosterSqlFor(c: Context<{ Bindings: Env }>): {
  sql: Sql | null;
  close?: () => Promise<void>;
} {
  const injected = (c.env as EnvWithRoster).ROSTER_STORE;
  if (injected) return { sql: injected };
  const url = databaseUrl(c.env);
  if (!url) return { sql: null };
  const client = postgres(url, perRequestDatabaseOptions());
  return {
    sql: client as unknown as Sql,
    close: () => client.end({ timeout: 0 }),
  };
}

/** Fresh-login mutual exclusion, per user: overlapping callbacks for the same
 * user run their insert+sweep one at a time, so insert A, insert B, sweep A,
 * sweep B cannot revoke both fresh tokens. Keys are user ids only — never a
 * global lock, so different users stay concurrent. Process-wide (not
 * per-store) so per-request store instances still serialize the same user;
 * entries are removed when their tail has no waiter. Holds no session data and
 * no live database connection while waiting (per-request clients connect
 * lazily on first query, inside the lock body — a queued waiter adds no
 * socket beyond the client its own request already owns). Single call site
 * (issueSession below); not reentrant — never wrap it in itself.
 *
 * Cross-isolate note: this chain serializes only within one isolate. Two
 * callbacks for the same user on different isolates still overlap; that case
 * stays fail-closed (re-login, no leak) until a store-coordinated follow-up
 * lands behind the same per-user scope. */
const freshLoginChains = new Map<string, Promise<void>>();

/** Bound on waiting for the previous same-user issuance (see
 * withFreshLoginUserLock): a holder that never settles its tail — a store
 * query stalled on transport (the per-request statement timeout cancels
 * server-side execution, not a dead socket) or a disconnect-cancelled
 * callback — would otherwise hang that user's future logins on the isolate
 * indefinitely. Normal insert+sweep work is millisecond-scale and the
 * barrier-test hold is 1.5 s, so 10 s (matching the DB connect timeout) only
 * fires on a genuinely stuck holder; the bound must stay above the worst
 * legitimate hold or waiters time out into the very overlap the lock exists
 * to prevent. A timeout overlap stays fail-closed (re-login, no leak), never
 * wedged — trading a both-dead window after a >10 s stall for eliminating
 * the indefinite hang. Exported for tests; production callers use the
 * default. */
export const FRESH_LOGIN_LOCK_WAIT_MS = 10_000;

export async function withFreshLoginUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
  waitMs = FRESH_LOGIN_LOCK_WAIT_MS,
): Promise<T> {
  const prev = freshLoginChains.get(userId) ?? Promise.resolve();
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const cur = prev.then(() => tail);
  freshLoginChains.set(userId, cur);
  // Bounded wait: skip waiting on a stuck predecessor, never unlink the
  // chain — later waiters still queue behind this tail, preserving FIFO
  // order. The timer is cleared on the fast path so settled waits hold no
  // resources. `prev` never rejects (tails only resolve), so the race cannot
  // throw here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prev,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  try {
    return await fn();
  } finally {
    releaseTail();
    if (freshLoginChains.get(userId) === cur) freshLoginChains.delete(userId);
  }
}

async function issueSession(
  c: Context<{ Bindings: Env }>,
  store: SessionStore,
  row: {
    userId: string;
    username: string;
    avatar: string | null;
    member: boolean;
    moderator: boolean;
  },
): Promise<void> {
  // N6 (TOG-9898): refresh the durable roster row on every sign-in — the
  // legacy updateOrCreate on the Discord id. The /join/callback reaches here
  // through the JoinSessionHooks mount below, and the staging QA seam calls
  // this directly, so all three sign-in paths share this one write (QA writes
  // the roster deliberately: W7 profile reads depend on it). Never blocks
  // sign-in: a roster failure warns and the session still issues. This payload
  // carries no moderator field — `users` has no such column, and the flag is
  // recomputed from Discord role IDs into the session row only.
  try {
    const roster = rosterSqlFor(c);
    try {
      await upsertRosterUser(roster.sql, {
        id: row.userId,
        username: row.username,
        avatar: row.avatar,
        member: row.member,
      });
    } finally {
      // Dedicated optional client only: never close injected/shared or session
      // storage. SQL limits cancel backend work; end also settles pending I/O.
      await roster.close?.();
    }
  } catch (err) {
    // Driver messages can carry DSN fragments; the class name is the whole story here.
    console.warn("roster upsert failed", {
      request_id: c.get("requestId"),
      exception: (err as Error)?.constructor?.name ?? "unknown",
    });
  }
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  const replacement = {
    tokenHash,
    ...row,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  };
  const prior = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  // Malformed pre-login bearers never reach the store: the shared
  // minted-shape gate rejects them before hashing (malformed prior =>
  // create, never replace).
  const priorHash = isValidSessionToken(prior) ? await hashToken(prior) : null;
  // Serialize the insert+sweep per user (see withFreshLoginUserLock): the
  // second overlapping issuance waits for the first to finish, so the final
  // state equals a serialized order — newest live, previous revoked. The wait
  // is bounded: a holder stuck past FRESH_LOGIN_LOCK_WAIT_MS (for example a
  // disconnect-cancelled callback that never settles its tail) no longer wedges
  // later logins; the overlap stays fail-closed. A sweep failure still
  // completes sign-in (fail-open wins over strict newest-wins: both stay live
  // rather than failing the login). A degenerate empty user id runs unlocked;
  // Discord ids are never empty.
  const runLocked =
    typeof row.userId === "string" && row.userId
      ? (fn: () => Promise<void>) => withFreshLoginUserLock(row.userId, fn)
      : (fn: () => Promise<void>) => fn();
  await runLocked(async () => {
    // Fresh authentication revokes the presented pre-login/pre-join token
    // atomically with the insert (a failed insert leaves the prior session
    // intact; see store.replace). The token is revoked by hash because it can
    // belong to a different user (shared terminal).
    if (priorHash) {
      await store.replace(priorHash, replacement);
    } else {
      await store.create(replacement);
    }
    // Session fixation: additionally revoke every other live session for this
    // user so only the newest survives. The fresh row already exists: a sweep
    // failure warns and sign-in still succeeds (fail-open on the sweep, never
    // a logout-on-login). Token-hash-only.
    try {
      await store.revokeUserSessions(row.userId, tokenHash);
    } catch (err) {
      console.warn("prior session sweep failed", {
        request_id: c.get("requestId"),
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
    }
  });
  await setSignedCookie(c, SESSION_COOKIE, token, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  await enableAuthStatus(c, store, await hashToken(token));
}

async function readSession(
  c: Context<{ Bindings: Env }>,
  rotateToken = true,
): Promise<Session | null> {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!isValidSessionToken(token)) return null;
  // Anonymous public pages must not depend on session storage or its startup DDL.
  const store = await storeFor(c);
  const row = await store.get(await hashToken(token));
  if (!row) return null;
  // Abortable calendar fragments validate expiry/revocation but must not delete
  // the browser's current token: an aborted response cannot deliver a replacement.
  if (!rotateToken) {
    return {
      id: row.userId,
      username: row.username,
      avatar: row.avatar,
      member: row.member,
      moderator: row.moderator,
    };
  }
  // Rotation: every authenticated page view mints a fresh token and deletes
  // the old row in the same statement, keeping the immediate predecessor
  // valid for 10s (bounded by its own expiry) while its successor stays live.
  // A replayed cookie past grace finds no row: guest (rotate resolves false
  // for a revoked/expired/missing source — row ineligible stays guest, never
  // an outage). Any rotation *error* is an outage, never a silent guest:
  // classified database failures propagate as themselves, generic errors
  // normalize to a plain Error so the callers' existing opaque-fallback
  // boundary (plain Error => outage, named non-outage => 500) renders the
  // honest outage treatment without leaking driver details or swallowing
  // genuine programming errors from other reads.
  const statusKey = await store.statusHash(await hashToken(token));
  const replacement = newSessionToken();
  let rotated: boolean;
  try {
    rotated = await store.rotate(await hashToken(token), {
      tokenHash: await hashToken(replacement),
      ...row,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    });
  } catch (err) {
    if (isDatabaseUnavailable(err)) throw err;
    throw new Error("Session rotation unavailable");
  }
  if (!rotated) {
    // Predecessor grace or a lost rotation race: re-read once. A grace row
    // (or a concurrent winner's predecessor) authenticates without rotating,
    // minting or extending — tab B keeps its jar until grace lapses. A
    // revoked/expired source stays guest.
    const graceRow = await store.get(await hashToken(token));
    if (!graceRow) return null;
    return {
      id: graceRow.userId,
      username: graceRow.username,
      avatar: graceRow.avatar,
      member: graceRow.member,
      moderator: graceRow.moderator,
    };
  }
  await enableAuthStatus(c, store, await hashToken(replacement), statusKey);
  await setSignedCookie(c, SESSION_COOKIE, replacement, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return {
    id: row.userId,
    username: row.username,
    avatar: row.avatar,
    member: row.member,
    moderator: row.moderator,
  };
}

// One banner sentence per ordinary-login failure meaning (TOG-10355): denied
// (they cancelled) is distinct from unavailable (Discord did not answer) and
// from the generic/expired "didn't complete". Discord's error_description is
// never echoed anywhere — the banner is our copy.
const NOTICES = new Set([
  "joined",
  "already_member",
  "join_failed",
  "signin_failed",
  "signin_denied",
  "signin_unavailable",
]);

app.get("/", async (c) => {
  const n = c.req.query("n");
  const notice = (n && NOTICES.has(n) ? n : null) as Notice;
  // Each homepage read opens its own web-DB client: the two transactions run
  // on parallel max:1 connections like pre-#856, never serialized behind one
  // shared client.
  // Independent reads start together: the session (web DB), the counts (bot
  // DB), the one-shot flash (signed cookie only) and the guest-invariant
  // homepage data (shared short-TTL cache, never per-session). Sequential
  // awaits summed every round trip into the server time here.
  // A DB outage must not break the funnel, including session setup. Fail closed to guest.
  const sessionPromise: Promise<{ session: Session | null; unavailable: boolean }> = readSession(
    c,
  ).then(
    (session) => ({ session, unavailable: false }),
    (err) => {
      // Keep the opaque session-failure fallback, not named non-outage exceptions.
      // Rotation errors arrive already normalized (classified outage or plain
      // Error), so they render sessionUnavailable here; a revoked/expired row
      // already returned null above (guest) without reaching rotation.
      if (err instanceof Error && err.name !== "Error" && !isDatabaseUnavailable(err)) throw err;
      // Driver messages can contain DSNs or session identifiers; only a fixed diagnostic is safe.
      console.warn("Home session unavailable; serving as guest.", {
        exception: "SessionReadFailure",
      });
      return { session: null as Session | null, unavailable: true };
    },
  );
  // The counts read degrades to the empty state when the bot DB is down — never a 500 on the
  // funnel top (ports two-web CountsReader::remember's never-throw contract).
  const countsPromise = readCounts(c.env);
  // One-shot join confirmation (legacy join_result flash): first render consumes it.
  // A failure landing drops a stale success flash instead — the current failure
  // explanation wins over an older journey's success (TOG-10356 review).
  const flashedPromise = takeJoinResult(c);
  // ExecutionContext is absent outside the Worker (tests, some adapters):
  // the guest cache is isolate-local memory only, so it needs no background
  // scheduling; the context is passed through for signature compatibility.
  let executionCtx: ExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx as unknown as ExecutionContext;
  } catch {
    executionCtx = undefined;
  }
  const homeUpcomingPromise = cachedHomeUpcoming(
    c.env,
    () => dbFor(c),
    () => discordEventsSource(c.env),
    new Date(),
    executionCtx,
    c.get("requestId"),
  );
  const featuredPromise = cachedFeatured(c.env, () => dbFor(c), new Date(), executionCtx);
  const [{ session, unavailable: sessionUnavailable }, counts, flashed, homeUpcoming, featured] =
    await Promise.all([
      sessionPromise,
      countsPromise,
      flashedPromise,
      homeUpcomingPromise,
      featuredPromise,
    ]);
  const joinResult = [
    "join_failed",
    "signin_failed",
    "signin_denied",
    "signin_unavailable",
  ].includes(notice ?? "")
    ? null
    : flashed;
  c.header("cache-control", "private, no-store");
  return c.html(
    <Home
      session={session}
      sessionUnavailable={sessionUnavailable}
      notice={notice}
      joinResult={joinResult}
      inviteUrl={c.env.DISCORD_INVITE_URL}
      appUrl={c.env.APP_URL}
      counts={counts}
      upcomingEvents={homeUpcoming.items}
      eventsUnavailable={homeUpcoming.unavailable}
      featured={featured}
      imageHosts={c.env.FEATURED_IMAGE_HOSTS}
    />,
  );
});

// Database-free static leaves (`/discord`, `/login`, `/community`, `/about`,
// `/faq`, `/rules`): registered in ./static-leaves so the Worker entry stays
// under the M3 file-size gate. Paths, status codes, cache headers and the
// `safeNext` policy live there verbatim.
registerStaticLeaves(app);

// Policy/SEO leaves (`/privacy`, `/sitemap_index.xml`, `/robots.txt`,
// `POST /csp-reports`): registered in ./seo-leaves so the Worker entry stays
// under the M3 file-size gate. Paths, status codes, cache headers and the
// DB-degrades-to-static sitemap policy live there verbatim. Registered before
// the join journey so the CSP sink keeps its pre-session placement.
registerSeoLeaves(app);

// AI-friendly machine formats: `/llms.txt` + curated `.md`
// alternates. New routes, not Accept negotiation — one media type per route.
// Viewer-independent by construction (no session read), so the HTML pages
// above link out with `rel=alternate` and staging noindexes the .md surface.
registerAiFriendlyRoutes(app);

// The one-click join journey (W6: TOG-9685). /join is the database-free page;
// /join/discord + /join/callback run the throttled OAuth round trip with the
// synchronous bot add. JoinAttempt rows land in Postgres when DATABASE_URL is
// set; without it the journey degrades to no persistence (never a 500).
registerJoinRoutes(
  app,
  { storeFor, issueSession },
  {
    joinPage: async (c, props) => {
      // Carrying the join-result flash makes the response viewer-specific:
      // the static page keeps its shared-cache TTL only when there is nothing
      // to consume (otherwise a guest could read another member's banner).
      // Vary stays on every variant: the representation depends on the flash
      // cookie even when this view has nothing to consume. A rendered presence
      // snapshot says "now", so it keeps only a 60 s shared-cache TTL to match
      // the widget verdict TTL; the static page without presence keeps 3600 s.
      const joinResult = await takeJoinResult(c);
      c.header(
        "cache-control",
        joinResult
          ? "private, no-store"
          : props.widgetSnapshot
            ? "public, max-age=60"
            : "public, max-age=3600",
      );
      c.header("vary", "Cookie");
      return c.html(
        <Join
          inviteUrl={props.inviteUrl}
          widgetUrl={props.widgetUrl}
          widgetSnapshot={props.widgetSnapshot}
          next={props.next}
          source={props.source}
          appUrl={c.env.APP_URL}
          joinResult={joinResult}
        />,
      );
    },
    // Same model, status and headers as the direct render: the injected
    // renderer only changes who turns the model into bytes (the Svelte
    // adapter consumes the same RecoveryModel). Statuses (200 recovery, 503
    // outage), the private no-store header and the journey-cookie clearing in
    // the callback stay exactly as contracted.
    recovery: (c, props, status = 200) =>
      renderHtmlOutcome(
        c,
        recoveryOutcome(
          { ...props, supportReference: safeRequestId(c.get("requestId")) },
          honoRecoveryRenderer,
          { status },
        ),
      ),
  },
);

// RFC 9116 disclosure file. Database-free like robots.txt: no session, cookie or DB read.
// Stays in the Worker entry: it arrived after the SEO/CSP extraction slice
// (its own module owns the body builder) and is not part of `registerSeoLeaves`.
app.get("/.well-known/security.txt", (c) => {
  c.header("content-type", "text/plain; charset=utf-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(buildSecurityTxt(c.env.APP_URL));
});
app.post("/api/agent-events", requestBodyLimit("agent"), agentEventsAdmission, agentEventsRoute);

// `GET /up` — session-free DB/schema and secret-presence readiness plus the
// existing queue signal. A missing required secret, DB/ledger failure or
// pending web migrations answers 503; queue-only degraded
// or unknown remains 200. `no-store` so a monitor never reads a stale response.
// Test seam: QUEUE_DEPTH_STORE injects a Sql double; production bindings never
// set it (same pattern as SESSION_STORE/ROSTER_STORE above).
type EnvWithDepth = Env & { QUEUE_DEPTH_STORE?: ReturnType<typeof postgres> };

app.get("/up", async (c) => {
  // Fixed app identity for the cutover probe, including unknown/degraded reads.
  c.header("x-two-origin", "two-web-next");
  const injected = (c.env as EnvWithDepth).QUEUE_DEPTH_STORE;
  // Readiness and the queue slice both read the database the web stores and
  // the queue producers/consumer select: explicit DATABASE_URL wins, DB only
  // when absent, never as a retry after a failed connection.
  const url = databaseUrl(c.env);
  const owned = new Set<ReturnType<typeof postgres>>();
  const connect = (target: string | undefined, max: number) => {
    if (injected) return injected;
    if (!target) return null;
    try {
      const client = postgres(target, {
        max,
        idle_timeout: 10,
        connect_timeout: 3,
        fetch_types: false,
      });
      owned.add(client);
      return client;
    } catch (err) {
      console.warn("Health check could not build the database client.", {
        exception: err instanceof Error ? err.name : typeof err,
      });
      return null;
    }
  };
  try {
    c.header("cache-control", "no-store");
    // Two slots on the one client: the queue read cannot starve the DB read.
    const sql = connect(url, 2);
    // Member-access-log enforcement signal: informational only, never moves
    // the status code. Parsing mirrors enforceOn exactly — no raw value or
    // variable name is echoed into the body. Security note: this two-state
    // label is intentionally public on the unauthenticated /up body. The
    // control name is already public in the operator runbooks, and dashboards
    // poll /up without credentials, so an authenticated-only signal would not
    // reach its consumers. `log_only` is a legacy label with no serving
    // effect — the keyed read boundary always fails closed — so the field
    // aids operators without giving an unauthenticated caller a bypass. Consistent with the existing public config/db/queue
    // signals, which likewise describe operational posture, not secrets.
    const body = await upBody(
      sql ? () => withHealthReadTimeout(sql, pgQueueDepth) : null,
      sql,
      configReadiness(c.env),
      enforceOn(c.env) ? "enforcing" : "log_only",
    );
    // Informational only: the revision never moves the status code.
    return c.json({ ...body, ...revisionReadiness(c.env.CF_VERSION_METADATA) }, upHttpStatus(body));
  } finally {
    // Close request-owned clients without waiting to drain. Transaction-local
    // server limits bound active queries; disconnect alone is not cancellation.
    // An injected client owns its own lifecycle.
    for (const sql of owned) {
      const closed = sql.end({ timeout: 0 }).catch(() => {});
      try {
        c.executionCtx.waitUntil(closed);
      } catch {
        void closed;
      }
    }
  }
});

// Branded error pages (N2: TOG-9906) — DB-free, never echo internals.
registerErrorHandlers(app);

// Admin panel (W11 pt1): moderator-only HTML tables + forms. The guard
// redirects guests to Discord OAuth and 403s signed-in non-moderators.
app.route("/admin", adminApp());

// Member journeys (W7): /profile, /members/:user. Gate + member-access-log are
// scoped to those paths inside profilesApp; see src/profiles/routes.tsx.
app.route("/", profilesApp());

// W8: public events pages, /events.json and moderator event writes.
registerEventRoutes(
  app,
  async (c) => readSession(c),
  async (c) => readSession(c, false),
);

// Hot zones: public aggregate heatmaps.
registerHotzoneRoutes(app);

// A3: bounded session-free public read API + OpenAPI spec. No session
// readers: every representation is published-only and identical for all
// viewers, so the shared isolate-local cache needs no cookie partitioning.
registerPublicApiRoutes(app);

// B2: stateless public read-only MCP at POST /mcp. Same posture as A3 — no
// session readers, published-only tools, shared rate budget — behind the
// exact-path transport guard in ./mcp/routes (the global same-origin rule
// keeps one exact-path exemption for POST /mcp and is otherwise untouched).
registerMcpRoutes(app);

registerAlertProbe(app);

export default app;
