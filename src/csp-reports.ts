// POST /csp-reports — the session-free CSP violation sink (TOG-10107).
//
// Ports two-web `CspReportController` (TOG-8403, `routes/funnel.php`): the
// funnel's empty-middleware posture — no session, no cookie, no CSRF, no
// throttle, no auth, no DB. The browser fires this from pages whose session
// may already be gone, and it answers when the app database is down: a report
// is logged, never stored.
//
// Contract (shape-parity with legacy: same accepted shapes, same fixed log
// keys, same cap, always-204) with two deliberate tightenings documented
// below: unparseable sample rates fall back to 1.0 instead of blinding the
// sink, non-scalar values collapse to null in the log line, and a
// `{"csp-report": [...]}` list payload stays silent instead of logging an
// all-null row.
//
// Log flood control uses one in-memory token bucket per isolate, shared by
// violation and oversize warnings. Sampling alone cannot bound log volume.
// This is not a global request limit: isolates refill/reset independently.
// The route stays DB-free and always-204, even after its log budget is spent.

import type { Context } from "hono";
import type { Env } from "./env";
import { readCappedBody } from "./csp-report-body";
import { redactCspReportUri } from "./csp-report-uri";

export { MAX_CSP_REPORT_BYTES, readCappedBody } from "./csp-report-body";
export type { CappedBody } from "./csp-report-body";

// The violation object after unwrapping either report shape. Values stay
// `unknown` until the fixed-key log line coerces them to scalars — the raw
// body is attacker-shaped and must never reach the log nested.
type CspReportFields = {
  "blocked-uri"?: unknown;
  blockedURL?: unknown;
  "violated-directive"?: unknown;
  effectiveDirective?: unknown;
  "document-uri"?: unknown;
  documentURL?: unknown;
  url?: unknown;
  "source-file"?: unknown;
  sourceFile?: unknown;
  "line-number"?: unknown;
  lineNumber?: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Pull the violation object out of either report shape.
 * Returns null when the body is not a recognisable report.
 */
export function extractCspReport(raw: string): CspReportFields | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  // Classic `report-uri` shape: {"csp-report": {...}}.
  if (isRecord(decoded) && isRecord(decoded["csp-report"]))
    return decoded["csp-report"] as CspReportFields;
  // Reporting API shape: [{...}, ...] — still handle only the first report.
  if (Array.isArray(decoded) && isRecord(decoded[0])) {
    const first = decoded[0];
    // Typed envelopes must be CSP violations with an object body. Keep the
    // legacy untyped body/flat shapes, but never log another report type as CSP.
    if ("type" in first && (first.type !== "csp-violation" || !isRecord(first.body))) return null;
    if (!isRecord(first.body)) return first as CspReportFields;
    // Preserve the envelope URL as a fallback, below the body document fields.
    return typeof first.url === "string"
      ? { ...first.body, url: firstString(first.body.url, first.url) }
      : (first.body as CspReportFields);
  }
  return null;
}

const firstString = (...vals: unknown[]): string | null => {
  for (const v of vals) if (typeof v === "string") return v;
  return null;
};

const firstNumber = (...vals: unknown[]): number | null => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
};

/** Fixed-key log line. URI credentials are removed; non-scalars collapse to null. */
export function cspReportLogFields(report: CspReportFields): {
  blocked_uri: string | null;
  violated_directive: string | null;
  document_uri: string | null;
  source_file: string | null;
  line_number: number | null;
} {
  return {
    blocked_uri: redactCspReportUri(firstString(report["blocked-uri"], report.blockedURL)),
    violated_directive: firstString(report["violated-directive"], report.effectiveDirective),
    document_uri: redactCspReportUri(
      firstString(report["document-uri"], report.documentURL, report.url),
    ),
    source_file: redactCspReportUri(firstString(report["source-file"], report.sourceFile)),
    line_number: firstNumber(report["line-number"], report.lineNumber),
  };
}

/**
 * Fraction of valid violation reports (0.0–1.0) written to the log, from
 * `CSP_REPORT_SAMPLE_RATE` (default 1.0). Out-of-range values clamp; a
 * missing or unparseable value falls back to 1.0. Deliberate divergence from
 * legacy: PHP's `(float)` cast turns a typo'd value into 0.0 (silently blinds
 * the sink); here a typo keeps logging and the operator sees the reports.
 */
export function parseCspSampleRate(raw: string | undefined): number {
  if (raw === undefined) return 1.0;
  const rate = Number.parseFloat(raw);
  if (!Number.isFinite(rate)) return 1.0;
  return Math.min(1, Math.max(0, rate));
}

/** Sampling gate. Edges mirror legacy: >= 1.0 always logs, <= 0.0 never does. */
export function shouldSampleReport(rate: number, random: () => number = Math.random): boolean {
  if (rate >= 1.0) return true;
  if (rate <= 0.0) return false;
  return random() <= rate;
}

const CSP_LOG_BURST = 20;
const CSP_LOG_REFILL_MS = 3_000;
let logTokens = CSP_LOG_BURST;
let lastLogRefill = 0;

// Fixed-size isolate state, no client keys or timers. Consume synchronously
// just before logging so concurrent body reads cannot overspend the budget.
function takeCspLogToken(): boolean {
  const now = Date.now();
  const elapsed = Math.max(0, now - lastLogRefill);
  logTokens = Math.min(CSP_LOG_BURST, logTokens + elapsed / CSP_LOG_REFILL_MS);
  lastLogRefill = Math.max(lastLogRefill, now);
  if (logTokens < 1) return false;
  logTokens -= 1;
  return true;
}

// No session, no cookie, no DB: an unauthenticated sink that must answer when
// everything behind it is down. Every path — valid, malformed, oversized,
// empty, aborted, log-budget exhausted — ends in 204.
export async function cspReportsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header("cache-control", "no-store");
  try {
    const body = await readCappedBody(c.req.raw);
    if (body.truncated) {
      if (takeCspLogToken()) console.warn("csp.report.dropped_oversize", { bytes: body.bytes });
      return c.body(null, 204);
    }
    const report = extractCspReport(body.text);
    if (report === null) return c.body(null, 204);
    if (shouldSampleReport(parseCspSampleRate(c.env.CSP_REPORT_SAMPLE_RATE)) && takeCspLogToken()) {
      console.warn("csp.report.violation", cspReportLogFields(report));
    }
    return c.body(null, 204);
  } catch {
    return c.body(null, 204);
  }
}
