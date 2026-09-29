import { describe, expect, it } from "vitest";
import {
  EVENT_FULL_TESTID,
  GOING_COUNT_TESTID,
  GOING_UPDATED_EVENT,
  RSVP_ABUSE_PINS,
  RSVP_BUTTON_ISLAND,
  RSVP_CHECK_TESTID,
  RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_TESTID,
  RSVP_COPY,
  RSVP_FAILED_TESTID,
  RSVP_FIRST_WRITE_STATUS,
  RSVP_GOING_TESTID,
  RSVP_HONEY_FIELD,
  RSVP_MIN_FILL_MS,
  RSVP_PAUSED_TESTID,
  RSVP_RATE_LIMIT,
  RSVP_RATE_LIMITED_TESTID,
  RSVP_REANSWER_STATUS,
  RSVP_SESSION_EXPIRED_TESTID,
  RSVP_STATUSES,
  RSVP_SYNCED_TESTID,
  RSVP_SYNC_FAILED_TESTID,
  RSVP_SYNCING_TESTID,
  RSVP_WITHDRAW_STATUS,
  RSVP_WITHDRAW_TESTID,
  WAITLIST_CLAIM_TESTID,
  WAITLIST_JOIN_TESTID,
  WAITLIST_LEAVE_TESTID,
  WAITLIST_POSITION_TESTID,
  loginUrl,
  rsvpBroadcast,
  rsvpClosedCopy,
  rsvpFocusTargets,
  rsvpFullCapCopy,
  rsvpUrl,
  rsvpViewerState,
  rsvpWithdrawRequest,
  rsvpWriteRequest,
  throttleWaitCopy,
  waitlistPositionCopy,
} from "../src/islands/contracts";

/**
 * TOG-9887: RsvpButton island parity checklist vs legacy Livewire, pinned at
 * two-web main. Each executable test names its legacy row
 * (RsvpButton.php / rsvp-button.blade.php / RsvpButtonTest.php / PR #431 /
 * SpamTrap.php); each skip names the blocker that owns the row.
 *
 * Slice state: no binder and no SSR exist yet — TOG-9839 (blocked, gated on
 * W9 routes TOG-9688) owns the implementation. Pure-contract rows run here;
 * binder/SSR/server rows skip with the blocker named rather than stalling.
 */

describe("rsvp-button requests fired: one request per click", () => {
  it("PUTs the answer to the singular resource with the full status enum", () => {
    for (const status of RSVP_STATUSES) {
      const req = rsvpWriteRequest("evt-1", status);
      expect(req.method).toBe("PUT");
      expect(req.url).toBe(rsvpUrl("evt-1"));
      expect(req.body).toEqual({ status });
    }
  });

  it("PUTs to /events/{key}/rsvp against the frozen RSVP URL", () => {
    expect(rsvpWriteRequest("EVT-9", "going").url).toBe("/events/EVT-9/rsvp");
  });

  it("DELETEs the same singular resource to withdraw", () => {
    const req = rsvpWithdrawRequest("evt-1");
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(rsvpUrl("evt-1"));
  });

  it("encodes the event key in the write URL so a binding cannot repoint a write", () => {
    expect(rsvpWriteRequest("a/b", "going").url).toBe("/events/a%2Fb/rsvp");
  });
});

describe("rsvp-button states rendered: copy + testids", () => {
  it("registers the island name beside the shipped islands", () => {
    expect(RSVP_BUTTON_ISLAND).toBe("rsvp-button");
  });

  it("pins every legacy testid the W8/W15 selector port binds to", () => {
    expect([
      RSVP_GOING_TESTID,
      RSVP_WITHDRAW_TESTID,
      RSVP_CONFIRMED_TESTID,
      RSVP_CHECK_TESTID,
      RSVP_CLOSED_TESTID,
      RSVP_PAUSED_TESTID,
      EVENT_FULL_TESTID,
      WAITLIST_JOIN_TESTID,
      WAITLIST_POSITION_TESTID,
      WAITLIST_CLAIM_TESTID,
      WAITLIST_LEAVE_TESTID,
      RSVP_SYNCING_TESTID,
      RSVP_SYNC_FAILED_TESTID,
      RSVP_SYNCED_TESTID,
      RSVP_RATE_LIMITED_TESTID,
      RSVP_FAILED_TESTID,
      RSVP_SESSION_EXPIRED_TESTID,
    ]).toEqual([
      "rsvp-going",
      "rsvp-withdraw",
      "rsvp-confirmed",
      "rsvp-check",
      "rsvp-closed",
      "rsvp-paused",
      "event-full",
      "waitlist-join",
      "waitlist-position",
      "waitlist-claim",
      "waitlist-leave",
      "rsvp-syncing",
      "rsvp-sync-failed",
      "rsvp-synced",
      "rsvp-rate-limited",
      "rsvp-failed",
      "rsvp-session-expired",
    ]);
  });

  it("keeps the member-visible copy verbatim", () => {
    expect(RSVP_COPY.cta).toBe("I'm in");
    expect(RSVP_COPY.saving).toBe("Saving…");
    expect(RSVP_COPY.confirmed).toBe("You're in");
    expect(RSVP_COPY.withdraw).toBe("Can't make it");
    expect(RSVP_COPY.removing).toBe("Removing…");
    expect(RSVP_COPY.full).toBe("This one's full.");
    expect(RSVP_COPY.syncing).toBe("Saved. Syncing to Discord.");
    expect(RSVP_COPY.syncFailed).toBe(
      "Saved. Discord sync didn't go through — your spot is still held.",
    );
    expect(RSVP_COPY.synced).toBe("Synced to Discord.");
    expect(RSVP_COPY.failedTitle).toBe("That RSVP didn't save.");
    expect(RSVP_COPY.failedAction).toBe("Try once more.");
    expect(RSVP_COPY.paused).toBe("RSVPs are paused for this event — check back soon.");
    expect(RSVP_COPY.sessionExpired).toBe("Your session expired.");
    expect(RSVP_COPY.guestCta).toBe("Log in with Discord");
  });

  it("names the closed reason in words: cancelled, draft, or been-and-gone", () => {
    expect(rsvpClosedCopy("cancelled")).toBe("Cancelled");
    expect(rsvpClosedCopy("draft")).toBe("Not published yet");
    expect(rsvpClosedCopy("past")).toBe("This one has been and gone");
  });

  it("names the cap beside the full message so the number is not a mystery", () => {
    expect(rsvpFullCapCopy(4)).toBe("Cap is 4.");
  });

  it("names the waitlist place in words and digits, with a fallback", () => {
    expect(waitlistPositionCopy(3)).toBe("You're on the waitlist — #3 in line");
    expect(waitlistPositionCopy(null)).toBe(RSVP_COPY.waitlistFallback);
  });
});

describe("rsvp-button broadcast: going-count-updated on every successful write", () => {
  it("maps going/waitlisted/withdraw/other to the badge announcement", () => {
    expect(rsvpViewerState("going")).toBe("going");
    expect(rsvpViewerState("waitlisted")).toBe("waitlisted");
    expect(rsvpViewerState("withdraw")).toBe("none");
    expect(rsvpViewerState("maybe")).toBe("other");
    expect(rsvpViewerState("not_going")).toBe("other");
  });

  it("broadcasts on the DOM CustomEvent name the going-count binder listens on", () => {
    const b = rsvpBroadcast("evt-1", "going");
    expect(b.event).toBe(GOING_UPDATED_EVENT);
    expect(b.eventKey).toBe("evt-1");
    expect(b.viewerState).toBe("going");
    expect(GOING_COUNT_TESTID).toBe("event-going-count");
  });
});

describe("rsvp-button abuse surface: status codes + budget + decoy (PR #431, SpamTrap)", () => {
  it("creates on first write (201), updates on re-answer (200), quiet 204 on withdraw", () => {
    expect(RSVP_FIRST_WRITE_STATUS).toBe(201);
    expect(RSVP_REANSWER_STATUS).toBe(200);
    expect(RSVP_WITHDRAW_STATUS).toBe(204);
  });

  it("pins the PR #431 abuse pins: double-submit, cross-user delete, 405s, quiet 204, past-403, cancelled-withdraw", () => {
    expect(RSVP_ABUSE_PINS.doubleSubmit).toEqual([201, 200]);
    expect(RSVP_ABUSE_PINS.crossUserDeleteVictimRowKept).toBe(204);
    expect(RSVP_ABUSE_PINS.methodTampering).toBe(405);
    expect(RSVP_ABUSE_PINS.withdrawWithoutRow).toBe(204);
    expect(RSVP_ABUSE_PINS.statusPastPut).toBe(403);
    expect(RSVP_ABUSE_PINS.withdrawFromCancelled).toBe(204);
  });

  it("shares one write budget across both verbs, per member: 12/min", () => {
    expect(RSVP_RATE_LIMIT.maxAttempts).toBe(12);
    expect(RSVP_RATE_LIMIT.decaySeconds).toBe(60);
  });

  it("keeps the announced throttle wait verbatim (CM-frozen), with the 1s and fallback shapes", () => {
    expect(throttleWaitCopy(60)).toBe(
      "Slow down — try again in 60 seconds. Nothing changed, just wait a moment.",
    );
    expect(throttleWaitCopy(1)).toBe(
      "Slow down — try again in 1 second. Nothing changed, just wait a moment.",
    );
    expect(throttleWaitCopy(null)).toBe(
      "Slow down — try again in a moment. Nothing changed, just wait a bit.",
    );
  });

  it("pins the honeypot field and fill floor the W9 writes enforce", () => {
    expect(RSVP_HONEY_FIELD).toBe("website");
    expect(RSVP_MIN_FILL_MS).toBe(1000);
  });
});

describe("rsvp-button clock-ended + pause + focus + return path", () => {
  it("pins the focus targets after the re-render swap — and none on failure", () => {
    expect(rsvpFocusTargets("confirmed")).toEqual([RSVP_CONFIRMED_TESTID]);
    expect(rsvpFocusTargets("waitlisted")).toEqual([WAITLIST_POSITION_TESTID]);
    expect(rsvpFocusTargets("withdrawn")).toEqual([RSVP_GOING_TESTID, WAITLIST_JOIN_TESTID]);
    expect(rsvpFocusTargets("failed")).toBeNull();
  });

  it("returns the member to the page after login, never to the update endpoint", () => {
    expect(loginUrl("/events")).toContain("next=%2Fevents");
    expect(loginUrl("/events")).not.toContain("rsvp");
    expect(loginUrl(null)).toBe("/auth/discord");
  });
});

describe.skip("rsvp-button binder rows (blocked on TOG-9839 implementation, gated on W9 TOG-9688)", () => {
  it("abort-then-resends on double-click so one click is one request", () => {
    expect(true).toBe(false);
  });

  it("renders optimistic saving in flight with aria-busy and a disabled control", () => {
    expect(true).toBe(false);
  });

  it("keeps the button enabled beside the throttle wait, failure alert, and sync notes", () => {
    expect(true).toBe(false);
  });

  it("moves focus to the confirmation/position/restored control on success only", () => {
    expect(true).toBe(false);
  });

  it("reloads into the guest render on a 419 instead of the native confirm (TOG-9354)", () => {
    expect(true).toBe(false);
  });
});

describe.skip("rsvp-button SSR/server rows (blocked on W9 routes TOG-9688 + TOG-9839)", () => {
  it("SSR marks the mount with data-island=rsvp-button and the event-key binding", () => {
    expect(true).toBe(false);
  });

  it("clock-ended-but-Published closes the control (TOG-7419 hole the island must not re-open)", () => {
    expect(true).toBe(false);
  });

  it("paused events keep withdraw/leave-the-line for holders, paused copy for the rest (TOG-8725)", () => {
    expect(true).toBe(false);
  });

  it("a filled honeypot decoy answers the byte-identical success shape with no write (TOG-8715)", () => {
    expect(true).toBe(false);
  });

  it("never serves one member another member's answer on the eager-loaded path", () => {
    expect(true).toBe(false);
  });
});
