import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../src/admin/db";
import { getMemberHomeRsvps } from "../../../src/events/member-home-rsvps";
import {
  FALLBACK_RANKS,
  HOME_JOIN_RESULT_COPY,
  HOME_NOTICES,
  JOIN_INTRO,
  applyHomeResponsePolicy,
  homeSessionFor,
} from "../../../src/home-copy";
import { inviteDestination } from "../../../src/invite";
import { JOIN_RESULT_COOKIE } from "../../../src/return-journey";

// Server-rendered only: the Hono homepage ships no page JavaScript (its
// islands are absent here), so the Kit page carries no hydration bundle that
// the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/index.tsx GET /):
// session-aware header from the bridge locals, join notice from ?n=,
// one-shot join flash, bot-owned counts, merged upcoming events and visible
// featured rows. Shared public panels degrade independently; a failed private
// RSVP read propagates rather than pretending the member has no answer. The
// response stays viewer-specific (private, no-store).
export const load: PageServerLoad = async ({ url, request, locals, cookies, setHeaders }) => {
  const session = homeSessionFor(locals);
  if (!locals.homePanels) throw new Error("Home panels were not prepared");
  const { counts, countsSnapshot, homeUpcoming, featured } = locals.homePanels;
  // This per-viewer read stays inside the declared member-read boundary and
  // outside the shared guest cache.
  const eventKeys = homeUpcoming.items.flatMap((event) =>
    event.source === "canonical" ? [event.eventKey] : [],
  );
  let memberRsvps: Array<{ eventKey: string; status: string; syncedToDiscordAt: Date | null }> = [];
  if (session?.member && eventKeys.length > 0) {
    const db = await dbFor({ env });
    if (!db) throw new Error("Home RSVP database unavailable");
    const answers = await getMemberHomeRsvps(db, session.userId, eventKeys);
    memberRsvps = Array.from(answers, ([eventKey, answer]) => ({ eventKey, ...answer }));
  }
  // Do not consume the one-shot notice if the private read failed.
  const { sessionUnavailable, notice, joinResult } = applyHomeResponsePolicy({
    locals,
    noticeRaw: url.searchParams.get("n"),
    method: request.method,
    cookieName: JOIN_RESULT_COOKIE,
    cookies,
    setHeaders,
  });
  return {
    nowMs: Date.now(),
    session,
    sessionUnavailable,
    notice,
    joinResult,
    inviteUrl: inviteDestination(env.DISCORD_INVITE_URL),
    appUrl: env.APP_URL,
    counts,
    countsSnapshot,
    // The shared cache is viewer-invariant. Redact names only in the response
    // projection, so a guest request cannot alter the later member view.
    upcomingEvents: session?.member
      ? homeUpcoming.items
      : homeUpcoming.items.map((event) =>
          event.source === "canonical" ? { ...event, organizer_name: null } : event,
        ),
    memberRsvps,
    eventsUnavailable: homeUpcoming.unavailable,
    featured,
    imageHosts: env.FEATURED_IMAGE_HOSTS,
    // SSR-only copy stays on the server, not in an unused shared client chunk.
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO },
  };
};
