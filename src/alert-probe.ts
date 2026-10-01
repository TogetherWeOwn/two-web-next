import type { Hono } from "hono";
import type { Env } from "./env";
import { AlertProbeError } from "./alert-probe-error";
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
    await c.env.INTERNAL_ACTION_QUEUE.send({ kind: "alert-probe" });
    // Intentionally reach the real 500 handler AFTER the queue accepts the job.
    // https://hono.dev/docs/api/hono#error-handling
    throw new AlertProbeError();
  });
}
