import type { Hono } from "hono";
import type { Env } from "./env";
import { AlertProbeError } from "./alert-probe-error";
import { QA_HEADER, qaEnabled, qaTokenMatches } from "./qa";

export function registerAlertProbe(app: Hono<{ Bindings: Env }>): void {
  app.post("/__probe/alert", async (c) => {
    // The global host/same-origin guards still precede this route. No new exemption.
    if (!qaEnabled(c.env.APP_URL, c.env.QA_AUTH_TOKEN) ||
        !await qaTokenMatches(c.env.QA_AUTH_TOKEN, c.req.header(QA_HEADER) ?? "")) return c.notFound();
    if (!c.env.INTERNAL_ACTION_QUEUE) return c.json({ error: "probe_queue_unavailable" }, 503);
    await c.env.INTERNAL_ACTION_QUEUE.send({ kind: "alert-probe" });
    // Intentionally reach the real 500 handler AFTER the queue accepts the job.
    throw new AlertProbeError();
  });
}
