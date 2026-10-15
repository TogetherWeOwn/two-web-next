// Join route shared module (structural split; zero behavior change).
//
// Cookie names, TTLs, journey types and the throttle/store helpers live here so
// the per-route leaves (`./route-page`, `./route-start`, `./route-callback`)
// share one definition. The historic barrel (`./route`) re-exports the public
// names, so existing importers keep working untouched.
import type { Context } from "hono";
import postgres from "postgres";
import { rateLimitExceeded } from "../errors";
import type { Env } from "../env";
import { databaseOptions, databaseUrl } from "../db/connection";
import { clientKey } from "../throttle";
import { type SessionStore, type Sql } from "../sessions";
import {
  type BotAdd,
  JOIN_THROTTLE_BUCKET,
  JOIN_THROTTLE_PER_MINUTE,
  checkJoinThrottle,
} from "./service";

export const JOIN_STATE_COOKIE = "__Host-two_join_state";
export const JOIN_SOURCE_COOKIE = "__Host-two_join_source";
export const JOIN_NEXT_COOKIE = "__Host-two_join_next";
export const STATE_TTL_SECONDS = 600;
export const JOURNEY_TTL_SECONDS = 600;

/** Injectable at the call site (`{...env, JOIN_STORE: …}`), like SESSION_STORE. */
export type JoinRouteDeps = {
  store?: () => Promise<Sql | null>;
  bot?: (botToken: string) => BotAdd;
  now?: () => number;
};
export type EnvWithJoin = Env & { JOIN_DEPS?: JoinRouteDeps };

export type Ctx = Context<{ Bindings: Env }>;

// Postgres access for the journey. Same posture as sessions (`storeFor` in the
// app module): tests inject a client through JOIN_DEPS; runtime uses the
// explicit DATABASE_URL or the Hyperdrive DB binding. With neither, throttle
// and attempts degrade to no-ops so the DB-free funnel stays up. No DDL here
// (TOG-19721): join_attempts/web_throttle_hits come from the migrate workflow
// (drizzle/1000); the runtime role stays read/write-only.
export async function joinStore(c: Ctx): Promise<Sql | null> {
  const deps = (c.env as EnvWithJoin).JOIN_DEPS;
  if (deps?.store) return deps.store();
  const url = databaseUrl(c.env);
  if (!url) return null;
  return postgres(url, databaseOptions) as unknown as Sql;
}

export function background(c: Ctx): ((work: Promise<void>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return undefined;
  }
}

export const joinRedirectUri = (env: Env) => `${env.APP_URL}/join/callback`;

export function currentMinute(now: () => number): number {
  return Math.floor(now() / 60000);
}

// The budget is per client: `join:<client>:<minute>`, the same client key every
// other human-route throttle uses. /join/discord and /join/callback draw on one
// bucket per client (legacy `throttle:10,1` keyed guests by IP), but no client
// can spend another's budget.
export async function throttled(c: Ctx): Promise<Response | null> {
  const deps = (c.env as EnvWithJoin).JOIN_DEPS;
  const verdict = await checkJoinThrottle(
    await joinStore(c),
    `${JOIN_THROTTLE_BUCKET}:${clientKey(c)}:${currentMinute(deps?.now ?? Date.now)}`,
    JOIN_THROTTLE_PER_MINUTE,
  );
  if (!verdict.limited) return null;
  return rateLimitExceeded(c, verdict.retryAfter);
}

// Session + issue helpers live in the main app module (the join router is
// mounted on it). They are passed in at mount time to keep this module free of
// the import cycle.
export type JoinSessionHooks = {
  storeFor: (c: Ctx) => Promise<SessionStore>;
  issueSession: (
    c: Ctx,
    store: SessionStore,
    row: {
      userId: string;
      username: string;
      avatar: string | null;
      member: boolean;
      moderator: boolean;
    },
  ) => Promise<void>;
};

export type JoinPageProps = {
  inviteUrl: string;
  widgetUrl: string | null;
  widgetSnapshot?: import("../discord-widget").DiscordWidgetSnapshot | null;
  next?: string | null;
  appUrl: string;
};
export type RecoveryProps = {
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
};

// Rendering lives with the app module (it owns the JSX runtime); this module
// owns the journey flow. Both callbacks receive the request context so they
// can answer with the right status.
export type JoinRender = {
  joinPage: (c: Ctx, props: JoinPageProps) => Response | Promise<Response>;
  recovery: (c: Ctx, props: RecoveryProps, status?: 200 | 503) => Response | Promise<Response>;
};
