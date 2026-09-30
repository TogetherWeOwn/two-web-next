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
// Flood control lives here instead of a throttle layer: like `/discord`, this
// route must answer during an app-DB outage, and a throttle would read the
// database-backed store — which is the database everywhere shipped.

import type { Context } from "hono";
import type { Env } from "./env";

/** Largest report body accepted, in bytes. Bigger bodies are dropped. */
export const MAX_CSP_REPORT_BYTES = 8192;

// The violation object after unwrapping either report shape. Values stay
// `unknown` until the fixed-key log line coerces them to scalars — the raw
// body is attacker-shaped and must never reach the log nested.
type CspReportFields = {
  "blocked-uri"?: unknown;
  blockedURL?: unknown;
  "violated-directive"?: unknown;
  effectiveDirective?: unknown;
  "document-uri"?: unknown;
  url?: unknown;
  "source-file"?: unknown;
  "line-number"?: unknown;
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
  if (isRecord(decoded) && isRecord(decoded["csp-report"])) return decoded["csp-report"] as CspReportFields;
  // Reporting API shape: [{...}, ...] — take the first report body.
  if (Array.isArray(decoded) && isRecord(decoded[0])) {
    const first = decoded[0] as Record<string, unknown>;
    return isRecord(first["body"]) ? (first["body"] as CspReportFields) : (first as CspReportFields);
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

/** Fixed-key log line. Non-scalar values collapse to null — never nested attacker data. */
export function cspReportLogFields(report: CspReportFields): {
  blocked_uri: string | null;
  violated_directive: string | null;
  document_uri: string | null;
  source_file: string | null;
  line_number: number | null;
} {
  return {
    blocked_uri: firstString(report["blocked-uri"], report.blockedURL),
    violated_directive: firstString(report["violated-directive"], report.effectiveDirective),
    document_uri: firstString(report["document-uri"], report.url),
    source_file: firstString(report["source-file"]),
    line_number: firstNumber(report["line-number"]),
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

export type CappedBody = { text: string; truncated: boolean; bytes: number };

/**
 * Read the request body without buffering past the cap. A `content-length`
 * over the cap short-circuits before the stream is touched at all; otherwise
 * the stream is consumed up to cap + 1 bytes and then cancelled, so an
 * oversized body is never fully read and never parsed.
 */
export async function readCappedBody(req: Request, cap: number = MAX_CSP_REPORT_BYTES): Promise<CappedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > cap) return { text: "", truncated: true, bytes: n };
  }
  if (!req.body) return { text: "", truncated: false, bytes: 0 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        // Over the cap: stop pulling and release the stream. The kept prefix
        // is discarded by the caller (truncated bodies are never parsed).
        await reader.cancel().catch(() => {});
        return { text: "", truncated: true, bytes };
      }
      chunks.push(value);
    }
  } catch {
    // An aborted stream is still a 204: the sink never fails the browser.
    await reader.cancel().catch(() => {});
    return { text: "", truncated: false, bytes };
  }
  const merged = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated: false, bytes };
}

// No session, no cookie, no DB: an unauthenticated sink that must answer when
// everything behind it is down. Every path — valid, malformed, oversized,
// empty, aborted — ends in 204.
export async function cspReportsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header("cache-control", "no-store");
  try {
    const body = await readCappedBody(c.req.raw);
    if (body.truncated) {
      console.warn("csp.report.dropped_oversize", { bytes: body.bytes });
      return c.body(null, 204);
    }
    const report = extractCspReport(body.text);
    if (report === null) return c.body(null, 204);
    if (shouldSampleReport(parseCspSampleRate(c.env.CSP_REPORT_SAMPLE_RATE))) {
      console.warn("csp.report.violation", cspReportLogFields(report));
    }
    return c.body(null, 204);
  } catch {
    return c.body(null, 204);
  }
}
