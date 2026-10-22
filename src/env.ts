import type { QueueMessage } from "./jobs/types";

export type Env = AgentEventsEnv & {
  APP_URL: string;
  // Event writes use the same W13 queue as scheduled reconciliation. Optional
  // only for local/test environments without a transport.
  SYNC_EVENT_QUEUE?: Pick<Queue<QueueMessage>, "send">;
  // Worker-first static assets: fetched only after the host guard admits the request.
  ASSETS?: Pick<Fetcher, "fetch">;
  // Worker Version metadata binding (`version_metadata`). Declared for the
  // staging and production web Workers and the staging jobs Worker; absent
  // locally, so `/up` carries no revision and log release fields stay null
  // there. `id` is the Version ID that `wrangler rollback` takes; `tag`
  // carries the deploy commit (src/release-tag.ts parses both tag shapes).
  CF_VERSION_METADATA?: Partial<Pick<WorkerVersionMetadata, "id" | "tag">>;
  DISCORD_CLIENT_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_INVITE_URL: string;
  // Optional: surfaces the "Last updated" stamp on /rules (YYYY-MM-DD). Empty or unparseable
  // hides the stamp instead of 500ing (ports two-web TOG-7323).
  RULES_LAST_UPDATED?: string;
  // Hyperdrive → shared Postgres for web reads, agent events, sessions,
  // roster writes and /up. DATABASE_URL overrides it for local/dev use. An
  // optional AGENT_DB binding overrides the store for agent-event ingress only.
  DB?: { connectionString: string };
  // Secrets (wrangler secret put). The bot token must belong to the same Discord application as
  // DISCORD_CLIENT_ID: Discord only lets an application's own bot add a member with that
  // application's guilds.join token.
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  SESSION_SECRET: string;
  // Optional explicit Postgres URL (agent-testdb locally); web DB consumers
  // use DB.connectionString when absent. `QA_AUTH_TOKEN` enables the staging-only
  // QA seam; unset elsewhere, the route 404s.
  DATABASE_URL?: string;
  // Bot database for the homepage counts' and profile stats' `web_v1` views
  // (bot-owned, read-only `two_web_reader` grant). Hyperdrive binding `BOT_DB`
  // in deployed environments; `BOT_DATABASE_URL` overrides it for local/dev
  // use. Absent both, counts and stats degrade to hidden — the web `DB` is
  // never read for them.
  BOT_DB?: { connectionString: string };
  BOT_DATABASE_URL?: string;
  DISCORD_MODERATOR_ROLE_IDS?: string;
  QA_AUTH_TOKEN?: string;
  // Separate default-off operational read boundary. No grant or principal is
  // provisioned here; both settings require independent security review.
  QUEUE_RECONCILE_PREVIEW_ENABLED?: string;
  QUEUE_RECONCILE_OPERATOR_ID?: string;
  // Evidence-only source/cache verifier (runtime-only, never checked-in
  // config). The bearer token, authorized incident ID, issued instant and
  // expiry instant are provisioned for one separately authorized invocation
  // (at most a one-hour issued-to-expiry window) and removed at teardown;
  // merged main carries no values, leaving the route inert.
  SOURCE_EVIDENCE_VERIFIER_ENABLED?: string;
  SOURCE_EVIDENCE_VERIFIER_TOKEN?: string;
  SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID?: string;
  SOURCE_EVIDENCE_VERIFIER_ISSUED_AT?: string;
  SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT?: string;
  // The staging alert probe uses the same internal queue as JobsEnv, without a DB fixture.
  INTERNAL_ACTION_QUEUE?: Queue<QueueMessage>;
  // CSP violation sink (TOG-10107): fraction of valid reports (0.0–1.0)
  // written to the log. Unset or unparseable falls back to 1.0 (log
  // everything); out-of-range values clamp. Lower it if report volume ever
  // outweighs the signal.
  CSP_REPORT_SAMPLE_RATE?: string;
  // Extra exact HTTPS image hosts, comma-separated; shared by admin validation
  // and img-src. No schemes, ports, paths or wildcards. Discord CDN is always allowed.
  FEATURED_IMAGE_HOSTS?: string;
  // Cutover freeze notice (docs/cutover-freeze.md): only the exact strings
  // "true"/"1" render the banner; unset or anything else stays invisible.
  // FREEZE_BANNER_DATES carries the human window (e.g. "12–14 Oct UTC");
  // the banner needs real dates, so the flag alone never renders.
  FREEZE_BANNER_ENABLED?: string;
  FREEZE_BANNER_DATES?: string;
  // Kit parity fixture only (ci/kit-worker-dev.mjs sets it on its generated
  // loopback worker, never a deployed config): enables the member board in
  // the fixture manifest so the executed parity journey runs the Kit load.
  // The shipped manifest now owns the board on Kit too, so the flag is
  // redundant for this entry (rollback is enabled: false). Honoured only
  // for an http loopback APP_URL (src/route-ownership.ts fixtureManifestFor).
  KIT_PARITY_FIXTURE_MEMBER_BOARD?: string;
  // Kit parity fixture only (same loopback worker, never deployed): enables
  // the live event detail (GET /e/:key) in the fixture manifest so the RSVP
  // companion's executed journey runs the Kit load. The shipped detail entry
  // stays disabled until the companion passes; honoured only for an http
  // loopback APP_URL (src/route-ownership.ts fixtureManifestFor).
  KIT_PARITY_FIXTURE_EVENT_DETAIL?: string;
  // Staging Kit rollout controls (web/wrangler.staging.jsonc only). The exact
  // staging APP_URL activates a fail-closed route manifest: unset or malformed
  // values keep archive and static families on Hono. Preview fixture workers
  // and production do not set these flags.
  KIT_ROUTE_ARCHIVE?: string;
  KIT_ROUTE_STATIC?: string;
  // B1 read-only WebMCP pilot: only the exact strings "true"/"1" inject the
  // model-context island on the four pilot pages; unset or anything else
  // leaves pages byte-identical. No session, cookie or database read.
  WEBMCP_PILOT_ENABLED?: string;
  // CI loopback workers only (e2e/wrangler.jsonc and the generated Kit
  // fixture in ci/kit-worker-dev.mjs set it, never a deployed config):
  // overrides the shared public-read admission budget for those workers,
  // whose sequential suites present one `anon` client key off-edge. Positive
  // integers only; unset or anything else keeps the production 60
  // (src/events/routes-shared.ts publicReadBudget).
  E2E_PUBLIC_READ_BUDGET?: string;
};

// Worker-only bindings added by W13; the web app (Hono) and its tests only need `Env`.
export type JobsEnv = Env & {
  // Queues are producer+consumer on this Worker; the DB string comes from Hyperdrive once it exists
  // (later slice), else DATABASE_URL (local/agent-testdb).
  SYNC_EVENT_QUEUE: Queue<QueueMessage>;
  INTERNAL_ACTION_QUEUE: Queue<QueueMessage>;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  // Signed bot client for sync/announcement/role jobs. All three are required
  // to send; a missing value is a terminal, alerting job failure (never an ack
  // as success). Values are Operator-provisioned; see docs/config.md.
  BOT_ENDPOINT_URL?: string;
  BOT_KEY_ID?: string;
  BOT_SHARED_SECRET?: string;
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
  // Optional signed bot observation configuration; missing values fail closed.
  BOT_ENDPOINT_URL?: string;
  BOT_KEY_ID?: string;
  BOT_SHARED_SECRET?: string;
  // Kill switch, default off: an unconfigured environment answers 404 ingress_disabled.
  AGENT_EVENTS_ENABLED?: string;
  // The one admitted caller. Env-only, no default: unset denies every grant (wrong_caller).
  AGENT_EVENTS_CALLER_AGENT_ID?: string;
  AGENT_EVENTS_GUILD_ID?: string;
  AGENT_EVENTS_PRODUCTION_GUILD_ID?: string;
  // Outer shield budget (two-web `agent-events.route_per_minute`, default 60).
  AGENT_EVENTS_ROUTE_PER_MINUTE?: string;
};
