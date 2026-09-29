import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { readCounts } from "./counts";
import { addGuildMember, authorizeUrl, exchangeCode, fetchUser } from "./discord";
import type { Env, Session } from "./env";
import { About, Faq, Home, Rules, type Notice } from "./pages";
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

async function readSession(c: Context<{ Bindings: Env }>): Promise<Session | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

const NOTICES = new Set(["joined", "already_member", "join_failed", "signin_failed"]);

app.get("/", async (c) => {
  const session = await readSession(c);
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

// Sitemap (ports two-web routes/web.php's sitemap closure; crawl set per TOG-7072): published
// events only. No DB binding yet, so the static entries ship now; the W8 events slice adds the
// published /e/{key} rows (drafts 403 / cancelled 410 stay out of the index).
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

app.get("/health", (c) => c.json({ ok: true }));
app.get("/healthz", (c) => c.json({ ok: true }));

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

  const session: Session = {
    id: user.id,
    username: user.global_name ?? user.username,
    avatar: user.avatar,
    member: join !== "failed",
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify(session), c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return c.redirect(`/?n=${join === "failed" ? "join_failed" : join}`, 302);
});

app.post("/logout", (c) => {
  // SameSite=Lax cookies are not sent on cross-site POSTs, so a forged logout form cannot end a session;
  // the origin check below refuses one anyway.
  const origin = c.req.header("origin");
  if (origin && origin !== c.env.APP_URL) return c.text("Forbidden", 403);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/", 303);
});

export default app;
