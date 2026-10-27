// Acceptance: truthful RSVP prompts for guests and non-members (Hono twin).
//
// V1 roadmap M194: guests see paused/full truth instead of a bare
// login link, signed-in non-members get the join path instead of a login loop.
// The Builder (paired build card) implements on this branch and never edits
// this file. Fail-first against d8fe53590; hermetic throughout (pg-proxy fakes,
// never a real database, never the network).
//
// New contract the Builder ships beside RSVP_COPY (exact strings pinned here):
//   RSVP_COPY.guestFullHint = "Sign in to join the waitlist"
//   RSVP_COPY.joinToRsvp   = "Join the server to RSVP"
//   RSVP_GUEST_SIGNIN_TESTID   = "rsvp-guest-signin"
//   RSVP_GUEST_FULL_HINT_TESTID = "rsvp-guest-full-hint"
//   RSVP_JOIN_SERVER_TESTID    = "rsvp-join-server"
//   Island attr data-signed-in = "true" | "false" (boolean only, never a token).
//
// Guest paused reuses RSVP_PAUSED_TESTID + RSVP_COPY.paused; guest full reuses
// EVENT_FULL_TESTID + RSVP_COPY.full + cap copy. Closed (cancelled/draft/past/
// clock-ended) stays byte-stable for every viewer. Member flows unchanged.
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { registerEventRoutes } from "../src/events/routes";
import type { ViewerRsvp } from "../src/events/reads";
import * as contracts from "../src/islands/contracts";
import {
  EVENT_FULL_TESTID,
  RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_TESTID,
  RSVP_COPY,
  RSVP_GOING_TESTID,
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
} from "../src/islands/contracts";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Member-read boundary requires Discord-snowflake viewer ids.
const MEMBER_ID = "420000000000000042";
const NONMEMBER_ID = "420000000000000043";
const PATH = `/e/${KEY}`;
const JOIN_HREF = `/join?next=${encodeURIComponent(PATH)}`;

// The exact new copy + testids the Builder ships. Asserted via the imported
// namespace so a missing export fails the test instead of failing the import.
const EXPECTED_GUEST_FULL_HINT = "Sign in to join the waitlist";
const EXPECTED_JOIN_TO_RSVP = "Join the server to RSVP";
const EXPECTED_GUEST_SIGNIN_TESTID = "rsvp-guest-signin";
const EXPECTED_GUEST_FULL_HINT_TESTID = "rsvp-guest-full-hint";
const EXPECTED_JOIN_SERVER_TESTID = "rsvp-join-server";

const memberSession: Session = {
  id: MEMBER_ID,
  username: "member",
  avatar: null,
  member: true,
  moderator: false,
};
const nonMemberSession: Session = {
  id: NONMEMBER_ID,
  username: "viewer",
  avatar: null,
  member: false,
  moderator: false,
};
const moderatorSession: Session = {
  ...memberSession,
  moderator: true,
};

function page(
  over: Partial<typeof events.$inferSelect> = {},
  answers: Record<string, ViewerRsvp> = {},
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
  const cols = Object.keys(getTableColumns(events)) as (keyof typeof event)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes("isfinite(") || sql.includes("row_number()")) return { rows: [] };
    if (sql.includes('from "events"'))
      return {
        rows: [cols.map((k) => (event[k] instanceof Date ? event[k].toISOString() : event[k]))],
      };
    // Occupancy 4: capacity 4 is full, 10/null is open.
    if (sql.includes("group by")) return { rows: [[event.id, 4]] };
    if (sql.includes('inner join "users"')) return { rows: [] };
    const answer = answers[String(params[1])];
    if (params[0] !== event.id || !answer) return { rows: [] };
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
  const auth = async () => who;
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(app, auth, auth);
  const env = {
    APP_URL: "https://next.example.test",
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    as: (session: Session | null) => {
      who = session;
    },
    request: (path = PATH, init?: RequestInit) => app.request(path, init, env),
  };
}

function mount(html: string): string {
  return /<section data-island="rsvp-button"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

function dataAttrs(section: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tag = /^<section[^>]*>/.exec(section)?.[0] ?? "";
  for (const m of tag.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

describe("acceptance: guest paused/full truth (Hono)", () => {
  it("guest on a paused event sees the paused note plus the sign-in link", async () => {
    const p = page({ rsvpOpen: false, capacity: 10 });
    p.as(null);
    const res = await p.request();
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    // The member paused note, now truthful for guests too.
    expect(html).toContain(`data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).toContain(RSVP_COPY.paused);
    // Plus the page-return sign-in link, never a bare note with no path.
    expect(html).toContain(`href="${loginUrl(PATH)}"`);
    expect(html).toContain(RSVP_COPY.guestCta);
    expect(html).toContain(`data-testid="${EXPECTED_GUEST_SIGNIN_TESTID}"`);
    // No join path for guests, no member form, no actions.
    expect(html).not.toContain("/join?next=");
    expect(html).not.toContain("data-rsvp-form");
    expect(html).not.toContain("data-action");
  });

  it("guest on a full event sees the full note plus the waitlist hint", async () => {
    const p = page({ rsvpOpen: true, capacity: 4 });
    p.as(null);
    const res = await p.request();
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain('data-full="true"');
    expect(html).toContain(`data-testid="${EVENT_FULL_TESTID}"`);
    // Hono JSX escapes the apostrophe in served HTML; RSVP_COPY.full itself
    // stays pinned to the raw copy below (contract assertion).
    expect(html).toContain("This one&#39;s full.");
    expect(html).toContain(rsvpFullCapCopy(4));
    // The new hint names the waitlist path; the link returns to this page.
    expect(html).toContain(EXPECTED_GUEST_FULL_HINT);
    expect(html).toContain(`data-testid="${EXPECTED_GUEST_FULL_HINT_TESTID}"`);
    expect(html).toContain(`href="${loginUrl(PATH)}"`);
    expect(html).not.toContain("/join?next=");
    expect(html).not.toContain("data-rsvp-form");
    expect(html).not.toContain("data-action");
  });

  it("guest on an open event keeps the bare sign-in link (control)", async () => {
    const p = page({ rsvpOpen: true, capacity: null });
    p.as(null);
    const res = await p.request();
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain(`href="${loginUrl(PATH)}"`);
    expect(html).toContain(RSVP_COPY.guestCta);
    expect(html).not.toContain(`data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).not.toContain(`data-testid="${EVENT_FULL_TESTID}"`);
    expect(html).not.toContain("/join?next=");
  });
});

describe("acceptance: signed-in non-member join path (Hono)", () => {
  it("open event links to the join landing, never a login loop", async () => {
    const p = page({ rsvpOpen: true, capacity: null });
    p.as(nonMemberSession);
    const res = await p.request();
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain(`data-testid="${EXPECTED_JOIN_SERVER_TESTID}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).toContain(`href="${JOIN_HREF}"`);
    // A login href for a signed-in viewer is a loop: forbidden. The island
    // mount always carries data-login-url for the binder's session-expired
    // recovery, so the loop check is href-specific, not a substring scan.
    expect(html).not.toContain('href="/join/discord');
    expect(html).not.toContain(RSVP_COPY.guestCta);
    expect(html).not.toContain("data-rsvp-form");
    expect(html).not.toContain("data-action");
  });

  it("paused event still offers the join path, never the login link", async () => {
    const p = page({ rsvpOpen: false, capacity: 10 });
    p.as(nonMemberSession);
    const res = await p.request();
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain(`href="${JOIN_HREF}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).not.toContain('href="/join/discord');
  });

  it("full event still offers the join path, never the login link", async () => {
    const p = page({ rsvpOpen: true, capacity: 4 });
    p.as(nonMemberSession);
    const res = await p.request();
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain(`href="${JOIN_HREF}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).not.toContain('href="/join/discord');
  });

  it("island fragment turns render the join path too", async () => {
    const p = page({ rsvpOpen: true, capacity: null });
    p.as(nonMemberSession);
    const res = await p.request(PATH, { headers: { "x-two-island": "attendees-live" } });
    const html = mount(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain(`href="${JOIN_HREF}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).not.toContain('href="/join/discord');
  });
});

describe("acceptance: closed prompts byte-stable (Hono)", () => {
  it.each([
    ["draft", { status: "draft" }, "Not published yet"],
    ["past", { status: "past" }, "This one has been and gone"],
    [
      "clock-ended published",
      { status: "published", endsAt: new Date("2020-01-01T22:00:00Z") },
      "This one has been and gone",
    ],
  ] as const)("moderator %s keeps the exact closed prompt", async (_name, over, copy) => {
    const p = page({ ...over });
    p.as(moderatorSession);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`role="status" data-testid="${RSVP_CLOSED_TESTID}">${copy}`);
    expect(html).not.toContain("data-action");
    // Href-specific: data-login-url always carries /join/discord for binder recovery.
    expect(html).not.toContain('href="/join/discord');
    expect(html).not.toContain('href="/join?next=');
  });

  it("past stays closed for guest and non-member alike, with no login or join", async () => {
    for (const session of [null, nonMemberSession] as const) {
      const p = page({ status: "past" });
      p.as(session);
      const html = mount(await (await p.request()).text());
      expect(html).toContain(rsvpClosedCopy("past"));
      expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
      expect(html).not.toContain('href="/join/discord');
      expect(html).not.toContain('href="/join?next=');
      expect(html).not.toContain("data-action");
    }
  });

  it("cancelled stays a 410 with no RSVP island at all", async () => {
    for (const session of [null, nonMemberSession, memberSession] as const) {
      const p = page({ status: "cancelled" });
      p.as(session);
      const res = await p.request();
      const html = await res.text();
      expect(res.status).toBe(410);
      expect(mount(html)).toBe("");
      expect(html).not.toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
      expect(html).not.toContain(EXPECTED_JOIN_TO_RSVP);
      expect(html).not.toContain(EXPECTED_GUEST_FULL_HINT);
    }
  });

  it("guest draft stays a 403, never a prompt", async () => {
    const p = page({ status: "draft" });
    p.as(null);
    expect((await p.request()).status).toBe(403);
  });
});

describe("acceptance: member flows unchanged (Hono)", () => {
  it("going renders confirmed + withdraw + sync stamp, never guest/join copy", async () => {
    const p = page(
      { capacity: null },
      { [MEMBER_ID]: { status: "going", syncedToDiscordAt: new Date("2026-09-29T12:00:00Z") } },
    );
    p.as(memberSession);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`data-testid="${RSVP_CONFIRMED_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_WITHDRAW_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_SYNCED_TESTID}"`);
    expect(html).not.toContain(RSVP_COPY.guestCta);
    expect(html).not.toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).not.toContain(EXPECTED_GUEST_FULL_HINT);
  });

  it("waitlisted with room renders position + claim + leave + syncing", async () => {
    const p = page(
      { capacity: null },
      { [MEMBER_ID]: { status: "waitlisted", syncedToDiscordAt: null } },
    );
    p.as(memberSession);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`data-testid="${WAITLIST_POSITION_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_CLAIM_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_LEAVE_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_SYNCING_TESTID}"`);
  });

  it("full member without an answer renders full + waitlist join, never going", async () => {
    const p = page({ capacity: 4 });
    p.as(memberSession);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(`data-testid="${EVENT_FULL_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_JOIN_TESTID}"`);
    expect(html).not.toContain(`data-testid="${RSVP_GOING_TESTID}"`);
  });

  it("paused member without an answer keeps the note and no join actions", async () => {
    const p = page({ rsvpOpen: false, capacity: 10 });
    p.as(memberSession);
    const html = mount(await (await p.request()).text());
    expect(html).toContain(RSVP_COPY.paused);
    expect(html).not.toContain('data-action="going"');
    expect(html).not.toContain('data-action="waitlisted"');
  });
});

describe("acceptance: island contract drift (rsvp-button)", () => {
  it("new copy lives beside RSVP_COPY with the pinned strings", () => {
    const copy = RSVP_COPY as unknown as Record<string, unknown>;
    expect(copy["guestFullHint"]).toBe(EXPECTED_GUEST_FULL_HINT);
    expect(copy["joinToRsvp"]).toBe(EXPECTED_JOIN_TO_RSVP);
  });

  it("new testids are exported with the pinned values", () => {
    const ns = contracts as unknown as Record<string, unknown>;
    expect(ns["RSVP_GUEST_SIGNIN_TESTID"]).toBe(EXPECTED_GUEST_SIGNIN_TESTID);
    expect(ns["RSVP_GUEST_FULL_HINT_TESTID"]).toBe(EXPECTED_GUEST_FULL_HINT_TESTID);
    expect(ns["RSVP_JOIN_SERVER_TESTID"]).toBe(EXPECTED_JOIN_SERVER_TESTID);
  });

  it("existing closed copy stays byte-stable", () => {
    expect(rsvpClosedCopy("cancelled")).toBe("Cancelled");
    expect(rsvpClosedCopy("draft")).toBe("Not published yet");
    expect(rsvpClosedCopy("past")).toBe("This one has been and gone");
    expect(RSVP_COPY.paused).toBe("RSVPs are paused for this event — check back soon.");
    expect(RSVP_COPY.full).toBe("This one's full.");
    expect(RSVP_COPY.guestCta).toBe("Log in with Discord");
  });
});

describe("acceptance: no session/token material in island attrs (Hono)", () => {
  it("the signed-in signal is a boolean-only data attr", async () => {
    const open = page({ rsvpOpen: true, capacity: null });
    open.as(null);
    expect(dataAttrs(mount(await (await open.request()).text()))["signed-in"]).toBe("false");
    const signed = page({ rsvpOpen: true, capacity: null });
    signed.as(nonMemberSession);
    expect(dataAttrs(mount(await (await signed.request()).text()))["signed-in"]).toBe("true");
    const member = page({ rsvpOpen: true, capacity: null });
    member.as(memberSession);
    expect(dataAttrs(mount(await (await member.request()).text()))["signed-in"]).toBe("true");
  });

  it("no island attr carries ids, tokens, or usernames", async () => {
    // Capacity 10 keeps data-capacity present (null omits it by design).
    for (const session of [null, nonMemberSession, memberSession] as const) {
      const p = page({ rsvpOpen: true, capacity: 10 });
      p.as(session);
      const section = mount(await (await p.request()).text());
      const attrs = dataAttrs(section);
      for (const [k, v] of Object.entries(attrs)) {
        expect(v, `data-${k}`).not.toContain(MEMBER_ID);
        expect(v, `data-${k}`).not.toContain(NONMEMBER_ID);
        expect(v, `data-${k}`).not.toContain("member");
        expect(v, `data-${k}`).not.toContain("viewer");
        expect(v, `data-${k}`).not.toContain("eyJ");
        expect(v, `data-${k}`).not.toContain("Bearer");
        expect(v, `data-${k}`).not.toContain("token");
        expect(v, `data-${k}`).not.toContain("session");
      }
      // The only new boolean signal is data-signed-in.
      expect(Object.keys(attrs).sort()).toEqual(
        ["capacity", "event-key", "full", "island", "login-url", "paused", "signed-in"].sort(),
      );
    }
  });
});

describe("acceptance: no-JS parity (Hono)", () => {
  it("non-member prompts are real anchors with no form; members keep the form", async () => {
    const guest = page({ rsvpOpen: false, capacity: 10 });
    guest.as(null);
    const guestHtml = mount(await (await guest.request()).text());
    expect(guestHtml).toMatch(/<a href="[^"]+"[^>]*>/);
    expect(guestHtml).not.toContain("<form");
    const outsider = page({ rsvpOpen: true, capacity: null });
    outsider.as(nonMemberSession);
    const outsiderHtml = mount(await (await outsider.request()).text());
    expect(outsiderHtml).toMatch(/<a href="[^"]+"[^>]*>/);
    expect(outsiderHtml).not.toContain("<form");
    const member = page({ rsvpOpen: true, capacity: null });
    member.as(memberSession);
    const memberHtml = mount(await (await member.request()).text());
    expect(memberHtml).toContain('<form method="post"');
    expect(memberHtml).toContain(`action="${PATH}/rsvp"`);
  });
});
