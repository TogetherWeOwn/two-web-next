// Moderator event writes (JSON): POST /events, PATCH /events/:key and the
// publish/cancel/rsvp-pause/rsvp-reopen transitions. Split out of
// src/events/routes.tsx; behavior unchanged.
import type { Context, MiddlewareHandler } from "hono";
import { getSignedCookie } from "hono/cookie";
import { dbFor } from "../admin/db";
import {
  NotFoundError,
  createEvent,
  patchEvent,
  setRsvpOpen,
  transitionEvent,
} from "../admin/store";
import { ValidationError, parseEventForm } from "../admin/validation";
import { dispatchWriteBack } from "../admin/writeback";
import { requestBodyLimit } from "../body-limit";
import { exceptionClass } from "../alerts";
import type { Env, Session } from "../env";
import { createRateLimitedWarn } from "../log-budget";
import { safeRequestId } from "../request-log";
import { jsonRefusal } from "../json-refusal";
import { WRITE_THROTTLE_PER_MINUTE, throttle } from "../throttle";
import { expiredWriteBounce } from "../write-recovery";
import { eventKeyAllowed } from "./keys";
import { getPublicEvent, withGoingCount } from "./reads";
import {
  body,
  dbUnavailableJson,
  eventJson,
  type App,
  type Ctx,
  type SessionReader,
} from "./routes-shared";
import { SESSION_COOKIE } from "../session-cookie";
import { isValidSessionToken } from "../sessions";

async function moderator(c: Ctx, readFragmentSession: SessionReader): Promise<Session | Response> {
  // Non-rotating: concurrent writes with one cookie must all authenticate.
  // A well-formed presented bearer with no live row (expired/revoked/rotated)
  // is an expired guest, not an unknown guest: writes recover through
  // expiredWriteBounce, matching the profile/admin gates (TOG-10357/TOG-12399).
  // These routes are JSON-only, so the bounce is always 401 with a recovery
  // link, never a 303 a header-less fetch would follow to a 200 page. A
  // request with no cookie — or a correctly-signed but malformed bearer, which
  // readSession already rejects as guest with zero store reads — keeps the
  // bare unauthenticated refusal the admission pins assert.
  const session = await readFragmentSession(c);
  if (!session) {
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    if (isValidSessionToken(token)) return expiredWriteBounce(c, true);
    return jsonRefusal(c, "unauthenticated", 401);
  }
  if (!session.moderator) return jsonRefusal(c, "forbidden", 403);
  return session;
}

class UnsupportedMediaTypeError extends Error {}

// Media types are case-insensitive (RFC 2045 §5.1) and may carry parameters:
// compare only the type/subtype before `;`, trimmed and lowercased. Anything
// else (including a missing Content-Type) is not an event body at all: the
// form parser would otherwise answer `{}` for those, which PATCH would merge
// with the stored row and acknowledge as a successful (but ignored) edit.
// Mirrors the profile save gate in src/profiles/routes-writes.tsx.
const mediaType = (value: string | null | undefined): string =>
  (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonMediaType = (value: string | null | undefined): boolean =>
  mediaType(value) === "application/json";
const isFormMediaType = (value: string | null | undefined): boolean => {
  const mt = mediaType(value);
  return mt === "application/x-www-form-urlencoded" || mt === "multipart/form-data";
};

// Malformed-body warns share one bucket: a body-spraying prober emits at
// most burst warns, then one shed per window, instead of one line per 422.
// 415s (admission refusal before the body is read) and well-formed
// validation 422s stay silent and spend nothing.
const malformedLog = createRateLimitedWarn({ shedLine: "event.write.shed" });

async function eventBody(c: Pick<Ctx, "req" | "get">): Promise<Record<string, unknown>> {
  // Event edits must not turn malformed/non-object JSON into an empty PATCH.
  // Keep the RSVP trap's permissive body parsing independent of this admission:
  // a form body that fails to parse is a 422 here, never an empty edit that
  // gets written, audited, and re-synced to Discord.
  const contentType = c.req.header("content-type");
  // Malformed-body warn fields: the refused content-type plus the exception
  // class only, never body bytes. The 422 shapes below are unchanged.
  const warnMalformed = (exception: string): void => {
    const requestId = safeRequestId(c.get("requestId"));
    malformedLog.warn("event.write.malformed_body", {
      exception,
      content_type: mediaType(contentType),
      ...(requestId ? { request_id: requestId } : {}),
    });
  };
  if (isJsonMediaType(contentType)) {
    let parseError: unknown;
    const input: unknown = await c.req.json().catch((err) => {
      parseError = err;
      return null;
    });
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      // A parse failure carries its real class (usually SyntaxError); a
      // well-formed non-object body carries TypeError (expected an object).
      warnMalformed(parseError !== undefined ? exceptionClass(parseError) : "TypeError");
      throw new ValidationError({ body: "Send a JSON object." });
    }
    return input as Record<string, unknown>;
  }
  if (isFormMediaType(contentType)) {
    try {
      return await body(c, { onMalformedForm: "throw" });
    } catch (err) {
      warnMalformed(exceptionClass(err));
      throw new ValidationError({ body: "Send a valid form body." });
    }
  }
  throw new UnsupportedMediaTypeError(`Unsupported media type: ${contentType ?? ""}`);
}

const invalid = (c: Context<any>, err: ValidationError) =>
  jsonRefusal(c, "invalid", 422, { fields: err.fields });

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
    requestBodyLimit("json"),
    throttle("event-write", WRITE_THROTTLE_PER_MINUTE),
    moderatorGate,
    async (c) => {
      const who = c.get("eventModerator");
      const db = await dbFor(c);
      if (!db) return dbUnavailableJson(c);
      try {
        const { row } = await createEvent(
          db,
          { id: who.id, username: who.username },
          parseEventForm(await eventBody(c)),
        );
        return c.json({ data: eventJson({ ...row, goingCount: 0, goingOccupancy: 0 }) }, 201);
      } catch (err) {
        if (err instanceof UnsupportedMediaTypeError)
          return jsonRefusal(c, "unsupported_media_type", 415);
        if (err instanceof ValidationError) return invalid(c, err);
        throw err;
      }
    },
  );

  app.patch(
    "/events/:key",
    requestBodyLimit("json"),
    throttle("event-write", WRITE_THROTTLE_PER_MINUTE),
    moderatorGate,
    async (c) => {
      const who = c.get("eventModerator");
      const db = await dbFor(c);
      if (!db) return dbUnavailableJson(c);
      const key = c.req.param("key");
      if (!eventKeyAllowed(key, c.env.APP_URL)) return jsonRefusal(c, "not_found", 404);
      try {
        // PATCH: omitted fields resolve from the locked row inside the same
        // transaction that commits the update (patchEvent), never from a
        // pre-lock snapshot, so concurrent disjoint edits both survive.
        const patch = await eventBody(c);
        // `status`/`rsvpOpen` are transitioned through the publish/cancel and
        // rsvp-pause/rsvp-reopen actions, never edited: the parser and writer
        // below never read them, so a silent merge would answer 200 with the
        // row visibly unchanged and mislead the moderator. Presence is refused,
        // even when the value repeats what is stored.
        const extraneous: Record<string, string> = {};
        if (patch.status !== undefined)
          extraneous.status = "Change the status with the publish/cancel actions, not by editing.";
        // Both spellings: the read envelope serializes `rsvp_open`, so a client
        // echoing the GET shape back must hit the same refusal (both-spellings
        // precedent: event_key/eventKey in parseEventForm).
        if (patch.rsvpOpen !== undefined || patch.rsvp_open !== undefined)
          extraneous.rsvpOpen =
            "Change RSVP availability with the rsvp-pause/rsvp-reopen actions, not by editing.";
        if (Object.keys(extraneous).length > 0) throw new ValidationError(extraneous);
        const { row, writeBack, childWriteBacks } = await patchEvent(
          db,
          { id: who.id, username: who.username },
          key,
          patch,
        );
        if (writeBack) await dispatchWriteBack(c.env, writeBack, c.get("requestId"));
        for (const wb of childWriteBacks) await dispatchWriteBack(c.env, wb, c.get("requestId"));
        const updated = await getPublicEvent(db, row.eventKey);
        return c.json({ data: eventJson(updated!) });
      } catch (err) {
        if (err instanceof UnsupportedMediaTypeError)
          return jsonRefusal(c, "unsupported_media_type", 415);
        if (err instanceof ValidationError) return invalid(c, err);
        if (err instanceof NotFoundError) return jsonRefusal(c, "not_found", 404);
        throw err;
      }
    },
  );

  for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
    app.post(
      `/events/:key/${action}`,
      requestBodyLimit("action"),
      throttle("event-write", WRITE_THROTTLE_PER_MINUTE),
      moderatorGate,
      async (c) => {
        const who = c.get("eventModerator");
        const db = await dbFor(c);
        if (!db) return dbUnavailableJson(c);
        try {
          const actor = { id: who.id, username: who.username };
          const key = c.req.param("key");
          if (!eventKeyAllowed(key, c.env.APP_URL)) return jsonRefusal(c, "not_found", 404);
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
          if (err instanceof NotFoundError) return jsonRefusal(c, "not_found", 404);
          throw err;
        }
      },
    );
  }
}
