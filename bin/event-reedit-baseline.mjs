#!/usr/bin/env node
// Read-only baseline report: share of published events that a moderator
// re-edited within 60 minutes of publishing (Goal 4 success signal).
// Definition, caveats and the recorded numbers live in
// docs/event-reedit-baseline.md; keep the two in step.
//
//   DATABASE_URL=... node bin/event-reedit-baseline.mjs --target=production [--json]
//   DATABASE_URL=... node bin/event-reedit-baseline.mjs --target=local --end=2026-11-01T00:00:00Z --window-days=28
//
// Safety shape, same as the other operator CLIs: the connection string comes
// from the environment only, never argv or logs; the shared operator guard
// refuses a production-looking URL without --target=production and refuses
// remote URLs without verify-full TLS. The session runs with
// default_transaction_read_only=on, so the database itself rejects any
// write; the one statement is a single bounded SELECT over activity_log.
// Output is aggregate counts only: no titles, causers or row contents.
// Exit 0 = report printed, 1 = run failure, 2 = usage/configuration refusal.
import { pathToFileURL } from "node:url";
import { parseDatabaseUrl } from "./db-ping-core.mjs";
import { validateOperatorEnvironment } from "./operator-db-core.mjs";

export const REEDIT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 28;
export const MAX_ROWS = 100_000;
export const METHOD_VERSION = 1;

const USAGE = `Usage: node bin/event-reedit-baseline.mjs --target=<local|staging|production> [--end=<ISO timestamp>] [--window-days=<1-366>] [--json] [--help]

Read-only report over activity_log: of the events first published in the
window [--end minus --window-days, --end), how many have a moderator content
edit within 60 minutes after publishing. --end defaults to now (UTC).

Environment:
  DATABASE_URL  postgres URL with an explicit host, user and database
                (required). Read-only session; a production-looking URL
                requires --target=production, a remote URL requires
                sslmode=verify-full (or sslrootcert=system).

Output: aggregate counts and the share only. Exit 0 = ok, 1 = run failure,
2 = usage or configuration refusal. See docs/event-reedit-baseline.md.`;

// activity_log carries two properties shapes (docs/data-import.md): rows the
// current app writes use {field: {before, after}}; imported legacy rows keep
// the spatie {attributes, old} shape verbatim. A publish is a status
// transition into "published" in either shape. A re-edit is a moderator
// content edit: the app's "updated event ..." rows, or a legacy "updated"
// row that changed something besides status/rsvp_open. Publish, cancel and
// RSVP pause/reopen rows are never re-edits.
export function classifyActivityRow(row) {
  const subjectType = typeof row?.subjectType === "string" ? row.subjectType : "";
  if (!/(^|\\)Event$/.test(subjectType)) return "other";
  const p = row?.properties && typeof row.properties === "object" ? row.properties : {};
  const status = p.status && typeof p.status === "object" ? p.status : null;
  if (status && status.after === "published" && status.before !== "published") return "publish";
  const attributes = p.attributes && typeof p.attributes === "object" ? p.attributes : null;
  if (attributes && attributes.status === "published" && p.old?.status !== "published")
    return "publish";
  if (typeof row?.description === "string" && row.description.startsWith("updated event "))
    return "edit";
  if (row?.event === "updated" && attributes) {
    const contentKeys = Object.keys(attributes).filter(
      (k) => k !== "status" && k !== "updated_at" && k !== "rsvp_open",
    );
    if (contentKeys.length > 0) return "edit";
  }
  return "other";
}

const toMs = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Count first publishes inside [windowStart, windowEnd) and how many of
 * those events were re-edited in (publish, publish + 60min]. Publishes
 * whose 60-minute observation window extends past `observedUntil` are
 * excluded from both counts and reported as underObserved, so a run made
 * minutes after a publish never silently dilutes the share.
 */
export function computeReeditShare(rows, { windowStart, windowEnd, observedUntil }) {
  const startMs = toMs(windowStart);
  const endMs = toMs(windowEnd);
  const observedMs = toMs(observedUntil);
  if (startMs === null || endMs === null || observedMs === null || endMs <= startMs)
    throw new Error("invalid window");
  const firstPublishAt = new Map();
  const editsBySubject = new Map();
  for (const row of rows) {
    const at = toMs(row?.createdAt);
    const subjectId = typeof row?.subjectId === "string" ? row.subjectId : null;
    if (at === null || !subjectId) continue;
    const kind = classifyActivityRow(row);
    if (kind === "publish") {
      const prev = firstPublishAt.get(subjectId);
      if (prev === undefined || at < prev) firstPublishAt.set(subjectId, at);
    } else if (kind === "edit") {
      const list = editsBySubject.get(subjectId) ?? [];
      list.push(at);
      editsBySubject.set(subjectId, list);
    }
  }
  let published = 0;
  let reedited = 0;
  let underObserved = 0;
  for (const [subjectId, publishAt] of firstPublishAt) {
    if (publishAt < startMs || publishAt >= endMs) continue;
    if (publishAt + REEDIT_WINDOW_MS > observedMs) {
      underObserved += 1;
      continue;
    }
    published += 1;
    const edits = editsBySubject.get(subjectId) ?? [];
    if (edits.some((at) => at > publishAt && at <= publishAt + REEDIT_WINDOW_MS)) reedited += 1;
  }
  return {
    metric: "event-reedit-within-1h",
    methodVersion: METHOD_VERSION,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    observedUntil: new Date(observedMs).toISOString(),
    published,
    reedited,
    underObserved,
    // Null, never 0, when nothing was published: no denominator, no share.
    sharePercent: published === 0 ? null : Math.round((reedited / published) * 1000) / 10,
  };
}

export function parseArgs(args) {
  const out = { target: null, end: null, windowDays: DEFAULT_WINDOW_DAYS, json: false };
  for (const arg of args) {
    if (arg === "--json") out.json = true;
    else if (arg.startsWith("--target=")) out.target = arg.slice("--target=".length);
    else if (arg.startsWith("--end=")) out.end = arg.slice("--end=".length);
    else if (arg.startsWith("--window-days=")) {
      const days = Number(arg.slice("--window-days=".length));
      if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error(USAGE);
      out.windowDays = days;
    } else throw new Error(USAGE);
  }
  if (!["local", "staging", "production"].includes(out.target)) throw new Error(USAGE);
  if (out.end !== null && toMs(out.end) === null) throw new Error(USAGE);
  return out;
}

// Failure lines carry the driver SQLSTATE code (for example 42P01 for a
// missing table) so a misconfigured target is diagnosable without a second
// run. The code names the error class only; it carries no secrets, hosts or
// query text, so it is safe to print next to the stable refusal token.
export function failureLine(err) {
  const raw = err && typeof err.code === "string" ? err.code : "";
  const code = /^[0-9A-Z]{5}$/.test(raw) ? raw : "UNKNOWN";
  return `REEDIT_BASELINE_FAILED sqlstate=${code}`;
}

export function renderReport(report, json) {
  if (json) return `${JSON.stringify(report)}\n`;
  const share =
    report.sharePercent === null ? "n/a (nothing published)" : `${report.sharePercent}%`;
  return [
    `Metric: ${report.metric} (method v${report.methodVersion})`,
    `Publish window (UTC): [${report.windowStart}, ${report.windowEnd})`,
    `Observed until (UTC): ${report.observedUntil}`,
    `Events first published in window: ${report.published}`,
    `Re-edited within 60 minutes: ${report.reedited}`,
    `Share re-edited: ${share}`,
    `Excluded, still inside their 60-minute window: ${report.underObserved}`,
    "",
  ].join("\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    // local targets may use the plain host check inside the shared guard;
    // staging/production go through its TLS + target floor unchanged.
    validateOperatorEnvironment(process.env, opts.target === "local" ? undefined : opts.target);
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "REEDIT_BASELINE_CONFIG";
    process.stderr.write(`${code}\n`);
    return 2;
  }
  // Discard ambient libpq settings before driver construction (see db-ping).
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"])
    console[method] = () => {};

  const now = Date.now();
  const windowEndMs = opts.end === null ? now : toMs(opts.end);
  const windowStart = new Date(windowEndMs - opts.windowDays * 86_400_000);
  const windowEnd = new Date(windowEndMs);
  // Edits land up to 60 minutes after the last publish in the window.
  const fetchEnd = new Date(Math.min(windowEndMs + REEDIT_WINDOW_MS, now));
  let sql;
  let code = 1;
  try {
    const { default: postgres } = await import("postgres");
    sql = postgres({
      ...parseDatabaseUrl(process.env.DATABASE_URL),
      max: 1,
      fetch_types: false,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 1,
      onnotice: () => {},
      debug: false,
      connection: {
        application_name: "event-reedit-baseline",
        default_transaction_read_only: "on",
        statement_timeout: 30_000,
        lock_timeout: 5_000,
        timezone: "UTC",
        search_path: "public",
      },
    });
    const rows = await sql`
      select subject_type as "subjectType", subject_id as "subjectId",
             description, event, properties, created_at as "createdAt"
      from activity_log
      where subject_type like '%Event'
        and created_at >= ${windowStart} and created_at < ${fetchEnd}
      order by created_at asc, id asc
      limit ${MAX_ROWS + 1}`;
    if (rows.length > MAX_ROWS) {
      process.stderr.write("REEDIT_BASELINE_TOO_MANY_ROWS\n");
      code = 1;
    } else {
      const report = computeReeditShare(rows, {
        windowStart,
        windowEnd,
        observedUntil: fetchEnd,
      });
      process.stdout.write(renderReport(report, opts.json));
      code = 0;
    }
  } catch (err) {
    process.stderr.write(`${failureLine(err)}\n`);
    code = 1;
  }
  if (sql) {
    try {
      await sql.end({ timeout: 0 });
    } catch {
      // A failed close after a printed report leaves the numbers valid but
      // the run unhealthy: keep the report, refuse the success exit.
      process.stderr.write("REEDIT_BASELINE_CLEANUP_FAILED\n");
      code = 1;
    }
  }
  return code;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${USAGE}\n`, () => process.exit(0));
  } else {
    main().then(
      (code) => process.exit(code),
      () => process.exit(1),
    );
  }
}
