import type { Hono } from "hono";
import type { Env } from "./env";
import { requestBodyLimit } from "./body-limit";
import { ALERT_PROBE_HEADER, AlertProbeError, validProbeId } from "./alert-probe-error";
import { QA_HEADER, qaEnabled, qaTokenMatches, refundQaAttempt, takeQaAttempt } from "./qa";
import { AUTH_THROTTLE_PER_MINUTE, clientKey, throttle } from "./throttle";

export function registerAlertProbe(app: Hono<{ Bindings: Env }>): void {
  app.post(
    "/__probe/alert",
    async (c, next) => {
      // The global host/same-origin guards still precede this route. No new exemption.
      // Gate BEFORE the throttle/reader: disabled/bad-token calls always 404.
      // Middleware order: https://hono.dev/docs/guides/middleware
      if (!qaEnabled(c.env.APP_URL, c.env.QA_AUTH_TOKEN)) return c.notFound();
      // Same per-client attempt budget as the QA login gate (src/qa.ts): a
      // presented token takes an attempt before the digest compare and a
      // match refunds it, so failed guesses against either surface drain
      // the one budget. Refusal is the same 404 as a bad token.
      const presented = c.req.header(QA_HEADER) ?? "";
      const client = clientKey(c);
      if (presented && !takeQaAttempt(client)) return c.notFound();
      if (!(await qaTokenMatches(c.env.QA_AUTH_TOKEN, presented))) return c.notFound();
      if (presented) refundQaAttempt(client);
      await next();
    },
    // Body cap BEFORE the throttle (cap-first): oversized probes get a 413
    // without spending alert-probe throttle budget. The QA gate above still
    // runs first, so disabled/bad-token calls 404 before either.
    requestBodyLimit("action"),
    throttle("alert-probe", AUTH_THROTTLE_PER_MINUTE),
    async (c) => {
      if (!c.env.INTERNAL_ACTION_QUEUE) return c.json({ error: "probe_queue_unavailable" }, 503);
      // https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#randomuuid
      const probeId = c.req.header(ALERT_PROBE_HEADER) ?? crypto.randomUUID();
      if (!validProbeId(probeId)) return c.json({ error: "invalid_probe_id" }, 400);
      await c.env.INTERNAL_ACTION_QUEUE.send({ kind: "alert-probe", probeId });
      // Intentionally reach the real 500 handler AFTER the queue accepts the job.
      // https://hono.dev/docs/api/hono#error-handling
      throw new AlertProbeError(probeId);
    },
  );
}
