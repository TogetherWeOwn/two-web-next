// Local-only fixture: real routing, cookies, OAuth and shipped binders; memory data.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import production from "../../src/index";
import { authStatusScript } from "../../src/auth-status";
import { expiredWriteBanner } from "../../src/write-recovery";
import { sameOrigin } from "../../src/same-origin";
import { profilesApp } from "../../src/profiles/routes";
import { createMemoryProfileStore } from "../../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import type { Env } from "../../src/env";

export const MEMBER = "100000000000000001";
export const SECRET = "local-fixture-secret-at-least-32-bytes-long";
export function recoveryFixture(origin = "https://next.example.test") {
  const sessions = createMemorySessionStore();
  const profiles = createMemoryProfileStore([
    { id: MEMBER, username: "Fixture member", avatar: null, bio: "Accepted bio", games: ["Chess"], timezone: "Europe/London" },
    { id: "100000000000000002", username: "Other member", avatar: null, bio: null, games: [], timezone: null },
  ]);
  const state = { logDown: false, writes: 0 };
  const env: Env & { SESSION_STORE: typeof sessions } = {
    APP_URL: origin, SESSION_SECRET: SECRET, SESSION_STORE: sessions,
    DISCORD_CLIENT_ID: "fixture-client", DISCORD_CLIENT_SECRET: "fixture-secret",
    DISCORD_BOT_TOKEN: "fixture-bot", DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
  };
  const app = new Hono<{ Bindings: Env }>();
  for (const path of ["/profile", "/members/*"]) {
    app.use(path, sameOrigin);
    app.use(path, authStatusScript);
    app.use(path, expiredWriteBanner);
  }
  app.route("/", profilesApp({
    sessionStore: sessions,
    store: { find: profiles.find, save: async (id, attrs) => { state.writes++; await profiles.save(id, attrs); } },
    stats: async () => null,
    accessLog: async () => { if (state.logDown) throw new Error("fixture audit failure"); return true; },
    throttle: async () => ({ limited: false }),
  }));
  app.route("/", production);
  const request = (path: string, init?: RequestInit) => app.request(new URL(path, env.APP_URL), init, env);
  async function login(expiresAt = new Date(Date.now() + 3600_000)) {
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    await sessions.create({ tokenHash, userId: MEMBER, username: "Fixture member", avatar: null, member: true, moderator: false, expiresAt });
    return { tokenHash, cookie: (await serializeSigned("__Host-two_session", token, SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]! };
  }
  return { app, env, request, sessions, profiles, state, login };
}

/** Browser-cookie semantics: replace by name and honor deletion, never concatenate old signatures. */
export function mergeCookies(previous: string, response: Response): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair]));
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0]!;
    const name = pair.slice(0, pair.indexOf("="));
    if (/Max-Age=0/i.test(raw)) jar.delete(name); else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

/** All unmatched outbound calls fail closed. Never contacts Discord. */
export async function fixtureDiscord(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input).replace("https://discord.com/api/v10/", "https://discord.com/api/");
  if (url === "https://discord.com/api/oauth2/token") return Response.json({ access_token: "fixture-user-token" });
  if (url === "https://discord.com/api/users/@me") return Response.json({ id: MEMBER, username: "Fixture member", global_name: null, avatar: null });
  if (url.includes(`/guilds/326474832151838730/members/${MEMBER}`)) {
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
  }
  throw new Error("Unexpected outbound fixture request");
}
