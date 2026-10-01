import type { Hono } from "hono";
import type { Env } from "./env";
import { ALERT_PROBE_HEADER, AlertProbeError, validProbeId } from "./alert-probe-error";
import { QA_HEADER, qaEnabled, qaTokenMatches } from "./qa";
import { AUTH_THROTTLE_PER_MINUTE, throttle } from "./throttle";

export function registerAlertProbe(app: Hono<{ Bindings: Env }>): void {
  app.post("/__probe/alert", async (c, next) => {
    // The global host/same-origin guards still precede this route. No new exemption.
    // Gate BEFORE the throttle: disabled/bad-token calls always 404, even at budget.
    if (!qaEnabled(c.env.APP_URL, c.env.QA_AUTH_TOKEN) ||
        !await qaTokenMatches(c.env.QA_AUTH_TOKEN, c.req.header(QA_HEADER) ?? "")) return c.notFound();
    await next();
  }, throttle("alert-probe", AUTH_THROTTLE_PER_MINUTE), async (c) => {
    if (!c.env.INTERNAL_ACTION_QUEUE) return c.json({ error: "probe_queue_unavailable" }, 503);
    // https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#randomuuid
    const probeId = c.req.header(ALERT_PROBE_HEADER) ?? crypto.randomUUID();
    if (!validProbeId(probeId)) return c.json({ error: "invalid_probe_id" }, 400);
    await c.env.INTERNAL_ACTION_QUEUE.send({ kind: "alert-probe", probeId });
    // Intentionally reach the real 500 handler AFTER the queue accepts the job.
    // https://hono.dev/docs/api/hono#error-handling
    throw new AlertProbeError(probeId);
  });
}
