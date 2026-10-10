// Moderator event writes (JSON): POST /events, PATCH /events/:key and the
// publish/cancel/rsvp-pause/rsvp-reopen transitions. Split out of
// src/events/routes.tsx; behavior unchanged.
import type { MiddlewareHandler } from "hono";
import { getSignedCookie } from "hono/cookie";
import { dbFor } from "../admin/db";
import {
  NotFoundError,
  createEvent,
  getEvent,
  setRsvpOpen,
  transitionEvent,
  updateEvent,
} from "../admin/store";
import { ValidationError, isKnownTimezone, parseEventForm } from "../admin/validation";
import { dispatchWriteBack } from "../admin/writeback";
import { requestBodyLimit } from "../body-limit";
import type { Env, Session } from "../env";
import { WRITE_THROTTLE_PER_MINUTE, throttle } from "../throttle";
import { expiredWriteBounce } from "../write-recovery";
import { getPublicEvent, withGoingCount } from "./reads";
import { body, eventJson, type App, type Ctx, type SessionReader } from "./routes-shared";
import { SESSION_COOKIE } from "../session-cookie";

async function moderator(c: Ctx, readFragmentSession: SessionReader): Promise<Session | Response> {
  // Non-rotating: concurrent writes with one cookie must all authenticate.
  // A presented bearer with no live row (expired/revoked/rotated) is an
  // expired guest, not an unknown guest: writes recover through
  // expiredWriteBounce, matching the profile/admin gates (TOG-10357/TOG-12399).
  // These routes are JSON-only, so the bounce is always 401 with a recovery
  // link, never a 303 a header-less fetch would follow to a 200 page. A
  // request with no cookie at all keeps the bare unauthenticated refusal the
  // admission pins assert.
  const session = await readFragmentSession(c);
  if (!session) {
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    if (token) return expiredWriteBounce(c, true);
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (!session.moderator) return c.json({ error: "forbidden" }, 403);
  return session;
}

async function eventBody(c: Pick<Ctx, "req">): Promise<Record<string, unknown>> {
  // Event edits must not turn malformed/non-object JSON into an empty PATCH.
  // Keep the RSVP trap's permissive body parsing independent of this admission:
  // a form body that fails to parse is a 422 here, never an empty edit that
  // gets written, audited, and re-synced to Discord.
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
    try {
      return await body(c, { onMalformedForm: "throw" });
    } catch {
      throw new ValidationError({ body: "Send a valid form body." });
    }
  }
  const input: unknown = await c.req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError({ body: "Send a JSON object." });
  }
  return input as Record<string, unknown>;
}

const invalid = (c: Pick<Ctx, "json">, err: ValidationError) =>
  c.json({ error: "invalid", fields: err.fields }, 422);

export function registerWriteRoutes(app: App, readFragmentSession: SessionReader): void {
  const moderatorGate: MiddlewareHandler<{
    Bindings: Env;
    Variables: { eventModerator: Session };
  }> = async (c, next) => {
    // The session reader uses only bindings/cookies, not this gate's variables.
    const who = await moderator(c as unknown as Ctx, readFragmentSession);
    if (who instanceof Response) return who;
    c.set("eventModerator", who);
    await next();
  };

  app.post(
    "/events",
    throttle("event-write", WRITE_THROTTLE_PER_MINUTE),
    moderatorGate,
    requestBodyLimit("json"),
    async (c) => {
      const who = c.get("eventModerator");
      const db = await dbFor(c);
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      try {
        const { row } = await createEvent(
          db,
          { id: who.id, username: who.username },
          parseEventForm(await eventBody(c)),
        );
        return c.json({ data: eventJson({ ...row, goingCount: 0 }) }, 201);
      } catch (err) {
        if (err instanceof ValidationError) return invalid(c, err);
        throw err;
      }
    },
  );

  app.patch(
    "/events/:key",
    throttle("event-write", WRITE_THROTTLE_PER_MINUTE),
    moderatorGate,
    requestBodyLimit("json"),
    async (c) => {
      const who = c.get("eventModerator");
      const db = await dbFor(c);
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const key = c.req.param("key");
      const existing = await getEvent(db, key);
      if (!existing) return c.json({ error: "not_found" }, 404);
      try {
        // PATCH: unspecified fields keep their stored value.
        const patch = await eventBody(c);
        const merged = {
          title: existing.title,
          game: existing.game,
          description: existing.description,
          timezone: existing.timezone,
          location: existing.location,
          capacity: existing.capacity,
          ...patch,
        } as Record<string, unknown>;
        // Match parseEventForm's zone default before deriving omitted wall times.
        const tz =
          typeof merged.timezone === "string"
            ? merged.timezone.trim() || "Europe/London"
            : "Europe/London";
        if (!isKnownTimezone(tz))
          throw new ValidationError({ timezone: `Unknown timezone: ${tz}.` });
        const wall = (d: Date) =>
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: tz,
            dateStyle: "short",
            timeStyle: "short",
          }).format(d);
        merged.starts_at ??= wall(existing.startsAt);
        merged.ends_at ??= wall(existing.endsAt);
        const input = parseEventForm(merged, {
          startsAtUtc: existing.startsAt.toISOString(),
          endsAtUtc: existing.endsAt.toISOString(),
        });
        const { row, writeBack, childWriteBacks } = await updateEvent(
          db,
          { id: who.id, username: who.username },
          key,
          input,
        );
        if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
        for (const wb of childWriteBacks) await dispatchWriteBack(c.env, wb, c.get("requestId"));
        const updated = await getPublicEvent(db, row.eventKey);
        return c.json({ data: eventJson(updated!) });
      } catch (err) {
        if (err instanceof ValidationError) return invalid(c, err);
        if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
        throw err;
      }
    },
  );

  for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
    app.post(
      `/events/:key/${action}`,
      throttle("event-write", WRITE_THROTTLE_PER_MINUTE),
      moderatorGate,
      requestBodyLimit("action"),
      async (c) => {
        const who = c.get("eventModerator");
        const db = await dbFor(c);
        if (!db) return c.json({ error: "db_unavailable" }, 503);
        try {
          const actor = { id: who.id, username: who.username };
          const key = c.req.param("key");
          const { row, writeBack } =
            action === "rsvp-pause" || action === "rsvp-reopen"
              ? await setRsvpOpen(db, actor, key, action === "rsvp-reopen")
              : await transitionEvent(
                  db,
                  actor,
                  key,
                  action === "publish" ? "published" : "cancelled",
                );
          if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
          return c.json({ data: eventJson(await withGoingCount(db, row)) });
        } catch (err) {
          if (err instanceof ValidationError) return invalid(c, err);
          if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
          throw err;
        }
      },
    );
  }
}
