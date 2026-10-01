var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../src/alert-probe-error.ts
function validProbeId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
__name(validProbeId, "validProbeId");

// worker.ts
var MUTE_MS = 5 * 60 * 1e3;
var MAX_TRACKED = 500;
var ALERT_ROUTES = /* @__PURE__ */ new Set([
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
  "/__probe/alert",
  "/csp-reports",
  "/discord",
  "/e/:key",
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
  "/up"
]);
var JOB_NAMES = /* @__PURE__ */ new Set(["SyncEventToDiscord", "CallInternalAction", "AlertProbe"]);
async function parseAlert(message, timestamp) {
  if (typeof message !== "string" || message.length > 16384 || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  let line;
  try {
    const value = JSON.parse(message);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    line = value;
  } catch {
    return null;
  }
  if (line.level !== "critical") return null;
  if (line.event === "error.alert") {
    if (typeof line.fingerprint !== "string" || !line.fingerprint || typeof line.route !== "string") return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(line.fingerprint));
    const fingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      event: line.event,
      fingerprint,
      route: ALERT_ROUTES.has(line.route) ? line.route : "[redacted]",
      timestamp: date.toISOString()
    };
  }
  if (line.event === "queue.failing") {
    if (typeof line.job !== "string" || !JOB_NAMES.has(line.job) || !Number.isSafeInteger(line.attempts) || line.attempts < 1) return null;
    return {
      event: line.event,
      fingerprint: `queue.failing@${line.job}`,
      job: line.job,
      attempts: line.attempts,
      timestamp: date.toISOString()
    };
  }
  return null;
}
__name(parseAlert, "parseAlert");
var DeliveryMute = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  now;
  static {
    __name(this, "DeliveryMute");
  }
  sent = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  begin(key, sourceTimestamp = this.now()) {
    const t = sourceTimestamp;
    if (this.pending.has(key) || t - (this.sent.get(key) ?? -Infinity) < MUTE_MS) return false;
    for (const [k, at] of this.sent) if (t - at >= MUTE_MS) this.sent.delete(k);
    if (this.pending.size >= MAX_TRACKED) return false;
    this.pending.set(key, t);
    return true;
  }
  finish(key, delivered) {
    const at = this.pending.get(key);
    this.pending.delete(key);
    if (!delivered || at === void 0) return;
    if (this.sent.size >= MAX_TRACKED) this.sent.delete(this.sent.keys().next().value);
    this.sent.set(key, at);
  }
};
function receiptProbeId(message, alert) {
  const line = JSON.parse(message);
  const synthetic = alert.event === "error.alert" && alert.route === "/__probe/alert" && line.fingerprint === "AlertProbeError@/__probe/alert" || alert.event === "queue.failing" && alert.job === "AlertProbe";
  return synthetic && validProbeId(line.probeId) ? line.probeId : void 0;
}
__name(receiptProbeId, "receiptProbeId");
function webhookUrl(secret) {
  if (!secret) return null;
  try {
    const url = new URL(secret);
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port || url.username || url.password || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
    url.hash = "";
    url.search = "?wait=true";
    return url;
  } catch {
    return null;
  }
}
__name(webhookUrl, "webhookUrl");
function createTailWorker(opts = {}) {
  const mute = opts.mute ?? new DeliveryMute();
  const send = opts.fetch ?? fetch;
  const sink = opts.sink ?? ((line) => console.log(line));
  return {
    async tail(events, env) {
      const url = webhookUrl(env.OPS_ALERT_WEBHOOK_URL);
      if (!url) return;
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
              const response = await send(url.toString(), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: JSON.stringify(alert), allowed_mentions: { parse: [] } }),
                redirect: "error",
                signal: AbortSignal.timeout(5e3)
              });
              delivered = response.ok;
              await response.body?.cancel();
            } catch {
            } finally {
              mute.finish(key, delivered);
            }
            const probeId = receiptProbeId(argument, alert);
            sink(JSON.stringify({
              ...alert,
              ...probeId ? { probeId } : {},
              delivery: delivered ? "ops.alert.delivered" : "ops.alert.delivery_failed"
            }));
          }
        }
      }
    }
  };
}
__name(createTailWorker, "createTailWorker");
var worker_default = createTailWorker();
export {
  ALERT_ROUTES,
  DeliveryMute,
  MUTE_MS,
  createTailWorker,
  worker_default as default,
  parseAlert
};
//# sourceMappingURL=worker.js.map
