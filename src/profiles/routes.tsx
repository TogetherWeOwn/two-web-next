// Member journeys (W7: TOG-9686): GET /profile, GET /members/:user,
// PATCH /members/:user. Ports ProfileController + UserPolicy + the `auth`
// group + `throttle:30,1` + `member-access-log`.
//
// Exposure posture (pinned in test/profiles.test.ts, written first):
// - guest → 302 /auth/discord, nothing rendered (legacy: `auth` middleware).
// - signed in but not in the guild (session.member false) → 403. Legacy login
//   404s non-members, so "authenticated" meant "member"; here sign-in can
//   succeed without the join, so the member bit is checked on every request.
// - member and moderator see the same profile fields; the moderator bit adds
//   nothing here (moderator reads happen in the admin panel, which logs too).
// - Reading someone else's profile writes one member_data_access_logs row
//   (viewer never counts as their own subject, so self-views write none —
//   AccessRecorder parity). Unknown/invalid ids are 404 and log nothing.
// - Only the owner may PATCH; origin-checked; 30 writes/min per member.
// Session seam mirrors the admin guard: a row read, never a rotation.

import { getSignedCookie } from "hono/cookie";
import { type Context, type Next, Hono } from "hono";
import postgres from "postgres";
import { dbFor } from "../admin/db";
import { sessionStoreFor } from "../admin/guard";
import { recordAccess } from "../admin/store";
import { memberAccessLog, type AccessDecl, type AccessSink } from "../access-log";
import type { Env } from "../env";
import { checkJoinThrottle, migrateJoin } from "../join/service";
import { bounceToLogin, takeJoinResult } from "../return-journey";
import { hashToken, type SessionStore, type Sql } from "../sessions";
import { PROFILE_COPY, profileTrapTripped } from "../islands/contracts";
import { ProfilePage } from "./pages";
import { createDbProfileStore, type ProfileStore } from "./store";
import { validateProfile } from "./validation";

export const PROFILE_WRITE_THROTTLE_PER_MINUTE = 30;
const SESSION_COOKIE = "__Host-two_session";
const SNOWFLAKE = /^\d{10,25}$/;

type Verdict = Awaited<ReturnType<typeof checkJoinThrottle>>;

export type ProfileDeps = {
  sessionStore?: SessionStore;
  store?: ProfileStore;
  accessLog?: AccessSink;
  /** bucket → verdict. Default: web_throttle_hits via DATABASE_URL; no DB allows. */
  throttle?: (bucket: string) => Promise<Verdict>;
};

type Viewer = { id: string; username: string; member: boolean; moderator: boolean };
type Vars = { viewerId: string; access: AccessDecl; viewer: Viewer };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const migratedThrottle = new Set<string>();

export function profilesApp(deps: ProfileDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  const storeFor = async (c: { env: Env }): Promise<ProfileStore | null> => {
    if (deps.store) return deps.store;
    const db = await dbFor(c);
    return db ? createDbProfileStore(db) : null;
  };
  const sinkFor = async (c: { env: Env }): Promise<AccessSink | null> => {
    if (deps.accessLog) return deps.accessLog;
    const db = await dbFor(c);
    return db ? (entry) => recordAccess(db, entry) : null;
  };
  const throttle = async (c: { env: Env }, bucket: string): Promise<Verdict> => {
    if (deps.throttle) return deps.throttle(bucket);
    const url = c.env.DATABASE_URL;
    if (!url) return { limited: false };
    const sql = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 }) as unknown as Sql;
    if (!migratedThrottle.has(url)) {
      await migrateJoin(sql);
      migratedThrottle.add(url);
    }
    return checkJoinThrottle(sql, bucket, PROFILE_WRITE_THROTTLE_PER_MINUTE);
  };

  // Gate: guest → OAuth, non-member → 403, store failure → 503 (fail closed).
  const gate = async (c: Ctx, next: Next) => {
    // The origin check for forged same-shape writes (SameSite=Lax already stops the cookie).
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin && origin !== c.env.APP_URL) return c.text("Forbidden", 403);
    }
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    // Guest: record where they were headed (legacy url.intended), then into
    // the site OAuth flow — the callback returns them here after sign-in.
    if (!token) return bounceToLogin(c);
    let viewer: Viewer | null = null;
    try {
      const sessions = deps.sessionStore ?? (await sessionStoreFor(c));
      if (!sessions) throw new Error("no session store");
      const row = await sessions.get(await hashToken(token));
      if (row) viewer = { id: row.userId, username: row.username, member: row.member, moderator: row.moderator };
    } catch (err) {
      console.error("profiles could not resolve the session; refusing.", { error: String(err) });
      return c.text("Profiles temporarily unavailable", 503);
    }
    // A cookie whose row is gone (revoked/expired/rotated) is a guest — same
    // intended-page bounce so the round trip lands them back here.
    if (!viewer) return bounceToLogin(c);
    if (!viewer.member) return c.text("Forbidden", 403);
    c.set("viewerId", viewer.id);
    c.set("viewer", viewer);
    await next();
    c.header("cache-control", "private, no-store");
  };

  // Scoped to this slice's paths: the app is mounted at "/", so a "*" here
  // would gate every route in the worker.
  for (const path of ["/profile", "/members/*"]) {
    app.use(path, gate);
    app.use(path, memberAccessLog(sinkFor));
  }

  const render = async (c: Ctx, id: string, routeName: string) => {
    if (!SNOWFLAKE.test(id)) return c.notFound();
    const store = await storeFor(c);
    if (!store) return c.text("Profiles temporarily unavailable", 503);
    const member = await store.find(id);
    if (!member) return c.notFound();
    const viewer = c.get("viewer");
    c.set("access", { resource: "profile", action: "view", route: routeName, subjects: [member.id] });
    // One-shot join confirmation: a member who just completed the join sees the
    // added/already-member banner (and the reinvite action) on their landing.
    const joinResult = await takeJoinResult(c);
    return c.html(<ProfilePage member={member} isOwner={viewer.id === member.id} joinResult={joinResult} />);
  };

  app.get("/profile", (c) => render(c, c.get("viewer").id, "profile"));
  app.get("/members/:user", (c) => render(c, c.req.param("user"), "profiles.show"));

  const patch = async (c: Ctx, forced?: Record<string, unknown>) => {
    const id = c.req.param("user") ?? "";
    const viewer = c.get("viewer");
    const verdict = await throttle(c, `profile-write:${viewer.id}`).catch(() => ({ limited: false }) as Verdict);
    if (verdict.limited) {
      return c.json(
        { reason: "rate_limited", message: "Too many profile updates. Try again shortly.", retry_after: verdict.retryAfter },
        429,
        { "Retry-After": String(verdict.retryAfter) },
      );
    }
    // UserPolicy::updateProfile: owner only. Moderators do not edit others' profiles.
    if (!SNOWFLAKE.test(id) || viewer.id !== id) return c.text("Forbidden", 403);
    const store = await storeFor(c);
    if (!store) return c.text("Profiles temporarily unavailable", 503);
    const member = await store.find(id);
    if (!member) return c.notFound();

    let input: Record<string, unknown>;
    try {
      if (forced) input = forced;
      else if ((c.req.header("content-type") ?? "").includes("application/json")) input = (await c.req.json()) as Record<string, unknown>;
      else input = { ...(await c.req.parseBody({ all: true })) };
    } catch {
      return c.text("Bad request", 400);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) return c.text("Bad request", 400);
    // `games` must be present (legacy `present|array`); a form without it is a blank list.
    if (input.games === undefined && input.games_text === undefined) input.games = [];

    const result = validateProfile(input);
    if (!result.ok) {
      if ((c.req.header("accept") ?? "").includes("application/json")) return c.json({ errors: result.errors }, 422);
      c.status(422);
      return c.html(
        <ProfilePage
          member={member}
          isOwner
          errors={result.errors}
          values={{
            bio: typeof input.bio === "string" ? input.bio : "",
            games_text: typeof input.games_text === "string" ? input.games_text : "",
            timezone: typeof input.timezone === "string" ? input.timezone : "",
          }}
        />,
      );
    }
    // Trap (TOG-8715/TOG-9361): only after validation, so errors surface first.
    // A tripped trap skips the write and answers the byte-identical success
    // shape: no oracle, nothing logged.
    const trapped = profileTrapTripped(input, Date.now());
    try {
      if (!trapped) await store.save(id, result.attrs);
    } catch (err) {
      console.error("profile save failed", { exception: (err as Error)?.constructor?.name });
      return c.text("Could not save your profile.", 500);
    }
    if ((c.req.header("accept") ?? "").includes("application/json")) {
      return c.json({ saved: true, message: PROFILE_COPY.saved });
    }
    return c.redirect(`/members/${id}`, 303);
  };

  app.patch("/members/:user", (c) => patch(c));
  // Plain HTML forms cannot PATCH: the edit form posts `_method=PATCH`.
  app.post("/members/:user", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true }).catch(() => null);
      if (body && body._method === "PATCH") {
        const { _method, ...rest } = body;
        return patch(c, rest);
      }
    }
    return c.text("Method Not Allowed", 405);
  });

  return app;
}
