// Tail handler/config contract:
// https://developers.cloudflare.com/workers/observability/logs/tail-workers/
export type TailEnv = { OPS_ALERT_WEBHOOK_URL?: string };
export const MUTE_MS = 5 * 60 * 1000;
const MAX_TRACKED = 500;

// Only registered templates may leave the account. Never fall back to a raw
// request path, query string, exception, job payload or trace event.request.
export const ALERT_ROUTES = new Set([
  "/", "/about", "/admin", "/admin/events", "/admin/events/:key", "/admin/events/new",
  "/admin/events/:key/cancel", "/admin/events/:key/edit", "/admin/events/create",
  "/admin/events/:key/publish", "/admin/events/:key/rsvp-pause", "/admin/events/:key/rsvp-reopen",
  "/admin/featured", "/admin/featured/:id", "/admin/featured/new", "/admin/featured/:id/delete",
  "/admin/featured-contents", "/admin/featured-contents/:id/edit", "/admin/featured-contents/create",
  "/admin/join-attempts", "/admin/join-attempts/:id",
  "/api/agent-events", "/auth/discord", "/auth/discord/callback", "/auth/discord/redirect", "/auth/qa/:identity",
  "/__probe/alert", "/csp-reports", "/discord", "/e/:key", "/events", "/events.ics",
  "/events.json", "/events.rss", "/events/:file{.+\\.ics}", "/events/past", "/events/:key",
  "/events/:key/cancel", "/events/:key/publish", "/events/:key/rsvp", "/events/:key/rsvp-pause",
  "/events/:key/rsvp-reopen", "/faq", "/join", "/join/callback", "/join/discord", "/logout",
  "/members/:user", "/privacy", "/profile", "/robots.txt", "/rules", "/sitemap_index.xml", "/up",
]);
const JOB_NAMES = new Set(["SyncEventToDiscord", "CallInternalAction", "AlertProbe"]);

export type AlertSummary = {
  event: "error.alert" | "queue.failing";
  fingerprint: string;
  route?: string;
  job?: string;
  attempts?: number;
  timestamp: string;
};

/** Parse exactly the app's single JSON argument; allowlist the outbound fields. */
export async function parseAlert(message: unknown, timestamp: number): Promise<AlertSummary | null> {
  if (typeof message !== "string" || message.length > 16_384 || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  let line: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    line = value as Record<string, unknown>;
  } catch { return null; }
  if (line.level !== "critical") return null;
  if (line.event === "error.alert") {
    if (typeof line.fingerprint !== "string" || !line.fingerprint || typeof line.route !== "string") return null;
    // Hash even malformed fingerprints: the original can contain a raw path or
    // injected exception text. Operators correlate it with the original trace.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(line.fingerprint));
    const fingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      event: line.event, fingerprint,
      route: ALERT_ROUTES.has(line.route) ? line.route : "[redacted]",
      timestamp: date.toISOString(),
    };
  }
  if (line.event === "queue.failing") {
    if (typeof line.job !== "string" || !JOB_NAMES.has(line.job) ||
        !Number.isSafeInteger(line.attempts) || (line.attempts as number) < 1) return null;
    // exception may be a bot refusal MESSAGE rather than a class; never use it.
    return {
      event: line.event, fingerprint: `queue.failing@${line.job}`, job: line.job,
      attempts: line.attempts as number, timestamp: date.toISOString(),
    };
  }
  return null;
}

/** Bounded, per-isolate five-minute mute. Failed deliveries can be attempted again. */
export class DeliveryMute {
  private readonly sent = new Map<string, number>();
  private readonly pending = new Set<string>();
  constructor(private readonly now: () => number = Date.now) {}
  begin(key: string): boolean {
    const t = this.now();
    if (this.pending.has(key) || t - (this.sent.get(key) ?? -Infinity) < MUTE_MS) return false;
    for (const [k, at] of this.sent) if (t - at >= MUTE_MS) this.sent.delete(k);
    if (this.pending.size >= MAX_TRACKED) return false;
    this.pending.add(key);
    return true;
  }
  finish(key: string, delivered: boolean): void {
    this.pending.delete(key);
    if (!delivered) return;
    if (this.sent.size >= MAX_TRACKED) this.sent.delete(this.sent.keys().next().value!);
    this.sent.set(key, this.now());
  }
}

function webhookUrl(secret: string | undefined): URL | null {
  if (!secret) return null;
  try {
    const url = new URL(secret);
    // Fail closed on non-Discord destinations, credentials, redirects and ports.
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port || url.username || url.password ||
        !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
    url.hash = "";
    url.search = "?wait=true";
    return url;
  } catch { return null; }
}

type Trace = Pick<TraceItem, "scriptName" | "logs">;
type Sink = (line: string) => void;

export function createTailWorker(opts: {
  fetch?: typeof fetch; mute?: DeliveryMute; sink?: Sink;
} = {}) {
  const mute = opts.mute ?? new DeliveryMute();
  const send = opts.fetch ?? fetch;
  const sink = opts.sink ?? ((line: string) => console.log(line));
  return {
    async tail(events: readonly Trace[], env: TailEnv): Promise<void> {
      const url = webhookUrl(env.OPS_ALERT_WEBHOOK_URL);
      if (!url) return; // No secret: no parsing, no logging, no outbound work.
      for (const trace of events) {
        if (trace.scriptName !== "two-web-next") continue;
        for (const log of trace.logs) {
          if (log.level !== "error") continue;
          for (const argument of log.message) {
            const alert = await parseAlert(argument, log.timestamp);
            if (!alert) continue;
            const key = `${alert.event}:${alert.fingerprint}`;
            if (!mute.begin(key)) continue;
            let delivered = false;
            try {
              // wait=true confirms message persistence; disable all mentions.
              // https://docs.discord.com/developers/resources/webhook#execute-webhook
              const response = await send(url.toString(), {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: JSON.stringify(alert), allowed_mentions: { parse: [] } }),
                redirect: "error", signal: AbortSignal.timeout(5000),
              });
              delivered = response.ok;
              await response.body?.cancel(); // Never read/log the message or credential-bearing error response.
            } catch { /* Transport/timeout: do not log the URL or exception. */ }
            finally { mute.finish(key, delivered); }
            // The probe waits for receipts, not for the source critical lines.
            sink(JSON.stringify({ ...alert, delivery: delivered ? "ops.alert.delivered" : "ops.alert.delivery_failed" }));
          }
        }
      }
    },
  };
}

export default createTailWorker() satisfies ExportedHandler<TailEnv>;
