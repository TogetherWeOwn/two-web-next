export type Env = AgentEventsEnv & {
  APP_URL: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_INVITE_URL: string;
  // Optional: surfaces the "Last updated" stamp on /rules (YYYY-MM-DD). Empty or unparseable
  // hides the stamp instead of 500ing (ports two-web TOG-7323).
  RULES_LAST_UPDATED?: string;
  // Secrets (wrangler secret put). The bot token must belong to the same Discord application as
  // DISCORD_CLIENT_ID: Discord only lets an application's own bot add a member with that
  // application's guilds.join token.
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  SESSION_SECRET: string;
  // Optional. `DATABASE_URL` (agent-testdb locally; absent in unit tests, which
  // use the memory store) and the Hyperdrive binding (S1/W1) share the Sql
  // surface in `db.ts`. `QA_AUTH_TOKEN` enables the staging-only QA seam; it is
  // unset everywhere else and the route 404s without it.
  DATABASE_URL?: string;
  DISCORD_MODERATOR_ROLE_IDS?: string;
  QA_AUTH_TOKEN?: string;
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
};
