import type { QueueMessage } from "./jobs/types";

export type Env = AgentEventsEnv & {
  APP_URL: string;
  // Worker-first static assets: fetched only after the host guard admits the request.
  ASSETS?: Pick<Fetcher, "fetch">;
  DISCORD_CLIENT_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_INVITE_URL: string;
  // Optional: surfaces the "Last updated" stamp on /rules (YYYY-MM-DD). Empty or unparseable
  // hides the stamp instead of 500ing (ports two-web TOG-7323).
  RULES_LAST_UPDATED?: string;
  // Hyperdrive → shared Postgres for web DB reads, sessions, roster writes,
  // and /up. DATABASE_URL overrides it for local/dev use. Same shape as
  // AGENT_DB below; the ingress binding remains independent.
  DB?: { connectionString: string };
  // Secrets (wrangler secret put). The bot token must belong to the same Discord application as
  // DISCORD_CLIENT_ID: Discord only lets an application's own bot add a member with that
  // application's guilds.join token.
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  SESSION_SECRET: string;
  // Optional explicit Postgres URL (agent-testdb locally); web DB consumers
  // use DB.connectionString when absent. `QA_AUTH_TOKEN` enables the staging-only
  // QA seam; unset elsewhere, the route 404s. `MEMBER_ACCESS_LOG_ENFORCE`
  // defaults to true (a log write failure refuses the read; "false" degrades).
  DATABASE_URL?: string;
  DISCORD_MODERATOR_ROLE_IDS?: string;
  QA_AUTH_TOKEN?: string;
  // The staging alert probe uses the same internal queue as JobsEnv, without a DB fixture.
  INTERNAL_ACTION_QUEUE?: Queue<QueueMessage>;
  MEMBER_ACCESS_LOG_ENFORCE?: string;
  // CSP violation sink (TOG-10107): fraction of valid reports (0.0–1.0)
  // written to the log. Unset or unparseable falls back to 1.0 (log
  // everything); out-of-range values clamp. Lower it if report volume ever
  // outweighs the signal.
  CSP_REPORT_SAMPLE_RATE?: string;
  // Extra exact HTTPS image hosts, comma-separated; shared by admin validation
  // and img-src. No schemes, ports, paths or wildcards. Discord CDN is always allowed.
  FEATURED_IMAGE_HOSTS?: string;
  // Staging-only first-party page-view counts (TOG-11885 experiment): Workers
  // Analytics Engine dataset bound at the top level of wrangler.jsonc only, so
  // `env.production` (which re-declares its own bindings) never sees it.
  // Optional: local dev and tests run without the binding and record nothing.
  PAGE_VIEWS?: AnalyticsEngineDataset;
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
