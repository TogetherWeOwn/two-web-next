// Moderator inventory resilience: one imported event row whose stored
// timestamps cannot be represented as a JS Date (Postgres infinity or an
// out-of-range year decodes to an Invalid Date) must not take down the
// events list or the edit page — the bad row is exactly the row a moderator
// needs to open and repair. These pins drive the admin read seams directly:
// the Hono EventsPage render, the Kit list serializer, the Kit edit read
// model, and the PATCH merge that saves a corrected time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { jsx } from "hono/jsx/jsx-runtime";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import { buildEventListView, serializeEventListRow } from "../src/admin/kit-events";
import { EventsPage } from "../src/admin/pages";
import { adminApp } from "../src/admin/routes";
import { mergePatchInput, type EventListRow, type PatchBase } from "../src/admin/store";
import { ValidationError } from "../src/admin/validation-shared";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const INVALID = new Date(Number.NaN);

function listRow(over: Partial<EventListRow> & { eventKey: string }): EventListRow {
  const at = new Date("2026-11-01T18:00:00.000Z");
  const { eventKey, ...rest } = over;
  return {
    id: 1,
    eventKey,
    title: eventKey,
    game: null,
    description: null,
    startsAt: at,
    endsAt: new Date("2026-11-01T21:00:00.000Z"),
    timezone: "Europe/London",
    location: null,
    capacity: 8,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: at,
    updatedAt: at,
    icsSequence: 0n,
    syncRevision: 0,
    syncedRevision: 0,
    goingCount: 3,
    ...rest,
  } as EventListRow;
}

describe("Hono moderator inventory with an unrenderable stored time", () => {
  const normal = listRow({ eventKey: "EVTNORMAL1", title: "Friday game night" });
  const badStart = listRow({
    eventKey: "EVTBADSTART",
    title: "Imported night (broken start)",
    startsAt: INVALID,
    status: "draft",
  });
  const badEnd = listRow({
    eventKey: "EVTBADEND1",
    title: "Imported night (broken end)",
    endsAt: INVALID,
  });

  it("renders every row: finite rows byte-identical, bad rows visibly flagged", () => {
    const html = String(
      jsx(EventsPage, {
        rows: [normal, badStart, badEnd],
        query: parseEventListQuery({}),
        hasNext: false,
      }),
    );
    // The finite row keeps its exact time bytes.
    expect(html).toContain(
      '<time datetime="2026-11-01T18:00:00.000Z">2026-11-01T18:00:00.000Z</time>',
    );
    // The bad-start row stays visible and identifiable, with a placeholder
    // instead of a <time> element the instant cannot fill.
    expect(html).toContain("/admin/events/EVTBADSTART");
    expect(html).toContain("Imported night (broken start)");
    expect(html).toContain('data-testid="event-status-EVTBADSTART"');
    expect(html).toContain('data-testid="event-unrenderable-time-EVTBADSTART"');
    expect(html).toContain("Unrenderable time");
    // The bad-end row keeps its renderable start and flags the broken end.
    expect(html).toContain('data-testid="event-unrenderable-time-EVTBADEND1"');
    // No invalid instant ever reaches a datetime attribute.
    expect(html).not.toContain('datetime=""');
    expect(html).not.toContain("Invalid Date");
  });

  it("offers no RSVP pause/reopen for a published row whose end is unrenderable", () => {
    const html = String(
      jsx(EventsPage, {
        rows: [badEnd],
        query: parseEventListQuery({}),
        hasNext: false,
      }),
    );
    expect(html).not.toContain("rsvp-pause");
    expect(html).not.toContain("rsvp-reopen");
    expect(html).not.toContain("Pause RSVPs");
  });
});

describe("Kit moderator inventory with an unrenderable stored time", () => {
  it("serializes nonfinite instants as empty strings and keeps the row", () => {
    const bad = listRow({
      eventKey: "EVTBADSTART",
      title: "Imported night (broken start)",
      startsAt: INVALID,
      endsAt: INVALID,
      status: "draft",
    });
    expect(serializeEventListRow(bad)).toEqual({
      eventKey: "EVTBADSTART",
      title: "Imported night (broken start)",
      game: null,
      status: "draft",
      startsAt: "",
      endsAt: "",
      capacity: 8,
      rsvpOpen: true,
      goingCount: 3,
    });
  });

  it("keeps the bad row in the view alongside finite rows", () => {
    const view = buildEventListView(parseEventListQuery({}), [
      listRow({ eventKey: "EVTNORMAL1" }),
      listRow({ eventKey: "EVTBADEND1", endsAt: INVALID }),
    ]);
    expect(view.rows.map((r) => r.eventKey)).toEqual(["EVTNORMAL1", "EVTBADEND1"]);
    expect(view.rows[0]!.startsAt).toBe("2026-11-01T18:00:00.000Z");
    expect(view.rows[0]!.endsAt).toBe("2026-11-01T21:00:00.000Z");
    expect(view.rows[1]!.startsAt).toBe("2026-11-01T18:00:00.000Z");
    expect(view.rows[1]!.endsAt).toBe("");
  });

  it("renders the placeholder instead of a bare time element in the Kit page", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../web/src/routes/admin/events/+page.svelte", import.meta.url).href),
      "utf8",
    );
    expect(source).toContain("Unrenderable time");
    expect(source).toContain("event-unrenderable-time-");
    // The <time> element is conditional on a rendered instant existing.
    expect(source).toContain("{#if r.startsAt}");
    expect(source).toContain("<time datetime={r.startsAt}>{r.startsAt}</time>");
  });
});

describe("Kit event edit with unrenderable stored times", () => {
  const db = {} as Db;
  const baseRow: KitEventEditRow = {
    eventKey: "EVTBADSTART",
    title: "Imported night (broken start)",
    game: "Chess",
    description: "Casual play",
    startsAt: INVALID,
    endsAt: INVALID,
    timezone: "Europe/London",
    location: "Hall",
    capacity: 8,
    status: "published",
    rsvpOpen: true,
    recurrenceFrequency: null,
  };

  function depsFor(row: KitEventEditRow): KitEventEditDeps {
    return {
      db,
      get: async () => ({ ...row }),
      list: async () => ({ rows: [], total: 0 }),
      now: new Date("2026-10-01T12:00:00.000Z"),
    };
  }

  it("opens with empty time fields the moderator can correct, like the Hono twin", async () => {
    const outcome = await resolveKitEventEdit("EVTBADSTART", {}, depsFor(baseRow));
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.title).toBe("Imported night (broken start)");
    expect(outcome.view.values.title).toBe("Imported night (broken start)");
    expect(outcome.view.values.starts_at).toBe("");
    expect(outcome.view.values.ends_at).toBe("");
    expect(outcome.view.values.timezone).toBe("Europe/London");
    expect(outcome.view.endsAt).toBe("");
    // A published row with no renderable end is never offered the RSVP toggle.
    expect(outcome.view.rsvpAction).toBeNull();
  });

  it("leaves wall fields empty for an unknown stored timezone, keeping the zone visible", async () => {
    const outcome = await resolveKitEventEdit(
      "EVTBADSTART",
      {},
      depsFor({
        ...baseRow,
        startsAt: new Date("2026-11-01T18:00:00.000Z"),
        endsAt: new Date("2026-11-01T21:00:00.000Z"),
        timezone: "Mars/Olympus",
      }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.values.starts_at).toBe("");
    expect(outcome.view.values.ends_at).toBe("");
    expect(outcome.view.values.timezone).toBe("Mars/Olympus");
    // The stored instant itself is renderable, so its ISO carrier survives.
    expect(outcome.view.endsAt).toBe("2026-11-01T21:00:00.000Z");
  });
});

describe("saving a corrected time over an unrenderable stored row", () => {
  const base: PatchBase = {
    title: "Imported night (broken start)",
    game: null,
    description: null,
    accessibilityNotes: null,
    timezone: "Europe/London",
    location: "Hall",
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: null,
    startsAt: INVALID,
    endsAt: INVALID,
  };

  it("parses the replacement wall times instead of formatting the stored instants", () => {
    const input = mergePatchInput(base, {
      starts_at: "2026-11-01 19:00",
      ends_at: "2026-11-01 22:00",
    });
    // November London is GMT, so wall text is the UTC instant.
    expect(input.startsAtUtc.toISOString()).toBe("2026-11-01T19:00:00.000Z");
    expect(input.endsAtUtc.toISOString()).toBe("2026-11-01T22:00:00.000Z");
  });

  it("refuses an omitted time with a field error, never a RangeError", () => {
    try {
      mergePatchInput(base, { title: "Still broken" });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fields.starts_at).toBe("Enter a valid start time.");
      expect((err as ValidationError).fields.ends_at).toBe("Enter a valid end time.");
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "stored infinity timestamps through the admin routes (isolated fixture)",
  () => {
    const env: Env = {
      APP_URL: "https://next.example.test",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    };
    const viewer = "100000000000000117";
    let fixture: MemberDataFixture;
    const store = createMemorySessionStore();
    let cookie: string;
    const app = () => adminApp({ sessionStore: store, db: fixture.db });
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as Env;

    async function cookieFor(sessionStore: SessionStore) {
      const token = newSessionToken();
      await sessionStore.create({
        tokenHash: await hashToken(token),
        userId: viewer,
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET!, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(() => fixture?.dispose());

    beforeEach(async () => {
      await fixture.reset();
      cookie = await cookieFor(store);
      await fixture.db.insert(events).values([
        {
          eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          title: "Friday game night",
          status: "published",
          timezone: "Europe/London",
          location: "Hall",
          startsAt: new Date("2026-11-01T18:00:00.000Z"),
          endsAt: new Date("2026-11-01T21:00:00.000Z"),
        },
        {
          eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
          title: "Imported night (broken start)",
          status: "draft",
          timezone: "Europe/London",
          startsAt: new Date("2026-11-03T18:00:00.000Z"),
          endsAt: new Date("2026-11-03T21:00:00.000Z"),
        },
      ]);
      // The import defect under test: a stored bound JS cannot represent.
      await fixture.db.execute(
        sql`update events set starts_at = 'infinity' where event_key = '01ARZ3NDEKTSV4RRFFQ69G5FAB'`,
      );
    });

    it("serves the inventory with the bad row flagged, never a 500", async () => {
      const res = await app().request("/events", { headers: { cookie } }, bindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Friday game night");
      expect(html).toContain(
        '<time datetime="2026-11-01T18:00:00.000Z">2026-11-01T18:00:00.000Z</time>',
      );
      expect(html).toContain("Imported night (broken start)");
      expect(html).toContain('data-testid="event-unrenderable-time-01ARZ3NDEKTSV4RRFFQ69G5FAB"');
      expect(html).toContain("Unrenderable time");
    });

    it("opens the edit page and saves a corrected finite time", async () => {
      const page = await app().request(
        "/events/01ARZ3NDEKTSV4RRFFQ69G5FAB",
        { headers: { cookie } },
        bindings(),
      );
      expect(page.status).toBe(200);
      const pageHtml = await page.text();
      expect(pageHtml).toContain("Imported night (broken start)");

      const body = new URLSearchParams({
        title: "Imported night (broken start)",
        starts_at: "2026-11-03 19:00",
        ends_at: "2026-11-03 22:00",
        timezone: "Europe/London",
      });
      const saved = await app().request(
        "/events/01ARZ3NDEKTSV4RRFFQ69G5FAB",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
        bindings(),
      );
      expect(saved.status).toBe(303);
      const [row] = await fixture.db
        .select()
        .from(events)
        .where(eq(events.eventKey, "01ARZ3NDEKTSV4RRFFQ69G5FAB"));
      expect(row!.startsAt.toISOString()).toBe("2026-11-03T19:00:00.000Z");
      expect(row!.endsAt.toISOString()).toBe("2026-11-03T22:00:00.000Z");
    });
  },
);
