import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import postgres from "postgres";
import { adminApp } from "./admin/routes";
import { agentEventsAdmission, agentEventsRoute } from "./agent-events/route";
import { registerAlertProbe } from "./alert-probe";
import { requestBodyLimit } from "./body-limit";
import { readCounts } from "./counts";
import { cspReportsRoute } from "./csp-reports";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "./sessions";
import { addGuildMember, authorizeUrl, exchangeCode, failureMeta, fetchUser, isProviderOutage } from "./discord";
import { databaseOptions, databaseUrl } from "./db/connection";
import { migrateRoster, upsertRosterUser } from "./db/roster";
import { pgQueueDepth } from "./jobs/postgres";
import type { Env, Session } from "./env";
import { inviteDestination } from "./invite";
import { imageHosts } from "./image-policy";
import { Join, Recovery, About, Faq, Home, Privacy, Rules, type Notice } from "./pages";
import { POLICY_VERSION, renderPolicyMarkdown } from "./privacy";
import { POLICY_MARKDOWN } from "./privacy-content";
import { registerErrorHandlers } from "./errors";
import { registerEventRoutes } from "./events/routes";
import { loadHomeUpcoming, sitemapEvents } from "./events/reads";
import { dbFor } from "./admin/db";
import { listVisibleFeatured } from "./featured";
import { robotsTag, SECURITY_HEADERS } from "./headers";
import { registerJoinRoutes } from "./join/route";
import { safeNext } from "./join/service";
import { profilesApp } from "./profiles/routes";
import { AUTH_THROTTLE_PER_MINUTE, WRITE_THROTTLE_PER_MINUTE, throttle, throttleGuard } from "./throttle";
import { QA_HEADER, QA_IDENTITIES, qaEnabled, qaTokenMatches } from "./qa";
import { parseModeratorRoleIds, recomputeModerator } from "./roles";
import { buildRobots, buildSitemapUrls, crawlableEvents, renderSitemap } from "./seo";
import { upBody } from "./up";
import { sameOrigin } from "./same-origin";
import { trustHosts } from "./trust-hosts";
import { rulesLastUpdated } from "./rules-last-updated";

export { rulesLastUpdated } from "./rules-last-updated";

const SESSION_COOKIE = "__Host-two_session";
const STATE_COOKIE = "__Host-two_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const STATE_TTL_SECONDS = 600;

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
    imgSrc: ["'self'", (c) => imageHosts((c.env as Env).FEATURED_IMAGE_HOSTS).map((host) => `https://${host}`).join(" ")],
    // Only the join page embeds Discord; OAuth/recovery/admin routes cannot frame anything.
    frameSrc: [(c) => c.req.path === "/join" && ["GET", "HEAD"].includes(c.req.method) ? "https://discord.com" : "'none'"],
    styleSrc: ["'self'"],
    scriptSrc: ["'self'"],
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

app.use("*", async (c, next) => {
  await staticSecurityHeaders(c, next);
  await robotsTag(c, async () => {});
});

// TrustHosts re-expression (W16: TOG-10110): refuse foreign Host values
// before routing. Mounted after secureHeaders (refusals leave hardened) and
// before every route; absolute URLs never derive from Host (all from APP_URL).
app.use("*", trustHosts());

// Before throttles, session rotation, body parsing, or any mounted handler.
app.use("*", sameOrigin);

// The Discord invite floor lives in ./invite so the join journey's recovery
// page can share it (same file the /discord redirect uses).
export { FALLBACK_INVITE, inviteDestination } from "./invite";

const redirectUri = (env: Env) => `${env.APP_URL}/auth/discord/callback`;

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
const migratedUrls = new Set<string>();

async function storeFor(c: Context<{ Bindings: Env }>): Promise<SessionStore> {
  const injected = (c.env as EnvWithStore).SESSION_STORE;
  if (injected) return injected;
  const url = databaseUrl(c.env);
  // No DB configuration: a fresh memory store per request fails closed to guest.
  if (!url) return createMemorySessionStore();
  // Short-lived per-request client; Hyperdrive pools underneath in the Worker.
  // Keep it alive while the store uses it; idle_timeout closes idle sockets.
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  if (!migratedUrls.has(url)) {
    await migrate(sql);
    migratedUrls.add(url);
  }
  return createPostgresSessionStore(sql);
}

// Roster persistence shares storeFor's DB selection so signed-in profiles
// read the same users sign-in writes. Tests may inject ROSTER_STORE; no DB
// configuration means a no-op upsert so DB-free sign-in tests still work.
const migratedRosterUrls = new Set<string>();

async function rosterSqlFor(c: Context<{ Bindings: Env }>): Promise<Sql | null> {
  const injected = (c.env as EnvWithRoster).ROSTER_STORE;
  if (injected) return injected;
  const url = databaseUrl(c.env);
  if (!url) return null;
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  if (!migratedRosterUrls.has(url)) {
    await migrateRoster(sql);
    migratedRosterUrls.add(url);
  }
  return sql;
}

async function issueSession(
  c: Context<{ Bindings: Env }>,
  store: SessionStore,
  row: { userId: string; username: string; avatar: string | null; member: boolean; moderator: boolean },
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
    console.warn("roster upsert failed", { user: row.userId, exception: (err as Error)?.constructor?.name ?? "unknown" });
  }
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: row.avatar,
    member: row.member,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  await setSignedCookie(c, SESSION_COOKIE, token, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
}

async function readSession(c: Context<{ Bindings: Env }>, rotateToken = true): Promise<Session | null> {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!token || !token.startsWith("two_")) return null;
  // Anonymous public pages must not depend on session storage or its startup DDL.
  const store = await storeFor(c);
  const row = await store.get(await hashToken(token));
  if (!row) return null;
  // Abortable calendar fragments validate expiry/revocation but must not delete
  // the browser's current token: an aborted response cannot deliver a replacement.
  if (!rotateToken) {
    return { id: row.userId, username: row.username, avatar: row.avatar, member: row.member, moderator: row.moderator };
  }
  // Rotation: every authenticated page view mints a fresh token and deletes
  // the old row in the same statement. A replayed cookie finds no row: guest.
  const replacement = newSessionToken();
  const rotated = await store
    .rotate(await hashToken(token), {
      tokenHash: await hashToken(replacement),
      ...row,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    })
    .catch(() => false);
  if (!rotated) return null;
  await setSignedCookie(c, SESSION_COOKIE, replacement, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { id: row.userId, username: row.username, avatar: row.avatar, member: row.member, moderator: row.moderator };
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
  const session = await readSession(c).catch(() => {
    // Driver messages can contain DSNs or session identifiers; only a fixed diagnostic is safe.
    console.warn("Home session unavailable; serving as guest.", { exception: "SessionReadFailure" });
    return null;
  });
  const n = c.req.query("n");
  const notice = (n && NOTICES.has(n) ? n : null) as Notice;
  // The counts read degrades to the empty state when the bot DB is down — never a 500 on the
  // funnel top (ports two-web CountsReader::remember's never-throw contract).
  const counts = await readCounts(c.env);
  const [upcomingEvents, featured] = await Promise.all([
    loadHomeUpcoming(() => dbFor(c)),
    dbFor(c).then((db) => db ? listVisibleFeatured(db) : []).catch(() => []),
  ]);
  c.header("cache-control", "private, no-store");
  return c.html(
    <Home session={session} notice={notice} inviteUrl={c.env.DISCORD_INVITE_URL} appUrl={c.env.APP_URL}
      counts={counts} upcomingEvents={upcomingEvents ?? []} eventsUnavailable={upcomingEvents === null} featured={featured}
      imageHosts={c.env.FEATURED_IMAGE_HOSTS} />,
  );
});

// `/discord` — the front door, and the only web-to-Discord conversion path (ports two-web
// routes/funnel.php + DiscordInviteController). Database-free floor by design: this handler reads
// no session, no cookie, no cache, no database — it must stay 200→302 when everything behind it
// is down. 302, not 301: the door gets retargeted, and a 301 is cached by browsers effectively
// forever. `no-store` for the same reason at the edge.
app.get("/discord", (c) => {
  c.header("cache-control", "no-store, private");
  return c.redirect(inviteDestination(c.env.DISCORD_INVITE_URL), 302);
});

// Static funnel leaves (ports two-web routes/funnel.php's `/about` + `/faq`): dependency-free,
// no controller, no session, no database — they stay 200 during an app-DB outage. No cookies are
// read or set here on purpose, for the same reason.
for (const path of ["/about", "/faq"] as const) {
  app.get(path, (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(path === "/about" ? <About appUrl={c.env.APP_URL} /> : <Faq appUrl={c.env.APP_URL} />);
  });
}

// Static house rules (ports two-web `Route::view('/rules')`, TOG-5147): no database — renders
// even when the bot's database is down. The last-updated stamp comes from config, and an empty
// or unparseable value hides the stamp instead of 500ing (TOG-7323).
app.get("/rules", (c) => {
  const stamp = rulesLastUpdated(c.env.RULES_LAST_UPDATED);
  c.header("cache-control", "public, max-age=3600");
  return c.html(<Rules appUrl={c.env.APP_URL} lastUpdated={stamp} />);
});

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
registerJoinRoutes(app, { storeFor, issueSession }, {
  joinPage: (c, props) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(<Join inviteUrl={props.inviteUrl} widgetUrl={props.widgetUrl} next={props.next} appUrl={c.env.APP_URL} />);
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
});

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

// CSP violation sink (TOG-10107 — ports two-web routes/funnel.php's
// `POST /csp-reports`). Funnel posture by placement: registered before any
// session-touching handler and the handler itself reads no session, no
// cookie, no cache, no database — it answers 204 during an app-DB outage.
// Deliberately no throttle: throttle reads the database-backed store, like
// `/discord`. Flood control lives in the handler instead.
app.post("/csp-reports", cspReportsRoute);

app.post("/api/agent-events", agentEventsAdmission, requestBodyLimit("agent"), agentEventsRoute);

// `GET /up` — the deploy/uptime signal with queue depth folded in (N3: TOG-9895;
// ports two-web HealthCheckController + QueueHealth on routes/funnel.php's empty
// stack). No session, cookie or auth on this path, and the queue read can never
// sink the endpoint: a backlog answers 200 `degraded`, an unreachable or
// unconfigured ledger 200 `unknown` — `curl -f` must keep passing through the
// outage it reports on. `no-store` so a monitor never reads a stale 200.
// Test seam: QUEUE_DEPTH_STORE injects a Sql double; production bindings never
// set it (same pattern as SESSION_STORE/ROSTER_STORE above).
type EnvWithDepth = Env & { QUEUE_DEPTH_STORE?: ReturnType<typeof postgres> };

app.get("/up", async (c) => {
  // Fixed app identity for the cutover probe, including unknown/degraded reads.
  c.header("x-two-origin", "two-web-next");
  const injected = (c.env as EnvWithDepth).QUEUE_DEPTH_STORE;
  // The queue ledger lives in the same Postgres as the rest of the W13 backend:
  // the Hyperdrive `DB` binding when present, else DATABASE_URL (local/dev).
  const url = c.env.DB?.connectionString ?? c.env.DATABASE_URL;
  let sql: EnvWithDepth["QUEUE_DEPTH_STORE"] | null = injected ?? null;
  try {
    c.header("cache-control", "no-store");
    // Client construction can throw (malformed URL); that is `unknown`, never a 500.
    if (!sql && url) {
      try {
        sql = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
      } catch (err) {
        console.warn("Health check could not build the queue client.", { exception: err instanceof Error ? err.name : typeof err });
      }
    }
    const client = sql;
    return c.json(await upBody(client ? () => pgQueueDepth(client) : null));
  } finally {
    // Per-request client; an injected double owns its own lifecycle.
    if (sql && !injected) await sql.end({ timeout: 1 }).catch(() => {});
  }
});

// Branded error pages (N2: TOG-9906) — DB-free, never echo internals.
registerErrorHandlers(app);

// Legacy login links: retain only the existing guarded-next value, never OAuth input.
app.get("/auth/discord/redirect", (c) => {
  const next = safeNext(c.req.query("next"));
  c.header("cache-control", "no-store");
  return c.redirect(next ? `/auth/discord?${new URLSearchParams({ next })}` : "/auth/discord", 302);
});

app.get("/auth/discord", async (c) => {
  const state = crypto.randomUUID();
  await setSignedCookie(c, STATE_COOKIE, state, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: STATE_TTL_SECONDS,
  });
  return c.redirect(authorizeUrl(c.env.DISCORD_CLIENT_ID, redirectUri(c.env), state), 302);
});

app.get("/auth/discord/callback", async (c) => {
  const limited = await throttleGuard(c, "login-callback", AUTH_THROTTLE_PER_MINUTE);
  if (limited) return limited;
  const expected = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  const code = c.req.query("code");
  const state = c.req.query("state");
  // A consent-screen refusal arrives as an `error` param before any code
  // exists. Denied gets its own sentence (the member chose this); any other
  // OAuth error keeps the generic one. Legacy DiscordLoginTest: the
  // error_description is never echoed — we render only our own copy.
  const oauthError = c.req.query("error");
  if (oauthError) {
    return c.redirect(oauthError === "access_denied" ? "/?n=signin_denied" : "/?n=signin_failed", 302);
  }

  if (!code || !state || !expected || state !== expected) return c.redirect("/?n=signin_failed", 302);

  let accessToken: string;
  let user;
  try {
    accessToken = await exchangeCode(code, c.env.DISCORD_CLIENT_ID, c.env.DISCORD_CLIENT_SECRET, redirectUri(c.env));
    user = await fetchUser(accessToken);
  } catch (err) {
    // Bounded like the join route: exception class + kind + status, never the
    // message (the token-exchange error body can quote the client secret).
    const meta = failureMeta(err);
    console.warn("discord sign-in failed", { exception: meta.exception, kind: meta.kind, status: meta.status });
    return c.redirect(isProviderOutage(meta.kind) ? "/?n=signin_unavailable" : "/?n=signin_failed", 302);
  }

  // Auto-join: a guild join failure never blocks sign-in. The access token is used once here and
  // never stored.
  const join = await addGuildMember(c.env.DISCORD_GUILD_ID, user.id, accessToken, c.env.DISCORD_BOT_TOKEN).catch(
    () => "failed" as const,
  );
  if (join === "failed") console.warn("guild auto-join failed", { user: user.id });

  // Moderator recompute: roles re-read with the bot token against snowflake IDs
  // (never names). A failed lookup fails closed on the flag, never on sign-in.
  const moderator = await recomputeModerator({
    guildId: c.env.DISCORD_GUILD_ID,
    userId: user.id,
    botToken: c.env.DISCORD_BOT_TOKEN,
    moderatorRoleIds: parseModeratorRoleIds(c.env.DISCORD_MODERATOR_ROLE_IDS),
  });

  const store = await storeFor(c);
  await issueSession(c, store, {
    userId: user.id,
    username: user.global_name ?? user.username,
    avatar: user.avatar,
    member: join !== "failed",
    moderator,
  });
  return c.redirect(`/?n=${join === "failed" ? "join_failed" : join}`, 302);
});

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

app.post("/logout", throttle("logout", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("action"), async (c) => {
  const store = await storeFor(c);
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (token) await store.revoke(await hashToken(token)).catch(() => {});
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/", 303);
});

// Staging-only QA seam. 404 everywhere that is not the staging host with
// QA_AUTH_TOKEN set. Unknown identity and bad token are byte-identical 404s.
app.post("/auth/qa/:identity", async (c, next) => {
  if (!qaEnabled(c.env.APP_URL, c.env.QA_AUTH_TOKEN)) return c.notFound();
  await next();
}, throttle("qa-login", AUTH_THROTTLE_PER_MINUTE), requestBodyLimit("action"), async (c) => {
  const presented = c.req.header(QA_HEADER) ?? "";
  const ok = await qaTokenMatches(c.env.QA_AUTH_TOKEN, presented);
  const fixture = QA_IDENTITIES[c.req.param("identity") ?? ""];
  if (!ok || !fixture) return c.notFound();
  const store = await storeFor(c);
  await issueSession(c, store, {
    userId: fixture.discordId,
    username: fixture.username,
    avatar: null,
    member: true,
    moderator: fixture.moderator,
  });
  return c.body(null, 204);
});

registerAlertProbe(app);

export default app;
