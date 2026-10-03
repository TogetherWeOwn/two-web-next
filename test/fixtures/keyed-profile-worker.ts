// Real profilesApp rendering/session gate in workerd, with memory stores only.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import type { AccessEntry } from "../../src/access-log";
import { profilesApp } from "../../src/profiles/routes";
import { createMemoryProfileStore } from "../../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

const subject = "100000000000000101";
const viewer = "100000000000000102";
const secret = "keyed-profile-worker-fixture-secret-32-bytes";
const app = new Hono();
app.get("/fixture/:mode", async (c) => {
  const mode = c.req.param("mode");
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    {
      id: subject,
      username: "workerd-profile-sensitive",
      avatar: null,
      bio: "workerd-bio-sensitive",
      games: ["Chess"],
      timezone: "UTC",
    },
  ]);
  if (mode === "invalid")
    store.rows.set(subject, { ...store.rows.get(subject)!, id: "invalid-owner" });
  const entries: AccessEntry[] = [];
  const router = profilesApp({
    sessionStore: sessions,
    store,
    stats: async () => null,
    throttle: async () => ({ limited: false }),
    accessLog: async (entry) => {
      if (mode === "audit-failure") throw new Error("fixture sink failure");
      entries.push(entry);
      return true;
    },
  });
  let cookie = "";
  if (mode !== "guest") {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: mode === "self" ? subject : viewer,
      username: "fixture-viewer",
      avatar: null,
      member: mode !== "non-member",
      moderator: mode === "moderator",
      expiresAt: new Date(Date.now() + 60_000),
    });
    cookie = (
      await serializeSigned("__Host-two_session", token, secret, {
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }
  const response = await router.request(
    `/members/${subject}`,
    { headers: { cookie } },
    {
      APP_URL: "https://profile.test",
      SESSION_SECRET: secret,
      DISCORD_CLIENT_ID: "fixture",
      DISCORD_CLIENT_SECRET: "fixture",
      DISCORD_GUILD_ID: "fixture",
      DISCORD_BOT_TOKEN: "fixture",
      DISCORD_INVITE_URL: "https://discord.gg/fixture",
    },
  );
  const copy = new Response(response.body, response);
  copy.headers.set("x-fixture-audit", JSON.stringify(entries));
  return copy;
});
export default app;
