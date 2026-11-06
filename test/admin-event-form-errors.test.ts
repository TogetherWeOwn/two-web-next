// Real POST responses, with an owned synthetic schema on agent-testdb / CI Postgres.
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { ValidationError, wallToUtc } from "../src/admin/validation";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "event-form-test-secret-at-least-32-bytes";
const KEY = "01K00000000000000000000021";
const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "Europe/London",
};
const GAP =
  "That time never occurred in Europe/London — clocks skipped forward over it. Pick a time outside the gap.";
const invalid = (raw: string) => `Not a date and time (want YYYY-MM-DD HH:mm): ${raw}`;
const escape = (raw: string) =>
  raw
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function expectFormErrors(
  html: string,
  values: Record<string, string>,
  errors: Record<string, string>,
) {
  expect(html).toContain('data-testid="form-errors"');
  expect(html).toContain("Check the highlighted fields and try again.");
  const visible = [...html.matchAll(/data-testid="error-([^"]+)"/g)].map((m) => m[1]);
  expect(visible.sort()).toEqual(Object.keys(errors).sort());
  for (const name of ["title", "starts_at", "ends_at", "timezone"]) {
    const id = `f-${name.replaceAll("_", "-")}`;
    const field = [...html.matchAll(/<div class="field">([\s\S]*?)<\/div>/g)].find((m) =>
      m[1]!.includes(`name="${name}"`),
    )?.[1];
    expect(field, name).toBeDefined();
    expect(field).toContain(`<label for="${id}">`);
    const input = field!.match(/<input\b[^>]*>/)?.[0];
    expect(input).toContain(`id="${id}"`);
    expect(input).toContain(`value="${escape(values[name]!)}"`);
    if (errors[name]) {
      expect(input).toContain('aria-invalid="true"');
      // Field owns association: hint id first when the field carries hint copy.
      const hintPrefix = field!.includes(`id="${id}-hint"`) ? `${id}-hint ` : "";
      expect(input).toContain(`aria-describedby="${hintPrefix}${id}-error"`);
      expect(field).toMatch(new RegExp(`<p[^>]*id="${id}-error"[^>]*role="alert"`));
      expect(field).toContain(escape(errors[name]!));
    } else {
      expect(input).not.toContain("aria-invalid");
      // Timezone always carries hint copy, so Field wires the hint id even clean.
      const hintOnly = field!.includes(`id="${id}-hint"`)
        ? `aria-describedby="${id}-hint"`
        : "aria-describedby";
      if (field!.includes(`id="${id}-hint"`)) expect(input).toContain(hintOnly);
      else expect(input).not.toContain(hintOnly);
    }
  }
}

it("keeps the shared wallToUtc error keys and second-fold resolution unchanged", () => {
  for (const [raw, timezone, fields] of [
    ["not-a-time", "Europe/London", { wall: invalid("not-a-time") }],
    ["2026-03-29 01:30", "Europe/London", { wall: GAP }],
    [FORM.starts_at, "Unknown/Zone", { timezone: "Unknown timezone: Unknown/Zone" }],
  ] as const) {
    let caught: unknown;
    try {
      wallToUtc(raw, timezone);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).fields).toEqual(fields);
  }
  expect(wallToUtc("2026-10-25 01:30", "Europe/London").toISOString()).toBe(
    "2026-10-25T01:30:00.000Z",
  );
});

describe.skipIf(!process.env.DATABASE_URL)("admin event field errors (isolated test DB)", () => {
  describe("stored infinity timestamps through the admin routes (isolated fixture)", () => {
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
        {
          eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
          title: "Imported night (paused, broken end)",
          status: "published",
          timezone: "Europe/London",
          location: "Hall",
          startsAt: new Date("2026-11-05T18:00:00.000Z"),
          endsAt: new Date("2026-11-05T21:00:00.000Z"),
          rsvpOpen: false,
        },
        {
          eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          title: "Imported night (open, broken end)",
          status: "published",
          timezone: "Europe/London",
          location: "Hall",
          startsAt: new Date("2026-11-06T18:00:00.000Z"),
          endsAt: new Date("2026-11-06T21:00:00.000Z"),
          rsvpOpen: true,
        },
      ]);
      // The import defect under test: a stored bound JS cannot represent.
      await fixture.db.execute(
        sql`update events set starts_at = 'infinity' where event_key = '01ARZ3NDEKTSV4RRFFQ69G5FAB'`,
      );
      await fixture.db.execute(
        sql`update events set ends_at = '-infinity' where event_key in ('01ARZ3NDEKTSV4RRFFQ69G5FAC', '01ARZ3NDEKTSV4RRFFQ69G5FAD')`,
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

    it("refuses to reopen RSVPs for a published paused row whose end is unrenderable", async () => {
      const res = await app().request(
        "/events/01ARZ3NDEKTSV4RRFFQ69G5FAC/rsvp-reopen",
        { method: "POST", headers: { cookie } },
        bindings(),
      );
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("That transition is not allowed");
      expect(html).toContain("Only published events that have not ended");
      const [row] = await fixture.db
        .select()
        .from(events)
        .where(eq(events.eventKey, "01ARZ3NDEKTSV4RRFFQ69G5FAC"));
      expect(row!.rsvpOpen).toBe(false);
    });

    it("refuses to pause RSVPs for a published open row whose end is unrenderable", async () => {
      const res = await app().request(
        "/events/01ARZ3NDEKTSV4RRFFQ69G5FAD/rsvp-pause",
        { method: "POST", headers: { cookie } },
        bindings(),
      );
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("That transition is not allowed");
      expect(html).toContain("Only published events that have not ended");
      const [row] = await fixture.db
        .select()
        .from(events)
        .where(eq(events.eventKey, "01ARZ3NDEKTSV4RRFFQ69G5FAD"));
      expect(row!.rsvpOpen).toBe(true);
    });
  });

  let fixture: MemberDataFixture;
  let cookie: string;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  const store = createMemorySessionStore();

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "wall-error-mod",
      username: "mod",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    cookie = (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    env = {
      APP_URL,
      SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "guild",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      ADMIN_DB: fixture.db,
    } as Env;
    app = new Hono<{ Bindings: Env }>()
      .use("*", sameOrigin)
      .route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(events).values({
      eventKey: KEY,
      title: "Stored title",
      timezone: FORM.timezone,
      status: "draft",
      startsAt: new Date("2026-11-04T20:00:00Z"),
      endsAt: new Date("2026-11-04T22:00:00Z"),
    });
  });

  const post = (path: string, values: Record<string, string>) =>
    app.request(
      APP_URL + path,
      {
        method: "POST",
        headers: { cookie, origin: APP_URL },
        body: new URLSearchParams(values),
      },
      env,
    );

  for (const mode of ["new", "edit"] as const) {
    const path = mode === "new" ? "/admin/events" : `/admin/events/${KEY}`;
    const cases: {
      label: string;
      values: Record<string, string>;
      errors: Record<string, string>;
    }[] = [
      {
        label: "invalid start",
        values: { starts_at: "not-a-time" },
        errors: { starts_at: invalid("not-a-time") },
      },
      {
        label: "impossible end date",
        values: { ends_at: "2026-02-30 22:00" },
        errors: { ends_at: invalid("2026-02-30 22:00") },
      },
      {
        label: "offset-bearing end",
        values: { ends_at: "2026-11-04T22:00Z" },
        errors: { ends_at: invalid("2026-11-04T22:00Z") },
      },
      {
        label: "start in a DST gap",
        values: { starts_at: "2026-03-29 01:30" },
        errors: { starts_at: GAP },
      },
      {
        label: "end in a DST gap",
        values: { ends_at: "2026-03-29 01:30" },
        errors: { ends_at: GAP },
      },
      {
        label: "both wall times invalid",
        values: { starts_at: "bad-start", ends_at: "bad-end" },
        errors: { starts_at: invalid("bad-start"), ends_at: invalid("bad-end") },
      },
      {
        label: "invalid start and missing end",
        values: { starts_at: "bad-start", ends_at: "" },
        errors: { starts_at: invalid("bad-start"), ends_at: "When does it end?" },
      },
      {
        label: "missing start and invalid end",
        values: { starts_at: "", ends_at: "bad-end" },
        errors: { starts_at: "When does it start?", ends_at: invalid("bad-end") },
      },
      {
        label: "HTML-sensitive invalid input",
        values: { starts_at: '<bad&time>"' },
        errors: { starts_at: invalid('<bad&time>"') },
      },
      {
        label: "unknown timezone",
        values: { timezone: "Unknown/Zone" },
        errors: { timezone: "Unknown timezone: Unknown/Zone." },
      },
      {
        label: "end before start",
        values: { ends_at: "2026-11-04 19:00" },
        errors: { ends_at: "The end is after the start." },
      },
    ];
    for (const { label, values: overrides, errors } of cases) {
      it(`${mode}: ${label} has retained values and accessible field errors, without writes`, async () => {
        const values = { ...FORM, ...overrides };
        const before = await fixture.db.select().from(events);
        const res = await post(path, values);
        expect(res.status).toBe(422);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const html = await res.text();
        expect(html).toContain(`action="${path}"`);
        expect(html).toContain(mode === "new" ? "Create draft" : "Save");
        expectFormErrors(html, values, errors);
        expect(await fixture.db.select().from(events)).toEqual(before);
        expect(await fixture.db.select().from(activityLog)).toEqual([]);
      });
    }

    it(`${mode}: valid wall times still save the same UTC instants`, async () => {
      const res = await post(path, FORM);
      expect(res.status).toBe(303);
      const key = res.headers.get("location")!.split("/").pop()!;
      const [saved] = await fixture.db.select().from(events).where(eq(events.eventKey, key));
      expect(saved?.startsAt.toISOString()).toBe("2026-11-04T20:00:00.000Z");
      expect(saved?.endsAt.toISOString()).toBe("2026-11-04T22:00:00.000Z");
    });

    it(`${mode}: a malformed multipart body answers 400 with no writes`, async () => {
      const before = await fixture.db.select().from(events);
      const res = await app.request(
        APP_URL + path,
        {
          method: "POST",
          headers: {
            cookie,
            origin: APP_URL,
            "content-type": "multipart/form-data; boundary=x",
          },
          body: "garbage",
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(await fixture.db.select().from(events)).toEqual(before);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
    });
  }

  it("fresh fold input saves the second occurrence deterministically", async () => {
    const res = await post("/admin/events", {
      ...FORM,
      starts_at: "2026-10-25 01:30",
      ends_at: "2026-10-25 02:30",
    });
    expect(res.status).toBe(303);
    const key = res.headers.get("location")!.split("/").pop()!;
    const [saved] = await fixture.db.select().from(events).where(eq(events.eventKey, key));
    expect(saved?.startsAt.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    expect(saved?.endsAt.toISOString()).toBe("2026-10-25T02:30:00.000Z");
  });

  it("an unchanged fold edit keeps the stored second occurrence, including seconds", async () => {
    await fixture.db
      .update(events)
      .set({
        startsAt: new Date("2026-10-25T01:30:17Z"),
        endsAt: new Date("2026-10-25T02:30:29Z"),
      })
      .where(eq(events.eventKey, KEY));
    const res = await post(`/admin/events/${KEY}`, {
      ...FORM,
      starts_at: "2026-10-25T01:30",
      ends_at: "2026-10-25 02:30",
    });
    expect(res.status).toBe(303);
    const [saved] = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
    expect(saved?.startsAt.toISOString()).toBe("2026-10-25T01:30:17.000Z");
    expect(saved?.endsAt.toISOString()).toBe("2026-10-25T02:30:29.000Z");
  });
});
