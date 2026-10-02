// Tail handler/config contract:
// https://developers.cloudflare.com/workers/observability/logs/tail-workers/
import { validProbeId } from "../src/alert-probe-error";

export type TailEnv = { OPS_ALERT_WEBHOOK_URL?: string; UPTIME_URL?: string };
export const MUTE_MS = 5 * 60 * 1000;
const MAX_TRACKED = 500;

// Uptime prober: two attempts per cron run, at least 10 s apart, each with a
// 10 s timeout. Page only when both fail. Silent failures (dead route,
// DNS/edge outage, Worker never running) produce no Tail log, so the Tail
// pager alone never sees them.
const UPTIME_TIMEOUT_MS = 10_000;
const UPTIME_RETRY_DELAY_MS = 10_000;
const EXPECTED_ORIGIN = "two-web-next";

export type UptimeAlert = {
  event: "uptime.down";
  status: number;
  timestamp: string;
};

// Only registered templates may leave the account. Never fall back to a raw
// request path, query string, exception, job payload or trace event.request.
export const ALERT_ROUTES = new Set([
  "/",
  "/about",
  "/admin",
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
  "/api/agent-events",
  "/auth/discord",
  "/auth/discord/callback",
  "/auth/discord/redirect",
  "/auth/qa/:identity",
  "/auth/recover",
  "/auth/status",
  "/__probe/alert",
  "/csp-reports",
  "/discord",
  "/e/:key",
  "/e/:key/rsvp",
  "/events",
  "/events.ics",
  "/events.json",
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
  "/join",
  "/join/callback",
  "/join/discord",
  "/logout",
  "/members/:user",
  "/privacy",
  "/profile",
  "/robots.txt",
  "/rules",
  "/sitemap_index.xml",
  "/up",
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
  return null;
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

type Trace = Pick<TraceItem, "scriptName" | "logs">;
type Sink = (line: string) => void;

export function createTailWorker(
  opts: {
    fetch?: typeof fetch;
    mute?: DeliveryMute;
    sink?: Sink;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const mute = opts.mute ?? new DeliveryMute();
  const send = opts.fetch ?? fetch;
  const sink = opts.sink ?? ((line: string) => console.log(line));
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** One bounded /up probe. Transport errors and timeouts are status 0. */
  async function probeOnce(target: string): Promise<{ ok: boolean; status: number }> {
    try {
      const response = await send(target, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(UPTIME_TIMEOUT_MS),
      });
      const ok = response.status === 200 && response.headers.get("x-two-origin") === EXPECTED_ORIGIN;
      await response.body?.cancel(); // Never read or log the body.
      return { ok, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
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
            if (!mute.begin(key, log.timestamp)) continue;
            let delivered = false;
            try {
              // wait=true confirms message persistence; disable all mentions.
              // https://docs.discord.com/developers/resources/webhook#execute-webhook
              const response = await send(url.toString(), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content: JSON.stringify(alert),
                  allowed_mentions: { parse: [] },
                }),
                redirect: "error",
                signal: AbortSignal.timeout(5000),
              });
              delivered = response.ok;
              await response.body?.cancel(); // Never read/log the message or credential-bearing error response.
            } catch {
              /* Transport/timeout: do not log the URL or exception. */
            } finally {
              mute.finish(key, delivered);
            }
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
    async scheduled(_controller: ScheduledController, env: TailEnv): Promise<void> {
      if (!env.UPTIME_URL) return; // Unconfigured: no probing work at all.
      const url = webhookUrl(env.OPS_ALERT_WEBHOOK_URL);
      if (!url) return; // No secret: no probing, no logging, no outbound work.
      const first = await probeOnce(env.UPTIME_URL);
      if (first.ok) return;
      await sleep(UPTIME_RETRY_DELAY_MS);
      const second = await probeOnce(env.UPTIME_URL);
      if (second.ok) return;
      const alert: UptimeAlert = {
        event: "uptime.down",
        status: second.status,
        timestamp: new Date().toISOString(),
      };
      const key = `${alert.event}:${alert.status}`;
      if (!mute.begin(key)) return;
      let delivered = false;
      try {
        const response = await send(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: JSON.stringify(alert),
            allowed_mentions: { parse: [] },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        delivered = response.ok;
        await response.body?.cancel();
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
    },
  };
}

export default createTailWorker() satisfies ExportedHandler<TailEnv>;
