// Admin routes (W11 pt1). Ports the Filament panel screens the legacy admin ran
// on, minus Filament: HTML tables + forms in this repo's JSX idiom.
//
// Routes (all behind adminGuard — moderator 403, guest OAuth redirect):
// - GET  /admin                      dashboard (index of resources)
// - GET  /admin/events               list (q + status filter)
// - GET  /admin/events/new           create form
// - POST /admin/events               create-as-draft (no delete anywhere)
// - GET  /admin/events/:key          edit form
// - POST /admin/events/:key          update
// - POST /admin/events/:key/publish  draft → published (write-back due)
// - POST /admin/events/:key/cancel   draft|published → cancelled
// - GET  /admin/join-attempts        read-only join audit viewer (W12 M8)
// - GET  /admin/featured             list, position order
// - GET  /admin/featured/new         create form
// - POST /admin/featured             create
// - GET  /admin/featured/:id         edit form
// - POST /admin/featured/:id         update
// - POST /admin/featured/:id/delete  delete (safe: nothing refers to it)
//
// Read routes declare their member-data subjects via c.set("access") so the
// guard flushes the access log (M5). Writes leave the audit trail in the
// store (M7) and dispatch the write-back seam where one is due (M3).

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { dbFor } from "./db";
import { type AccessDecl, type Actor, type AdminOverrides, adminGuard } from "./guard";
import type { SessionStore } from "../sessions";
import {
  type EventRow,
  type FeaturedRow,
  createEvent,
  createFeatured,
  deleteFeatured,
  getEvent,
  getFeatured,
  listEvents,
  listFeatured,
  NotFoundError,
  transitionEvent,
  updateEvent,
  updateFeatured,
} from "./store";
import { JOIN_OUTCOMES } from "../join/service";
import { joinFunnelStats, listJoinAttempts, listRoster } from "./reads";
import { parseRecurrenceForm } from "./recurrence";
import { parseEventForm, parseFeaturedForm, utcToWall, ValidationError } from "./validation";
import { dispatchWriteBack } from "./writeback";
import { AdminDashboard, ErrorPage, EventFormPage, EventsPage, FeaturedFormPage, FeaturedPage, JoinAttemptsPage } from "./pages";

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
  return c.html(<ErrorPage heading={heading} detail={detail} />);
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

  admin.get("/", async (c) => {
    declareAccess(c, { resource: "dashboard", action: "view", route: "admin.dashboard", subjects: [] });
    // Funnel counts are outcomes only (no member data): no access-log subjects.
    // No DB (bare-guard tests / unconfigured): the widget is omitted, not fatal.
    const db = await dbFor(c);
    const funnel = db ? await joinFunnelStats(db) : undefined;
    return c.html(<AdminDashboard actor={c.get("adminActor")} funnel={funnel} />);
  });

  admin.get("/join-attempts", async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const outcome = c.req.query("outcome") ?? "";
    const q = (c.req.query("q") ?? "").trim();
    const rows = await listJoinAttempts(db, { outcome: outcome || undefined, q: q || undefined });
    declareAccess(c, {
      resource: "join_attempts",
      action: "list",
      route: "admin.join-attempts.index",
      subjects: rows.flatMap((r) => (r.discordId ? [r.discordId] : [])),
    });
    return c.html(<JoinAttemptsPage rows={rows} outcome={outcome} q={q} outcomes={JOIN_OUTCOMES} />);
  });

  admin.get("/events", async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const q = c.req.query("q") ?? undefined;
    const status = c.req.query("status") ?? undefined;
    const rows = await listEvents(db, { q, status });
    declareAccess(c, {
      resource: "events",
      action: "list",
      route: "admin.events.index",
      subjects: rows.map((r) => r.eventKey),
    });
    return c.html(<EventsPage rows={rows} q={q ?? ""} status={status ?? ""} />);
  });

  admin.get("/events/new", (c) => {
    declareAccess(c, { resource: "events", action: "view", route: "admin.events.create", subjects: [] });
    return c.html(<EventFormPage mode="new" values={{}} errors={{}} />);
  });

  admin.post("/events", async (c) => {
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
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const row = await getEvent(db, c.req.param("key"));
    if (!row) return errorPage(c, 404, "Event not found");
    const roster = await listRoster(db, row.eventKey);
    // The roster is member data: the viewed members are the access-log subjects.
    declareAccess(c, {
      resource: "events",
      action: "view",
      route: "admin.events.edit",
      subjects: roster.map((r) => r.userId),
    });
    return c.html(
      <EventFormPage
        mode="edit"
        row={row}
        values={eventValues(row)}
        errors={{}}
        roster={roster}
      />,
    );
  });

  admin.post("/events/:key", async (c) => {
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
      if (writeBack) await dispatchWriteBack(c.env, writeBack);
      for (const wb of childWriteBacks) await dispatchWriteBack(c.env, wb);
      return c.redirect(`/admin/events/${row.eventKey}`, 303);
    } catch (err) {
      if (err instanceof NotFoundError) return errorPage(c, 404, "Event not found");
      throw err;
    }
  });

  for (const action of ["publish", "cancel"] as const) {
    admin.post(`/events/:key/${action}`, async (c) => {
      const db = await dbOr503(c);
      if (!db) return c.text("Admin temporarily unavailable", 503);
      try {
        const to = action === "publish" ? "published" : "cancelled";
        const { row, writeBack } = await transitionEvent(db, c.get("adminActor"), c.req.param("key"), to);
        if (writeBack) await dispatchWriteBack(c.env, writeBack);
        return c.redirect(`/admin/events/${row.eventKey}`, 303);
      } catch (err) {
        if (err instanceof NotFoundError) return errorPage(c, 404, "Event not found");
        if (err instanceof ValidationError) {
          return errorPage(c, 422, "That transition is not allowed", err.fields.status);
        }
        throw err;
      }
    });
  }

  admin.get("/featured", async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const rows = await listFeatured(db, {});
    declareAccess(c, {
      resource: "featured_contents",
      action: "list",
      route: "admin.featured.index",
      subjects: rows.map((r) => String(r.id)),
    });
    return c.html(<FeaturedPage rows={rows} />);
  });

  admin.get("/featured/new", (c) => {
    declareAccess(c, { resource: "featured_contents", action: "view", route: "admin.featured.create", subjects: [] });
    return c.html(<FeaturedFormPage mode="new" values={{}} errors={{}} />);
  });

  admin.post("/featured", async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const values = formData(await c.req.parseBody());
    let input;
    try {
      input = parseFeaturedForm(values);
    } catch (err) {
      if (err instanceof ValidationError) {
        return formError(
          c,
          err,
          (errors, v) => c.html(<FeaturedFormPage mode="new" values={v} errors={errors} />),
          values,
        );
      }
      throw err;
    }
    const row = await createFeatured(db, c.get("adminActor"), input);
    return c.redirect(`/admin/featured/${row.id}`, 303);
  });

  admin.get("/featured/:id", async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return errorPage(c, 404, "Featured content not found");
    const row = await getFeatured(db, id);
    if (!row) return errorPage(c, 404, "Featured content not found");
    declareAccess(c, {
      resource: "featured_contents",
      action: "view",
      route: "admin.featured.edit",
      subjects: [String(row.id)],
    });
    return c.html(<FeaturedFormPage mode="edit" row={row} values={featuredValues(row)} errors={{}} />);
  });

  admin.post("/featured/:id", async (c) => {
    const db = await dbOr503(c);
    if (!db) return c.text("Admin temporarily unavailable", 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return errorPage(c, 404, "Featured content not found");
    const existing = await getFeatured(db, id);
    if (!existing) return errorPage(c, 404, "Featured content not found");
    const values = formData(await c.req.parseBody());
    let input;
    try {
      input = parseFeaturedForm(values);
    } catch (err) {
      if (err instanceof ValidationError) {
        return formError(
          c,
          err,
          (errors, v) => c.html(<FeaturedFormPage mode="edit" row={existing} values={v} errors={errors} />),
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

  admin.post("/featured/:id/delete", async (c) => {
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

function featuredValues(row: FeaturedRow): Record<string, unknown> {
  const wall = (d: Date | null) =>
    d === null ? "" : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return {
    title: row.title,
    body: row.body ?? "",
    url: row.url ?? "",
    image_url: row.imageUrl ?? "",
    image_alt: row.imageAlt ?? "",
    is_published: row.isPublished ? "on" : "",
    position: String(row.position),
    starts_at: wall(row.startsAt),
    ends_at: wall(row.endsAt),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export { SESSION_GUEST_REDIRECT };
