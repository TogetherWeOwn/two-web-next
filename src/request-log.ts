import type { Context, Next } from "hono";
import { matchedRoutes } from "hono/route";
import { selectRequestId } from "./http/request-log";
import { currentReleaseFields, setReleaseMetadata } from "./release-tag";
import { STAGING_APP_URL } from "./qa";

export { newRequestId, safeRequestId } from "./http/request-log";

const CALENDAR_PHASES = [
  "public_read_guard",
  "calendar_model",
  "canonical_read",
  "discord_snapshot",
  "discord_dedupe",
  "render_cache",
] as const;
export type Phase = (typeof CALENDAR_PHASES)[number];
export type CalendarPhaseRecorder = {
  measure<T>(name: string, work: () => T | Promise<T>): Promise<T>;
  snapshot(): Partial<Record<Phase, number>>;
};

/** Request-local wall times: overlapping branches are not additive. */
export function createCalendarPhaseRecorder(now: () => number): CalendarPhaseRecorder {
  const times: Partial<Record<Phase, number>> = {};
  const reading = () => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      // Diagnostics must not replace a work result or its original rejection.
      return undefined;
    }
  };
  return {
    async measure<T>(name: string, work: () => T | Promise<T>): Promise<T> {
      if (!CALENDAR_PHASES.includes(name as Phase)) return work();
      const start = reading();
      try {
        return await work();
      } finally {
        const end = reading();
        if (start !== undefined && end !== undefined) {
          const elapsed = end - start;
          if (Number.isFinite(elapsed) && elapsed >= 0) times[name as Phase] = elapsed;
        }
      }
    },
    snapshot: () => ({ ...times }),
  };
}

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    calendarPhaseRecorder: CalendarPhaseRecorder | undefined;
  }
}

/** Registered patterns include mount prefixes, but never resolved params. */
export function requestRoute(c: Context): string {
  // routeIndex is the handler that responded, so /events/new is not logged as
  // a later /events/:key. A wildcard guard or 404 names the first endpoint the
  // router would run, and wildcard-only matches get one constant label, never
  // the user-supplied path (or an identity).
  // Source: https://hono.dev/docs/helpers/route#matchedroutes
  const paths = matchedRoutes(c).map((r) => r.path);
  const responded = paths[c.req.routeIndex];
  if (responded && !responded.endsWith("*")) return responded;
  return paths.find((path) => !path.endsWith("*")) ?? "unmatched";
}

export async function requestLog(c: Context, next: Next): Promise<void> {
  const started = performance.now();
  const requestId = selectRequestId(c.req.header("cf-ray"));
  c.set("requestId", requestId);
  if (
    (c.env as { APP_URL?: unknown } | undefined)?.APP_URL === STAGING_APP_URL &&
    c.req.method === "GET" &&
    c.req.path === "/events"
  ) {
    c.set(
      "calendarPhaseRecorder",
      createCalendarPhaseRecorder(() => performance.now()),
    );
  }
  // Seed the per-isolate release identity before any downstream alert can
  // fire, so error lines from this request carry the same build SHA.
  setReleaseMetadata(
    (c.env as { CF_VERSION_METADATA?: { tag?: unknown } } | undefined)?.CF_VERSION_METADATA,
  );
  // Hono handles downstream exceptions before next resolves. Run this wrapper
  // outermost so downstream response replacements are included in the status.
  // Source: https://hono.dev/docs/guides/middleware#execution-order
  await next();
  c.header("x-request-id", requestId);
  const colo = (c.req.raw.cf as { colo?: unknown } | undefined)?.colo;
  const phases = c.get("calendarPhaseRecorder");
  console.log(
    JSON.stringify({
      event: "http.request",
      request_id: requestId,
      method: c.req.method,
      route: requestRoute(c),
      status: c.res.status,
      duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
      colo: typeof colo === "string" && /^[A-Z]{3}$/.test(colo) ? colo : null,
      // Same fields on every structured line: this record has no error.
      error_class: null,
      ...currentReleaseFields(),
      ...(phases ? { calendar_phase_ms: phases.snapshot() } : {}),
    }),
  );
}
