// Admin routes (W11 pt1). Ports the Filament panel screens the legacy admin ran
// on, minus Filament: HTML tables + forms in this repo's JSX idiom.
//
// Routes (all behind adminGuard — moderator 403, guest OAuth redirect):
// - GET  /admin                      dashboard (index of resources)
// - GET  /admin/events               list (search, status/series/fill, sort, page)
// - GET  /admin/events/new           create form
// - POST /admin/events               create-as-draft (no delete anywhere)
// - GET  /admin/events/:key          edit form
// - POST /admin/events/:key          update
// - POST /admin/events/:key/publish  draft → published (write-back due)
// - POST /admin/events/:key/cancel   draft|published → cancelled
// - GET  /admin/join-attempts        read-only join audit viewer (W12 M8)
// - GET  /admin/join-attempts/:id    read-only attempt detail
// - GET  /admin/featured             list, position order
// - GET  /admin/featured/new         create form
// - POST /admin/featured             create
// - GET  /admin/featured/:id         edit form
// - POST /admin/featured/:id         update
// - POST /admin/featured/:id/delete  delete (safe: nothing refers to it)
//
// Read routes declare stable metadata; keyed retrieval owns the subjects and
// the guard flushes before releasing buffered HTML (M5). Writes leave the
// audit trail in the store (M7) and dispatch write-back where due (M3).

import { WRITE_THROTTLE_PER_MINUTE, throttle } from "../throttle";
import { requestBodyLimit } from "../body-limit";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { dbFor, type EnvWithAdminDb } from "./db";
import { bufferedMemberHtml, bufferedMemberText } from "../member-reads";
import { EVENT_PAGE_SIZE, parseEventListQuery } from "./event-list";
import { JOIN_ATTEMPT_PAGE_SIZE, parseFeaturedListQuery, parseJoinAttemptsQuery, parseRosterQuery } from "./table-list";
import { type AccessDecl, type Actor, type AdminOverrides, adminGuard } from "./guard";
import type { SessionStore } from "../sessions";
import {
  type EventRow,
  type FeaturedEditRow,
  createEvent,
  createFeatured,
  deleteFeatured,
  getEvent,
  getFeatured,
  getFeaturedIdByLegacyId,
  listEvents,
  listFeatured,
  NotFoundError,
  setRsvpOpen,
  transitionEvent,
  updateEvent,
  updateFeatured,
} from "./store";
import { topZeroResultSearches } from "../events/search-log";
import { JOIN_OUTCOMES } from "../join/service";
import { databaseUrl } from "../db/connection";
import { dashboardJoinFunnel, FUNNEL_READ_DEADLINE_MS } from "./join-funnel";
import { getJoinAttempt, listJoinAttempts, listRoster } from "./reads";
import { parseRecurrenceForm } from "./recurrence";
import { parseEventForm, parseFeaturedForm, utcToWall, ValidationError } from "./validation";
import { dispatchWriteBack } from "./writeback";
import { AdminDashboard, ErrorPage, EventFormPage, EventsPage, FeaturedFormPage, FeaturedPage, JoinAttemptPage, JoinAttemptsPage } from "./pages";

type Vars = {
  Bindings: Env;
  Variables: { adminActor: Actor; access: AccessDecl };
};

const SESSION_GUEST_REDIRECT = "/auth/discord";

function formData(body: Record<string, string | File>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
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
) {
  c.status(status);
  return bufferedMemberHtml(c, <ErrorPage heading={heading} detail={detail} />, status);
}

/** Validation errors re-render the form (422). */
function formError(
  c: Context<Vars>,
  err: ValidationError,
  render: (errors: Record<string, string>, values: Record<string, unknown>) => Response | Promise<Response>,
  values: Record<string, unknown>,
): Response | Promise<Response> {
  c.status(422);
  return render(err.fields, values);
}

/**
 * Optional overrides (tests only — production resolves through the seams).
 * A bare SessionStore overrides session resolution (guard pins); live route
 * tests pass `{ sessionStore, db }` so sessions resolve from memory while
 * admin tables read/write Postgres.
 */
export function adminApp(overrides?: AdminOverrides | SessionStore) {
  const admin = new Hono<Vars>();
  admin.use("/*", adminGuard(overrides));

  // Legacy Filament bookmarks: guard first, no query forwarding.
  // Only the featured edit alias needs a resource read to resolve the imported ID.
  // Keep the literal create alias ahead of /events/:key.
  admin.get("/events/create", (c) => legacyRedirect(c, "/admin/events/new", "events", "admin.events.legacy-create"));
  admin.get("/events/:key/edit", (c) => legacyRedirect(c, `/admin/events/${encodeURIComponent(c.req.param("key"))}`, "events", "admin.events.legacy-edit"));
  admin.get("/featured-contents", (c) => legacyRedirect(c, "/admin/featured", "featured_contents", "admin.featured.legacy-index"));
  admin.get("/featured-contents/create", (c) => legacyRedirect(c, "/admin/featured/new", "featured_contents", "admin.featured.legacy-create"));
  admin.get("/featured-contents/:id/edit", async (c) => {
    declareAccess(c, { resource: "featured_contents", action: "view", route: "admin.featured.legacy-edit" });
    const legacyId = c.req.param("id");
    if (!/^[1-9]\d*$/.test(legacyId)) return errorPage(c, 404, "Featured content not found");
    try {
      const db = await dbOr503(c);
      if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
      const id = await getFeaturedIdByLegacyId(db, legacyId);
      if (id === null) return errorPage(c, 404, "Featured content not found");
      return legacyRedirect(c, `/admin/featured/${id}`, "featured_contents", "admin.featured.legacy-edit");
    } catch {
      return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    }
  });

  admin.get("/", async (c) => {
    declareAccess(c, { resource: "dashboard", action: "view", route: "admin.dashboard" });
    // Funnel counts are outcomes only (no member data): no access-log subjects.
    // No DB (bare-guard tests / unconfigured): the widget is omitted, not fatal.
    const db = await dbFor(c);
    // Match dbFor's precedence: an injected ADMIN_DB overrides either URL.
    const identity = (c.env as EnvWithAdminDb).ADMIN_DB || databaseUrl(c.env) || db;
    // Start both optional analytics reads together with the same 500 ms budget,
    // rather than stacking their deadlines. Failed/blocked widgets are omitted;
    // authorization and the guard's critical access-log write stay fail-closed.
    const [funnel, zeroSearches] = db ? await Promise.all([
      dashboardJoinFunnel(db, identity),
      topZeroResultSearches(db, 10, FUNNEL_READ_DEADLINE_MS),
    ]) : [undefined, undefined];
    return bufferedMemberHtml(c, <AdminDashboard actor={c.get("adminActor")} funnel={funnel} zeroSearches={zeroSearches} />);
  });

  admin.get("/join-attempts", async (c) => {
    declareAccess(c, { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" });
    const db = await dbOr503(c);
    if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    const query = parseJoinAttemptsQuery(c.req.query());
    const fetched = await listJoinAttempts(db, query);
    const rows = fetched.slice(0, JOIN_ATTEMPT_PAGE_SIZE);
    return bufferedMemberHtml(c, <JoinAttemptsPage rows={rows} query={query} hasNext={fetched.length > JOIN_ATTEMPT_PAGE_SIZE} outcomes={JOIN_OUTCOMES} />);
  });

  admin.get("/join-attempts/:id", async (c) => {
    declareAccess(c, { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" });
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) {
      return errorPage(c, 404, "Join attempt not found");
    }
    const db = await dbOr503(c);
    if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    const result = await getJoinAttempt(db, id);
    if (!result) return errorPage(c, 404, "Join attempt not found");
    return bufferedMemberHtml(c, <JoinAttemptPage row={result.attempt} />);
  });

  admin.get("/events", async (c) => {
    declareAccess(c, { resource: "events", action: "list", route: "admin.events.index" });
    const db = await dbOr503(c);
    if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    const params = c.req.query();
    const query = parseEventListQuery(params);
    const fetched = await listEvents(db, params);
    const rows = fetched.slice(0, EVENT_PAGE_SIZE);
    return bufferedMemberHtml(c, <EventsPage rows={rows} query={query} hasNext={fetched.length > EVENT_PAGE_SIZE} />);
  });

  admin.get("/events/new", (c) => {
    declareAccess(c, { resource: "events", action: "view", route: "admin.events.create" });
    return bufferedMemberHtml(c, <EventFormPage mode="new" values={{}} errors={{}} />);
  });

  admin.post("/events", throttle("admin-write", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("form"), async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const values = formData(await c.req.parseBody());
    let input;
    let recurrence;
    try {
      // Both parsers run so one submit reports every field error; the event
      // rules own starts/timezone errors, the recurrence rules own theirs.
      const errors: Record<string, string> = {};
      try {
        input = parseEventForm(values);
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
        return formError(c, err, (errors, v) => c.html(<EventFormPage mode="new" values={v} errors={errors} />), values);
      }
      throw err;
    }
    const { row } = await createEvent(db, c.get("adminActor"), input!, recurrence ?? null);
    return c.redirect(`/admin/events/${row.eventKey}`, 303);
  });

  admin.get("/events/:key", async (c) => {
    declareAccess(c, { resource: "events", action: "view", route: "admin.events.edit" });
    const db = await dbOr503(c);
    if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    const row = await getEvent(db, c.req.param("key"));
    if (!row) return errorPage(c, 404, "Event not found");
    const rosterQuery = parseRosterQuery(c.req.query());
    const roster = await listRoster(db, row.eventKey, rosterQuery);
    return bufferedMemberHtml(c,
      <EventFormPage
        mode="edit"
        row={row}
        values={eventValues(row)}
        errors={{}}
        roster={roster}
        rosterQuery={rosterQuery}
      />,
    );
  });

  admin.post("/events/:key", throttle("admin-write", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("form"), async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const key = c.req.param("key");
    const existing = await getEvent(db, key);
    if (!existing) return errorPage(c, 404, "Event not found");
    const values = formData(await c.req.parseBody());
    // Hidden carriers: an untouched fold/gap wall time keeps the stored
    // instant (TOG-6805 — see validation.preservedOrParsed).
    const carriers = {
      startsAtUtc: existing.startsAt.toISOString(),
      endsAtUtc: existing.endsAt.toISOString(),
    };
    let input;
    try {
      input = parseEventForm(values, carriers);
    } catch (err) {
      if (err instanceof ValidationError) {
        return formError(
          c,
          err,
          (errors, v) => c.html(<EventFormPage mode="edit" row={existing} values={v} errors={errors} />),
          values,
        );
      }
      throw err;
    }
    try {
      const { row, writeBack, childWriteBacks } = await updateEvent(db, c.get("adminActor"), key, input);
      if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
      for (const wb of childWriteBacks) await dispatchWriteBack(c.env, wb, c.get("requestId"));
      return c.redirect(`/admin/events/${row.eventKey}`, 303);
    } catch (err) {
      if (err instanceof NotFoundError) return errorPage(c, 404, "Event not found");
      if (err instanceof ValidationError) {
        return formError(
          c, err,
          (errors, v) => c.html(<EventFormPage mode="edit" row={existing} values={v} errors={errors} />),
          values,
        );
      }
      throw err;
    }
  });

  for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
    admin.post(`/events/:key/${action}`, throttle("admin-write", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("action"), async (c) => {
      const db = await dbOr503(c);
      if (!db) return c.text("Admin temporarily unavailable", 503);
      try {
        const actor = c.get("adminActor");
        const key = c.req.param("key");
        const { row, writeBack } = action === "rsvp-pause" || action === "rsvp-reopen"
          ? await setRsvpOpen(db, actor, key, action === "rsvp-reopen")
          : await transitionEvent(db, actor, key, action === "publish" ? "published" : "cancelled");
        if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
        return c.redirect(`/admin/events/${row.eventKey}`, 303);
      } catch (err) {
        if (err instanceof NotFoundError) return errorPage(c, 404, "Event not found");
        if (err instanceof ValidationError) {
          return errorPage(c, 422, "That transition is not allowed", err.fields.status ?? err.fields.ends_at ?? err.fields.rsvp_open);
        }
        throw err;
      }
    });
  }

  admin.get("/featured", async (c) => {
    declareAccess(c, { resource: "featured_contents", action: "list", route: "admin.featured.index" });
    const db = await dbOr503(c);
    if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    const query = parseFeaturedListQuery(c.req.query());
    const rows = await listFeatured(db, { ...query, published: query.published ? query.published === "1" : undefined });
    return bufferedMemberHtml(c, <FeaturedPage rows={rows} query={query} />);
  });

  admin.get("/featured/new", (c) => {
    declareAccess(c, { resource: "featured_contents", action: "view", route: "admin.featured.create" });
    return bufferedMemberHtml(c, <FeaturedFormPage appUrl={c.env.APP_URL} imageHosts={c.env.FEATURED_IMAGE_HOSTS} mode="new" values={{}} errors={{}} />);
  });

  admin.post("/featured", throttle("admin-write", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("featured"), async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const values = formData(await c.req.parseBody());
    let input;
    try {
      input = parseFeaturedForm(values, c.env.FEATURED_IMAGE_HOSTS);
    } catch (err) {
      if (err instanceof ValidationError) {
        return formError(
          c,
          err,
          (errors, v) => c.html(<FeaturedFormPage appUrl={c.env.APP_URL} imageHosts={c.env.FEATURED_IMAGE_HOSTS} mode="new" values={v} errors={errors} />),
          values,
        );
      }
      throw err;
    }
    const row = await createFeatured(db, c.get("adminActor"), input);
    return c.redirect(`/admin/featured/${row.id}`, 303);
  });

  admin.get("/featured/:id", async (c) => {
    declareAccess(c, { resource: "featured_contents", action: "view", route: "admin.featured.edit" });
    const db = await dbOr503(c);
    if (!db) return bufferedMemberText(c, "Admin temporarily unavailable", 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return errorPage(c, 404, "Featured content not found");
    const row = await getFeatured(db, id);
    if (!row) return errorPage(c, 404, "Featured content not found");
    return bufferedMemberHtml(c, <FeaturedFormPage appUrl={c.env.APP_URL} imageHosts={c.env.FEATURED_IMAGE_HOSTS} mode="edit" row={row} values={featuredValues(row)} errors={{}} />);
  });

  admin.post("/featured/:id", throttle("admin-write", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("featured"), async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return errorPage(c, 404, "Featured content not found");
    const existing = await getFeatured(db, id);
    if (!existing) return errorPage(c, 404, "Featured content not found");
    const values = formData(await c.req.parseBody());
    let input;
    try {
      input = parseFeaturedForm(values, c.env.FEATURED_IMAGE_HOSTS);
    } catch (err) {
      if (err instanceof ValidationError) {
        return formError(
          c,
          err,
          (errors, v) => c.html(<FeaturedFormPage appUrl={c.env.APP_URL} imageHosts={c.env.FEATURED_IMAGE_HOSTS} mode="edit" row={existing} values={v} errors={errors} />),
          values,
        );
      }
      throw err;
    }
    try {
      const row = await updateFeatured(db, c.get("adminActor"), id, input);
      return c.redirect(`/admin/featured/${row.id}`, 303);
    } catch (err) {
      if (err instanceof NotFoundError) return errorPage(c, 404, "Featured content not found");
      throw err;
    }
  });

  admin.post("/featured/:id/delete", throttle("admin-write", WRITE_THROTTLE_PER_MINUTE), requestBodyLimit("action"), async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return errorPage(c, 404, "Featured content not found");
    try {
      await deleteFeatured(db, c.get("adminActor"), id);
      return c.redirect("/admin/featured", 303);
    } catch (err) {
      if (err instanceof NotFoundError) return errorPage(c, 404, "Featured content not found");
      throw err;
    }
  });

  return admin;
}

function eventValues(row: EventRow): Record<string, unknown> {
  return {
    title: row.title,
    game: row.game ?? "",
    description: row.description ?? "",
    // Wall text in the row's zone — what the moderator typed is what they see.
    starts_at: utcToWall(row.startsAt, row.timezone),
    ends_at: utcToWall(row.endsAt, row.timezone),
    timezone: row.timezone,
    location: row.location ?? "",
    capacity: row.capacity === null ? "" : String(row.capacity),
  };
}

function featuredValues(row: FeaturedEditRow): Record<string, unknown> {
  return {
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
