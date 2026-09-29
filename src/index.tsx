import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { addGuildMember, authorizeUrl, exchangeCode, fetchUser } from "./discord";
import type { Env, Session } from "./env";
import { Home, type Notice } from "./pages";

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
  c.header("cache-control", "private, no-store");
  return c.html(<Home session={session} notice={notice} inviteUrl={c.env.DISCORD_INVITE_URL} />);
});

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
