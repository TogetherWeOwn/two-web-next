// Join route shared module (structural split; zero behavior change).
//
// Cookie names, TTLs, journey types and the throttle/store helpers live here so
// the per-route leaves (`./route-page`, `./route-start`, `./route-callback`)
// share one definition. The historic barrel (`./route`) re-exports the public
// names, so existing importers keep working untouched.
import type { Context } from "hono";
import postgres from "postgres";
import { rateLimitExceeded } from "../errors";
import { isDatabaseUnavailable } from "../db/errors";
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

// The fixed ?notice= value the store-down start bounce carries so the
// journey page renders a visible explanation instead of a silent bounce
// (E1). Fixed server-side, never member input; the page allowlists this
// exact value and renders the plain page for anything else.
export const JOIN_START_FAILED_NOTICE = "start-failed";

/** Injectable at the call site (`{...env, JOIN_STORE: …}`), like SESSION_STORE. */
export type JoinRouteDeps = {
  store?: () => Promise<Sql | null>;
  bot?: (botToken: string) => BotAdd;
  // Unused since the minute-boundary fix (S1): kept so older callers and
  // fixtures that still pass `now` keep typechecking. The bucket no longer
  // carries a minute segment; admission is the sliding 60 s window in
  // checkJoinThrottle.
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

// The budget is per client: `join:<client>`, the same client-key shape every
// other human-route throttle uses. /join/discord and /join/callback draw on one
// minute-free bucket per client (legacy `throttle:10,1` keyed guests by IP), so
// a burst straddling a wall-clock minute still spends one sliding 60 s budget.
// No client can spend another's budget.
//
// A throwing store degrades to allow — the same verdict as throttleGuard
// ("a missed count beats a 500") — unless the throw is a classified database
// outage, which stays fail-closed: the global handler renders the branded 503
// the outage matrix pins for both join routes. This throw-path catch stays
// silent by scope carve-out: only the throttleGuard path warns (see the
// `Throttle store failed` row in docs/runbook-logs.md), while the null-store
// allow warns inside checkJoinThrottle. A class-only line here would comply
// with the no-echo pin, but that widening is a follow-up, not this leg.
export async function throttled(c: Ctx): Promise<Response | null> {
  const verdict = await joinStore(c)
    .then((sql) =>
      checkJoinThrottle(sql, `${JOIN_THROTTLE_BUCKET}:${clientKey(c)}`, JOIN_THROTTLE_PER_MINUTE),
    )
    .catch((err: unknown) => {
      if (isDatabaseUnavailable(err)) throw err;
      return { limited: false } as const;
    });
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
  // Already passed sanitizeSource. Absent means the one-click link carries no
  // attribution, the same as a request that arrived without ?source=.
  source?: string | null;
  appUrl: string;
  // The validated store-down notice (JOIN_START_FAILED_NOTICE) when the
  // request carried exactly that ?notice= value; otherwise null and the
  // page renders plain. Display-only: never echoed into the one-click href.
  notice?: typeof JOIN_START_FAILED_NOTICE | null;
};
export type RecoveryProps = {
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
  // Validated request ID for the member to quote to support (the same value
  // as the response's x-request-id). Optional so non-request callers keep
  // working; the join render boundary always supplies it.
  supportReference?: string;
};

// Rendering lives with the app module (it owns the JSX runtime); this module
// owns the journey flow. Both callbacks receive the request context so they
// can answer with the right status.
export type JoinRender = {
  joinPage: (c: Ctx, props: JoinPageProps) => Response | Promise<Response>;
  recovery: (c: Ctx, props: RecoveryProps, status?: 200 | 503) => Response | Promise<Response>;
};
