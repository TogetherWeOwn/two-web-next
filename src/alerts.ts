// Log-line alerting (N4). Ports two-web's bootstrap/app.php report listener
// (one critical line per distinct `class@route` fingerprint, muted by
// ErrorAlertRateLimit for 5 minutes, dont-report list silent) and
// AppServiceProvider::Queue::failing (one critical line per failed job).
// The app emits logs only; tail/worker.ts delivers allowlisted summaries to
// the optional ops Discord webhook (see docs/runbook-alerts.md). Every alert is
// ONE single-line JSON object on
// console.error with `event` set to "error.alert" or "queue.failing".
//
// Alert lines carry the exception CLASS, never its message: a database error
// message can carry the failed statement's bound values. The full error is
// still logged by the caller (internalErrorHandler) for whoever follows the
// alert line to the trace.

export const ALERT_WINDOW_MS = 5 * 60 * 1000;
const MAX_TRACKED = 500;

export type Clock = () => number;

// Hono's HTTPException, zod errors and thrown Response-likes all carry either a
// numeric `status` or a ZodError name. The dont-report list mirrors legacy:
// 404 / 403 / validation / throttle (and any other client error) stay silent.
export function shouldReport(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;
  const e = err as { status?: unknown; name?: unknown };
  if (e.name === "ZodError") return false;
  if (typeof e.status === "number" && e.status < 500) return false;
  return true;
}

export function exceptionClass(err: unknown): string {
  if (err instanceof Error) return err.constructor?.name || err.name || "Error";
  return typeof err;
}

export function fingerprintOf(err: unknown, route: string): string {
  return `${exceptionClass(err)}@${route}`;
}

/** Per-fingerprint mute, ports ErrorAlertRateLimit (1 alert / 5 min). Per isolate: see the runbook. */
export class AlertRateLimit {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly windowMs = ALERT_WINDOW_MS,
    private readonly now: Clock = Date.now,
  ) {}

  /** True when this fingerprint may alert now; records the alert. */
  allow(fingerprint: string): boolean {
    const t = this.now();
    const prev = this.last.get(fingerprint);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    if (this.last.size >= MAX_TRACKED) {
      for (const [k, at] of this.last) if (t - at >= this.windowMs) this.last.delete(k);
      // Still full of live entries: drop the oldest so memory stays bounded.
      if (this.last.size >= MAX_TRACKED) this.last.delete(this.last.keys().next().value as string);
    }
    this.last.set(fingerprint, t);
    return true;
  }
}

const limiter = new AlertRateLimit();

type Sink = (line: string) => void;
const consoleSink: Sink = (line) => console.error(line);

/** Request error alert. Returns true when a line was written. */
export function alertRequestError(
  err: unknown,
  req: { method: string; route: string },
  opts: { limiter?: AlertRateLimit; sink?: Sink } = {},
): boolean {
  if (!shouldReport(err)) return false;
  const fingerprint = fingerprintOf(err, req.route);
  if (!(opts.limiter ?? limiter).allow(fingerprint)) return false;
  (opts.sink ?? consoleSink)(
    JSON.stringify({
      level: "critical",
      event: "error.alert",
      fingerprint,
      exception: exceptionClass(err),
      method: req.method,
      route: req.route,
    }),
  );
  return true;
}

export type FailedJob = {
  connection: string;
  queue: string;
  job: string;
  attempts: number;
  exception: string;
};

/** Failing queue job (ports Queue::failing): connection, queue, job class, attempts, exception. */
export function alertQueueFailing(job: FailedJob, sink: Sink = consoleSink): void {
  sink(JSON.stringify({ level: "critical", event: "queue.failing", ...job }));
}
