// Send-time eligibility for event reminders: the pure rule slice 2 owns.
// The Builder implements `resolveReminderPreference` in
// `src/events/reminders.ts` on this branch and never edits this file. RED
// until that module exists (the loader below turns "missing module" into a
// readable assertion failure, not a collection error, so typecheck stays
// green while the behavior is missing).
//
// Pinned contract:
// - Input: the member's live RSVP status for the event (`null` = no row),
//   the live global opt-out, the live per-event mute. All three are read at
//   send time, so every toggle and every un-RSVP takes effect immediately.
// - Output: `{send: true}`, or `{send: false, reason}` with one of the
//   spec section 3 skip codes: `skipped_rsvp`, `skipped_optout`,
//   `skipped_muted`.
// - `going` and `maybe` are eligible (spec Q6: maybe gets both leads);
//   `not_going`, `waitlisted` and no row are `skipped_rsvp`.
// - Precedence is RSVP, then opt-out, then mute: the RSVP row is the gate
//   (spec section 2.1), and the global opt-out is the broader statement,
//   so it wins over a per-event mute when both apply.
//
// Deliberately NOT pinned here (slice 3 owns them): event-status gating,
// the rolling 24h cap, lead windows, delivery-row writes, the sweep itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import {
  cookieFor as memberCookieFor,
  env as memberEnv,
  EVENT_KEY,
  MEMBER,
} from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

type ReminderEligibilityInput = {
  rsvpStatus: "going" | "maybe" | "not_going" | "waitlisted" | null;
  reminderOptOut: boolean;
  muted: boolean;
};
type ReminderVerdict =
  | { send: true }
  | { send: false; reason: "skipped_rsvp" | "skipped_optout" | "skipped_muted" };
type ResolveReminderPreference = (input: ReminderEligibilityInput) => ReminderVerdict;

// Widened on purpose: a string literal would fail typecheck (and Vite
// resolution) until the builder creates the module. See the header.
const REMINDERS_MODULE: string = "../src/events/reminders";

async function loadResolver(): Promise<ResolveReminderPreference | null> {
  const mod = (await import(REMINDERS_MODULE).catch(() => null)) as {
    resolveReminderPreference?: unknown;
  } | null;
  return typeof mod?.resolveReminderPreference === "function"
    ? (mod.resolveReminderPreference as ResolveReminderPreference)
    : null;
}

async function resolveOrFail(input: ReminderEligibilityInput): Promise<ReminderVerdict> {
  const resolve = await loadResolver();
  expect(typeof resolve, "slice 2 adds resolveReminderPreference to src/events/reminders.ts").toBe(
    "function",
  );
  return (resolve as ResolveReminderPreference)(input);
}

const ELIGIBILITY_CASES: Array<[ReminderEligibilityInput, ReminderVerdict]> = [
  [{ rsvpStatus: "going", reminderOptOut: false, muted: false }, { send: true }],
  [{ rsvpStatus: "maybe", reminderOptOut: false, muted: false }, { send: true }],
  [
    { rsvpStatus: "not_going", reminderOptOut: false, muted: false },
    { send: false, reason: "skipped_rsvp" },
  ],
  [
    { rsvpStatus: "waitlisted", reminderOptOut: false, muted: false },
    { send: false, reason: "skipped_rsvp" },
  ],
  [
    { rsvpStatus: null, reminderOptOut: false, muted: false },
    { send: false, reason: "skipped_rsvp" },
  ],
  [
    { rsvpStatus: "going", reminderOptOut: true, muted: false },
    { send: false, reason: "skipped_optout" },
  ],
  [
    { rsvpStatus: "maybe", reminderOptOut: true, muted: false },
    { send: false, reason: "skipped_optout" },
  ],
  [
    { rsvpStatus: "going", reminderOptOut: false, muted: true },
    { send: false, reason: "skipped_muted" },
  ],
  // Precedence: the RSVP gate first, then the global opt-out, then the mute.
  [
    { rsvpStatus: "going", reminderOptOut: true, muted: true },
    { send: false, reason: "skipped_optout" },
  ],
  [
    { rsvpStatus: null, reminderOptOut: true, muted: true },
    { send: false, reason: "skipped_rsvp" },
  ],
  [
    { rsvpStatus: "waitlisted", reminderOptOut: true, muted: true },
    { send: false, reason: "skipped_rsvp" },
  ],
];

describe("reminder send-time eligibility", () => {
  it.each(ELIGIBILITY_CASES)("resolves %o to %o", async (input, expected) => {
    expect(await resolveOrFail(input)).toEqual(expected);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "eligibility follows live rows (isolated agent-testdb schema)",
  () => {
    const APP_URL = "https://next.example.test";
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const fullEnv = () =>
      ({
        ...memberEnv,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
      }) as unknown as Env;

    const readRsvpStatus = async (): Promise<ReminderEligibilityInput["rsvpStatus"]> => {
      const rows = await fixture.db.select().from(rsvps);
      return (rows.find((r) => r.userId === MEMBER.userId)?.status ??
        null) as ReminderEligibilityInput["rsvpStatus"];
    };
    // Slice 1 columns; raw SQL keeps this file decoupled from the builder's
    // Drizzle table placement. A missing profile row reads as subscribed,
    // matching the column default for existing rows. Until slice 1 lands,
    // missing relations read as defaults so failures pin slice 2 behavior
    // instead of erroring on slice 1's absence.
    const isMissingSlice1Relation = (err: unknown): boolean => {
      if (typeof err !== "object" || err === null) return false;
      const code = (err as { code?: unknown }).code;
      return code === "42P01" || code === "42703";
    };
    const readOptOut = async (): Promise<boolean> => {
      try {
        const rows = await fixture.client`select reminder_opt_out from profiles
          where user_id = ${MEMBER.userId}`;
        return (rows[0]?.reminder_opt_out as boolean | undefined) ?? false;
      } catch (err) {
        if (isMissingSlice1Relation(err)) return false;
        throw err;
      }
    };
    const readMuted = async (): Promise<boolean> => {
      try {
        const rows = await fixture.client`select 1 from event_reminder_mutes
          where user_id = ${MEMBER.userId}`;
        return rows.length > 0;
      } catch (err) {
        if (isMissingSlice1Relation(err)) return false;
        throw err;
      }
    };
    const liveInput = async (): Promise<ReminderEligibilityInput> => ({
      rsvpStatus: await readRsvpStatus(),
      reminderOptOut: await readOptOut(),
      muted: await readMuted(),
    });

    const putMute = (muted: boolean) =>
      memberCookieFor(sessions, MEMBER).then((cookie) =>
        app.request(
          `/events/${EVENT_KEY}/reminder-mute`,
          {
            method: "PUT",
            headers: {
              cookie,
              origin: APP_URL,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ muted }),
          },
          fullEnv(),
        ),
      );
    const patchOptOut = (reminderOptOut: boolean) =>
      memberCookieFor(sessions, MEMBER).then((cookie) =>
        app.request(
          `/members/${MEMBER.userId}`,
          {
            method: "PATCH",
            headers: {
              cookie,
              origin: APP_URL,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              bio: "bio",
              games: [],
              timezone: "UTC",
              reminder_opt_out: reminderOptOut,
            }),
          },
          fullEnv(),
        ),
      );

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      sessions = createMemorySessionStore();
      await fixture.reset();
      await fixture.client`delete from web_throttle_hits`;
      const { seed } = await import("./helpers/member-data");
      await seed(fixture.db);
      const [event] = await fixture.db.select().from(events);
      await fixture.db
        .insert(rsvps)
        .values({ eventId: event!.id, userId: MEMBER.userId, status: "going" });
    });

    it("toggles and un-RSVP take effect on the very next send-time read", async () => {
      expect(await resolveOrFail(await liveInput())).toEqual({ send: true });

      expect((await putMute(true)).status).toBe(200);
      expect(await resolveOrFail(await liveInput())).toEqual({
        send: false,
        reason: "skipped_muted",
      });

      expect((await putMute(false)).status).toBe(200);
      expect(await resolveOrFail(await liveInput())).toEqual({ send: true });

      expect((await patchOptOut(true)).status).toBe(200);
      expect(await resolveOrFail(await liveInput())).toEqual({
        send: false,
        reason: "skipped_optout",
      });

      expect((await patchOptOut(false)).status).toBe(200);
      expect(await resolveOrFail(await liveInput())).toEqual({ send: true });

      // Un-RSVP by withdrawal cancels pending sends.
      const cookie = await memberCookieFor(sessions, MEMBER);
      const withdraw = await app.request(
        `/events/${EVENT_KEY}/rsvp`,
        { method: "DELETE", headers: { cookie, origin: APP_URL, accept: "application/json" } },
        fullEnv(),
      );
      expect(withdraw.status).toBe(204);
      expect(await resolveOrFail(await liveInput())).toEqual({
        send: false,
        reason: "skipped_rsvp",
      });

      // Un-RSVP by answering not_going cancels pending sends too.
      const going = await app.request(
        `/events/${EVENT_KEY}/rsvp`,
        {
          method: "PUT",
          headers: {
            cookie,
            origin: APP_URL,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ status: "going" }),
        },
        fullEnv(),
      );
      expect([200, 201]).toContain(going.status);
      expect(await resolveOrFail(await liveInput())).toEqual({ send: true });

      const notGoing = await app.request(
        `/events/${EVENT_KEY}/rsvp`,
        {
          method: "PUT",
          headers: {
            cookie,
            origin: APP_URL,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ status: "not_going" }),
        },
        fullEnv(),
      );
      expect([200, 201]).toContain(notGoing.status);
      expect(await resolveOrFail(await liveInput())).toEqual({
        send: false,
        reason: "skipped_rsvp",
      });
    });
  },
);
