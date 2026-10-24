// Kit read model for GET /profile and GET /members/:user.
// Framework-free so the root suite pins it without a SvelteKit transform:
// the +page.server.ts loads map these outcomes onto redirect()/error() and
// run inside the hook's memberReadResponse boundary, which audits the
// declared retrieved subject before any bytes leave.
//
// Gate order mirrors src/profiles/routes-gate.ts: the member bit is decided
// before any store read, so guests bounce, non-members 403 and outages 503
// with no declaration and no audit row. Read order mirrors
// src/profiles/routes-reads.tsx: the store declares the retrieved owner (never
// the requested id); a missing member declares the empty read and 404s.
// POST/PATCH sibling paths are not modelled here and stay Hono-owned: the
// manifest carries GET entries only, and the Kit view's edit form posts back
// to the Hono write routes until the edit-parity follow-up.
import { drizzle } from "drizzle-orm/postgres-js";
import { generateCookie, generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { dbFor, type EnvWithAdminDb } from "../admin/db";
import { botDatabaseUrl, databaseOptions } from "../db/connection";
import type { Env } from "../env";
import { safeNext } from "../join/service";
import type { KitRequestSession } from "../kit-session";
import { declareMemberResult } from "../member-reads";
import { JOURNEY_TTL_SECONDS, LOGIN_INTENDED_COOKIE, type JoinResult } from "../return-journey";
import { SNOWFLAKE } from "./routes-shared";
import {
  MEMBER_STATS_BUDGET_MS,
  memberStatsWithBudget,
  readMemberStats,
  readOwnedMemberStats,
  type MemberStats,
} from "./stats";
import { findSharedGames } from "./shared-games";
import { createDbProfileStore, type MemberView, type ProfileStore } from "./store";

export const KIT_PROFILE_LOGIN_LOCATION = "/auth/discord";

export type KitProfileRequest = {
  session: KitRequestSession;
  /** /profile passes the viewer's own id; /members/:user passes the param. */
  requestedId: string | null;
  joinResult: JoinResult | null;
  /** Full load-event URL; optional only for legacy model callers. */
  url?: string;
};

export type KitProfileDeps = {
  store: ProfileStore | null;
  sessionSecret?: string;
  /** Absent (or resolving null) hides the stats block; a read failure resolves
   * to an unavailable marker the view renders, never a refusal of the page. */
  stats?: (memberId: string) => Promise<MemberStats | null>;
};

export type KitProfileOutcome =
  | { kind: "redirect"; location: string; intendedCookie?: string }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | {
      kind: "ok";
      member: MemberView;
      stats: MemberStats | null;
      isOwner: boolean;
      isModerator: boolean;
      joinResult: JoinResult | null;
      /** Member's displayed game strings the viewer also plays, in list order;
       * [] when none, including self reads. */
      sharedGames: string[];
    };

/** Production store/stats wiring for the Kit loads: the Hono resolvers' twin. */
export function kitProfileDeps(env: Env) {
  const storeFor = async (): Promise<ProfileStore | null> => {
    const db = await dbFor({ env });
    return db ? createDbProfileStore(db) : null;
  };
  const statsFor = (memberId: string): Promise<MemberStats | null> =>
    memberStatsWithBudget(async (id, signal) => {
      // Injected fixtures/clients are borrowed, never shut down by this request.
      const injected = (env as EnvWithAdminDb).ADMIN_DB;
      if (injected) return readMemberStats(injected, id, signal);
      // Bot-owned `web_v1` views live in the bot database, never the
      // web DB (same source rule as homepage counts): explicit
      // BOT_DATABASE_URL wins, else the BOT_DB Hyperdrive binding.
      const url = botDatabaseUrl(env);
      if (!url) return null;
      signal.throwIfAborted();
      // Also bound server-side execution if the connection disappears mid-query.
      const client = postgres(url, {
        ...databaseOptions,
        connection: { statement_timeout: MEMBER_STATS_BUDGET_MS },
      });
      return readOwnedMemberStats(drizzle(client), id, signal);
    }, memberId);
  return { storeFor, statsFor, sessionSecret: env.SESSION_SECRET };
}

export async function resolveKitProfile(
  req: KitProfileRequest,
  deps: KitProfileDeps,
): Promise<KitProfileOutcome> {
  const { session } = req;
  // The bridge maps every store failure to unknown, never to a false logout:
  // an outage is unavailable, not a bounce and never a rendered read.
  if (session.status === "unknown") return { kind: "unavailable" };
  // Guest (missing/tampered cookie, unknown row): the Hono intended-page
  // bounce. No store read, no declaration, no audit row.
  if (session.status !== "authenticated" || !session.session) {
    // Legacy model callers have no request to remember. Real loads always
    // supply both inputs; a rejected destination clears abandoned state.
    if (!req.url || !deps.sessionSecret)
      return { kind: "redirect", location: KIT_PROFILE_LOGIN_LOCATION };
    const url = new URL(req.url);
    const dest = safeNext(url.pathname + url.search);
    const options = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };
    const intendedCookie = dest
      ? await generateSignedCookie(LOGIN_INTENDED_COOKIE, dest, deps.sessionSecret, {
          ...options,
          maxAge: JOURNEY_TTL_SECONDS,
        })
      : generateCookie(LOGIN_INTENDED_COOKIE, "", { ...options, maxAge: 0 });
    return { kind: "redirect", location: KIT_PROFILE_LOGIN_LOCATION, intendedCookie };
  }
  const viewer = session.session;
  // Signed in but outside the guild: the Hono 403. Nothing rendered, nothing logged.
  if (!viewer.member) return { kind: "forbidden" };
  // Malformed ids never reach the store: the Hono 404 logs nothing.
  if (!req.requestedId || !SNOWFLAKE.test(req.requestedId)) return { kind: "notFound" };
  // No database: fail closed like the Hono gate's 503, with no contents.
  if (!deps.store) return { kind: "unavailable" };
  // The store declares the retrieved owner (or the empty read for a miss);
  // a refusal propagates to the boundary, which replaces the contents.
  const member = await deps.store.find(req.requestedId);
  if (!member) {
    // Borrowed non-SQL stores declare retrieved keys, never the requested id.
    declareMemberResult([]);
    return { kind: "notFound" };
  }
  const stats = deps.stats ? await deps.stats(member.id) : null;
  const isOwner = viewer.userId === member.id;
  // Another member's page marks the games the viewer also plays: one extra
  // keyed read of the viewer's own stored row, bounded by the stored list.
  // The hook's member-read boundary filters the viewer out of the audit
  // subjects, so the access log keeps the viewed member only. Self reads skip it.
  const viewerRow = isOwner ? null : await deps.store.find(viewer.userId);
  const sharedGames = isOwner ? [] : findSharedGames(member.games, viewerRow?.games ?? []);
  return {
    kind: "ok",
    member,
    stats,
    isOwner,
    isModerator: viewer.moderator,
    joinResult: req.joinResult,
    sharedGames,
  };
}
