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
// - Bare /members is a retired 404 (URL freeze), answered before the gate:
//   no session, no cookie, no access-log row (legacy had no such page).
// Session seam mirrors the admin guard: a row read, never a rotation.
//
// Barrel: the mount lives here, one module per concern beside it —
// routes-gate (session gate, access-log boundary, failure handler),
// routes-admission (write throttle, owner-only), routes-stores (store, stats
// and sink resolvers), routes-reads, routes-writes, routes-shared (types).
// Registration order matches the original file exactly.

import { Hono } from "hono";
import type { Env } from "../env";
import { profileError, registerGate } from "./routes-gate";
import { registerReadRoutes } from "./routes-reads";
import type { ProfileDeps, Vars } from "./routes-shared";
import { profileStores } from "./routes-stores";
import { registerWriteRoutes } from "./routes-writes";

export { PROFILE_WRITE_THROTTLE_PER_MINUTE } from "./routes-admission";
export type { ProfileDeps } from "./routes-shared";

export function profilesApp(deps: ProfileDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.onError(profileError);
  const stores = profileStores(deps);
  registerGate(app, deps, stores);
  registerReadRoutes(app, stores);
  registerWriteRoutes(app, deps, stores);
  return app;
}
