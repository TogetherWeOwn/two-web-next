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
import { cspReportsRoute } from "./csp-reports";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
  type Sql,
} from "./sessions";
import { databaseOptions, databaseUrl } from "./db/connection";
import { isDatabaseUnavailable } from "./db/errors";
import { upsertRosterUser } from "./db/roster";
import { pgQueueDepth } from "./jobs/postgres";
import type { Env, Session } from "./env";
import { imageHosts } from "./image-policy";
import { Join, Recovery, Home, Privacy, type Notice } from "./pages";
import { POLICY_VERSION, renderPolicyMarkdown } from "./privacy";
import { POLICY_MARKDOWN } from "./privacy-content";
import { internalErrorHandler, registerErrorHandlers } from "./errors";
import { registerEventRoutes } from "./events/routes";
import { loadHomeUpcoming, sitemapEvents } from "./events/reads";
import { dbFor } from "./admin/db";
import { listVisibleFeatured } from "./featured";
import { robotsTag, SECURITY_HEADERS } from "./headers";
import { registerJoinRoutes } from "./join/route";
import { registerStaticLeaves } from "./static-leaves";
import { safeNext } from "./join/service";
import { profilesApp } from "./profiles/routes";
import { takeJoinResult } from "./return-journey";
import { buildRobots, buildSitemapUrls, crawlableEvents, renderSitemap } from "./seo";
import { buildSecurityTxt } from "./security-txt";
import {
  configReadiness,
  revisionReadiness,
  upBody,
  upHttpStatus,
  withHealthReadTimeout,
} from "./up";
import { requestLog } from "./request-log";
import { sameOrigin } from "./same-origin";
import { trustHosts } from "./trust-hosts";
import { authStatusScript, enableAuthStatus } from "./auth-status";
import { expiredWriteBanner } from "./write-recovery";
import { freezeBanner } from "./freeze-banner";

export { rulesLastUpdated } from "./rules-last-updated";

// The session cookie name is defined once in ./auth/routes (it owns logout).
// The OAuth state lifetime stays defined here: the privacy-numbers pin only
// allows STATE_TTL_SECONDS to originate from this module (or join/route).
export const STATE_TTL_SECONDS = 600;

const app = new Hono<{ Bindings: Env }>();

// The violation sink (TOG-10107): report-uri is the legacy fallback;
// the CSP report-to directive selects the modern Reporting-Endpoints group.
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
// plus the staging X-Robots-Tag. Mounted sub-apps inherit both from this
// outer dispatch, including refusals from the same-origin guard.
const staticSecurityHeaders = secureHeaders({
  // Edge-owned (TOG-8729): emitting HSTS from the app would pin local dev
  // machines to HTTPS, so the Hono default is explicitly off.
  strictTransportSecurity: false,
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
    styleSrc: ["'self'"],
    scriptSrc: ["'self'"],
    fontSrc: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    reportUri: CSP_REPORT_ENDPOINT,
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
  const injected = (c.env as EnvWithStore).SESSION_STORE;
  if (injected) return injected;
  const url = databaseUrl(c.env);
  // No DB configuration: a fresh memory store per request fails closed to guest.
  if (!url) return createMemorySessionStore();
  // Short-lived per-request client; Hyperdrive pools underneath in the Worker.
  // Keep it alive while the store uses it; idle_timeout closes idle sockets.
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  return createPostgresSessionStore(sql);
}

// Roster persistence shares storeFor's DB selection so signed-in profiles
// read the same users sign-in writes. Tests may inject ROSTER_STORE; no DB
// configuration means a no-op upsert so DB-free sign-in tests still work.
// No DDL here either (TOG-19721): the users table is drizzle/0000, owned by
// the migrate workflow.
async function rosterSqlFor(c: Context<{ Bindings: Env }>): Promise<Sql | null> {
  const injected = (c.env as EnvWithRoster).ROSTER_STORE;
  if (injected) return injected;
  const url = databaseUrl(c.env);
  if (!url) return null;
  return postgres(url, databaseOptions) as unknown as Sql;
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
    await upsertRosterUser(await rosterSqlFor(c), {
      id: row.userId,
      username: row.username,
      avatar: row.avatar,
      member: row.member,
    });
  } catch (err) {
    // Driver messages can carry DSN fragments; the class name is the whole story here.
    console.warn("roster upsert failed", {
      user: row.userId,
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
  // Fresh authentication revokes the presented pre-login/pre-join token
  // atomically with the insert (a failed insert leaves the prior session
  // intact; see store.replace). The token is revoked by hash because it can
  // belong to a different user (shared terminal).
  if (typeof prior === "string" && prior.startsWith("two_")) {
    await store.replace(await hashToken(prior), replacement);
  } else {
    await store.create(replacement);
  }
  // Session fixation (TOG-12284): additionally revoke every other live
  // session for this user so only the newest survives. The fresh row already
  // exists: a sweep failure warns and sign-in still succeeds (fail-open on the
  // sweep, never a logout-on-login). Token-hash-only.
  try {
    await store.revokeUserSessions(row.userId, tokenHash);
  } catch (err) {
    console.warn("prior session sweep failed", {
      user: row.userId,
      exception: (err as Error)?.constructor?.name ?? "unknown",
    });
  }
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
  if (!token || !token.startsWith("two_")) return null;
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
  // the old row in the same statement. A replayed cookie finds no row: guest.
  const statusKey = await store.statusHash(await hashToken(token));
  const replacement = newSessionToken();
  const rotated = await store
    .rotate(await hashToken(token), {
      tokenHash: await hashToken(replacement),
      ...row,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    })
    .catch((err) => {
      if (isDatabaseUnavailable(err)) throw err;
      return false;
    });
  if (!rotated) return null;
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
  // A DB outage must not break the funnel, including session setup. Fail closed to guest.
  let sessionUnavailable = false;
  const session = await readSession(c).catch((err) => {
    // Keep the opaque session-failure fallback, not named non-outage exceptions.
    if (err instanceof Error && err.name !== "Error" && !isDatabaseUnavailable(err)) throw err;
    // Driver messages can contain DSNs or session identifiers; only a fixed diagnostic is safe.
    console.warn("Home session unavailable; serving as guest.", {
      exception: "SessionReadFailure",
    });
    sessionUnavailable = true;
    return null;
  });
  const n = c.req.query("n");
  const notice = (n && NOTICES.has(n) ? n : null) as Notice;
  // The counts read degrades to the empty state when the bot DB is down — never a 500 on the
  // funnel top (ports two-web CountsReader::remember's never-throw contract).
  const counts = await readCounts(c.env);
  // One-shot join confirmation (legacy join_result flash): first render consumes it.
  // A failure landing drops a stale success flash instead — the current failure
  // explanation wins over an older journey's success (TOG-10356 review).
  const flashed = await takeJoinResult(c);
  const joinResult = [
    "join_failed",
    "signin_failed",
    "signin_denied",
    "signin_unavailable",
  ].includes(notice ?? "")
    ? null
    : flashed;
  const [upcomingEvents, featured] = await Promise.all([
    loadHomeUpcoming(() => dbFor(c)),
    dbFor(c)
      .then((db) => (db ? listVisibleFeatured(db) : []))
      .catch(() => []),
  ]);
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
      upcomingEvents={upcomingEvents ?? []}
      eventsUnavailable={upcomingEvents === null}
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

// Versioned privacy policy (N1: TOG-9893 — ports two-web routes/funnel.php's
// `/privacy` + PrivacyController). Funnel-style: no session, no cookie, no
// cache, no database — stays 200 during an app-DB outage. The markdown is
// bundled at build (src/privacy-content.ts, generated from
// content/privacy-policy-vN.md) and pre-rendered once at module load, so the
// request path performs zero reads of any kind. CSP comes from the global
// secureHeaders middleware above.
const PRIVACY_HTML = renderPolicyMarkdown(POLICY_MARKDOWN);

app.get("/privacy", (c) => {
  c.header("cache-control", "public, max-age=3600");
  return c.html(<Privacy appUrl={c.env.APP_URL} version={POLICY_VERSION} html={PRIVACY_HTML} />);
});

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
      // cookie even when this view has nothing to consume.
      const joinResult = await takeJoinResult(c);
      c.header("cache-control", joinResult ? "private, no-store" : "public, max-age=3600");
      c.header("vary", "Cookie");
      return c.html(
        <Join
          inviteUrl={props.inviteUrl}
          widgetUrl={props.widgetUrl}
          next={props.next}
          appUrl={c.env.APP_URL}
          joinResult={joinResult}
        />,
      );
    },
    recovery: (c, props, status = 200) => {
      c.header("cache-control", "no-store, private");
      c.status(status);
      return c.html(
        <Recovery
          title={props.title}
          message={props.message}
          retryUrl={props.retryUrl}
          retryLabel={props.retryLabel}
          inviteUrl={props.inviteUrl}
        />,
      );
    },
  },
);

// Sitemap (ports two-web routes/web.php's sitemap closure; crawl set per TOG-7072): published
// events only. No DB binding yet, so the static entries ship now; the W8 events slice adds the
// published /e/{key} rows (drafts 403 / cancelled 410 stay out of the index).
// W6 adds /join (changefreq monthly, priority 0.9 — same as legacy).
app.get("/sitemap_index.xml", async (c) => {
  c.header("content-type", "application/xml; charset=UTF-8");
  c.header("cache-control", "public, max-age=3600");
  // Published events only; a DB outage degrades to the static entries, never a 500.
  const db = await dbFor(c).catch(() => null);
  const rows = db ? await sitemapEvents(db).catch(() => []) : [];
  return c.body(renderSitemap(buildSitemapUrls(c.env.APP_URL, crawlableEvents(rows))));
});

// robots.txt is dynamic, not a static file in public/ (TOG-7071): the Sitemap line names this
// environment's APP_URL host, so each environment advertises itself.
app.get("/robots.txt", (c) => {
  c.header("content-type", "text/plain; charset=UTF-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(buildRobots(c.env.APP_URL));
});

// RFC 9116 disclosure file. Database-free like robots.txt: no session, cookie or DB read.
app.get("/.well-known/security.txt", (c) => {
  c.header("content-type", "text/plain; charset=utf-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(buildSecurityTxt(c.env.APP_URL));
});

// CSP violation sink (TOG-10107 — ports two-web routes/funnel.php's
// `POST /csp-reports`). Funnel posture by placement: registered before any
// session-touching handler and the handler itself reads no session, no
// cookie, no cache, no database — it answers 204 during an app-DB outage.
// Deliberately no throttle: throttle reads the database-backed store, like
// `/discord`. Flood control lives in the handler instead.
app.post("/csp-reports", cspReportsRoute);

app.post("/api/agent-events", agentEventsAdmission, requestBodyLimit("agent"), agentEventsRoute);

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
    const body = await upBody(
      sql ? () => withHealthReadTimeout(sql, pgQueueDepth) : null,
      sql,
      configReadiness(c.env),
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

registerAlertProbe(app);

export default app;
