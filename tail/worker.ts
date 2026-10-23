// Tail handler/config contract:
// https://developers.cloudflare.com/workers/observability/logs/tail-workers/
import { validProbeId } from "../src/alert-probe-error";

export type TailEnv = {
  OPS_ALERT_WEBHOOK_URL?: string;
  UPTIME_URL?: string;
  ALERT_AGGREGATOR?: DurableObjectNamespace;
};
export const MUTE_MS = 5 * 60 * 1000;
// Source timestamps more than this far ahead of the Tail clock are treated as
// skew or poisoning: the mute decision uses the local clock instead. Smaller
// skews keep exact source-time semantics so the app's own alert limiter
// (which re-emits on the window boundary in source time) stays coordinated
// with the Tail mute.
export const MAX_SOURCE_SKEW_MS = 60_000;
// Aggregate spike alarm: one page per script when errors cross these gates in a
// rolling window, then a cooldown. Per-fingerprint pages alone cannot say
// "half of traffic is 5xx", so the Tail Worker counts every trace outcome.
export const SPIKE_WINDOW_MS = 5 * 60 * 1000;
export const SPIKE_MIN_ERRORS = 5;
export const SPIKE_MIN_RATE = 0.5;
export const SPIKE_MIN_CRASHES = 5;
export const SPIKE_COOLDOWN_MS = 15 * 60 * 1000;
// Health must stay red continuously past this threshold before uptime.down pages.
export const HEALTH_DOWN_MS = 2 * 60 * 1000;
export const HEALTH_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_TRACKED = 500;
const MAX_BUCKETS = 40;
const BUCKET_MS = 30_000;
// Future-skew slack: a batch stamped more than this far beyond the wall
// clock is rejected at ingest (dropped on the tail path, 400 on the
// aggregator wire) so one far-future batch cannot advance the eviction
// cutoff and wipe every in-window bucket. Two buckets cover ordinary
// clock drift and bucket quantization (a one-bucket +30s skew still
// counts); merely-late batches (stamped in the past) are unaffected and
// still count when inside the rolling window.
export const BATCH_FUTURE_SLACK_MS = 2 * BUCKET_MS;
// A deployed version tag is the staging SHA, or <sha>-<run-id>-<attempt> in
// production. Accept only that leading 40-hex SHA; arbitrary tags never leave.
const VERSION_TAG = /^([0-9a-f]{40})(?:-\d+-\d+)?$/;

export function shaFromVersionTag(tag: unknown): string | undefined {
  if (typeof tag !== "string") return undefined;
  return VERSION_TAG.exec(tag)?.[1];
}

const BUILD_SHA = /^[0-9a-f]{40}$/;
// Cloudflare Worker Version IDs are lowercase UUIDs (see src/up-revision.ts:
// version_id is the exact value `wrangler rollback` takes). Anything else is
// not echoed: a raw non-UUID string could push the page past Discord's
// 2,000-character limit and turn the page into a delivery_failed.
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Live traces do not populate scriptVersion.tag: in the 2026-10-17 staging
// drill the active version tag was the bare deploy SHA, yet delivered
// summaries omitted build_sha. The app's release-tagged log lines
// (http.request, error.alert, queue.failing) carry build_sha from its own
// version_metadata binding, always paired with an equal release field, so
// read the SHA from the trace's own logs when the version tag is absent.
// Only that exact pair passes; nothing else from the line is ever read.
function buildShaFromLogs(logs: TraceLike["logs"]): string | undefined {
  if (!Array.isArray(logs)) return undefined;
  for (const log of logs.slice(0, 100)) {
    const messages = Array.isArray(log?.message) ? log.message.slice(0, 20) : [];
    for (const message of messages) {
      if (
        typeof message !== "string" ||
        message.length > 16_384 ||
        !message.includes('"build_sha"')
      )
        continue;
      try {
        const line: unknown = JSON.parse(message);
        if (!line || typeof line !== "object" || Array.isArray(line)) continue;
        const { build_sha, release } = line as Record<string, unknown>;
        if (typeof build_sha === "string" && build_sha === release && BUILD_SHA.test(build_sha))
          return build_sha;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function traceBuildSha(trace: TraceLike): string | undefined {
  return shaFromVersionTag(trace.scriptVersion?.tag) ?? buildShaFromLogs(trace.logs);
}

export type UpAttribution = {
  build_sha?: string;
  version_id?: string;
};

/**
 * Build attribution from a prober-observed `/up` body. The public body
 * carries `revision: { version_id, commit }` (see src/up-revision.ts);
 * `commit` passes only through the existing exact 40-hex SHA allowlist and
 * `version_id` only through the UUID allowlist for Worker Version IDs.
 * Anything unreadable yields absent attribution, never a throw and never an
 * echo of the raw value.
 */
export function upAttributionFromBody(body: unknown): UpAttribution {
  if (typeof body !== "string" || body === "" || body.length > 64_000) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const revision = (parsed as Record<string, unknown>).revision;
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) return {};
  const fields = revision as Record<string, unknown>;
  const commit = fields.commit;
  const build_sha = typeof commit === "string" && BUILD_SHA.test(commit) ? commit : undefined;
  if (!build_sha) return {};
  const version = fields.version_id;
  const version_id = typeof version === "string" && VERSION_ID.test(version) ? version : undefined;
  return version_id ? { build_sha, version_id } : { build_sha };
}

export function logsPath(script: string): string {
  return `Workers & Pages > ${script} > Observability > Logs`;
}

// Exact app script names this pager accepts. Wrangler does not inherit
// tail_consumers into named environments, so production traces arrive under
// the production app names, and each jobs Worker (two-web-jobs,
// two-web-jobs-production) tails separately from its web Worker. Never match
// by prefix: a prefix wildcard would page for foreign Workers in the same
// account.
export const APP_SCRIPT_NAMES: ReadonlySet<string> = new Set([
  "two-web-next",
  "two-web-next-production",
  "two-web-jobs",
  "two-web-jobs-production",
]);

// Uptime prober: two attempts per cron run, at least 10 s apart, each with a
// 10 s timeout. Page only when both fail. Silent failures (dead route,
// DNS/edge outage, Worker never running) produce no Tail log, so the Tail
// pager alone never sees them.
const UPTIME_TIMEOUT_MS = 10_000;
const UPTIME_RETRY_DELAY_MS = 10_000;
const EXPECTED_ORIGIN = "two-web-next";
// Bound the /up attribution read: headers already arrived, so only the body
// read needs a budget, and it must not ride the cooperative fetch signal
// (a body that stalls after its headers would stall the whole scheduled
// run: no uptime page and no synthetic checks). Expiry yields absent
// attribution and cleanup still runs.
const ATTRIBUTION_TIMEOUT_MS = 2_000;
// Largest /up body prefix worth parsing: upAttributionFromBody rejects
// anything over 64_000 characters, so stop reading there instead of
// buffering an unbounded body into the pager.
const ATTRIBUTION_READ_CAP = 64_000;
// Bound every aggregator call: aggregation runs before per-fingerprint paging
// in the tail handler, so a stalled Durable Object must not stall that pager.
// Each complete operation (request plus body parsing) settles within
// AGGREGATOR_TIMEOUT_MS via an independent setTimeout race; the
// AbortSignal.timeout on each fetch stays on as cooperative cleanup only.
// Result acknowledgement is exactly two such attempts, so its total wait is
// bounded by twice the per-operation budget.
const AGGREGATOR_TIMEOUT_MS = 5_000;

// Independent settlement deadline for one complete aggregator operation.
// AbortSignal.timeout is cooperative: an uncooperative stub can ignore its
// signal forever, so awaiting fetch (or response.json) with only that signal
// can hang the caller. Racing the work against a setTimeout guarantees the
// caller settles within the budget and falls back to local counts. The late
// loser is ignored: a noop handler is attached up front so a late rejection
// after expiry cannot surface as an unhandled rejection, and its value can
// never change the already-settled caller result.
async function withAggregatorDeadline<T>(work: Promise<T>, ms = AGGREGATOR_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("aggregator deadline")), ms);
    });
    void work.then(
      () => {},
      () => {},
    );
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Bound every outbound webhook POST the same way: the per-attempt delivery
// budget is DELIVERY_TIMEOUT_MS via an independent setTimeout race; the
// AbortSignal.timeout on each fetch stays on as cooperative cleanup only.
// The verdict comes from the HTTP response alone: once a response is known,
// body cleanup is still attempted but its outcome is inert and can never
// flip success into failure or stall the caller.
const DELIVERY_TIMEOUT_MS = 5_000;

// Independent settlement deadline for one webhook attempt. AbortSignal.timeout
// is cooperative: an uncooperative fetch can ignore its signal forever, so
// awaiting send (or body.cancel) with only that signal can hang the caller.
// Racing the work against a setTimeout guarantees the caller settles within
// the budget. The late loser is ignored: a noop handler is attached up front
// so a late settlement or rejection after expiry cannot surface as an
// unhandled rejection, and its value can never change the settled result.
async function withDeliveryDeadline<T>(work: Promise<T>, ms = DELIVERY_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("delivery deadline")), ms);
    });
    void work.then(
      () => {},
      () => {},
    );
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Best-effort response cleanup: request cancel, swallow its outcome, never
// let rejection or stall reach a receipt, a mute decision, or the process.
function cleanupResponse(response: Response): void {
  try {
    const cleanup = response.body?.cancel();
    if (cleanup)
      void cleanup.then(
        () => {},
        () => {},
      );
  } catch {
    /* Cleanup request failures never flip the delivery verdict. */
  }
}

// Independent settlement deadline for one scheduled GET header wait. The
// /up and synthetic probes each allow UPTIME_TIMEOUT_MS per attempt; the
// AbortSignal.timeout on each GET stays on as cooperative cleanup only.
// Racing the headers against a setTimeout guarantees the attempt settles
// within the existing budget even when the transport never resolves and
// ignores abort. Expiry is the existing transport treatment (status 0,
// eligible for the existing retry). A late response gets best-effort inert
// body cleanup without being awaited, and a late rejection is swallowed:
// neither can change the settled verdict, page twice, or surface as an
// unhandled rejection.
async function withProbeDeadline(
  work: Promise<Response>,
  ms = UPTIME_TIMEOUT_MS,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("probe deadline")), ms);
    });
    void work.then(
      () => {},
      () => {},
    );
    return await Promise.race([work, timeout]);
  } catch (error) {
    // The race already settled without this attempt: a late Response still
    // gets inert cleanup, a late rejection stays swallowed, and the settled
    // verdict below never changes. Attached only on the losing path so a
    // winning attempt is still cleaned up exactly once by its caller.
    void work.then(
      (response) => {
        try {
          cleanupResponse(response);
        } catch {
          /* Late cleanup never flips the settled verdict. */
        }
      },
      () => {},
    );
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type UptimeAlert = {
  event: "uptime.down";
  status: number;
  down_seconds: number;
  build_sha?: string;
  version_id?: string;
  timestamp: string;
};

export type SpikeAlert = {
  event: "error.spike";
  script: string;
  build_sha?: string;
  logs: string;
  window_seconds: number;
  requests: number;
  errors: number;
  crashes: number;
  error_rate: number;
  timestamp: string;
};

export type TraceBatch = {
  script: string;
  buildSha?: string;
  at: number;
  requests: number;
  errors: number;
  crashes: number;
};

// Synthetic main-flow checks: the same cron also probes the conversion entry
// and the main public pages, because a healthy /up does not prove members
// can load the site or start Discord sign-in. Every check is an anonymous
// GET with manual redirects: never a login attempt, form post or fault
// injection, and no probe changes application data. The sign-in check
// stops at /login on purpose: the next hop (/auth/discord) mints OAuth
// state, writing a login-redirect throttle hit and an OAuth journey row
// per attempt, so probing it would not stay passive in production. The
// conversion check likewise stops at the /join page: the next hops
// (/join/discord, /join/callback) mint journey state and write throttle
// hits, while the page itself is a persistence-free leaf that writes
// nothing. /events records one rate-limit counter hit (the events-read bucket) per
// admitted attempt, exactly like any anonymous visitor; the existing
// throttle expiry sweep deletes those counters. Expected values were
// verified against staging: /login redirects to /auth/discord on the same
// host. The redirect Location is compared by host/path only and never
// logged, so nothing from its query can reach a page or log line.
export type SyntheticCheck = {
  path: "/" | "/events" | "/join" | "/login";
  status: number;
  contentType?: string;
  locationPath?: string;
};

export const SYNTHETIC_CHECKS: readonly SyntheticCheck[] = [
  { path: "/", status: 200, contentType: "text/html" },
  { path: "/events", status: 200, contentType: "text/html" },
  { path: "/join", status: 200, contentType: "text/html" },
  { path: "/login", status: 302, locationPath: "/auth/discord" },
];

export type SyntheticAlert = {
  event: "synthetic.down";
  check: SyntheticCheck["path"];
  /** Public host of the configured target: identifies the environment. */
  target: string;
  status: number;
  build_sha?: string;
  version_id?: string;
  timestamp: string;
};

// The cron fires every minute for the /up health window; synthetics keep
// their original five-minute cadence (see the scheduled handler), so the
// main-flow probe load does not grow with the faster health loop.
const SYNTHETIC_INTERVAL_MINUTES = 5;

// Only registered templates may leave the account. Never fall back to a raw
// request path, query string, exception, job payload or trace event.request.
export const ALERT_ROUTES = new Set([
  "/",
  "/about",
  "/about.md",
  "/admin",
  "/admin/activity-log",
  "/admin/events",
  "/admin/events/:key",
  "/admin/events/new",
  "/admin/events/:key/cancel",
  "/admin/events/:key/edit",
  "/admin/events/create",
  "/admin/events/:key/publish",
  "/admin/events/:key/rsvp-pause",
  "/admin/events/:key/rsvp-reopen",
  "/admin/featured",
  "/admin/featured/:id",
  "/admin/featured/new",
  "/admin/featured/:id/delete",
  "/admin/featured-contents",
  "/admin/featured-contents/:id/edit",
  "/admin/featured-contents/create",
  "/admin/join-attempts",
  "/admin/join-attempts/:id",
  "/admin/queue/failed/:id/preview",
  "/admin/queue/failed/:id/redispatch",
  "/admin/queue/source-evidence/:id",
  "/api/agent-events",
  "/api/public/community",
  "/api/public/events",
  "/api/public/events/:key",
  "/api/public/join",
  "/auth/discord",
  "/auth/discord/callback",
  "/auth/discord/redirect",
  "/auth/qa/:identity",
  "/auth/recover",
  "/auth/status",
  "/__probe/alert",
  "/csp-reports",
  "/community",
  "/discord",
  "/e/:key",
  "/e/:file{.+\\.md}",
  "/e/:key/rsvp",
  "/events",
  "/events.ics",
  "/events.json",
  "/events.md",
  "/events.rss",
  "/events/:file{.+\\.ics}",
  "/events/past",
  "/events/:key",
  "/events/:key/cancel",
  "/events/:key/publish",
  "/events/:key/rsvp",
  "/events/:key/rsvp-pause",
  "/events/:key/rsvp-reopen",
  "/faq",
  "/faq.md",
  "/hotzones",
  "/hotzones/:signal",
  "/join",
  "/join/callback",
  "/join/discord",
  "/join.md",
  "/leaderboards/members",
  "/llms.txt",
  "/login",
  "/logout",
  "/mcp",
  "/members",
  "/members/",
  "/members/:user",
  "/members/:user/links",
  "/openapi.json",
  "/privacy",
  "/privacy.md",
  "/profile",
  "/profile/links",
  "/.well-known/security.txt",
  "/robots.txt",
  "/rules",
  "/rules.md",
  "/sitemap_index.xml",
  "/up",
]);
const JOB_NAMES = new Set(["SyncEventToDiscord", "CallInternalAction", "AlertProbe"]);
// Allowlisted scheduled-job discriminators for the direct scheduled.failing
// paging signal. Sparse cron invocations can never trip the crash-loop gate
// on their own, so one failed known reconcile/prune run pages directly.
const SCHEDULED_JOBS = new Set(["events:reconcile", "model:prune"]);
// Exception classes only: a database error message can hold bound values,
// SQL, event keys or identities, so anything that is not a bare identifier
// never leaves the account.
const EXCEPTION_CLASS = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type AlertSummary = {
  event: "error.alert" | "queue.failing" | "scheduled.failing";
  fingerprint: string;
  script?: string;
  build_sha?: string;
  logs?: string;
  route?: string;
  job?: string;
  attempts?: number;
  exception?: string;
  timestamp: string;
};

/** Parse exactly the app's single JSON argument; allowlist the outbound fields. */
export async function parseAlert(
  message: unknown,
  timestamp: number,
): Promise<AlertSummary | null> {
  if (typeof message !== "string" || message.length > 16_384 || !Number.isFinite(timestamp))
    return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  let line: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    line = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (line.level !== "critical") return null;
  if (line.event === "error.alert") {
    if (typeof line.fingerprint !== "string" || !line.fingerprint || typeof line.route !== "string")
      return null;
    // Hash even malformed fingerprints: the original can contain a raw path or
    // injected exception text. Operators correlate it with the original trace.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(line.fingerprint),
    );
    const fingerprint = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return {
      event: line.event,
      fingerprint,
      route: ALERT_ROUTES.has(line.route) ? line.route : "[redacted]",
      timestamp: date.toISOString(),
    };
  }
  if (line.event === "queue.failing") {
    if (
      typeof line.job !== "string" ||
      !JOB_NAMES.has(line.job) ||
      !Number.isSafeInteger(line.attempts) ||
      (line.attempts as number) < 1
    )
      return null;
    // exception may be a bot refusal MESSAGE rather than a class; never use it.
    return {
      event: line.event,
      fingerprint: `queue.failing@${line.job}`,
      job: line.job,
      attempts: line.attempts as number,
      timestamp: date.toISOString(),
    };
  }
  if (line.event === "scheduled.failing") {
    // One failed known scheduled run pages directly, without waiting for the
    // aggregate crash-loop gate. Only the allowlisted job discriminator and
    // an identifier-shaped exception class pass; cron text, messages, SQL,
    // event keys and identities are never forwarded.
    if (typeof line.job !== "string" || !SCHEDULED_JOBS.has(line.job)) return null;
    if (
      typeof line.exception !== "string" ||
      line.exception.length > 128 ||
      !EXCEPTION_CLASS.test(line.exception)
    )
      return null;
    return {
      event: line.event,
      fingerprint: `scheduled.failing@${line.job}`,
      job: line.job,
      exception: line.exception,
      timestamp: date.toISOString(),
    };
  }
  return null;
}

// Internal attempt identity for fencing retried results. One UUID per
// admitted spike/health page attempt, persisted with the pending marker and
// carried only on the aggregator wire (never in external alert payloads).
// A result settles only the attempt whose identity it carries.
function newAttemptId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function validAttemptId(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 ? value : undefined;
}

type Bucket = {
  at: number;
  requests: number;
  errors: number;
  crashes: number;
  // Homogeneous validated 40-hex SHA for every counted observation merged
  // into this bucket. Absent when the bucket mixes builds or contains any
  // counted observation with unknown attribution: an untagged or invalid
  // batch, or a restored legacy entry written before provenance existed.
  buildSha?: string;
};
type ScriptState = {
  buckets: Bucket[];
  // Newest event time seen for this script, never rewound by late arrivals.
  // Absent only for an empty legacy snapshot before its first observation.
  windowEndAt?: number;
  cooldownUntil: number;
  // A page attempt is outstanding: set by observe, cleared by resolve. The
  // cooldown arms only when resolve reports a delivered page, mirroring the
  // per-fingerprint mute; an unresolved attempt stops blocking after one
  // cooldown so a crashed delivery cannot mute the alarm forever.
  pendingAt?: number;
  // Fences retried results to the attempt they settle. Restored legacy state
  // has a pendingAt without an identity and still suppresses until age-out.
  pendingAttemptId?: string;
};

function orderSpike(alert: SpikeAlert): SpikeAlert {
  // Fixed field order keeps Discord summaries and receipts diff-stable.
  return {
    event: alert.event,
    script: alert.script,
    ...(alert.build_sha ? { build_sha: alert.build_sha } : {}),
    logs: alert.logs,
    window_seconds: alert.window_seconds,
    requests: alert.requests,
    errors: alert.errors,
    crashes: alert.crashes,
    error_rate: alert.error_rate,
    timestamp: alert.timestamp,
  };
}

/**
 * Rolling per-script counts behind the aggregate alarm. Used inside the
 * AlertAggregator Durable Object (durable, one instance per environment) and
 * directly when no binding is configured (per-isolate best effort).
 */
export class AggregateTracker {
  private readonly scripts = new Map<string, ScriptState>();
  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): Record<string, ScriptState> {
    return Object.fromEntries(
      [...this.scripts].map(([script, state]) => [
        script,
        {
          buckets: state.buckets.map((b) => ({
            at: b.at,
            requests: b.requests,
            errors: b.errors,
            crashes: b.crashes,
            ...(shaFromVersionTag(b.buildSha) ? { buildSha: shaFromVersionTag(b.buildSha)! } : {}),
          })),
          ...(state.windowEndAt !== undefined ? { windowEndAt: state.windowEndAt } : {}),
          cooldownUntil: state.cooldownUntil,
          ...(state.pendingAt !== undefined ? { pendingAt: state.pendingAt } : {}),
          ...(state.pendingAttemptId !== undefined
            ? { pendingAttemptId: state.pendingAttemptId }
            : {}),
        },
      ]),
    );
  }

  /**
   * Replace the whole tracker state with a previously captured snapshot.
   * Unlike restore (which merges into the live map for load), this also drops
   * scripts the snapshot does not contain, so rolling back a failed write
   * cannot leave behind an entry the failed observation created.
   */
  resetTo(value: unknown): void {
    this.scripts.clear();
    this.restore(value);
  }

  restore(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [script, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!APP_SCRIPT_NAMES.has(script) || !raw || typeof raw !== "object") continue;
      const state = raw as Partial<ScriptState>;
      const buckets = Array.isArray(state.buckets)
        ? state.buckets.filter(
            (b): b is Bucket =>
              !!b &&
              typeof b === "object" &&
              [b.at, b.requests, b.errors, b.crashes].every(
                (n) => Number.isSafeInteger(n) && (n as number) >= 0,
              ),
          )
        : [];
      // Batches can arrive out of order, so the same 30s bucket may recur
      // after a different bucket was observed. Merge by bucket time first:
      // trimming raw entries would discard a still-live bucket (for example
      // the crash bucket) while keeping duplicates of later buckets.
      // Provenance merges too: duplicate entries keep a SHA only when every
      // copy carries the same validated SHA. Legacy entries without
      // provenance, and any legacy top-level buildSha, are unknown and
      // ignored — never proof the restored counts came from one build.
      const byAt = new Map<number, Bucket>();
      for (const b of buckets) {
        const sha = shaFromVersionTag((b as Partial<Bucket>).buildSha);
        const existing = byAt.get(b.at);
        if (existing) {
          existing.requests += b.requests;
          existing.errors += b.errors;
          existing.crashes += b.crashes;
          if (existing.buildSha === undefined || sha === undefined || existing.buildSha !== sha) {
            delete existing.buildSha;
          }
        } else if (sha !== undefined) {
          byAt.set(b.at, {
            at: b.at,
            requests: b.requests,
            errors: b.errors,
            crashes: b.crashes,
            buildSha: sha,
          });
        } else {
          byAt.set(b.at, { at: b.at, requests: b.requests, errors: b.errors, crashes: b.crashes });
        }
      }
      const merged = [...byAt.values()].sort((a, b) => a.at - b.at);
      // Legacy writers stored bucket starts, not the newest exact event time.
      // Derive their endpoint from the newest valid bucket, regardless of array
      // order. A saved endpoint cannot trail retained counts; an empty legacy
      // snapshot leaves it unset until the first observation. Keep compatible
      // pending/cooldown markers and unknown legacy provenance intact.
      const newestBucketAt = merged.at(-1)?.at;
      const savedEndAt =
        Number.isSafeInteger(state.windowEndAt) && state.windowEndAt! >= 0
          ? state.windowEndAt
          : undefined;
      const windowEndAt =
        savedEndAt === undefined
          ? newestBucketAt
          : Math.max(savedEndAt, newestBucketAt ?? savedEndAt);
      this.scripts.set(script, {
        buckets: merged
          .filter(
            (b) => windowEndAt === undefined || b.at + BUCKET_MS > windowEndAt - SPIKE_WINDOW_MS,
          )
          .slice(-MAX_BUCKETS),
        ...(windowEndAt !== undefined ? { windowEndAt } : {}),
        cooldownUntil: Number.isSafeInteger(state.cooldownUntil) ? state.cooldownUntil! : 0,
        pendingAt: Number.isSafeInteger(state.pendingAt) ? state.pendingAt : undefined,
        pendingAttemptId: validAttemptId(state.pendingAttemptId),
      });
    }
  }

  // Identity of the current pending spike attempt for one script, if any.
  // Direct observe() callers keep the long-standing plain alert shape; the
  // fencing identity travels via this accessor (local) and the aggregator
  // wire (Durable Object), never in external alert payloads.
  pendingAttemptId(script: string): string | null {
    const state = this.scripts.get(script);
    return state?.pendingAt !== undefined && state.pendingAttemptId !== undefined
      ? state.pendingAttemptId
      : null;
  }

  observe(batch: TraceBatch): SpikeAlert | null {
    if (!APP_SCRIPT_NAMES.has(batch.script)) return null;
    const at = Number.isFinite(batch.at) ? batch.at : this.now();
    let state = this.scripts.get(batch.script);
    if (!state) {
      state = { buckets: [], cooldownUntil: 0 };
      this.scripts.set(batch.script, state);
    }
    state.windowEndAt = Math.max(state.windowEndAt ?? at, at);
    const cutoff = state.windowEndAt - SPIKE_WINDOW_MS;
    state.buckets = state.buckets.filter((b) => b.at + BUCKET_MS > cutoff);
    const bucketAt = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    // Expired arrivals are no-ops, before insertion, attribution or paging:
    // they cannot fill the cap, evict live counts or retry an expired window.
    // Equal timestamps and older buckets still overlapping the cutoff add.
    if (bucketAt + BUCKET_MS <= cutoff) return null;
    // Provenance is per bucket, not per latest batch: a bucket keeps its
    // SHA only while every counted observation merged into it shares one
    // validated SHA. An untagged or invalid batch, or a second validated
    // build in the same 30-second bucket, clears that bucket to unknown.
    // A batch contributing no counts never changes provenance.
    const incomingSha = shaFromVersionTag(batch.buildSha);
    const incomingCounts = batch.requests + batch.errors + batch.crashes;
    // The same bucket time can recur after a different bucket was observed,
    // so coalesce by bucket time rather than reusing only the last bucket.
    // Otherwise each revisit appends a duplicate entry and the bucket cap
    // evicts still-live in-window counts.
    let bucket = state.buckets.find((b) => b.at === bucketAt);
    if (!bucket) {
      bucket = { at: bucketAt, requests: 0, errors: 0, crashes: 0 };
      state.buckets.push(bucket);
      state.buckets.sort((a, b) => a.at - b.at);
      if (state.buckets.length > MAX_BUCKETS)
        state.buckets.splice(0, state.buckets.length - MAX_BUCKETS);
    }
    if (incomingCounts > 0) {
      const priorCounts = bucket.requests + bucket.errors + bucket.crashes;
      if (priorCounts === 0) {
        if (incomingSha !== undefined) bucket.buildSha = incomingSha;
        else delete bucket.buildSha;
      } else if (
        bucket.buildSha === undefined ||
        incomingSha === undefined ||
        bucket.buildSha !== incomingSha
      ) {
        delete bucket.buildSha;
      }
    }
    bucket.requests += batch.requests;
    bucket.errors += batch.errors;
    bucket.crashes += batch.crashes;
    if (at < state.cooldownUntil) return null;
    let requests = 0;
    let errors = 0;
    let crashes = 0;
    // The page counts every trace in the window whatever build produced it;
    // the SHA is emitted only when every counted bucket in the window
    // carries the same validated SHA. Mixed builds, or any counted bucket
    // with unknown attribution (including restored legacy buckets), page
    // with no build_sha rather than blaming the latest build.
    let windowSha: string | undefined;
    let windowMixed = false;
    for (const b of state.buckets) {
      requests += b.requests;
      errors += b.errors;
      crashes += b.crashes;
      if (b.requests + b.errors + b.crashes === 0) continue;
      if (b.buildSha === undefined) windowMixed = true;
      else if (windowSha === undefined) windowSha = b.buildSha;
      else if (windowSha !== b.buildSha) windowMixed = true;
    }
    if (windowMixed) windowSha = undefined;
    const rateGate =
      errors >= SPIKE_MIN_ERRORS && requests > 0 && errors / requests >= SPIKE_MIN_RATE;
    const crashGate = crashes >= SPIKE_MIN_CRASHES;
    if (!rateGate && !crashGate) return null;
    if (state.pendingAt !== undefined && at - state.pendingAt < SPIKE_COOLDOWN_MS) return null;
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) return null;
    state.pendingAt = at;
    state.pendingAttemptId = newAttemptId();
    return orderSpike({
      event: "error.spike",
      script: batch.script,
      ...(windowSha ? { build_sha: windowSha } : {}),
      logs: logsPath(batch.script),
      window_seconds: SPIKE_WINDOW_MS / 1000,
      requests,
      errors,
      crashes,
      error_rate: requests > 0 ? Math.round((errors / requests) * 1000) / 1000 : 0,
      timestamp: date.toISOString(),
    });
  }

  /**
   * Settle one pending spike attempt. A result carrying an attempt identity
   * settles only that attempt: a duplicate or stale retry never clears, nor
   * arms a cooldown for, a newer attempt. A result without an identity is a
   * legacy caller and still settles any pending attempt; stored legacy state
   * without an identity is settled by any result so upgrades keep retrying.
   */
  resolve(script: string, delivered: boolean, attemptId?: unknown): void {
    const state = this.scripts.get(script);
    if (!state || state.pendingAt === undefined) return;
    const resultId = validAttemptId(attemptId);
    if (resultId !== undefined && state.pendingAttemptId !== undefined) {
      if (resultId !== state.pendingAttemptId) return;
    }
    if (delivered) state.cooldownUntil = state.pendingAt + SPIKE_COOLDOWN_MS;
    state.pendingAt = undefined;
    state.pendingAttemptId = undefined;
  }
}

/** Continuous-red health window: pages only after HEALTH_DOWN_MS, then cools down. */
export class HealthTracker {
  private downSince: number | null = null;
  private cooldownUntil = 0;
  private pendingAt: number | null = null;
  // Fences retried results to the attempt they settle; see AggregateTracker.
  private pendingAttemptId: string | undefined;
  // Monotonic source-observation watermark: the newest source timestamp
  // applied so far. A delayed observation stamped strictly older than this
  // is ignored before it can clear a newer outage (or its pending page) or
  // resurrect an outage a newer healthy sample already cleared. Equal
  // timestamps are not strictly older, so same-time duplicates and retries
  // still take effect.
  private lastObservedAt: number | null = null;
  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): {
    downSince: number | null;
    cooldownUntil: number;
    pendingAt: number | null;
    pendingAttemptId?: string;
    lastObservedAt: number | null;
  } {
    return {
      downSince: this.downSince,
      cooldownUntil: this.cooldownUntil,
      pendingAt: this.pendingAt,
      ...(this.pendingAttemptId !== undefined ? { pendingAttemptId: this.pendingAttemptId } : {}),
      lastObservedAt: this.lastObservedAt,
    };
  }

  restore(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const state = value as {
      downSince?: unknown;
      cooldownUntil?: unknown;
      pendingAt?: unknown;
      pendingAttemptId?: unknown;
      lastObservedAt?: unknown;
    };
    this.downSince = Number.isSafeInteger(state.downSince) ? (state.downSince as number) : null;
    this.cooldownUntil = Number.isSafeInteger(state.cooldownUntil)
      ? (state.cooldownUntil as number)
      : 0;
    this.pendingAt = Number.isSafeInteger(state.pendingAt) ? (state.pendingAt as number) : null;
    this.pendingAttemptId = validAttemptId(state.pendingAttemptId);
    // Legacy snapshots predate the watermark: they load safely with it unset,
    // and the first accepted observation after the restore establishes it.
    this.lastObservedAt = Number.isSafeInteger(state.lastObservedAt)
      ? (state.lastObservedAt as number)
      : null;
  }

  /** Identity of the current pending health attempt, if any. */
  pendingAttempt(): string | null {
    return this.pendingAt !== null && this.pendingAttemptId !== undefined
      ? this.pendingAttemptId
      : null;
  }

  /** Returns how long health has been red when a page is due, else null. */
  observe(ok: boolean, at = this.now()): number | null {
    // Fence observation ordering, not arrival order: a strictly older sample
    // is a successful no-op (null, nothing mutated) so it can neither clear
    // a newer outage/pending page nor resurrect a cleared window.
    if (this.lastObservedAt !== null && at < this.lastObservedAt) return null;
    this.lastObservedAt = at;
    if (ok) {
      this.downSince = null;
      this.pendingAt = null;
      this.pendingAttemptId = undefined;
      return null;
    }
    if (this.downSince === null) this.downSince = at;
    // A page attempt is awaiting its result; a lost result ages out after one
    // cooldown (same bound as the spike pending) instead of wedging the alarm.
    if (this.pendingAt !== null && at - this.pendingAt < HEALTH_COOLDOWN_MS) return null;
    this.pendingAt = null;
    this.pendingAttemptId = undefined;
    const downMs = at - this.downSince;
    // Strictly over two minutes: exactly HEALTH_DOWN_MS red does not page yet.
    if (downMs <= HEALTH_DOWN_MS || at < this.cooldownUntil) return null;
    this.pendingAt = at;
    this.pendingAttemptId = newAttemptId();
    return downMs;
  }

  /** Arm the cooldown only for a delivered page; a failed POST re-pages next run. */
  resolve(delivered: boolean, attemptId?: unknown): void {
    const resultId = validAttemptId(attemptId);
    if (resultId !== undefined && this.pendingAttemptId !== undefined) {
      if (resultId !== this.pendingAttemptId) return;
    }
    if (delivered && this.pendingAt !== null) {
      this.cooldownUntil = this.pendingAt + HEALTH_COOLDOWN_MS;
    }
    this.pendingAt = null;
    this.pendingAttemptId = undefined;
  }
}

function isFetchTrace(event: unknown): event is TraceItemFetchEventInfo {
  return !!event && typeof event === "object" && "request" in (event as Record<string, unknown>);
}

type TraceLike = Pick<TraceItem, "scriptName" | "logs"> &
  Partial<Pick<TraceItem, "scriptVersion" | "outcome" | "exceptions" | "event" | "eventTimestamp">>;

// Tail outcomes that mean the invocation died before it could log an alert
// line: an unhandled exception, a CPU/memory limit kill (error 1102 to the
// client, no response), or a missing script. The client-disconnect outcomes
// ("canceled", "responseStreamDisconnected") are deliberately not crashes.
// https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/
const CRASH_OUTCOMES: ReadonlySet<string> = new Set([
  "exception",
  "exceededCpu",
  "exceededMemory",
  "scriptNotFound",
]);

/** Count one trace without ever reading its request URL, headers or exception text. */
function batchForTrace(trace: TraceLike, fallbackAt: number): TraceBatch | null {
  if (!trace.scriptName || !APP_SCRIPT_NAMES.has(trace.scriptName)) return null;
  const crashes =
    (typeof trace.outcome === "string" && CRASH_OUTCOMES.has(trace.outcome)) ||
    (Array.isArray(trace.exceptions) && trace.exceptions.length > 0)
      ? 1
      : 0;
  let requests = 0;
  let errors = 0;
  if (isFetchTrace(trace.event)) {
    requests = 1;
    const status = trace.event.response?.status;
    if (crashes > 0 || (typeof status === "number" && status >= 500)) errors = 1;
  }
  const at =
    typeof trace.eventTimestamp === "number" && Number.isFinite(trace.eventTimestamp)
      ? trace.eventTimestamp
      : fallbackAt;
  const buildSha = traceBuildSha(trace);
  return {
    script: trace.scriptName,
    ...(buildSha ? { buildSha } : {}),
    at,
    requests,
    errors,
    crashes,
  };
}

// Future-skew slack bound: a wire batch stamped beyond now plus
// BATCH_FUTURE_SLACK_MS is rejected (null -> 400) so it can neither wipe
// in-window buckets nor future-date an alert or pending/cooldown marker.
// Merely-late batches (stamped in the past) are allowed and still count
// when inside the rolling window; a one-bucket (+30s) skew is within the
// slack and also counts.
function validBatch(value: unknown): TraceBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  if (typeof b.script !== "string" || !APP_SCRIPT_NAMES.has(b.script)) return null;
  if (
    ![b.at, b.requests, b.errors, b.crashes].every(
      (n) => Number.isSafeInteger(n) && (n as number) >= 0,
    )
  )
    return null;
  if ((b.errors as number) > (b.requests as number) + (b.crashes as number)) return null;
  if ((b.at as number) > Date.now() + BATCH_FUTURE_SLACK_MS) return null;
  const buildSha = shaFromVersionTag(b.buildSha);
  return {
    script: b.script,
    ...(buildSha ? { buildSha } : {}),
    at: b.at as number,
    requests: b.requests as number,
    errors: b.errors as number,
    crashes: b.crashes as number,
  };
}

// Skew-vs-malformed classifier for the /observe 400: true only for a batch
// that would have counted but for its stamp. Every structural check mirrors
// validBatch exactly, so a batch that is both malformed and future-stamped
// (unknown script, bad counts, missing timestamp) reads as malformed, never
// skew. Drop semantics and the slack bound live in validBatch; this function
// only names the rejection reason for the log line.
function isFutureSkewedBatch(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  if (typeof b.script !== "string" || !APP_SCRIPT_NAMES.has(b.script)) return false;
  if (
    ![b.at, b.requests, b.errors, b.crashes].every(
      (n) => Number.isSafeInteger(n) && (n as number) >= 0,
    )
  )
    return false;
  if ((b.errors as number) > (b.requests as number) + (b.crashes as number)) return false;
  return (b.at as number) > Date.now() + BATCH_FUTURE_SLACK_MS;
}

/**
 * Durable aggregate state: one instance per Tail Worker environment keeps the
 * rolling counts and the health window across isolate churn. Storage holds
 * only counts, timestamps and an allowlisted build SHA — never request data.
 */
export class AlertAggregator {
  private readonly tracker = new AggregateTracker();
  private readonly health = new HealthTracker();
  private loaded: Promise<void> | undefined;
  // Serializes mutating requests within one instance. Each observe/resolve
  // mutates its tracker before its storage.put lands; without ordering, a
  // late put rejection could roll back over a concurrent successful update
  // (or interleave with one), stranding or duplicating alert state. The
  // chain survives individual failures so one rejected write never wedges
  // later requests.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState) {}

  private load(): Promise<void> {
    if (!this.loaded) {
      const attempt = this.loadOnce();
      this.loaded = attempt;
      // A rejected initial load must not wedge the instance: clear the
      // cached promise so a later request retries once storage is healthy.
      // Concurrent holders keep `attempt`, so one recovery load stays
      // single-flight; the identity guard never clears a newer attempt.
      // A resolved load stays cached: success remains single-flight.
      void attempt.catch(() => {
        if (this.loaded === attempt) this.loaded = undefined;
      });
    }
    return this.loaded;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadOnce(): Promise<void> {
    // Read both keys before restoring either: a rejected second read must
    // not leave half-restored scripts state applied (or applied twice on
    // recovery), and a failed load must not reach a snapshot write.
    const scripts = await this.state.storage.get("scripts");
    const health = await this.state.storage.get("health");
    this.tracker.restore(scripts);
    this.health.restore(health);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (
      request.method !== "POST" ||
      !["/observe", "/health", "/spike-result", "/health-result"].includes(pathname)
    ) {
      return new Response(null, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // Unparseable body: malformed, never skew. No payload bytes in the line.
      console.warn("tail observe rejected malformed batch: invalid body");
      return new Response(null, { status: 400 });
    }
    await this.load();
    if (pathname === "/observe") {
      const batch = validBatch(body);
      if (!batch) {
        // Status stays 400 either way; the line names the reason so
        // operators can tell clock skew from payload corruption.
        if (isFutureSkewedBatch(body)) {
          console.warn("tail observe rejected future-skewed batch: timestamp beyond slack");
        } else {
          console.warn("tail observe rejected malformed batch: invalid payload");
        }
        return new Response(null, { status: 400 });
      }
      return this.enqueue(async () => {
        // Deep-clone: snapshot() shares its bucket arrays with the live
        // tracker, so an alias would observe the very mutation it must undo.
        const prior = structuredClone(this.tracker.snapshot());
        const alert = this.tracker.observe(batch);
        try {
          await this.state.storage.put("scripts", this.tracker.snapshot());
        } catch (error) {
          // The write never landed, so the mutation must not become visible:
          // a retained pending marker would suppress a recovered observation
          // until expiry and retained counts would diverge from the snapshot
          // a fresh instance restores. Rethrow so the caller takes its
          // documented local fallback instead of reading a false success.
          this.tracker.resetTo(prior);
          throw error;
        }
        if (alert === null) return Response.json(null);
        const attemptId = this.tracker.pendingAttemptId(batch.script);
        return Response.json(attemptId ? { ...alert, attemptId } : alert);
      });
    }
    if (pathname === "/spike-result") {
      const result = body as { script?: unknown; delivered?: unknown; attemptId?: unknown };
      if (
        typeof result?.script !== "string" ||
        !APP_SCRIPT_NAMES.has(result.script) ||
        typeof result.delivered !== "boolean" ||
        (result.attemptId !== undefined &&
          result.attemptId !== null &&
          validAttemptId(result.attemptId) === undefined)
      ) {
        return new Response(null, { status: 400 });
      }
      // Capture narrowed fields before the closure: property narrowing does
      // not carry into the queued callback.
      const script = result.script;
      const delivered = result.delivered;
      const attemptId = result.attemptId;
      return this.enqueue(async () => {
        this.tracker.resolve(script, delivered, attemptId);
        await this.state.storage.put("scripts", this.tracker.snapshot());
        return Response.json(null);
      });
    }
    if (pathname === "/health-result") {
      const result = body as { delivered?: unknown; attemptId?: unknown };
      if (
        typeof result?.delivered !== "boolean" ||
        (result.attemptId !== undefined &&
          result.attemptId !== null &&
          validAttemptId(result.attemptId) === undefined)
      ) {
        return new Response(null, { status: 400 });
      }
      const delivered = result.delivered;
      const attemptId = result.attemptId;
      return this.enqueue(async () => {
        this.health.resolve(delivered, attemptId);
        await this.state.storage.put("health", this.health.snapshot());
        return Response.json(null);
      });
    }
    const probe = body as { ok?: unknown; at?: unknown };
    if (typeof probe?.ok !== "boolean" || !Number.isSafeInteger(probe.at)) {
      return new Response(null, { status: 400 });
    }
    const ok = probe.ok;
    const at = probe.at as number;
    return this.enqueue(async () => {
      const prior = structuredClone(this.health.snapshot());
      const downMs = this.health.observe(ok, at);
      // A stale observation changes nothing (every mutated field is part of
      // the snapshot), so there is nothing to publish: skip the write and
      // answer success instead of persisting an identical value.
      if (JSON.stringify(this.health.snapshot()) === JSON.stringify(prior)) {
        return Response.json(null);
      }
      try {
        await this.state.storage.put("health", this.health.snapshot());
      } catch (error) {
        // Same contract as /observe: an unpersisted health mutation must not
        // leak into this instance (a stranded window or pending page would
        // suppress or restart the outage window). HealthTracker.restore
        // overwrites every field, so no key cleanup is needed here.
        this.health.restore(prior);
        throw error;
      }
      if (downMs === null) return Response.json(null);
      return Response.json({ downMs, attemptId: this.health.pendingAttempt() });
    });
  }
}

/** Bounded, per-isolate five-minute mute. Failed deliveries can be attempted again. */
export class DeliveryMute {
  private readonly sent = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  begin(key: string, sourceTimestamp = this.now()): boolean {
    const t = sourceTimestamp;
    if (this.pending.has(key) || t - (this.sent.get(key) ?? -Infinity) < MUTE_MS) return false;
    for (const [k, at] of this.sent) if (t - at >= MUTE_MS) this.sent.delete(k);
    if (this.pending.size >= MAX_TRACKED) return false;
    this.pending.set(key, t);
    return true;
  }
  finish(key: string, delivered: boolean): void {
    const at = this.pending.get(key);
    this.pending.delete(key);
    if (!delivered || at === undefined) return;
    if (this.sent.size >= MAX_TRACKED) this.sent.delete(this.sent.keys().next().value!);
    // Anchor to the source log, not delivery completion or Tail arrival latency.
    this.sent.set(key, at);
  }
}

function receiptProbeId(message: string, alert: AlertSummary): string | undefined {
  const line = JSON.parse(message) as Record<string, unknown>; // Already validated by parseAlert.
  const synthetic =
    (alert.event === "error.alert" &&
      alert.route === "/__probe/alert" &&
      line.fingerprint === "AlertProbeError@/__probe/alert") ||
    (alert.event === "queue.failing" && alert.job === "AlertProbe");
  return synthetic && validProbeId(line.probeId) ? line.probeId : undefined;
}

function webhookUrl(secret: string | undefined): URL | null {
  if (!secret) return null;
  try {
    const url = new URL(secret);
    // Fail closed on non-Discord destinations, credentials, redirects and ports.
    if (
      url.protocol !== "https:" ||
      url.hostname !== "discord.com" ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      return null;
    url.hash = "";
    url.search = "?wait=true";
    return url;
  } catch {
    return null;
  }
}

type Sink = (line: string) => void;

export function createTailWorker(
  opts: {
    fetch?: typeof fetch;
    mute?: DeliveryMute;
    sink?: Sink;
    sleep?: (ms: number) => Promise<void>;
    tracker?: AggregateTracker;
    health?: HealthTracker;
    now?: () => number;
  } = {},
) {
  const now = opts.now ?? Date.now;
  const mute = opts.mute ?? new DeliveryMute(now);
  const send = opts.fetch ?? fetch;
  const sink = opts.sink ?? ((line: string) => console.log(line));
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tracker = opts.tracker ?? new AggregateTracker(now);
  const health = opts.health ?? new HealthTracker(now);

  async function deliver(url: URL, summary: object): Promise<boolean> {
    try {
      // wait=true confirms message persistence; disable all mentions.
      // https://docs.discord.com/developers/resources/webhook#execute-webhook
      const response = await withDeliveryDeadline(
        send(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: JSON.stringify(summary),
            allowed_mentions: { parse: [] },
          }),
          redirect: "manual", // Workers fetch rejects "error"; a 3xx is never ok, so it fails closed.
          signal: AbortSignal.timeout(5000),
        }),
      );
      const ok = response.ok;
      cleanupResponse(response); // Never read/log the message or credential-bearing error response.
      return ok;
    } catch {
      /* Transport/timeout: do not log the URL or exception. */
      return false;
    }
  }

  function aggregator(env: TailEnv): DurableObjectStub | null {
    try {
      return env.ALERT_AGGREGATOR?.get(env.ALERT_AGGREGATOR.idFromName("alerts")) ?? null;
    } catch {
      return null;
    }
  }

  type ObservationSource = "aggregator" | "local";
  type SpikeObservation = SpikeAlert & { attemptId?: string; source: ObservationSource };

  // Visibility for a malfunctioning aggregator: one classified console line
  // per fallback (non-OK, unparseable, wrong-shape 200 on spike/observe and
  // health). Console, not the sink: sink lines are delivery receipts and
  // exact-receipt assertions pin them. Only fixed tokens plus a numeric
  // status: never payload bytes, the webhook credential, the trace token,
  // or the internal aggregator URL. Thrown/stalled operations stay silent
  // (deliberately unpinned) so stall coverage keeps its exact shape.
  type AggregatorFallbackClass = "non-ok" | "unparseable" | "wrong-shape";
  function warnAggregatorFallback(
    path: "spike" | "health",
    failure: AggregatorFallbackClass,
    status?: number,
  ): void {
    try {
      console.warn(
        JSON.stringify({
          event: "aggregator.fallback",
          path,
          fallback: "aggregator-fallback",
          reason:
            failure === "non-ok"
              ? "non-ok-status"
              : failure === "unparseable"
                ? "unparseable-json"
                : "wrong-shape",
          ...(status !== undefined ? { status } : {}),
        }),
      );
    } catch {
      /* Diagnostics never throw. */
    }
  }
  function normalizeSpikeObservation(value: unknown): SpikeObservation | null {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown> & SpikeAlert;
    if (record.event !== "error.spike" || typeof record.script !== "string") return null;
    // A verdict built from a non-finite, negative, or mistyped count would
    // page garbage while the local tracker never counts the burst: every
    // numeric field the alert is built from must be a finite, non-negative
    // number, otherwise the observation is malformed and falls back.
    for (const field of [
      "requests",
      "errors",
      "crashes",
      "error_rate",
      "window_seconds",
    ] as const) {
      const fieldValue = record[field];
      if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0)
        return null;
    }
    const attemptId = validAttemptId((record as { attemptId?: unknown }).attemptId);
    return {
      ...(record as SpikeAlert),
      ...(attemptId ? { attemptId } : {}),
      source: "aggregator",
    };
  }

  async function observeBatch(env: TailEnv, batch: TraceBatch): Promise<SpikeObservation | null> {
    const localObserve = (): SpikeObservation | null => {
      const alert = tracker.observe(batch);
      if (alert === null) return null;
      const attemptId = tracker.pendingAttemptId(batch.script);
      return attemptId ? { ...alert, attemptId, source: "local" } : { ...alert, source: "local" };
    };
    const stub = aggregator(env);
    if (!stub) return localObserve();
    try {
      // One independent deadline covers request plus body parsing: headers
      // followed by a stalled JSON body expire as a single operation.
      type ObserveOutcome =
        | { fallback: true; failure: AggregatorFallbackClass; status?: number }
        | { data: SpikeObservation | null };
      const operation: Promise<ObserveOutcome> = (async () => {
        const response = await stub.fetch("https://aggregator.invalid/observe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS),
        });
        if (!response.ok)
          return { fallback: true as const, failure: "non-ok" as const, status: response.status };
        let raw: unknown;
        try {
          raw = await response.json();
        } catch (error) {
          // Only malformed JSON warns: a body stream error, dropped
          // connection, or abort/timeout mid-body rethrows to the silent
          // outer fallback so on-call chases latency/resets, not parsing.
          if (!(error instanceof SyntaxError)) throw error;
          return { fallback: true as const, failure: "unparseable" as const };
        }
        const spike = normalizeSpikeObservation(raw);
        // A 200 that parses to anything other than null or a valid spike
        // alert is a malfunctioning aggregator: fall back to local counts so
        // it can never suppress the spike page.
        if (raw !== null && spike === null)
          return { fallback: true as const, failure: "wrong-shape" as const };
        return { data: spike };
      })();
      const result = await withAggregatorDeadline(operation);
      if ("fallback" in result) {
        warnAggregatorFallback(
          "spike",
          result.failure,
          "status" in result ? result.status : undefined,
        );
        return localObserve();
      }
      return result.data;
    } catch {
      // Aggregation is additive: a broken binding falls back to local counts
      // and must never suppress the per-fingerprint pager.
      return localObserve();
    }
  }

  // Result calls clear the Durable Object's pending marker; a lost result
  // would suppress the next due page until the marker ages out, so a thrown
  // or non-ok attempt gets exactly one retry. Resolving twice is a no-op.
  async function postAggregatorResult(
    stub: DurableObjectStub,
    path: string,
    body: unknown,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Each attempt has its own settlement deadline, so a stalled
        // acknowledgement still makes exactly one retry and the total wait
        // stays finite. A late loser is ignored and cannot change the
        // settled caller result.
        const response = await withAggregatorDeadline(
          stub.fetch(`https://aggregator.invalid${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS),
          }),
        );
        if (response.ok) return;
      } catch {
        /* Fall through to the single retry, then give up. */
      }
    }
  }

  async function resolveSpike(
    env: TailEnv,
    script: string,
    delivered: boolean,
    attemptId?: string,
    source?: ObservationSource,
  ): Promise<void> {
    const stub = aggregator(env);
    if (!stub) return tracker.resolve(script, delivered, attemptId);
    // A locally-originated page never matches the DO's pending attempt, so it
    // posts without an identity: an applied-but-unacknowledged DO attempt
    // still settles (legacy settle-any) instead of suppressing the failed
    // delivery's retry for a full cooldown. The local tracker settles with
    // its own identity.
    await postAggregatorResult(
      stub,
      "/spike-result",
      source === "local" ? { script, delivered } : { script, delivered, attemptId },
    );
    // Resolve locally too, whatever the aggregator answered: the observation
    // may have fallen back to this tracker while the result call recovered,
    // and a leftover local pending would suppress a failed delivery's retry.
    tracker.resolve(script, delivered, attemptId);
  }

  async function resolveHealth(
    env: TailEnv,
    delivered: boolean,
    attemptId?: string | null,
    source?: ObservationSource,
  ): Promise<void> {
    const stub = aggregator(env);
    if (!stub) return health.resolve(delivered, attemptId ?? undefined);
    await postAggregatorResult(
      stub,
      "/health-result",
      source === "local" ? { delivered } : { delivered, attemptId },
    );
    health.resolve(delivered, attemptId ?? undefined);
  }

  async function observeHealth(
    env: TailEnv,
    ok: boolean,
    at: number,
  ): Promise<{ downMs: number | null; attemptId: string | null; source: ObservationSource }> {
    const local = (): {
      downMs: number | null;
      attemptId: string | null;
      source: ObservationSource;
    } => {
      const downMs = health.observe(ok, at);
      return {
        downMs,
        attemptId: downMs === null ? null : health.pendingAttempt(),
        source: "local",
      };
    };
    const stub = aggregator(env);
    if (!stub) return local();
    try {
      // One independent deadline covers request plus body parsing, matching
      // observeBatch: expiry takes the existing local fallback.
      type HealthOutcome =
        | { fallback: true; failure: AggregatorFallbackClass; status?: number }
        | { downMs: number | null; attemptId: string | null; source: "aggregator" };
      const operation: Promise<HealthOutcome> = (async () => {
        const response = await stub.fetch("https://aggregator.invalid/health", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok, at }),
          signal: AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS),
        });
        if (!response.ok)
          return { fallback: true as const, failure: "non-ok" as const, status: response.status };
        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          // Same contract as the spike path: only SyntaxError is
          // unparseable; stream/abort failures stay silent.
          if (!(error instanceof SyntaxError)) throw error;
          return { fallback: true as const, failure: "unparseable" as const };
        }
        // Well-formed answers are exactly null or an object with a numeric
        // downMs. Anything else on a 200 is a malfunctioning aggregator:
        // fall back to the local health observation so it can never suppress
        // the uptime page.
        if (data === null) return { downMs: null, attemptId: null, source: "aggregator" as const };
        if (typeof data !== "object" || data === null || Array.isArray(data))
          return { fallback: true as const, failure: "wrong-shape" as const };
        const { downMs, attemptId } = data as { downMs?: unknown; attemptId?: unknown };
        // typeof NaN === "number", so a shape check alone waves NaN,
        // ±Infinity, and negative durations through as authoritative and
        // pages a garbage down_seconds. Only a finite, non-negative downMs
        // is well-formed; anything else falls back to the local health
        // observation.
        if (typeof downMs !== "number" || !Number.isFinite(downMs) || downMs < 0)
          return { fallback: true as const, failure: "wrong-shape" as const };
        return {
          downMs,
          attemptId: validAttemptId(attemptId) ?? null,
          source: "aggregator" as const,
        };
      })();
      const result = await withAggregatorDeadline(operation);
      if ("fallback" in result) {
        warnAggregatorFallback(
          "health",
          result.failure,
          "status" in result ? result.status : undefined,
        );
        return local();
      }
      // A healthy probe handled durably still ends the local red window:
      // without this, a fallback-red / aggregator-healthy / fallback-red
      // sequence pages as continuous red from the first run. Healthy
      // answers JSON null, so this covers the no-number branch too.
      if (ok) health.observe(true, at);
      return result;
    } catch {
      return local();
    }
  }

  /**
   * Read the already-fetched /up body for the public revision marker only.
   * Stops at ATTRIBUTION_READ_CAP so a corrupt or hostile body cannot buffer
   * unboundedly; a stalled stream simply never resolves and the caller's
   * independent deadline wins. Returns "" when the body is unavailable, so
   * the caller yields absent attribution, never a throw. Never logs.
   */
  async function readAttributionBody(response: Response): Promise<string> {
    if (typeof response.text !== "function") return "";
    const stream = response.body;
    if (!stream || typeof stream.getReader !== "function") return response.text();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          text += decoder.decode(value, { stream: true });
          if (text.length > ATTRIBUTION_READ_CAP) return "";
        }
      }
      text += decoder.decode();
      return text;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* A pending stalled read stays pending with the stream; the caller's independent deadline wins. */
      }
    }
  }

  /** One bounded /up probe. Transport errors and timeouts are status 0. */
  async function probeOnce(target: string): Promise<{
    ok: boolean;
    status: number;
    attribution: UpAttribution;
  }> {
    try {
      const response = await withProbeDeadline(
        send(target, {
          method: "GET",
          redirect: "manual", // Workers fetch rejects "error"; a 3xx is never ok, so it fails closed.
          signal: AbortSignal.timeout(UPTIME_TIMEOUT_MS),
        }),
        UPTIME_TIMEOUT_MS,
      );
      const ok =
        response.status === 200 && response.headers.get("x-two-origin") === EXPECTED_ORIGIN;
      // Read the already-fetched body for the public revision marker only.
      // No extra fetch: health still depends on status + origin alone, and an
      // unreadable body yields absent attribution, never a throw. The read
      // races an independent setTimeout deadline (not the cooperative fetch
      // signal), so a body that stalls after its headers cannot stall the
      // scheduled run. Cleanup stays inert (see #1095): its outcome can
      // never flip this verdict.
      let attribution: UpAttribution = {};
      try {
        attribution = await withDeliveryDeadline(
          readAttributionBody(response).then(upAttributionFromBody),
          ATTRIBUTION_TIMEOUT_MS,
        );
      } catch {
        attribution = {};
      }
      cleanupResponse(response); // Never read or log beyond the marker; cleanup stays inert.
      return { ok, status: response.status, attribution };
    } catch {
      return { ok: false, status: 0, attribution: {} };
    }
  }

  /** One bounded synthetic probe. Transport errors and timeouts are status 0. */
  async function probeCheck(
    base: URL,
    check: SyntheticCheck,
  ): Promise<{ ok: boolean; status: number }> {
    try {
      const response = await withProbeDeadline(
        send(new URL(check.path, base).toString(), {
          method: "GET",
          redirect: "manual", // Never follow into Discord or a login flow.
          signal: AbortSignal.timeout(UPTIME_TIMEOUT_MS),
        }),
        UPTIME_TIMEOUT_MS,
      );
      let ok = response.status === check.status;
      if (ok && check.contentType) {
        ok = (response.headers.get("content-type") ?? "").startsWith(check.contentType);
      }
      if (ok && check.locationPath) {
        // Compare host/path only; any Location query is discarded here and
        // never reaches a log line or the webhook. The one redirect check
        // (/login) must stay on the probed host.
        const location = response.headers.get("location");
        let target: URL | null = null;
        try {
          target = location ? new URL(location, base) : null;
        } catch {
          target = null;
        }
        ok = target !== null && target.pathname === check.locationPath && target.host === base.host;
      }
      cleanupResponse(response); // Never read or log the body; cleanup stays inert.
      return { ok, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /** Deliver one scheduled-prober page through the shared mute + receipt. */
  async function deliverScheduled(
    url: URL,
    alert: UptimeAlert | SyntheticAlert,
    key: string,
  ): Promise<void> {
    if (!mute.begin(key)) return;
    let delivered = false;
    try {
      const response = await withDeliveryDeadline(
        send(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: JSON.stringify(alert),
            allowed_mentions: { parse: [] },
          }),
          redirect: "manual", // Workers fetch rejects "error"; a 3xx is never ok, so it fails closed.
          signal: AbortSignal.timeout(5000),
        }),
      );
      delivered = response.ok;
      cleanupResponse(response);
    } catch {
      /* Transport/timeout: do not log the URL or exception. */
    } finally {
      mute.finish(key, delivered);
    }
    sink(
      JSON.stringify({
        ...alert,
        delivery: delivered ? "ops.alert.delivered" : "ops.alert.delivery_failed",
      }),
    );
  }

  /**
   * Probe every synthetic check once; re-probe only the failures after the
   * retry delay and page each check that still fails. The base origin comes
   * from the configured UPTIME_URL, so staging and production each probe
   * their own public host with no extra configuration.
   */
  async function runSynthetics(
    url: URL,
    uptimeUrl: string,
    attribution: UpAttribution = {},
  ): Promise<void> {
    let base: URL;
    try {
      base = new URL(uptimeUrl);
    } catch {
      return; // Misconfigured target: no synthetic probing work at all.
    }
    if (base.protocol !== "https:") return;
    const failures: SyntheticCheck[] = [];
    for (const check of SYNTHETIC_CHECKS) {
      const result = await probeCheck(base, check);
      if (!result.ok) failures.push(check);
    }
    if (failures.length === 0) return;
    await sleep(UPTIME_RETRY_DELAY_MS);
    for (const check of failures) {
      const second = await probeCheck(base, check);
      if (second.ok) continue;
      const alert: SyntheticAlert = {
        event: "synthetic.down",
        check: check.path,
        target: base.host,
        status: second.status,
        ...(attribution.build_sha ? { build_sha: attribution.build_sha } : {}),
        ...(attribution.version_id ? { version_id: attribution.version_id } : {}),
        timestamp: new Date().toISOString(),
      };
      // Mute on check identity only: the status and the build attribution ride
      // in the payload but must not split the mute, or one flapping check (or
      // a deploy mid-incident) re-pages on every change. One instance probes
      // one host, so no target segment.
      await deliverScheduled(url, alert, `${alert.event}:${alert.check}`);
    }
  }
  return {
    async tail(events: readonly TraceLike[], env: TailEnv): Promise<void> {
      const url = webhookUrl(env.OPS_ALERT_WEBHOOK_URL);
      if (!url) return; // No secret: no parsing, no logging, no outbound work.
      // Merge same-script traces by their 30-second event-time bucket, so
      // one invocation makes at most one aggregation call per script and
      // bucket; SHA is per-trace version metadata. Merging by script alone
      // and re-stamping at the newest trace time would collapse minutes-old
      // crashes into the newest bucket and page without any real in-window
      // spike. Each bucket batch keeps a SHA only while every counted trace
      // in that bucket shares one validated SHA. An untagged or invalid
      // trace, or a second validated build, clears it to unknown: the last
      // tag must never speak for the whole bucket.
      // Drop traces skewed beyond now plus the documented slack before the
      // merge: keeping one would let Math.max lift the merged batch into
      // the future and wipe in-window buckets. Merely-late traces still
      // count; a one-bucket future skew stays within the slack.
      const wallNow = now();
      const batches = new Map<string, TraceBatch>();
      // Future-skew drop accounting: one line per invocation reporting that
      // invocation's dropped count (not a running total). Drop semantics and
      // the slack bound are unchanged; this counter only names the drops.
      let skewDropped = 0;
      for (const trace of events) {
        const batch = batchForTrace(trace, wallNow);
        if (!batch) continue;
        if (batch.at > wallNow + BATCH_FUTURE_SLACK_MS) {
          skewDropped += 1;
          continue;
        }
        const bucketAt = Math.floor(batch.at / BUCKET_MS) * BUCKET_MS;
        const key = `${batch.script}\0${bucketAt}`;
        const prior = batches.get(key);
        if (!prior) {
          batches.set(key, { ...batch });
        } else {
          const incomingCounts = batch.requests + batch.errors + batch.crashes;
          if (incomingCounts > 0) {
            const priorCounts = prior.requests + prior.errors + prior.crashes;
            const incomingSha = shaFromVersionTag(batch.buildSha);
            if (priorCounts === 0) {
              if (incomingSha !== undefined) prior.buildSha = incomingSha;
              else delete prior.buildSha;
            } else if (
              prior.buildSha === undefined ||
              incomingSha === undefined ||
              prior.buildSha !== incomingSha
            ) {
              delete prior.buildSha;
            }
          }
          prior.requests += batch.requests;
          prior.errors += batch.errors;
          prior.crashes += batch.crashes;
          prior.at = Math.max(prior.at, batch.at);
        }
      }
      // One accounting line per invocation that dropped skewed traces,
      // reporting that invocation's count. Goes to the log sink like the
      // delivery receipts — never to the webhook — and carries no trace
      // payload data. Zero-drop invocations stay silent.
      if (skewDropped > 0) {
        sink(JSON.stringify({ event: "tail.skew_drop", dropped: skewDropped }));
      }
      // Feed the oldest event-time bucket first, whatever order the
      // traces arrived in: the rolling window, eviction cutoff and alert
      // timestamp then match feeding the same traces bucket by bucket.
      const ordered = [...batches.values()].sort((a, b) => a.at - b.at);
      for (const batch of ordered) {
        const observed = await observeBatch(env, batch);
        if (!observed) continue;
        // The fencing identity and observation source stay internal: strip
        // both before delivery and receipts so external payloads keep
        // their long-standing shape.
        const { attemptId, source, ...spike } = observed;
        const delivered = await deliver(url, spike);
        await resolveSpike(env, spike.script, delivered, attemptId, source);
        sink(
          JSON.stringify({
            ...spike,
            delivery: delivered ? "ops.alert.delivered" : "ops.alert.delivery_failed",
          }),
        );
      }
      for (const trace of events) {
        if (!trace.scriptName || !APP_SCRIPT_NAMES.has(trace.scriptName)) continue;
        const buildSha = traceBuildSha(trace);
        for (const log of trace.logs) {
          if (log.level !== "error") continue;
          for (const argument of log.message) {
            const parsed = await parseAlert(argument, log.timestamp);
            if (!parsed) continue;
            const alert: AlertSummary = {
              event: parsed.event,
              fingerprint: parsed.fingerprint,
              script: trace.scriptName,
              ...(buildSha ? { build_sha: buildSha } : {}),
              logs: logsPath(trace.scriptName),
              ...(parsed.route ? { route: parsed.route } : {}),
              ...(parsed.job ? { job: parsed.job } : {}),
              ...(parsed.attempts !== undefined ? { attempts: parsed.attempts } : {}),
              // Scheduled pages carry only the allowlisted exception class;
              // request and queue summaries never forward an exception.
              ...(parsed.exception ? { exception: parsed.exception } : {}),
              timestamp: parsed.timestamp,
            };
            const key = `${alert.event}:${alert.fingerprint}`;
            // Clamp only far-future source timestamps to the local clock: the
            // page still carries its original timestamp, but suppression can
            // never stretch past the documented window. Stamps within skew
            // tolerance (past, on-time, or seconds ahead) keep source-time
            // semantics so boundary re-emits from the app's own limiter
            // still coordinate with the Tail mute.
            const nowMs = now();
            const muteAt = log.timestamp - nowMs > MAX_SOURCE_SKEW_MS ? nowMs : log.timestamp;
            if (!mute.begin(key, muteAt)) continue;
            const delivered = await deliver(url, alert);
            mute.finish(key, delivered);
            // Probe correlation is receipt-only: never send it to the webhook or split the mute key.
            const probeId = receiptProbeId(argument, alert);
            sink(
              JSON.stringify({
                ...alert,
                ...(probeId ? { probeId } : {}),
                delivery: delivered ? "ops.alert.delivered" : "ops.alert.delivery_failed",
              }),
            );
          }
        }
      }
    },
    async scheduled(controller: ScheduledController, env: TailEnv): Promise<void> {
      if (!env.UPTIME_URL) return; // Unconfigured: no probing work at all.
      const url = webhookUrl(env.OPS_ALERT_WEBHOOK_URL);
      if (!url) return; // No secret: no probing, no logging, no outbound work.
      const at = now();
      // Attribution is read from the /up body already fetched in this run —
      // never a cached build, never an extra fetch. A healthy run names the
      // first body's build; a red run names the second attempt's build, so an
      // unreadable paging-run body pages unattributed instead of blaming the
      // previous build.
      let upAttribution: UpAttribution = {};
      const first = await probeOnce(env.UPTIME_URL);
      if (first.ok) {
        upAttribution = first.attribution;
        await observeHealth(env, true, at);
      } else {
        await sleep(UPTIME_RETRY_DELAY_MS);
        const second = await probeOnce(env.UPTIME_URL);
        upAttribution = second.attribution;
        if (second.ok) {
          await observeHealth(env, true, at);
        } else {
          const { downMs, attemptId, source } = await observeHealth(env, false, at);
          // Red, but not yet red for over two minutes (or cooling down):
          // no uptime page this run; synthetics below still run.
          if (downMs !== null) {
            const alert: UptimeAlert = {
              event: "uptime.down",
              status: second.status,
              down_seconds: Math.floor(downMs / 1000),
              ...(upAttribution.build_sha ? { build_sha: upAttribution.build_sha } : {}),
              ...(upAttribution.version_id ? { version_id: upAttribution.version_id } : {}),
              timestamp: new Date(at).toISOString(),
            };
            const delivered = await deliver(url, alert);
            await resolveHealth(env, delivered, attemptId, source);
            sink(
              JSON.stringify({
                ...alert,
                delivery: delivered ? "ops.alert.delivered" : "ops.alert.delivery_failed",
              }),
            );
          }
        }
      }
      // Synthetics run even when /up is down: each failing main-flow check
      // is its own signal, muted independently of the uptime page. They keep
      // their five-minute cadence: only runs landing on a five-minute
      // boundary probe the main flows, so the per-minute health loop does
      // not multiply synthetic probe load (or /events throttle hits). The
      // gate reads the scheduled slot, not the invocation time, so a
      // boundary run that starts a minute late still probes.
      const slot = Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : at;
      if (new Date(slot).getUTCMinutes() % SYNTHETIC_INTERVAL_MINUTES === 0) {
        await runSynthetics(url, env.UPTIME_URL, upAttribution);
      }
    },
  };
}

export default createTailWorker() satisfies ExportedHandler<TailEnv>;
