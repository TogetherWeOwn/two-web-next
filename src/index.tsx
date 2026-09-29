import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import postgres from "postgres";
import { agentEventsRoute } from "./agent-events/route";
import { readCounts } from "./counts";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "./sessions";
import { addGuildMember, authorizeUrl, exchangeCode, fetchUser } from "./discord";
import { dbPing, hyperdriveQuery } from "./db/ping";
import { migrateRoster, upsertRosterUser } from "./db/roster";
import type { Env, Session } from "./env";
import { Join, Recovery, About, Faq, Home, Rules, type Notice } from "./pages";
import { registerErrorHandlers } from "./errors";
import { registerJoinRoutes } from "./join/route";
import { QA_HEADER, QA_IDENTITIES, qaEnabled, qaTokenMatches } from "./qa";
import { parseModeratorRoleIds, recomputeModerator } from "./roles";
import { buildRobots, buildSitemapUrls, renderSitemap } from "./seo";

const SESSION_COOKIE = "__Host-two_session";
const STATE_COOKIE = "__Host-two_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const STATE_TTL_SECONDS = 600;

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "https://cdn.discordapp.com"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  }),
);

// The last resort, hardcoded on purpose (ports two-web DiscordInviteController::FALLBACK_INVITE).
// The WEB-HOMEPAGE campaign code: never expires, unlimited uses, so the join button has an invite
// that cannot rot and web arrivals attribute to the website. An invite code is not a secret: it is
// a public join link that grants nothing but membership of a server anyone can ask to join.
export const FALLBACK_INVITE = "https://discord.gg/4GwEDNRTtx";

const DISCORD_HOSTS = new Set(["discord.gg", "discord.com"]);

function landsInDiscord(url: string): boolean {
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    return false;
  }
  return parts.protocol === "https:" && DISCORD_HOSTS.has(parts.hostname.toLowerCase());
}

// The configured invite if usable, the hardcoded one otherwise. Never throws: a member clicking
// the join link is the single most valuable request this site serves, and an error page is worse
// than an invite one rotation out of date.
function inviteDestination(configured: string): string {
  if (landsInDiscord(configured)) return configured;
  console.error("services.discord.invite_url is unusable; serving the hardcoded fallback invite.");
  return FALLBACK_INVITE;
}

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
  const url = c.env.DATABASE_URL;
  // No DB binding: sessions cannot persist (a fresh memory store per request
  // fails closed to guest). This is the transitional state until the
  // Hyperdrive binding lands (W1/S1); staging sets DATABASE_URL meanwhile.
  if (!url) return createMemorySessionStore();
  // Short-lived per-request client, one pooled connection max. Never ended
  // while the store holds it (ending here would hand the store a dead client);
  // idle sockets close themselves via idle_timeout. The W1 Hyperdrive spike
  // owns production pooling; Hyperdrive will use this same Sql surface.
  const sql = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 }) as unknown as Sql;
  if (!migratedUrls.has(url)) {
    await migrate(sql);
    migratedUrls.add(url);
  }
  return createPostgresSessionStore(sql);
}

// Roster persistence for the N6 user-roster write. Same posture as storeFor:
// tests inject a Sql double through ROSTER_STORE; staging/production use
// DATABASE_URL with a short-lived per-request client and the runtime DDL; an
// absent DATABASE_URL means the roster write quietly degrades to null (a
// no-op upsert) so sign-in stays up instead of 500ing.
const migratedRosterUrls = new Set<string>();

async function rosterSqlFor(c: Context<{ Bindings: Env }>): Promise<Sql | null> {
  const injected = (c.env as EnvWithRoster).ROSTER_STORE;
  if (injected) return injected;
  const url = c.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 }) as unknown as Sql;
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
    console.warn("roster upsert failed", { user: row.userId, error: String(err) });
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

async function readSession(c: Context<{ Bindings: Env }>, store: SessionStore): Promise<Session | null> {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!token || !token.startsWith("two_")) return null;
  const row = await store.get(await hashToken(token));
  if (!row) return null;
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

const NOTICES = new Set(["joined", "already_member", "join_failed", "signin_failed"]);

app.get("/", async (c) => {
  const store = await storeFor(c);
  const session = await readSession(c, store);
  const n = c.req.query("n");
  const notice = (n && NOTICES.has(n) ? n : null) as Notice;
  // The counts read degrades to the empty state when the bot DB is down — never a 500 on the
  // funnel top (ports two-web CountsReader::remember's never-throw contract).
  const counts = await readCounts(c.env).catch(() => ({ memberCount: null, onlineCount: null }));
  c.header("cache-control", "private, no-store");
  return c.html(
    <Home session={session} notice={notice} inviteUrl={c.env.DISCORD_INVITE_URL} appUrl={c.env.APP_URL} counts={counts} />,
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
    return c.html(path === "/about" ? <About /> : <Faq />);
  });
}

// Static house rules (ports two-web `Route::view('/rules')`, TOG-5147): no database — renders
// even when the bot's database is down. The last-updated stamp comes from config, and an empty
// or unparseable value hides the stamp instead of 500ing (TOG-7323).
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function rulesLastUpdated(raw: string | undefined): { iso: string; label: string } | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const invalid = () => {
    console.warn("Invalid community.rules_last_updated — hiding /rules stamp");
    return null;
  };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = m?.[1];
  const mon = m?.[2];
  const dayStr = m?.[3];
  if (!year || !mon || !dayStr) return invalid();
  const month = MONTHS[Number(mon) - 1];
  const day = Number(dayStr);
  if (month === undefined || day < 1 || day > 31) return invalid();
  return { iso: `${year}-${mon}-${dayStr}`, label: `${day} ${month} ${year}` };
}

app.get("/rules", (c) => {
  const stamp = rulesLastUpdated(c.env.RULES_LAST_UPDATED);
  c.header("cache-control", "public, max-age=3600");
  return c.html(<Rules lastUpdated={stamp?.iso ?? null} />);
});

// The one-click join journey (W6: TOG-9685). /join is the database-free page;
// /join/discord + /join/callback run the throttled OAuth round trip with the
// synchronous bot add. JoinAttempt rows land in Postgres when DATABASE_URL is
// set; without it the journey degrades to no persistence (never a 500).
registerJoinRoutes(app, { storeFor, issueSession }, {
  joinPage: (c, props) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(<Join inviteUrl={props.inviteUrl} widgetUrl={props.widgetUrl} />);
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
app.get("/sitemap_index.xml", (c) => {
  c.header("content-type", "application/xml; charset=UTF-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(renderSitemap(buildSitemapUrls(c.env.APP_URL, [])));
});

// robots.txt is dynamic, not a static file in public/ (TOG-7071): the Sitemap line names this
// environment's APP_URL host, so each environment advertises itself.
app.get("/robots.txt", (c) => {
  c.header("content-type", "text/plain; charset=UTF-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(buildRobots(c.env.APP_URL));
});

app.post("/api/agent-events", agentEventsRoute);

app.get("/health", (c) => c.json({ ok: true }));
app.get("/healthz", (c) => c.json({ ok: true }));

// Branded error pages (N2: TOG-9906) — DB-free, never echo internals.
registerErrorHandlers(app);

// Shared-Postgres acceptance ping (S1: TOG-9679): proves the Neon staging
// branch serves this Worker through Hyperdrive. 503s without the binding or
// on any DB error, with no internals in the body.
app.get("/db-ping", async (c) => {
  if (!c.env.DB) return c.json({ ok: false, error: "db_unavailable" }, 503);
  try {
    return c.json(await dbPing(hyperdriveQuery(c.env.DB.connectionString)));
  } catch (err) {
    console.warn("db-ping failed", { error: String(err) });
    return c.json({ ok: false, error: "db_unavailable" }, 503);
  }
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
  const expected = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || !expected || state !== expected) return c.redirect("/?n=signin_failed", 302);

  let accessToken: string;
  let user;
  try {
    accessToken = await exchangeCode(code, c.env.DISCORD_CLIENT_ID, c.env.DISCORD_CLIENT_SECRET, redirectUri(c.env));
    user = await fetchUser(accessToken);
  } catch (err) {
    console.warn("discord sign-in failed", { error: String(err) });
    return c.redirect("/?n=signin_failed", 302);
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

app.post("/logout", async (c) => {
  // SameSite=Lax cookies are not sent on cross-site POSTs, so a forged logout form cannot end a session;
  // the origin check below refuses one anyway.
  const origin = c.req.header("origin");
  if (origin && origin !== c.env.APP_URL) return c.text("Forbidden", 403);
  const store = await storeFor(c);
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (token) await store.revoke(await hashToken(token)).catch(() => {});
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/", 303);
});

// Staging-only QA seam. 404 everywhere that is not the staging host with
// QA_AUTH_TOKEN set. Unknown identity and bad token are byte-identical 404s.
app.post("/auth/qa/:identity", async (c) => {
  if (!qaEnabled(c.env.APP_URL, c.env.QA_AUTH_TOKEN)) return c.notFound();
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

export default app;
