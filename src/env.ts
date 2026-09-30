import type { QueueMessage } from "./jobs/types";

export type Env = AgentEventsEnv & {
  APP_URL: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_INVITE_URL: string;
  // Optional: surfaces the "Last updated" stamp on /rules (YYYY-MM-DD). Empty or unparseable
  // hides the stamp instead of 500ing (ports two-web TOG-7323).
  RULES_LAST_UPDATED?: string;
  // S1 (TOG-9679): Hyperdrive → Neon shared Postgres for the /db-ping
  // acceptance probe. Optional until the operator provisions Hyperdrive;
  // /db-ping 503s without it. Same shape as AGENT_DB below: at cutover the
  // operator may point both bindings at one Hyperdrive config id.
  DB?: { connectionString: string };
  // Secrets (wrangler secret put). The bot token must belong to the same Discord application as
  // DISCORD_CLIENT_ID: Discord only lets an application's own bot add a member with that
  // application's guilds.join token.
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  SESSION_SECRET: string;
  // Optional. `DATABASE_URL` (agent-testdb locally; absent in unit tests, which
  // use the memory store) and the Hyperdrive binding (S1/W1) share the Sql
  // surface in `db.ts`. `QA_AUTH_TOKEN` enables the staging-only QA seam; it is
  // unset everywhere else and the route 404s without it. The admin slice (W11)
  // reads Postgres through the same var in dev/staging and fails closed
  // without it; `MEMBER_ACCESS_LOG_ENFORCE` defaults to true when unset
  // (a log write failure refuses the read; set "false" to degrade instead).
  DATABASE_URL?: string;
  DISCORD_MODERATOR_ROLE_IDS?: string;
  QA_AUTH_TOKEN?: string;
  MEMBER_ACCESS_LOG_ENFORCE?: string;
  // CSP violation sink (TOG-10107): fraction of valid reports (0.0–1.0)
  // written to the log. Unset or unparseable falls back to 1.0 (log
  // everything); out-of-range values clamp. Lower it if report volume ever
  // outweighs the signal.
  CSP_REPORT_SAMPLE_RATE?: string;
};

// Worker-only bindings added by W13; the web app (Hono) and its tests only need `Env`.
export type JobsEnv = Env & {
  // Queues are producer+consumer on this Worker; the DB string comes from Hyperdrive once it exists
  // (later slice), else DATABASE_URL (local/agent-testdb).
  SYNC_EVENT_QUEUE: Queue<QueueMessage>;
  INTERNAL_ACTION_QUEUE: Queue<QueueMessage>;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
};

export type Session = {
  id: string;
  username: string;
  avatar: string | null;
  member: boolean;
  moderator: boolean;
};

// W14: agent-events ingress. Postgres comes through a Hyperdrive binding in the worker; tests
// and `wrangler dev` inject a connection string via the same shape (agent-testdb only).
export type AgentEventsEnv = {
  AGENT_DB?: { connectionString: string };
  // Kill switch, default off: an unconfigured environment answers 404 ingress_disabled.
  AGENT_EVENTS_ENABLED?: string;
  // The one admitted caller. Env-only, no default: unset denies every grant (wrong_caller).
  AGENT_EVENTS_CALLER_AGENT_ID?: string;
  AGENT_EVENTS_GUILD_ID?: string;
  AGENT_EVENTS_PRODUCTION_GUILD_ID?: string;
  // Outer shield budget (two-web `agent-events.route_per_minute`, default 60).
  AGENT_EVENTS_ROUTE_PER_MINUTE?: string;
};
