import type { FC } from "hono/jsx";
import {
  EVENT_FULL_TESTID,
  RSVP_BUTTON_ISLAND,
  RSVP_CHECK_TESTID,
  RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_TESTID,
  RSVP_COPY,
  RSVP_GOING_TESTID,
  RSVP_GUEST_FULL_HINT_TESTID,
  RSVP_GUEST_SIGNIN_TESTID,
  RSVP_JOIN_SERVER_TESTID,
  RSVP_MAYBE_TESTID,
  RSVP_NOT_GOING_TESTID,
  RSVP_PAUSED_TESTID,
  RSVP_SYNCED_TESTID,
  RSVP_SYNCING_TESTID,
  RSVP_WITHDRAW_TESTID,
  WAITLIST_CLAIM_TESTID,
  WAITLIST_JOIN_TESTID,
  WAITLIST_LEAVE_TESTID,
  WAITLIST_POSITION_TESTID,
  loginUrl,
  rsvpClosedCopy,
  rsvpFullCapCopy,
  waitlistPositionCopy,
} from "../islands/contracts";
import type { PublicEvent, ViewerRsvp } from "./reads";
import { rsvpActionHref } from "./attendee-paths";

/** Only the session viewer's answer is supplied; no member answer collection. */
export const RsvpButton: FC<{
  e: PublicEvent;
  member: boolean;
  /** Boolean only: true for any signed-in viewer (member or not). Guests see
   * the sign-in link; signed-in non-members see the join path, never login. */
  signedIn?: boolean;
  answer: ViewerRsvp | null;
  returnTo: string;
  waitlistPosition?: number | null;
  now?: Date;
  /** Normalized native attendee page (1 stays bare); the form action carries
   * only this validated page so malformed query values cannot leak through. */
  attendeePage?: number;
}> = ({
  e,
  member,
  signedIn = false,
  answer,
  returnTo,
  waitlistPosition = null,
  now = new Date(),
  attendeePage = 1,
}) => {
  const closed =
    e.status === "cancelled"
      ? "cancelled"
      : e.status === "draft"
        ? "draft"
        : e.status !== "published" || e.endsAt <= now
          ? "past"
          : null;
  // Seat-accurate verdict: occupancy counts every going row like the write
  // path, so the CTA never offers a seat a nameless row already holds. The
  // visible "N going" label stays on the attributable `goingCount`.
  const occupancy = e.goingOccupancy;
  const full = e.capacity !== null && occupancy >= e.capacity;
  const going = answer?.status === "going";
  const waitlisted = answer?.status === "waitlisted";
  const soft = answer?.status === "maybe" || answer?.status === "not_going";
  const signIn = loginUrl(returnTo);
  const joinHref = `/join?next=${encodeURIComponent(returnTo)}`;
  const button = (id: string, action: string, copy: string) => (
    <button type="submit" name="status" value={action} data-testid={id} data-action={action}>
      {copy}
    </button>
  );
  // Guests get the same paused/full truth members see, plus the sign-in path;
  // signed-in non-members get the join path instead of a login loop. Both are
  // real anchors with no form, so no-JS parity holds.
  const guestPrompt = !e.rsvpOpen ? (
    <>
      <p role="status" data-testid={RSVP_PAUSED_TESTID}>
        {RSVP_COPY.paused}
      </p>
      <a href={signIn} data-testid={RSVP_GUEST_SIGNIN_TESTID}>
        {RSVP_COPY.guestCta}
      </a>
    </>
  ) : full ? (
    <>
      <p role="status" data-testid={EVENT_FULL_TESTID}>
        {RSVP_COPY.full} {rsvpFullCapCopy(e.capacity!)}
      </p>
      <p data-testid={RSVP_GUEST_FULL_HINT_TESTID}>
        <a href={signIn} data-testid={RSVP_GUEST_SIGNIN_TESTID}>
          {RSVP_COPY.guestFullHint}
        </a>
      </p>
    </>
  ) : (
    <a href={signIn} data-testid={RSVP_GUEST_SIGNIN_TESTID}>
      {RSVP_COPY.guestCta}
    </a>
  );
  return (
    <section
      data-island={RSVP_BUTTON_ISLAND}
      data-event-key={e.eventKey}
      data-login-url={signIn}
      data-capacity={e.capacity ?? undefined}
      data-full={full ? "true" : "false"}
      data-paused={e.rsvpOpen ? "false" : "true"}
      data-signed-in={signedIn ? "true" : "false"}
      aria-label="RSVP"
    >
      {closed ? (
        <p role="status" data-testid={RSVP_CLOSED_TESTID}>
          {rsvpClosedCopy(closed)}
        </p>
      ) : !member ? (
        signedIn ? (
          <a href={joinHref} data-testid={RSVP_JOIN_SERVER_TESTID}>
            {RSVP_COPY.joinToRsvp}
          </a>
        ) : (
          guestPrompt
        )
      ) : (
        <form method="post" action={rsvpActionHref(e.eventKey, attendeePage)} data-rsvp-form>
          {!e.rsvpOpen ? (
            <p role="status" data-testid={RSVP_PAUSED_TESTID}>
              {RSVP_COPY.paused}
            </p>
          ) : null}
          {going ? (
            <>
              <p role="status" tabindex={-1} data-testid={RSVP_CONFIRMED_TESTID}>
                <span aria-hidden="true" data-testid={RSVP_CHECK_TESTID}>
                  ✓{" "}
                </span>
                {RSVP_COPY.confirmed}
              </p>
              {button(RSVP_WITHDRAW_TESTID, "withdraw", RSVP_COPY.withdraw)}
            </>
          ) : waitlisted ? (
            <>
              <p role="status" tabindex={-1} data-testid={WAITLIST_POSITION_TESTID}>
                {waitlistPositionCopy(waitlistPosition)}
              </p>
              {e.rsvpOpen && !full
                ? button(WAITLIST_CLAIM_TESTID, "going", RSVP_COPY.waitlistClaim)
                : null}
              {button(WAITLIST_LEAVE_TESTID, "withdraw", RSVP_COPY.waitlistLeave)}
            </>
          ) : soft ? (
            <>
              <p
                role="status"
                tabindex={-1}
                data-testid={answer?.status === "maybe" ? RSVP_MAYBE_TESTID : RSVP_NOT_GOING_TESTID}
              >
                {answer?.status === "maybe" ? RSVP_COPY.maybe : RSVP_COPY.notGoing}
              </p>
              {!e.rsvpOpen ? (
                button(RSVP_WITHDRAW_TESTID, "withdraw", RSVP_COPY.withdraw)
              ) : full ? (
                <>
                  {button(WAITLIST_JOIN_TESTID, "waitlisted", RSVP_COPY.waitlistJoin)}
                  {button(RSVP_WITHDRAW_TESTID, "withdraw", RSVP_COPY.withdraw)}
                </>
              ) : (
                <>
                  {button(RSVP_GOING_TESTID, "going", RSVP_COPY.cta)}
                  {button(RSVP_WITHDRAW_TESTID, "withdraw", RSVP_COPY.withdraw)}
                </>
              )}
            </>
          ) : !e.rsvpOpen ? null : full ? (
            <>
              <p role="status" data-testid={EVENT_FULL_TESTID}>
                {RSVP_COPY.full} {rsvpFullCapCopy(e.capacity!)}
              </p>
              {button(WAITLIST_JOIN_TESTID, "waitlisted", RSVP_COPY.waitlistJoin)}
            </>
          ) : (
            button(RSVP_GOING_TESTID, "going", RSVP_COPY.cta)
          )}
          {going || waitlisted ? (
            answer?.syncedToDiscordAt ? (
              <p data-testid={RSVP_SYNCED_TESTID}>{RSVP_COPY.synced}</p>
            ) : (
              <p role="status" data-testid={RSVP_SYNCING_TESTID}>
                {RSVP_COPY.syncing}
              </p>
            )
          ) : null}
        </form>
      )}
    </section>
  );
};
