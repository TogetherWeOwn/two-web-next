// RSVP member writes: PUT/DELETE /events/:key/rsvp, the POST /e/:key/rsvp
// HTML adapter and the 405 fallback. Split out of src/events/routes.tsx;
// behavior unchanged.
import { getSignedCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { dbFor } from "../admin/db";
import { requestBodyLimit } from "../body-limit";
import type { Session } from "../env";
import { rateLimitExceeded } from "../errors";
import { RSVP_HONEY_FIELD, loginUrl, rsvpHoneyFilled } from "../islands/contracts";
import { renderHtmlOutcome } from "../html-outcome";
import { SESSION_COOKIE } from "../session-cookie";
import { isValidSessionToken } from "../sessions";
import { expiredWriteBounce } from "../write-recovery";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { dispatchRsvpSync, isRsvpStatus, withdrawRsvp, writeRsvp, type RsvpAnswer } from "./rsvp";
import { resolveNativeRsvpPage, rsvpPageReturnPath } from "./reads";
import { renderRsvpRefusal } from "./rsvp-refusal-hono";
import { rsvpRefusalModelFor, rsvpRefusalOutcome } from "./rsvp-refusal";
import { body, type App, type Ctx, type SessionReader } from "./routes-shared";

// One answer per member per event: a singular resource. PUT 201 first / 200 re-answer,
// DELETE 204 on a real withdrawal and 404 when it deletes nothing, any other verb 405.
// A valid key in another letter case 308s to the canonical RSVP URL before any
// honeypot, session or DB read. One shared 12/min budget per member.
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
  if (!session) {
    // Recover only a signed, well-formed dead bearer; unknown guests keep
    // the bare refusal. JSON-only even for header-less callers: no false 200.
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    if (isValidSessionToken(token)) return expiredWriteBounce(c, true);
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (!session.member) return c.json({ error: "forbidden" }, 403);
  return session;
}

const putRsvp = async (
  c: Ctx,
  input: Record<string, unknown>,
  readFragmentSession: SessionReader,
): Promise<Response> => {
  c.header("cache-control", "private, no-store");
  // Decoy: a filled honeypot answers the byte-identical first-write success
  // without touching limiter, auth or DB, and logs nothing. Present non-string
  // values count as filled (fail-closed); absent/empty inputs are genuine.
  // Both sources are evaluated independently, with ALL values preserved:
  // `query()` is first-wins, so duplicates use `queries()` — an empty query
  // value must not mask a filled sibling or a filled body decoy, and a
  // non-string body value trips like a filled string. The status echo reads
  // the body only; no other query parameter influences the trap or the echo.
  const queryHoney = c.req.queries(RSVP_HONEY_FIELD);
  const bodyHoney = input[RSVP_HONEY_FIELD];
  if (rsvpHoneyFilled(queryHoney) || rsvpHoneyFilled(bodyHoney)) {
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
  // POST /e/:key/rsvp aliases normalize here (PUT/DELETE already 308 above):
  // ULIDs are stored uppercase, so an alias in another letter case reaches
  // the same row. Invalid keys return null and keep their refusal path.
  const lookupKey = canonicalEventKey(key) ?? key;
  const db = await dbFor(c);
  if (!db) return c.json({ error: "db_unavailable" }, 503);
  // Policy, clock and budget are decided inside writeRsvp, after all blocking waits
  // (member/event/RSVP-row locks and the throttle prune), as in Laravel: a refused
  // write does not spend an attempt. No pre-lock check here — a stale read could
  // refuse a write that is open by the time the locks are held.
  const r = await writeRsvp(db, lookupKey, who.id, input.status);
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
  const lookupKey = canonicalEventKey(key) ?? key;
  const r = await withdrawRsvp(db, eventKeyAllowed(key, c.env.APP_URL) ? lookupKey : "", who.id);
  if (r.limited) return rateLimitExceeded(c, r.retryAfter);
  // Honest withdrawal: no caller row (never answered, only another member
  // answered, unknown or forged key) is the same not-found the PUT answers,
  // never a 204 that implies a withdrawal happened.
  if (!r.deleted) return c.json({ error: "not_found" }, 404);
  await dispatchRsvpSync(c.env, lookupKey, r.status, c.get("requestId"));
  return c.body(null, 204);
};

// One canonical key form per event, mirroring the read routes: a valid key in
// another letter case redirects to the canonical RSVP URL before any
// honeypot, session or DB read. Seed/demo keys and unparsable keys keep
// their current path (forged keys still refuse, unknown keys still 404).
// Scoped to the /events/:key/rsvp verbs so the POST /e/:key/rsvp HTML
// adapter below keeps its exact session, decoy and refusal paths. The status
// is 308, not the read routes' 301: these are unsafe verbs, and common
// non-browser clients (Go net/http, reqwest) replay a 301/302/303 as a
// body-less GET that would land on the 405 catch-all, losing the write.
// RFC 9110 §15.4.9 keeps the method and body on 308.
const canonicalRsvpRedirect = (c: Ctx): Response | null => {
  const key = c.req.param("key") ?? "";
  const canonical = canonicalEventKey(key);
  if (canonical && canonical !== key) {
    const search = new URL(c.req.url).search;
    return c.redirect(`/events/${encodeURIComponent(canonical)}/rsvp${search}`, 308);
  }
  return null;
};

export function registerRsvpRoutes(app: App, readFragmentSession: SessionReader): void {
  app.put("/events/:key/rsvp", requestBodyLimit("action"), async (c) => {
    const moved = canonicalRsvpRedirect(c);
    if (moved) return moved;
    return putRsvp(c, await body(c), readFragmentSession);
  });

  app.delete("/events/:key/rsvp", requestBodyLimit("action"), async (c) => {
    const moved = canonicalRsvpRedirect(c);
    if (moved) return moved;
    return deleteRsvp(c, await body(c).catch(() => ({})), readFragmentSession);
  });

  // HTML adapter only: reuse the exact session, decoy, shared budget and
  // locked service paths above. The frozen JSON resource still refuses POST.
  app.post("/e/:key/rsvp", requestBodyLimit("action"), async (c) => {
    const input = await body(c);
    const response = await (input.status === "withdraw"
      ? deleteRsvp(c, input, readFragmentSession)
      : putRsvp(c, input, readFragmentSession));
    // Success, guest login and refusal links rebuild from the canonical key.
    // Expired-bearer recovery keeps the shared safe return journey above.
    const rawKey = c.req.param("key") ?? "";
    const key = canonicalEventKey(rawKey) ?? rawKey;
    // For those paths, native page context comes only from the validated
    // action-query and body carriers (both normalized, agreement required),
    // never the Referer. Invalid values fall back to the bare event page;
    // nothing submitted can escape the locally rebuilt destination.
    const attendeePage = resolveNativeRsvpPage(
      new URL(c.req.url).searchParams.getAll("attendees"),
      input["attendees"],
      "attendees" in input,
    );
    const path = rsvpPageReturnPath(key, attendeePage);
    // A withdraw that deletes no caller row is already-withdrawn state, like
    // the island's withdraw-404 convergence: back to the event page, whose own
    // 404 still covers unknown or forged keys. Other failures keep refusal.
    const alreadyWithdrawn = input.status === "withdraw" && response.status === 404;
    if (response.ok || alreadyWithdrawn) return c.redirect(path, 303);
    if (response.status === 401) {
      const refusal = (await response.json()) as { recovery?: string };
      return c.redirect(refusal.recovery ?? loginUrl(path), 303);
    }
    const retryAfter = response.headers.get("Retry-After");
    // No-JS refusal renders inside the branded event shell (viewport, skip
    // link, main landmark, stylesheets, header/footer), like every other
    // event failure page. Status, Retry-After, failure copy and the
    // return-to-event link are unchanged. Only signed-in members reach this
    // page (a missing session redirects to login above), so the shell stays
    // presentational with account={false} — like the cancelled (410) event
    // page — instead of rendering guest sign-in chrome for a member. The
    // refusal renders once through the shared outcome interface: the mutation
    // above already ran exactly once, and a re-read of the outcome object
    // reuses its bytes instead of re-rendering.
    return renderHtmlOutcome(
      c,
      rsvpRefusalOutcome(
        rsvpRefusalModelFor({ status: response.status, retryAfter, eventKey: key, attendeePage }),
        renderRsvpRefusal,
        {
          status: response.status as ContentfulStatusCode,
          ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
        },
      ),
    );
  });

  app.all("/events/:key/rsvp", (c) => c.body(null, 405, { Allow: "PUT, DELETE" }));
}
