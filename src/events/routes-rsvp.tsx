// RSVP member writes: PUT/DELETE /events/:key/rsvp, the POST /e/:key/rsvp
// HTML adapter and the 405 fallback. Split out of src/events/routes.tsx;
// behavior unchanged.
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { dbFor } from "../admin/db";
import { requestBodyLimit } from "../body-limit";
import type { Session } from "../env";
import { rateLimitExceeded } from "../errors";
import {
  RSVP_COPY,
  RSVP_HONEY_FIELD,
  loginUrl,
  rsvpHoneyFilled,
  rsvpTrapTripped,
  throttleWaitCopy,
} from "../islands/contracts";
import { eventKeyAllowed } from "./keys";
import { dispatchRsvpSync, isRsvpStatus, withdrawRsvp, writeRsvp, type RsvpAnswer } from "./rsvp";
import { body, type App, type Ctx, type SessionReader } from "./routes-shared";

// One answer per member per event: a singular resource. PUT 201 first / 200 re-answer,
// DELETE 204 always (quiet), any other verb 405. One shared 12/min budget per member.
const rsvpBody = (a: RsvpAnswer) => ({
  data: {
    status: a.status,
    synced_to_discord_at: a.syncedToDiscordAt?.toISOString() ?? null,
    waitlist_position: a.waitlistPosition,
  },
});
const closed = (c: Ctx, why: string) =>
  c.json({ reason: "event_not_open", why, message: "This event is not taking RSVPs." }, 403);

async function member(c: Ctx, readFragmentSession: SessionReader): Promise<Session | Response> {
  // Non-rotating: concurrent writes with one cookie must all authenticate.
  const session = await readFragmentSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  if (!session.member) return c.json({ error: "forbidden" }, 403);
  return session;
}

const putRsvp = async (
  c: Ctx,
  input: Record<string, unknown>,
  readFragmentSession: SessionReader,
): Promise<Response> => {
  c.header("cache-control", "private, no-store");
  // Decoy (TOG-8715): a filled honeypot answers the byte-identical first-write success
  // without touching limiter, auth or DB, and logs nothing. Present non-string
  // values count as filled (fail-closed); absent/empty inputs are genuine.
  if (rsvpTrapTripped(input)) {
    return c.json(
      rsvpBody({
        status: isRsvpStatus(input.status) ? input.status : "going",
        syncedToDiscordAt: null,
        waitlistPosition: null,
      }),
      201,
    );
  }
  const who = await member(c, readFragmentSession);
  if (who instanceof Response) return who;
  if (!isRsvpStatus(input.status))
    return c.json({ error: "invalid", fields: { status: ["status is invalid"] } }, 422);
  // Accepted, then refused: answering for the caller instead would look like it worked.
  if (input.user_id !== undefined && String(input.user_id) !== who.id)
    return c.json({ error: "forbidden" }, 403);
  // Generic Ctx (no route path type) yields string|undefined: fail closed.
  const key = c.req.param("key") ?? "";
  if (!eventKeyAllowed(key, c.env.APP_URL)) return c.json({ error: "not_found" }, 404);
  const db = await dbFor(c);
  if (!db) return c.json({ error: "db_unavailable" }, 503);
  // Policy, clock and budget are decided inside writeRsvp, after all blocking waits
  // (member/event/RSVP-row locks and the throttle prune), as in Laravel: a refused
  // write does not spend an attempt. No pre-lock check here — a stale read could
  // refuse a write that is open by the time the locks are held.
  const r = await writeRsvp(db, key, who.id, input.status);
  if (!r.ok) {
    if (r.reason === "limited") return rateLimitExceeded(c, r.retryAfter);
    if (r.reason === "not_found") return c.json({ error: "not_found" }, 404);
    return closed(c, r.why);
  }
  await dispatchRsvpSync(c.env, r.eventKey, r.mirrored, c.get("requestId"));
  return c.json(rsvpBody(r.answer), r.created ? 201 : 200);
};

const deleteRsvp = async (
  c: Ctx,
  input: Record<string, unknown>,
  readFragmentSession: SessionReader,
): Promise<Response> => {
  c.header("cache-control", "private, no-store");
  // Both sources are evaluated independently, with ALL values preserved:
  // `query()` is first-wins, so duplicates use `queries()` — an empty query
  // value must not mask a filled sibling or a filled body decoy, and a
  // non-string body value trips like a filled string.
  const queryHoney = c.req.queries(RSVP_HONEY_FIELD);
  const bodyHoney = input[RSVP_HONEY_FIELD];
  if (rsvpHoneyFilled(queryHoney) || rsvpHoneyFilled(bodyHoney)) return c.body(null, 204);
  const who = await member(c, readFragmentSession);
  if (who instanceof Response) return who;
  const db = await dbFor(c);
  if (!db) return c.json({ error: "db_unavailable" }, 503);
  // Only the caller's own row is reachable: the delete is keyed on the session user.
  // The budget is charged inside withdrawRsvp, atomically with the delete.
  // Generic Ctx (no route path type) yields string|undefined: fail closed.
  const key = c.req.param("key") ?? "";
  const r = await withdrawRsvp(db, eventKeyAllowed(key, c.env.APP_URL) ? key : "", who.id);
  if (r.limited) return rateLimitExceeded(c, r.retryAfter);
  await dispatchRsvpSync(c.env, key, r.status, c.get("requestId"));
  return c.body(null, 204);
};

export function registerRsvpRoutes(app: App, readFragmentSession: SessionReader): void {
  app.put("/events/:key/rsvp", requestBodyLimit("action"), async (c) =>
    putRsvp(c, await body(c), readFragmentSession),
  );

  app.delete("/events/:key/rsvp", requestBodyLimit("action"), async (c) =>
    deleteRsvp(c, await body(c).catch(() => ({})), readFragmentSession),
  );

  // HTML adapter only: reuse the exact session, decoy, shared budget and
  // locked service paths above. The frozen JSON resource still refuses POST.
  app.post("/e/:key/rsvp", requestBodyLimit("action"), async (c) => {
    const input = await body(c);
    const response = await (input.status === "withdraw"
      ? deleteRsvp(c, input, readFragmentSession)
      : putRsvp(c, input, readFragmentSession));
    const path = `/e/${encodeURIComponent(c.req.param("key"))}`;
    if (response.ok) return c.redirect(path, 303);
    if (response.status === 401) return c.redirect(loginUrl(path), 303);
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) c.header("Retry-After", retryAfter);
    return c.html(
      <html lang="en">
        <head>
          <title>RSVP not saved</title>
        </head>
        <body>
          <h1>{RSVP_COPY.failedTitle}</h1>
          <p role="alert">
            {response.status === 429
              ? throttleWaitCopy(retryAfter ? Number(retryAfter) : null)
              : "Nothing changed. Return to the event to check availability and try again."}
          </p>
          <a href={path}>Return to the event</a>
        </body>
      </html>,
      response.status as ContentfulStatusCode,
    );
  });

  app.all("/events/:key/rsvp", (c) => c.body(null, 405, { Allow: "PUT, DELETE" }));
}
