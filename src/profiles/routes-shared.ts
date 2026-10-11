// Types and constants shared by the profile route modules. Split out of
// src/profiles/routes.tsx so the gate, admission, store, read and write
// modules agree on one request shape; nothing here touches a request.
import type { Context, Hono } from "hono";
import type { AccessDecl, AccessSink } from "../access-log";
import type { Env } from "../env";
import type { checkJoinThrottle } from "../join/service";
import type { SessionStore } from "../sessions";
import type { MemberStatsSource } from "./stats";
import type { ProfileStore } from "./store";

export const SNOWFLAKE = /^\d{10,25}$/;

export type Verdict = Awaited<ReturnType<typeof checkJoinThrottle>>;

export type ProfileDeps = {
  sessionStore?: SessionStore;
  store?: ProfileStore;
  stats?: MemberStatsSource;
  accessLog?: AccessSink;
  /** bucket → verdict. Default: web_throttle_hits via the web DB; no DB allows. */
  throttle?: (bucket: string) => Promise<Verdict>;
};

export type Viewer = { id: string; username: string; member: boolean; moderator: boolean };
export type Vars = { viewerId: string; access: AccessDecl; viewer: Viewer };
export type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
export type ProfileApp = Hono<{ Bindings: Env; Variables: Vars }>;
