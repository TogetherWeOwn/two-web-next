import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
// route-inventory: POST /e/:key/rsvp
import { registerEventRoutes } from "../src/events/routes";
import { sameOrigin } from "../src/same-origin";
import type { ViewerRsvp } from "../src/events/reads";
import * as rsvpService from "../src/events/rsvp";
import {
  EVENT_CANCELLED_TESTID,
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
  WAITLIST_SEAT_TAKEN_TESTID,
  loginUrl,
  rsvpBroadcast,
  rsvpClosedCopy,
  rsvpFocusTargets,
  rsvpFullCapCopy,
  rsvpHoneyFilled,
  rsvpTrapTripped,
  rsvpUrl,
  rsvpViewerState,
  rsvpWithdrawRequest,
  rsvpWriteRequest,
  throttleWaitCopy,
  waitlistPositionCopy,
} from "../src/islands/contracts";

/** Contract and real route SSR drift; no database or network.
 * Shipped-script click/state coverage lives in islands-rsvp-binder.test.ts.
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
      WAITLIST_SEAT_TAKEN_TESTID,
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
      "waitlist-seat-taken",
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
    expect(RSVP_COPY.waitlistSeatTaken).toBe("Someone just took that seat.");
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

  it("pins the honeypot contract: no bare-click timing gate, arrays and non-strings fail closed", () => {
    expect(RSVP_HONEY_FIELD).toBe("website");
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: "spam" })).toBe(true);
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: "" })).toBe(false);
    expect(rsvpTrapTripped({})).toBe(false);
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: ["", "spam"] })).toBe(true);
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: ["spam", ""] })).toBe(true);
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: ["", ""] })).toBe(false);
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: [] })).toBe(false);
    expect(rsvpTrapTripped({ [RSVP_HONEY_FIELD]: true })).toBe(true);
    expect(rsvpHoneyFilled(undefined)).toBe(false);
    expect(rsvpHoneyFilled(null)).toBe(false);
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
    expect(loginUrl(null)).toBe("/join/discord");
  });
});

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Member-read boundary (#145) declarations require Discord-snowflake viewer
// ids; non-digit ids are refused with a 503 before any assertion runs.
const VIEWER_ONE = "420000000000000042";
const VIEWER_TWO = "420000000000000043";
const viewer: Session = {
  id: VIEWER_ONE,
  username: "one",
  avatar: null,
  member: true,
  moderator: false,
};
function page(
  over: Partial<typeof events.$inferSelect> = {},
  answers: Record<string, ViewerRsvp> = {},
  protectWrites = false,
) {
  const startsAt = new Date("2030-01-01T20:00:00Z");
  const event: typeof events.$inferSelect = {
    id: 42,
    eventKey: KEY,
    title: "Squad night",
    game: null,
    description: null,
    startsAt,
    endsAt: new Date("2030-01-01T22:00:00Z"),
    timezone: "Europe/London",
    location: null,
    capacity: 4,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    ...over,
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const cols = Object.keys(getTableColumns(events)) as (keyof typeof event)[];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("isfinite(") || sql.includes("row_number()")) return { rows: [] };
    if (sql.includes('from "events"'))
      return {
        rows: [cols.map((k) => (event[k] instanceof Date ? event[k].toISOString() : event[k]))],
      };
    if (sql.includes("group by")) return { rows: [[event.id, 4]] };
    // The member-only attendees projection joins users and is empty in this
    // fixture; without this arm it would fall through to the answer lookup.
    if (sql.includes('inner join "users"')) return { rows: [] };
    const answer = answers[String(params[1])];
    if (params[0] !== event.id || !answer) return { rows: [] };
    // The keyed viewer-answer projection selects (user_id, status,
    // synced_to_discord_at). Drizzle's pg-proxy mapper reads positional
    // columns while the boundary's owner projection reads the named owner
    // key, so the row carries both shapes; the key must be the session
    // snowflake or the boundary refuses the response with a 503.
    const userId = String(params[1]);
    const synced = answer.syncedToDiscordAt?.toISOString() ?? null;
    return {
      rows: [
        Object.assign([userId, answer.status, synced], {
          userId,
          status: answer.status,
          syncedToDiscordAt: synced,
        }),
      ],
    };
  });
  let who: Session | null = null;
  let authReads = 0;
  const auth = async () => {
    authReads++;
    return who;
  };
  const app = new Hono<{ Bindings: Env }>();
  if (protectWrites) app.use("*", sameOrigin);
  registerEventRoutes(app, auth, auth);
  const env = {
    APP_URL: "https://next.example.test",
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    queries,
    db,
    event,
    authReads: () => authReads,
    as: (session: Session | null) => {
      who = session;
    },
    request: (path = `/e/${KEY}`, init?: RequestInit) => app.request(path, init, env),
  };
}

function mount(html: string): string {
  return /<section data-island="rsvp-button"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

describe("rsvp-button SSR/server drift", () => {
  afterEach(() => vi.restoreAllMocks());

  it("SSR binds the event key and guest page-return link without exposing actions or reading an answer", async () => {
    const p = page();
    const res = await p.request(`/e/${KEY}?from=calendar`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mount(html)).toContain(`data-event-key="${KEY}"`);
    expect(mount(html)).toContain(`href="${loginUrl(`/e/${KEY}?from=calendar`)}"`);
    expect(mount(html)).toContain(RSVP_COPY.guestCta);
    expect(mount(html)).not.toContain("data-action");
    expect(html).toContain('src="/islands/rsvp-button.js"');
    expect(
      p.queries.filter((q) => q.sql.includes('from "rsvps"') && !q.sql.includes("group by")),
    ).toHaveLength(0);
  });

  it.each([
    ["draft", {}, "Not published yet"],
    ["past", {}, "This one has been and gone"],
    ["published", { endsAt: new Date("2020-01-01T22:00:00Z") }, "This one has been and gone"],
  ] as const)(
    "closes %s, including clock-ended Published, without action controls",
    async (status, over, copy) => {
      const p = page({ status, ...over });
      p.as({ ...viewer, moderator: true });
      const res = await p.request();
      const html = mount(await res.text());
      expect(res.status).toBe(200);
      expect(html).toContain(`role="status" data-testid="${RSVP_CLOSED_TESTID}">${copy}`);
      expect(html).not.toContain("data-action");
    },
  );

  it("answers cancelled with 410 and the notice alone, never a closed RSVP control", async () => {
    const p = page({ status: "cancelled" });
    p.as({ ...viewer, moderator: true });
    const res = await p.request();
    const html = await res.text();
    expect(res.status).toBe(410);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).toContain(`data-testid="${EVENT_CANCELLED_TESTID}">Cancelled`);
    expect(mount(html)).toBe("");
    expect(html).not.toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    expect(html).not.toContain("/islands/rsvp-button.js");
  });

  it("preserves draft authorization", async () => {
    const p = page({ status: "draft" });
    p.as(viewer);
    expect((await p.request()).status).toBe(403);
  });

  it("renders full + waitlist join, never a going button", async () => {
    const p = page();
    p.as(viewer);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`data-testid="${EVENT_FULL_TESTID}"`);
    expect(html).toContain("This one&#39;s full. Cap is 4.");
    expect(html).toContain(`data-testid="${WAITLIST_JOIN_TESTID}"`);
    expect(html).not.toContain(`data-testid="${RSVP_GOING_TESTID}"`);
  });

  it("renders going, withdraw and the stored sync stamp with an accessible confirmation", async () => {
    const p = page(
      {},
      { [viewer.id]: { status: "going", syncedToDiscordAt: new Date("2026-09-29T12:00:00Z") } },
    );
    p.as(viewer);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`role="status" tabindex="-1" data-testid="${RSVP_CONFIRMED_TESTID}"`);
    expect(html).toContain(`aria-hidden="true" data-testid="${RSVP_CHECK_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_WITHDRAW_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_SYNCED_TESTID}"`);
    expect(html).not.toContain(`data-testid="${EVENT_FULL_TESTID}"`);
  });

  it.each([true, false])(
    "renders a full waitlist holder without refusal copy (RSVPs open: %s)",
    async (rsvpOpen) => {
      const p = page(
        { rsvpOpen },
        { [viewer.id]: { status: "waitlisted", syncedToDiscordAt: null } },
      );
      p.as(viewer);
      const html = mount(await (await p.request()).text());
      expect(html).toContain('data-full="true"');
      expect(html).toContain(
        `data-testid="${WAITLIST_POSITION_TESTID}">You&#39;re on the waitlist`,
      );
      expect(html).toContain(`data-testid="${WAITLIST_LEAVE_TESTID}"`);
      expect(html).not.toContain(`data-testid="${EVENT_FULL_TESTID}"`);
      expect(html).not.toContain("This one&#39;s full.");
      expect(html).not.toContain(`data-testid="${WAITLIST_CLAIM_TESTID}"`);
      expect(html).not.toContain(`data-testid="${WAITLIST_JOIN_TESTID}"`);
      expect(html).not.toContain(`data-testid="${RSVP_CONFIRMED_TESTID}"`);
    },
  );

  it("renders waitlist fallback + claim-seat when room exists, without inventing a position", async () => {
    const p = page(
      { capacity: null },
      { [viewer.id]: { status: "waitlisted", syncedToDiscordAt: null } },
    );
    p.as(viewer);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`data-testid="${WAITLIST_POSITION_TESTID}">You&#39;re on the waitlist`);
    // WaitlistTest.php: the line is announced politely and can take focus.
    expect(html).toContain(`role="status" tabindex="-1" data-testid="${WAITLIST_POSITION_TESTID}"`);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(`data-testid="${WAITLIST_CLAIM_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_LEAVE_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_SYNCING_TESTID}"`);
    expect(html).not.toContain("in line");
  });

  it.each([null, "going", "waitlisted"] as const)(
    "paused keeps only withdraw/leave for holder %s",
    async (status) => {
      const p = page(
        { rsvpOpen: false },
        status ? { [viewer.id]: { status, syncedToDiscordAt: null } } : {},
      );
      p.as(viewer);
      const html = mount(await (await p.request()).text());
      expect(html).toContain(RSVP_COPY.paused);
      expect(html).not.toContain('data-action="going"');
      expect(html).not.toContain('data-action="waitlisted"');
      expect(html.includes('data-action="withdraw"')).toBe(status !== null);
    },
  );

  it("never serves another member's answer and marks personalized HTML uncacheable", async () => {
    const p = page({}, { [viewer.id]: { status: "going", syncedToDiscordAt: null } });
    p.as(viewer);
    const first = await p.request();
    expect(mount(await first.text())).toContain(`data-testid="${RSVP_CONFIRMED_TESTID}"`);
    p.as({ ...viewer, id: VIEWER_TWO });
    const second = await p.request();
    expect(mount(await second.text())).not.toContain(`data-testid="${RSVP_CONFIRMED_TESTID}"`);
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    // Viewer-answer reads stay keyed on the session user (they select the
    // sync stamp); the member-only attendees projection (merged from main)
    // joins users and reads by event + status, never another member's answer.
    const viewerReads = p.queries.filter((q) => q.sql.includes('"synced_to_discord_at"'));
    expect(viewerReads.map((q) => q.params)).toEqual([
      [42, VIEWER_ONE],
      [42, VIEWER_TWO],
    ]);
    const attendeeReads = p.queries.filter((q) => q.sql.includes('inner join "users"'));
    // The member-only attendees projection excludes nameless rows in SQL.
    expect(attendeeReads.map((q) => q.params)).toEqual([
      [42, "going", ""],
      [42, "going", ""],
    ]);
  });

  it.each(["going", "waitlisted", "withdraw"] as const)(
    "no-JS %s submits a real form, shares the JSON service and returns to the event",
    async (status) => {
      const p = page(
        status === "going" ? { capacity: null } : {},
        status === "withdraw" ? { [viewer.id]: { status: "going", syncedToDiscordAt: null } } : {},
        true,
      );
      p.as(viewer);
      const html = mount(await (await p.request()).text());
      const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
      expect(action).toBe(`/e/${KEY}/rsvp`);
      expect(html).toContain(`type="submit" name="status" value="${status}"`);
      const write = vi.spyOn(rsvpService, "writeRsvp").mockResolvedValue({
        ok: true,
        created: true,
        answer: {
          status: status === "withdraw" ? "going" : status,
          syncedToDiscordAt: null,
          waitlistPosition: null,
        },
        mirrored: null,
        eventKey: KEY,
      });
      const remove = vi
        .spyOn(rsvpService, "withdrawRsvp")
        .mockResolvedValue({ limited: false, deleted: true, status: null });
      const res = await p.request(action!, {
        method: "POST",
        headers: { origin: "https://next.example.test" },
        body: new URLSearchParams({ status }),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/e/${KEY}`);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      // The route passes the boundary-observed db (memberReadDb proxy over the
      // same pool), so pin the write routing (key, user, status), not db identity.
      if (status === "withdraw") {
        expect(remove.mock.calls[0]?.slice(1)).toEqual([KEY, viewer.id]);
        expect(write).not.toHaveBeenCalled();
      } else {
        expect(write.mock.calls[0]?.slice(1)).toEqual([KEY, viewer.id, status]);
        expect(remove).not.toHaveBeenCalled();
      }
    },
  );

  it("no-JS failures preserve status, throttle copy and an actionable recovery link", async () => {
    const p = page({}, {}, true);
    p.as(viewer);
    vi.spyOn(rsvpService, "writeRsvp").mockResolvedValue({
      ok: false,
      reason: "limited",
      retryAfter: 5,
    });
    const res = await p.request(`/e/${KEY}/rsvp`, {
      method: "POST",
      headers: { origin: "https://next.example.test" },
      body: new URLSearchParams({ status: "going" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain(throttleWaitCopy(5));
    expect(html).toContain(`href="/e/${KEY}"`);
  });

  it("no-JS refuses missing/foreign origins, non-members and cross-user writes; expired sessions get the return-aware link", async () => {
    const p = page({}, {}, true);
    p.as(viewer);
    const write = vi.spyOn(rsvpService, "writeRsvp");
    const init = (origin?: string, extra: Record<string, string> = {}): RequestInit => ({
      method: "POST",
      headers: origin ? { origin } : {},
      body: new URLSearchParams({ status: "going", ...extra }),
    });
    const path = `/e/${KEY}/rsvp`;
    for (const origin of [undefined, "https://evil.test"])
      expect((await p.request(path, init(origin))).status).toBe(403);
    expect(
      (await p.request(path, init("https://next.example.test", { user_id: "other-member" })))
        .status,
    ).toBe(403);
    p.as({ ...viewer, member: false });
    expect((await p.request(path, init("https://next.example.test"))).status).toBe(403);
    p.as(null);
    const expired = await p.request(path, init("https://next.example.test"));
    expect(expired.status).toBe(303);
    expect(expired.headers.get("location")).toBe(loginUrl(`/e/${KEY}`));
    expect(write).not.toHaveBeenCalled();
  });

  it("no-JS filled decoys touch no auth/DB/service and the JSON resource still refuses POST", async () => {
    const p = page({}, {}, true);
    const write = vi.spyOn(rsvpService, "writeRsvp");
    const remove = vi.spyOn(rsvpService, "withdrawRsvp");
    for (const status of ["going", "withdraw"]) {
      const res = await p.request(`/e/${KEY}/rsvp`, {
        method: "POST",
        headers: { origin: "https://next.example.test" },
        body: new URLSearchParams({ status, website: "filled" }),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/e/${KEY}`);
    }
    expect(p.authReads()).toBe(0);
    expect(p.queries).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const offVerb = await p.request(`/events/${KEY}/rsvp`, {
      method: "POST",
      headers: { origin: "https://next.example.test" },
    });
    expect(offVerb.status).toBe(405);
    expect(offVerb.headers.get("Allow")).toBe("PUT, DELETE");
  });

  it("filled decoy is byte-identical to first-write success without auth, DB, limiter or write service", async () => {
    const p = page({ capacity: null });
    p.as(viewer);
    const write = vi.spyOn(rsvpService, "writeRsvp").mockResolvedValue({
      ok: true,
      created: true,
      answer: { status: "going", syncedToDiscordAt: null, waitlistPosition: null },
      mirrored: null,
      eventKey: KEY,
    });
    const init = (input: unknown): RequestInit => ({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const real = await p.request(`/events/${KEY}/rsvp`, init({ status: "going" }));
    expect(real.status).toBe(201);
    expect(write).toHaveBeenCalledTimes(1);
    const authReads = p.authReads();
    const queries = p.queries.length;
    const trap = await p.request(
      "/events/invalid-key/rsvp",
      init({ status: "going", website: "filled" }),
    );
    expect(trap.status).toBe(real.status);
    expect(await trap.text()).toBe(await real.text());
    expect(p.authReads()).toBe(authReads);
    expect(p.queries).toHaveLength(queries);
    expect(write).toHaveBeenCalledTimes(1);
    const withdrawn = await p.request("/events/invalid-key/rsvp?website=filled", {
      method: "DELETE",
    });
    expect(withdrawn.status).toBe(204);
    expect(await withdrawn.text()).toBe("");
    expect(p.authReads()).toBe(authReads);
  });
});
