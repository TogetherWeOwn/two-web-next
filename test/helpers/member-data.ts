// W15 fixtures: synthetic identities only. Live suites share the migrated test DB
// and run serially (vitest.config.ts); never pass a staging/production URL.
import { serializeSigned } from "hono/utils/cookie";
import { activityLog, events, memberDataAccessLogs, rsvps } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import { joinAttempts, profiles, users } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { hashToken, newSessionToken, type SessionStore } from "../../src/sessions";

export const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

export const SUBJECT = { userId: "100000000000000101", username: "zxq-directoryprobe", member: true, moderator: false };
export const MEMBER = { userId: "100000000000000102", username: "w15-member", member: true, moderator: false };
export const MODERATOR = { userId: "100000000000000103", username: "w15-moderator", member: true, moderator: true };
export const OUTSIDER = { userId: "100000000000000104", username: "w15-outsider", member: false, moderator: false };
export const EVENT_KEY = "01J00000000000000000000015";
export const PERSONAL_STRINGS = [SUBJECT.username, "Bio that must never reach a guest 7f3a", "Zxq Game One", "avatar_directoryprobe"];

export async function cookieFor(store: SessionStore, actor: typeof MEMBER): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
}

export async function clean(db: Db): Promise<void> {
  await db.delete(memberDataAccessLogs);
  await db.delete(activityLog);
  await db.delete(rsvps);
  await db.delete(profiles);
  await db.delete(joinAttempts);
  await db.delete(events);
  await db.delete(users);
}

export async function seed(db: Db, hasProfile = true): Promise<void> {
  await db.insert(users).values([SUBJECT, MEMBER, MODERATOR, OUTSIDER].map((actor) => ({
    id: actor.userId, username: actor.username, member: actor.member,
    avatar: actor === SUBJECT ? PERSONAL_STRINGS[3] : null,
  })));
  if (hasProfile) await db.insert(profiles).values({
    userId: SUBJECT.userId, bio: PERSONAL_STRINGS[1], games: [PERSONAL_STRINGS[2]!], timezone: "Europe/London",
  });
  const [event] = await db.insert(events).values({
    eventKey: EVENT_KEY, title: "Friday night games", status: "published",
    startsAt: new Date("2099-11-04T20:00:00Z"), endsAt: new Date("2099-11-04T22:00:00Z"),
  }).returning();
  await db.insert(rsvps).values({ eventId: event!.id, userId: SUBJECT.userId, status: "going" });
  await db.insert(joinAttempts).values({ outcome: "added", discordId: SUBJECT.userId, requestId: "w15-request" });
}
