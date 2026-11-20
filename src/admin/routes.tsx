// Admin routes (W11 pt1). Ports the Filament panel screens the legacy admin ran
// on, minus Filament: HTML tables + forms in this repo's JSX idiom.
//
// Routes behind adminGuard (non-moderator 403, guest OAuth redirect).
// Queue preview additionally requires default-off staging/operator admission:
// - GET  /admin/ops-overrides        control-bearer record/epoch, session-free, read-only
// - GET  /admin                      dashboard (index of resources)
// - GET  /admin/events               list (search, status/series/fill, sort, page)
// - GET  /admin/events/new           create form
// - POST /admin/events               create-as-draft (no delete anywhere)
// - GET  /admin/events/:key          edit form
// - POST /admin/events/:key          update
// - POST /admin/events/:key/publish  draft → published (write-back due)
// - POST /admin/events/:key/cancel   draft|published → cancelled
// - POST /admin/events/:key/duplicate  draft|published|cancelled → new draft copy (never mirrored)
// - GET  /admin/join-attempts        read-only join audit viewer (W12 M8)
// - GET  /admin/join-attempts/:id    read-only attempt detail
// - GET  /admin/activity-log         read-only activity-log viewer (R11)
// - GET  /admin/queue/failed/:id/preview  one-row advice only
// - GET  /admin/queue/source-evidence/:id  evidence-only source/cache proof (no session, no audit write)
// - POST /admin/queue/failed/:id/redispatch  one-row guarded re-dispatch
//   (replay advice only; refusals and stale rows are never deleted here)
// - GET  /admin/featured             list, position order
// - GET  /admin/featured/new         create form
// - POST /admin/featured             create
// - GET  /admin/featured/:id         edit form
// - POST /admin/featured/:id         update
// - POST /admin/featured/:id/unpublish  unpublish
// - POST /admin/featured/:id/delete  delete (safe: nothing refers to it)
//
// Read routes declare stable metadata; keyed retrieval owns the subjects and
// the guard flushes before releasing buffered HTML (M5). Writes leave the
// audit trail in the store (M7) and dispatch write-back where due (M3).

import { WRITE_THROTTLE_PER_MINUTE, throttle } from "../throttle";
import { requestBodyLimit } from "../body-limit";
import { Hono } from "hono";
import type { Context } from "hono";
import { queuePreviewAdmission, queuePreviewHandler, type QueuePreviewVars } from "./queue-preview";
import { queueRedispatchHandler, queueRedispatchPreThrottleRefusal } from "./queue-redispatch";
import { sourceEvidenceHandler, sourceEvidenceMethodRefused } from "./source-evidence";
import { opsOverridesHandler, opsOverridesMethodRefused } from "./ops-overrides";
import { dbFor, type EnvWithAdminDb } from "./db";
import { bufferedMemberHtml, bufferedMemberText } from "../member-reads";
import { badRequest, prefersHtmlError, varyAccept } from "../errors";
import { EVENT_PAGE_SIZE, parseEventListQuery } from "./event-list";
import { eventKeyAllowed } from "../events/keys";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  FEATURED_PAGE_SIZE,
  JOIN_ATTEMPT_PAGE_SIZE,
  parseActivityLogQuery,
  parseFeaturedListQuery,
  parseJoinAttemptsQuery,
  parseRosterQuery,
} from "./table-list";
import { type AccessDecl, type AdminOverrides, adminGuard } from "./guard";
import type { SessionStore } from "../sessions";
import {
  type EventRow,
  type FeaturedEditRow,
  createEvent,
  createFeatured,
  deleteFeatured,
  duplicateEvent,
  getEvent,
  getFeatured,
  getFeaturedIdByLegacyId,
  listEvents,
  listFeatured,
  NotFoundError,
  setRsvpOpen,
  transitionEvent,
  unpublishFeatured,
  updateEvent,
  updateFeatured,
} from "./store";
import { topZeroResultSearches } from "../events/search-log";
import { JOIN_OUTCOMES } from "../join/service";
import { databaseUrl } from "../db/connection";
import { isDatabaseQueryCancellation, isDatabaseUnavailable } from "../db/errors";
import { safeRequestId } from "../request-log";
import { dashboardJoinFunnel, FUNNEL_READ_DEADLINE_MS } from "./join-funnel";
import { getJoinAttempt, listActivityLog, listJoinAttempts, listRoster } from "./reads";
import { parseRecordId } from "./record-id";
import { parseRecurrenceForm } from "./recurrence";
import {
  isKnownTimezone,
  parseHumanEventForm,
  parseFeaturedForm,
  utcToWall,
  ValidationError,
  wallToUtc,
} from "./validation";
import { dispatchWriteBack } from "./writeback";
import {
  eventSaveBaseline,
  featuredSaveBaseline,
  isSaveBaseline,
  SAVE_BASELINE_FIELD,
  StaleSaveError,
} from "./save-baseline";
import {
  ActivityLogPage,
  AdminDashboard,
  ErrorPage,
  EventFormPage,
  EventsPage,
  FeaturedFormPage,
  FeaturedPage,
  JoinAttemptPage,
  JoinAttemptsPage,
  type RecoveryLink,
} from "./pages";

type Vars = QueuePreviewVars;

const SESSION_GUEST_REDIRECT = "/auth/discord";

function formData(body: Record<string, string | File>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// A malformed multipart body rejects the parse: answer 400 instead of throwing
// into the alerting 500 path. Null means the caller must refuse the write.
async function parsedForm(c: Context<Vars>): Promise<Record<string, unknown> | null> {
  try {
    return formData(await c.req.parseBody());
  } catch {
    return null;
  }
}

function declareAccess(c: Context<Vars>, decl: AccessDecl): void {
  c.set("access", decl);
}

function legacyRedirect(c: Context<Vars>, location: string, resource: string, route: string) {
  declareAccess(c, { resource, action: "view", route });
  c.header("location", location);
  return bufferedMemberText(c, "", 301);
}

async function dbOr503(c: Context<Vars>) {
  const db = await dbFor(c);
  if (!db) return null;
  return db;
}

function errorPage(
  c: Context<Vars>,
  // hono's text/html helpers only accept literal status codes.
  status: 404 | 422 | 503,
  heading: string,
  detail?: string,
  recovery?: RecoveryLink[],
) {
  c.status(status);
  return bufferedMemberHtml(
    c,
    <ErrorPage heading={heading} detail={detail} recovery={recovery} />,
    status,
  );
}

function adminUnavailable(c: Context<Vars>) {
  return bufferedMemberText(c, "Admin temporarily unavailable", 503);
}

function eventNotFound(c: Context<Vars>) {
  return errorPage(c, 404, "Event not found");
}

function featuredNotFound(c: Context<Vars>) {
  return errorPage(c, 404, "Featured content not found");
}

function writeUnavailable(c: Context<Vars>) {
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  if (prefersHtmlError(c)) return errorPage(c, 503, "Admin temporarily unavailable");
  return c.text("Admin temporarily unavailable", 503);
}

/** Validation errors re-render the form (422). */
function formError(
  c: Context<Vars>,
  err: ValidationError,
  render: (
    errors: Record<string, string>,
    values: Record<string, unknown>,
  ) => Response | Promise<Response>,
  values: Record<string, unknown>,
): Response | Promise<Response> {
  c.status(422);
  return render(err.fields, values);
}

// A carrier-less reparse of a refused draft loses two things the saved
// carriers preserve: which side of an autumn fold a wall time came from,
// and any seconds (the form speaks minutes). Either loss can invent an
// ordering error — a fold wall can shift onto the other endpoint, and
// minute-identical walls can hide a valid seconds-ordered pair. So an
// ordering error survives only when it holds across every possible
// interpretation: the latest possible end (later fold instant plus the
// whole minute) is still at or before the earliest possible start.
// Syntax and gap errors do not depend on the carrier and always survive.
function possibleRange(wall: unknown, timezone: string): { min: number; max: number } | null {
  if (typeof wall !== "string" || !wall.trim()) return null;
  try {
    const earlier = wallToUtc(wall, timezone, "earlier").getTime();
    const later = wallToUtc(wall, timezone, "later").getTime();
    return { min: Math.min(earlier, later), max: Math.max(earlier, later) + 59_999 };
  } catch {
    return null;
  }
}

function orderingDefinitelyInvalid(
  startWall: unknown,
  endWall: unknown,
  timezone: string,
): boolean {
  const start = possibleRange(startWall, timezone);
  const end = possibleRange(endWall, timezone);
  // An unresolvable wall already carries its own intrinsic error; keep the
  // ordering diagnostic rather than dropping the only signal.
  if (!start || !end) return true;
  return end.max <= start.min;
}

function refusedEventSave(
  c: Context<Vars>,
  row: EventRow,
  values: Record<string, unknown>,
  status: 400 | 409,
) {
  let errors: Record<string, string> = {};
  try {
    parseHumanEventForm(values);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    errors = { ...err.fields };
    const timezone =
      typeof values.timezone === "string" && values.timezone.trim()
        ? values.timezone.trim()
        : "Europe/London";
    if (
      errors.ends_at === "The end is after the start." &&
      !orderingDefinitelyInvalid(values.starts_at, values.ends_at, timezone)
    ) {
      delete errors.ends_at;
    }
  }
  c.status(status);
  return c.html(
    <EventFormPage
      mode="edit"
      row={row}
      values={values}
      errors={errors}
      rosterHiddenNotice
      saveRefused={status === 409 ? "stale" : "unverified"}
    />,
  );
}

function refusedFeaturedSave(
  c: Context<Vars>,
  row: FeaturedEditRow,
  values: Record<string, unknown>,
  status: 400 | 409,
) {
  let errors: Record<string, string> = {};
  try {
    parseFeaturedForm(values, c.env.FEATURED_IMAGE_HOSTS);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    errors = err.fields;
  }
  c.status(status);
  return c.html(
    <FeaturedFormPage
      appUrl={c.env.APP_URL}
      imageHosts={c.env.FEATURED_IMAGE_HOSTS}
      mode="edit"
      row={row}
      values={values}
      errors={errors}
      saveRefused={status === 409 ? "stale" : "unverified"}
    />,
  );
}

/**
 * Optional overrides (tests only — production resolves through the seams).
 * A bare SessionStore overrides session resolution (guard pins); live route
 * tests pass `{ sessionStore, db }` so sessions resolve from memory while
 * admin tables read/write Postgres.
 */
export function adminApp(overrides?: AdminOverrides | SessionStore) {
  const admin = new Hono<Vars>();
  // Control-token holders only: no session lookup, role admission or writes.
  admin.get("/ops-overrides", opsOverridesHandler);
  admin.on(
    ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    "/ops-overrides",
    requestBodyLimit("action"),
    opsOverridesMethodRefused,
  );
  // Evidence-only source/cache verifier: session-free by construction.
  // Registered before every admin middleware (Hono composes in registration
  // order and these handlers answer without next()), so no session lookup,
  // guard, or preview admission runs for this path. The bearer/incident/
  // one-hour-window admission lives in the GET handler; write verbs are refused on the
  // same path so the method contract never depends on sibling flags. The
  // route is inert without the runtime-only settings.
  admin.get("/queue/source-evidence/:id", sourceEvidenceHandler);
  // HEAD keeps standard GET-without-body semantics; it is safe here because
  // the handler has no side effects (read-only snapshot, no audit write).
  admin.on(
    ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    "/queue/source-evidence/:id",
    // Same wire cap as every other admin write: oversized attempts refuse
    // before parsing, and the refusal itself never parses a payload.
    requestBodyLimit("action"),
    sourceEvidenceMethodRefused,
  );
  admin.use("/queue/*", queuePreviewAdmission);
  admin.use("/*", adminGuard(overrides));
  admin.get("/queue/failed/:id/preview", queuePreviewHandler);
  // Action-class admin write: the wire cap runs before the shared throttle
  // (oversized attempts 413 without spending the bucket), the cap refuses
  // before parsing, and the handler itself never parses a payload
  // (dispatch always starts from the reconciled source). The two I/O-free
  // refusals (non-operator 403, malformed id/query 422) run between the cap
  // and the throttle with zero spend, even under an exhausted budget; the
  // handler keeps the same checks as idempotent defense. Only the dedicated
  // staging operator principal can reach the handler.
  admin.post(
    "/queue/failed/:id/redispatch",
    requestBodyLimit("action"),
    queueRedispatchPreThrottleRefusal,
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    queueRedispatchHandler,
  );

  // Legacy Filament bookmarks: guard first, no query forwarding.
  // Only the featured edit alias needs a resource read to resolve the imported ID.
  // Keep the literal create alias ahead of /events/:key.
  admin.get("/events/create", (c) =>
    legacyRedirect(c, "/admin/events/new", "events", "admin.events.legacy-create"),
  );
  admin.get("/events/:key/edit", (c) =>
    legacyRedirect(
      c,
      `/admin/events/${encodeURIComponent(c.req.param("key"))}`,
      "events",
      "admin.events.legacy-edit",
    ),
  );
  admin.get("/featured-contents", (c) =>
    legacyRedirect(c, "/admin/featured", "featured_contents", "admin.featured.legacy-index"),
  );
  admin.get("/featured-contents/create", (c) =>
    legacyRedirect(c, "/admin/featured/new", "featured_contents", "admin.featured.legacy-create"),
  );
  admin.get("/featured-contents/:id/edit", async (c) => {
    declareAccess(c, {
      resource: "featured_contents",
      action: "view",
      route: "admin.featured.legacy-edit",
    });
    const legacyId = c.req.param("id");
    if (!/^[1-9]\d*$/.test(legacyId)) return featuredNotFound(c);
    try {
      const db = await dbOr503(c);
      if (!db) return adminUnavailable(c);
      const id = await getFeaturedIdByLegacyId(db, legacyId);
      if (id === null) return featuredNotFound(c);
      return legacyRedirect(
        c,
        `/admin/featured/${id}`,
        "featured_contents",
        "admin.featured.legacy-edit",
      );
    } catch (err) {
      // The guard's read boundary renders the shared outage envelope.
      if (isDatabaseUnavailable(err)) throw err;
      return adminUnavailable(c);
    }
  });

  admin.get("/", async (c) => {
    declareAccess(c, { resource: "dashboard", action: "view", route: "admin.dashboard" });
    // Funnel counts are outcomes only (no member data): no access-log subjects.
    // No DB (bare-guard tests / unconfigured): the widget is omitted, not fatal.
    const db = await dbFor(c);
    // Match dbFor's precedence: an injected ADMIN_DB overrides either URL.
    const identity = (c.env as EnvWithAdminDb).ADMIN_DB || databaseUrl(c.env) || db;
    // Start both optional analytics reads together with the same budget, rather
    // than stacking their deadlines; they still share one pooled connection, so
    // the budget covers both transactions. Failed/blocked widgets are omitted;
    // authorization and the guard's critical access-log write stay fail-closed.
    let funnel: Awaited<ReturnType<typeof dashboardJoinFunnel>>;
    let zeroSearches: Awaited<ReturnType<typeof topZeroResultSearches>>;
    if (db) {
      const [funnelResult, zeroSearchesResult] = await Promise.allSettled([
        dashboardJoinFunnel(db, identity),
        topZeroResultSearches(db, 10, FUNNEL_READ_DEADLINE_MS),
      ]);
      for (const result of [funnelResult, zeroSearchesResult]) {
        if (result.status === "rejected" && !isDatabaseQueryCancellation(result.reason)) {
          throw result.reason;
        }
      }
      // One correlated line per degraded widget: with a db present, a settled
      // value of undefined is exactly the degraded signal for both helpers
      // (they resolve undefined on cancellations, ordinary failures and
      // deadline timeouts), so the log distinguishes degraded from healthy.
      // Outages threw above; rejected cancellations fall through to the same
      // line.
      const requestId = safeRequestId(c.get("requestId"));
      if (funnelResult.status !== "fulfilled" || funnelResult.value === undefined) {
        console.warn("dashboard widget degraded", { widget: "funnel", request_id: requestId });
      }
      if (zeroSearchesResult.status !== "fulfilled" || zeroSearchesResult.value === undefined) {
        console.warn("dashboard widget degraded", {
          widget: "zero_searches",
          request_id: requestId,
        });
      }
      funnel = funnelResult.status === "fulfilled" ? funnelResult.value : undefined;
      zeroSearches =
        zeroSearchesResult.status === "fulfilled" ? zeroSearchesResult.value : undefined;
    } else {
      funnel = undefined;
      zeroSearches = undefined;
    }
    return bufferedMemberHtml(
      c,
      <AdminDashboard actor={c.get("adminActor")} funnel={funnel} zeroSearches={zeroSearches} />,
    );
  });

  admin.get("/join-attempts", async (c) => {
    declareAccess(c, {
      resource: "join_attempts",
      action: "list",
      route: "admin.join-attempts.index",
    });
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const query = parseJoinAttemptsQuery(c.req.query());
    const fetched = await listJoinAttempts(db, query);
    const rows = fetched.slice(0, JOIN_ATTEMPT_PAGE_SIZE);
    return bufferedMemberHtml(
      c,
      <JoinAttemptsPage
        rows={rows}
        query={query}
        hasNext={fetched.length > JOIN_ATTEMPT_PAGE_SIZE}
        outcomes={JOIN_OUTCOMES}
      />,
    );
  });

  admin.get("/join-attempts/:id", async (c) => {
    declareAccess(c, {
      resource: "join_attempts",
      action: "view",
      route: "admin.join-attempts.show",
    });
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) {
      return errorPage(c, 404, "Join attempt not found");
    }
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const result = await getJoinAttempt(db, id);
    if (!result) return errorPage(c, 404, "Join attempt not found");
    return bufferedMemberHtml(c, <JoinAttemptPage row={result.attempt} />);
  });

  admin.get("/activity-log", async (c) => {
    declareAccess(c, {
      resource: "activity_log",
      action: "list",
      route: "admin.activity-log.index",
    });
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const query = parseActivityLogQuery(c.req.query());
    const fetched = await listActivityLog(db, query);
    const rows = fetched.slice(0, ACTIVITY_LOG_PAGE_SIZE);
    return bufferedMemberHtml(
      c,
      <ActivityLogPage
        rows={rows}
        query={query}
        hasNext={fetched.length > ACTIVITY_LOG_PAGE_SIZE}
      />,
    );
  });

  admin.get("/events", async (c) => {
    declareAccess(c, { resource: "events", action: "list", route: "admin.events.index" });
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const params = c.req.query();
    const query = parseEventListQuery(params);
    const fetched = await listEvents(db, params);
    const rows = fetched.slice(0, EVENT_PAGE_SIZE);
    return bufferedMemberHtml(
      c,
      <EventsPage rows={rows} query={query} hasNext={fetched.length > EVENT_PAGE_SIZE} />,
    );
  });

  admin.get("/events/new", (c) => {
    declareAccess(c, { resource: "events", action: "view", route: "admin.events.create" });
    return bufferedMemberHtml(c, <EventFormPage mode="new" values={{}} errors={{}} />);
  });

  admin.post(
    "/events",
    // Cap before throttle: oversized moderator bodies 413 with zero
    // admin-write spend and no store read; the guard above still runs first.
    requestBodyLimit("form"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      const values = await parsedForm(c);
      if (!values) return badRequest(c);
      let input;
      let recurrence;
      try {
        // Both parsers run so one submit reports every field error; the event
        // rules own starts/timezone errors, the recurrence rules own theirs.
        const errors: Record<string, string> = {};
        try {
          input = parseHumanEventForm(values);
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          Object.assign(errors, err.fields);
        }
        try {
          recurrence = parseRecurrenceForm(values);
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          Object.assign(errors, err.fields);
        }
        if (Object.keys(errors).length > 0) throw new ValidationError(errors);
      } catch (err) {
        if (err instanceof ValidationError) {
          return formError(
            c,
            err,
            (errors, v) => c.html(<EventFormPage mode="new" values={v} errors={errors} />),
            values,
          );
        }
        throw err;
      }
      const { row } = await createEvent(db, c.get("adminActor"), input!, recurrence ?? null);
      return c.redirect(
        `/admin/events/${row.eventKey}${row.status === "draft" ? "?saved=1" : ""}`,
        303,
      );
    },
  );

  admin.get("/events/:key", async (c) => {
    declareAccess(c, { resource: "events", action: "view", route: "admin.events.edit" });
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const key = c.req.param("key");
    if (!eventKeyAllowed(key, c.env.APP_URL)) return eventNotFound(c);
    const row = await getEvent(db, key);
    if (!row) return eventNotFound(c);
    const rosterQuery = parseRosterQuery(c.req.query());
    const { rows: roster, total: rosterTotal } = await listRoster(db, row.eventKey, rosterQuery);
    return bufferedMemberHtml(
      c,
      <EventFormPage
        mode="edit"
        row={row}
        values={await eventValues(row)}
        errors={{}}
        roster={roster}
        rosterTotal={rosterTotal}
        rosterQuery={rosterQuery}
        saved={c.req.query("saved") === "1"}
      />,
    );
  });

  admin.post(
    "/events/:key",
    // Cap before throttle: oversized moderator bodies 413 with zero
    // admin-write spend and no store read; the guard above still runs first.
    requestBodyLimit("form"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      const key = c.req.param("key");
      if (!eventKeyAllowed(key, c.env.APP_URL)) return eventNotFound(c);
      const existing = await getEvent(db, key);
      if (!existing) return eventNotFound(c);
      const values = await parsedForm(c);
      if (!values) return badRequest(c);
      const baseline = values[SAVE_BASELINE_FIELD];
      if (!isSaveBaseline(baseline)) return refusedEventSave(c, existing, values, 400);
      if (baseline !== (await eventSaveBaseline(existing))) {
        return refusedEventSave(c, existing, values, 409);
      }
      // Hidden carriers: an untouched fold/gap wall time keeps the stored
      // instant. A nonfinite stored date has no hint; parse its replacement.
      const carriers = {
        startsAtUtc: Number.isFinite(existing.startsAt.getTime())
          ? existing.startsAt.toISOString()
          : undefined,
        endsAtUtc: Number.isFinite(existing.endsAt.getTime())
          ? existing.endsAt.toISOString()
          : undefined,
      };
      let input;
      try {
        input = parseHumanEventForm(values, carriers);
      } catch (err) {
        if (err instanceof ValidationError) {
          return formError(
            c,
            err,
            (errors, v) =>
              c.html(
                <EventFormPage
                  mode="edit"
                  row={existing}
                  values={v}
                  errors={errors}
                  rosterHiddenNotice
                />,
              ),
            values,
          );
        }
        throw err;
      }
      try {
        const { row, writeBack, childWriteBacks } = await updateEvent(
          db,
          c.get("adminActor"),
          key,
          input,
          baseline,
        );
        if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
        for (const wb of childWriteBacks) await dispatchWriteBack(c.env, wb, c.get("requestId"));
        return c.redirect(
          `/admin/events/${row.eventKey}${row.status === "draft" ? "?saved=1" : ""}`,
          303,
        );
      } catch (err) {
        if (err instanceof NotFoundError) return eventNotFound(c);
        if (err instanceof StaleSaveError) {
          // The locked snapshot is carried by the error: a second read can fail
          // after refusal and must never replace the recoverable draft with 503.
          return refusedEventSave(c, err.current as EventRow, values, 409);
        }
        if (err instanceof ValidationError) {
          return formError(
            c,
            err,
            (errors, v) =>
              c.html(
                <EventFormPage
                  mode="edit"
                  row={existing}
                  values={v}
                  errors={errors}
                  rosterHiddenNotice
                />,
              ),
            values,
          );
        }
        throw err;
      }
    },
  );

  for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
    // Action-class lifecycle write: wire cap before the shared throttle, so an
    // oversized moderator body 413s without spending admin-write budget.
    admin.post(
      `/events/:key/${action}`,
      requestBodyLimit("action"),
      throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
      async (c) => {
        const db = await dbOr503(c);
        if (!db) return writeUnavailable(c);
        const key = c.req.param("key");
        if (!eventKeyAllowed(key, c.env.APP_URL)) return eventNotFound(c);
        const body = action === "publish" ? await parsedForm(c) : {};
        if (!body) return badRequest(c);
        const fromReview = body.review === "1";
        const reviewedUpdatedAt = fromReview
          ? typeof body.reviewed_updated_at === "string"
            ? body.reviewed_updated_at
            : ""
          : undefined;
        try {
          const actor = c.get("adminActor");
          const { row, writeBack } =
            action === "rsvp-pause" || action === "rsvp-reopen"
              ? await setRsvpOpen(db, actor, key, action === "rsvp-reopen")
              : await transitionEvent(
                  db,
                  actor,
                  key,
                  action === "publish" ? "published" : "cancelled",
                  reviewedUpdatedAt,
                );
          if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
          return c.redirect(
            fromReview ? `/e/${row.eventKey}?published=1` : `/admin/events/${row.eventKey}`,
            303,
          );
        } catch (err) {
          if (err instanceof NotFoundError) return eventNotFound(c);
          if (err instanceof ValidationError) {
            if (fromReview) {
              const reason = err.fields.reviewed_updated_at
                ? "stale"
                : err.fields.location
                  ? "location"
                  : err.fields.ends_at
                    ? "ended"
                    : err.fields.dates
                      ? "dates"
                      : "status";
              // PRG reads the latest saved detail through the moderator-only
              // review route. Query codes select fixed copy, never raw input.
              return c.redirect(
                `/e/${encodeURIComponent(key)}?review=1&publish_error=${reason}`,
                303,
              );
            }
            // A blank location blocks publishing: re-render the edit form so the
            // no-JS moderator sees the error next to the location control and can
            // fix it, rather than an error page with nowhere to correct it.
            if (err.fields.location) {
              const key = c.req.param("key");
              const row = await getEvent(db, key);
              if (!row) return eventNotFound(c);
              return formError(
                c,
                err,
                (errors, v) =>
                  c.html(<EventFormPage mode="edit" row={row} values={v} errors={errors} />),
                await eventValues(row),
              );
            }
            return errorPage(
              c,
              422,
              "That transition is not allowed",
              err.fields.status ?? err.fields.ends_at ?? err.fields.dates ?? err.fields.rsvp_open,
              // Nothing changed. Offer plain GET links back to the event and
              // the list; never a form that would retry the refused POST.
              [
                { href: `/admin/events/${key}`, label: "Back to the event" },
                { href: "/admin/events", label: "Back to events" },
              ],
            );
          }
          throw err;
        }
      },
    );
  }

  // Duplicate-as-draft (S4): same action-class stack as publish/cancel (cap,
  // then throttle, then the moderator guard's admission), but the redirect
  // lands on the fresh copy and there is never a write-back: a draft is
  // never mirrored, so no queue row and no fan-out leave this handler.
  admin.post(
    "/events/:key/duplicate",
    requestBodyLimit("action"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      const key = c.req.param("key");
      if (!eventKeyAllowed(key, c.env.APP_URL)) return eventNotFound(c);
      try {
        const { row } = await duplicateEvent(db, c.get("adminActor"), key);
        return c.redirect(`/admin/events/${row.eventKey}`, 303);
      } catch (err) {
        if (err instanceof NotFoundError) return eventNotFound(c);
        if (err instanceof ValidationError) {
          // The source's stored fields fail the current form rules: re-render
          // the source editor so the no-JS moderator sees the error next to
          // the flagged control and can fix it, like the publish-location
          // refusal in the action loop above.
          const row = await getEvent(db, key);
          if (!row) return eventNotFound(c);
          return formError(
            c,
            err,
            (errors, v) =>
              c.html(<EventFormPage mode="edit" row={row} values={v} errors={errors} />),
            await eventValues(row),
          );
        }
        throw err;
      }
    },
  );

  admin.get("/featured", async (c) => {
    declareAccess(c, {
      resource: "featured_contents",
      action: "list",
      route: "admin.featured.index",
    });
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const query = parseFeaturedListQuery(c.req.query());
    const fetched = await listFeatured(db, {
      ...query,
      published: query.published ? query.published === "1" : undefined,
    });
    const rows = fetched.slice(0, FEATURED_PAGE_SIZE);
    return bufferedMemberHtml(
      c,
      <FeaturedPage rows={rows} query={query} hasNext={fetched.length > FEATURED_PAGE_SIZE} />,
    );
  });

  admin.get("/featured/new", (c) => {
    declareAccess(c, {
      resource: "featured_contents",
      action: "view",
      route: "admin.featured.create",
    });
    return bufferedMemberHtml(
      c,
      <FeaturedFormPage
        appUrl={c.env.APP_URL}
        imageHosts={c.env.FEATURED_IMAGE_HOSTS}
        mode="new"
        values={{}}
        errors={{}}
      />,
    );
  });

  admin.post(
    "/featured",
    // Cap first: refuse an oversized editorial body before spending admin-write throttle.
    requestBodyLimit("featured"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      const values = await parsedForm(c);
      if (!values) return badRequest(c);
      let input;
      try {
        input = parseFeaturedForm(values, c.env.FEATURED_IMAGE_HOSTS);
      } catch (err) {
        if (err instanceof ValidationError) {
          return formError(
            c,
            err,
            (errors, v) =>
              c.html(
                <FeaturedFormPage
                  appUrl={c.env.APP_URL}
                  imageHosts={c.env.FEATURED_IMAGE_HOSTS}
                  mode="new"
                  values={v}
                  errors={errors}
                />,
              ),
            values,
          );
        }
        throw err;
      }
      const row = await createFeatured(db, c.get("adminActor"), input);
      return c.redirect(`/admin/featured/${row.id}`, 303);
    },
  );

  admin.get("/featured/:id", async (c) => {
    declareAccess(c, {
      resource: "featured_contents",
      action: "view",
      route: "admin.featured.edit",
    });
    const id = parseRecordId(c.req.param("id"));
    if (id === null) return featuredNotFound(c);
    const db = await dbOr503(c);
    if (!db) return adminUnavailable(c);
    const row = await getFeatured(db, id);
    if (!row) return featuredNotFound(c);
    return bufferedMemberHtml(
      c,
      <FeaturedFormPage
        appUrl={c.env.APP_URL}
        imageHosts={c.env.FEATURED_IMAGE_HOSTS}
        mode="edit"
        row={row}
        values={await featuredValues(row)}
        errors={{}}
      />,
    );
  });

  admin.post(
    "/featured/:id",
    // Cap first: refuse an oversized editorial body before spending admin-write throttle.
    requestBodyLimit("featured"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const id = parseRecordId(c.req.param("id"));
      if (id === null) return featuredNotFound(c);
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      const existing = await getFeatured(db, id);
      if (!existing) return featuredNotFound(c);
      const values = await parsedForm(c);
      if (!values) return badRequest(c);
      const baseline = values[SAVE_BASELINE_FIELD];
      if (!isSaveBaseline(baseline)) return refusedFeaturedSave(c, existing, values, 400);
      if (baseline !== (await featuredSaveBaseline(existing))) {
        return refusedFeaturedSave(c, existing, values, 409);
      }
      let input;
      try {
        input = parseFeaturedForm(values, c.env.FEATURED_IMAGE_HOSTS);
      } catch (err) {
        if (err instanceof ValidationError) {
          return formError(
            c,
            err,
            (errors, v) =>
              c.html(
                <FeaturedFormPage
                  appUrl={c.env.APP_URL}
                  imageHosts={c.env.FEATURED_IMAGE_HOSTS}
                  mode="edit"
                  row={existing}
                  values={v}
                  errors={errors}
                />,
              ),
            values,
          );
        }
        throw err;
      }
      try {
        const row = await updateFeatured(db, c.get("adminActor"), id, input, baseline);
        return c.redirect(`/admin/featured/${row.id}`, 303);
      } catch (err) {
        if (err instanceof NotFoundError) return featuredNotFound(c);
        if (err instanceof StaleSaveError) {
          return refusedFeaturedSave(c, err.current as FeaturedEditRow, values, 409);
        }
        throw err;
      }
    },
  );

  admin.post(
    "/featured/:id/unpublish",
    // Cap first: refuse an oversized body before spending admin-write throttle.
    requestBodyLimit("action"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const id = parseRecordId(c.req.param("id"));
      if (id === null) return featuredNotFound(c);
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      try {
        await unpublishFeatured(db, c.get("adminActor"), id);
        return c.redirect("/admin/featured", 303);
      } catch (err) {
        if (err instanceof NotFoundError) return featuredNotFound(c);
        throw err;
      }
    },
  );

  admin.post(
    "/featured/:id/delete",
    // Cap first: refuse an oversized body before spending admin-write throttle.
    requestBodyLimit("action"),
    throttle("admin-write", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      const id = parseRecordId(c.req.param("id"));
      if (id === null) return featuredNotFound(c);
      const db = await dbOr503(c);
      if (!db) return writeUnavailable(c);
      try {
        await deleteFeatured(db, c.get("adminActor"), id);
        return c.redirect("/admin/featured", 303);
      } catch (err) {
        if (err instanceof NotFoundError) return featuredNotFound(c);
        throw err;
      }
    },
  );

  return admin;
}

async function eventValues(row: EventRow): Promise<Record<string, unknown>> {
  // A validation refusal can retain a corrupt stored zone or instant. Keep the
  // bad zone visible for correction, but never format it or invent wall times.
  const knownTimezone = isKnownTimezone(row.timezone);
  return {
    [SAVE_BASELINE_FIELD]: await eventSaveBaseline(row),
    title: row.title,
    game: row.game ?? "",
    description: row.description ?? "",
    accessibility_notes: row.accessibilityNotes ?? "",
    // Wall text in the row's zone — what the moderator typed is what they see.
    starts_at:
      knownTimezone && Number.isFinite(row.startsAt.getTime())
        ? utcToWall(row.startsAt, row.timezone)
        : "",
    ends_at:
      knownTimezone && Number.isFinite(row.endsAt.getTime())
        ? utcToWall(row.endsAt, row.timezone)
        : "",
    timezone: row.timezone,
    location: row.location ?? "",
    organizer_name: row.organizer_name ?? "",
    join_url: row.join_url ?? "",
    join_instructions: row.join_instructions ?? "",
    capacity: row.capacity === null ? "" : String(row.capacity),
  };
}

async function featuredValues(row: FeaturedEditRow): Promise<Record<string, unknown>> {
  return {
    [SAVE_BASELINE_FIELD]: await featuredSaveBaseline(row),
    title: row.title,
    body: row.body ?? "",
    url: row.url ?? "",
    image_url: row.imageUrl ?? "",
    image_alt: row.imageAlt ?? "",
    is_published: row.isPublished ? "on" : "",
    position: String(row.position),
    starts_at: row.startsAtText ?? "",
    ends_at: row.endsAtText ?? "",
  };
}

export { SESSION_GUEST_REDIRECT };
