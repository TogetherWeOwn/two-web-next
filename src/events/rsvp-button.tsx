import type { FC } from "hono/jsx";
import {
  EVENT_FULL_TESTID, RSVP_BUTTON_ISLAND, RSVP_CHECK_TESTID, RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_TESTID, RSVP_COPY, RSVP_GOING_TESTID, RSVP_PAUSED_TESTID,
  RSVP_SYNCED_TESTID, RSVP_SYNCING_TESTID, RSVP_WITHDRAW_TESTID,
  WAITLIST_CLAIM_TESTID, WAITLIST_JOIN_TESTID, WAITLIST_LEAVE_TESTID,
  WAITLIST_POSITION_TESTID, loginUrl, rsvpClosedCopy, rsvpFullCapCopy, waitlistPositionCopy,
} from "../islands/contracts";
import type { PublicEvent, ViewerRsvp } from "./reads";

/** Only the session viewer's answer is supplied; no member answer collection. */
export const RsvpButton: FC<{
  e: PublicEvent;
  member: boolean;
  answer: ViewerRsvp | null;
  returnTo: string;
  waitlistPosition?: number | null;
  now?: Date;
}> = ({ e, member, answer, returnTo, waitlistPosition = null, now = new Date() }) => {
  const closed = e.status === "cancelled" ? "cancelled" : e.status === "draft" ? "draft"
    : e.status !== "published" || e.endsAt <= now ? "past" : null;
  const full = e.capacity !== null && e.goingCount >= e.capacity;
  const going = answer?.status === "going";
  const waitlisted = answer?.status === "waitlisted";
  const signIn = loginUrl(returnTo);
  const button = (id: string, action: string, copy: string) =>
    <button type="submit" name="status" value={action} data-testid={id} data-action={action}>{copy}</button>;
  return (
    <section data-island={RSVP_BUTTON_ISLAND} data-event-key={e.eventKey}
      data-login-url={signIn} data-capacity={e.capacity ?? undefined}
      data-full={full ? "true" : "false"} data-paused={e.rsvpOpen ? "false" : "true"}
      aria-label="RSVP">
      {closed ? (
        <p role="status" data-testid={RSVP_CLOSED_TESTID}>{rsvpClosedCopy(closed)}</p>
      ) : !member ? (
        <a href={signIn}>{RSVP_COPY.guestCta}</a>
      ) : (
        <form method="post" action={`/e/${encodeURIComponent(e.eventKey)}/rsvp`} data-rsvp-form>
          {!e.rsvpOpen ? <p role="status" data-testid={RSVP_PAUSED_TESTID}>{RSVP_COPY.paused}</p> : null}
          {going ? (
            <>
              <p role="status" tabindex={-1} data-testid={RSVP_CONFIRMED_TESTID}>
                <span aria-hidden="true" data-testid={RSVP_CHECK_TESTID}>✓ </span>{RSVP_COPY.confirmed}
              </p>
              {button(RSVP_WITHDRAW_TESTID, "withdraw", RSVP_COPY.withdraw)}
            </>
          ) : waitlisted ? (
            <>
              {full ? <p role="status" data-testid={EVENT_FULL_TESTID}>{RSVP_COPY.full} {rsvpFullCapCopy(e.capacity!)}</p> : null}
              <p role="status" tabindex={-1} data-testid={WAITLIST_POSITION_TESTID}>{waitlistPositionCopy(waitlistPosition)}</p>
              {e.rsvpOpen && !full ? button(WAITLIST_CLAIM_TESTID, "going", RSVP_COPY.waitlistClaim) : null}
              {button(WAITLIST_LEAVE_TESTID, "withdraw", RSVP_COPY.waitlistLeave)}
            </>
          ) : !e.rsvpOpen ? null : full ? (
            <>
              <p role="status" data-testid={EVENT_FULL_TESTID}>{RSVP_COPY.full} {rsvpFullCapCopy(e.capacity!)}</p>
              {button(WAITLIST_JOIN_TESTID, "waitlisted", RSVP_COPY.waitlistJoin)}
            </>
          ) : button(RSVP_GOING_TESTID, "going", RSVP_COPY.cta)}
          {going || waitlisted ? (
            answer?.syncedToDiscordAt ? <p data-testid={RSVP_SYNCED_TESTID}>{RSVP_COPY.synced}</p>
              : <p role="status" data-testid={RSVP_SYNCING_TESTID}>{RSVP_COPY.syncing}</p>
          ) : null}
        </form>
      )}
    </section>
  );
};
