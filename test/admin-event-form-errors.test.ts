// Real POST responses, with an owned synthetic schema on agent-testdb / CI Postgres.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { mergePatchInput, type PatchBase } from "../src/admin/store";
import { ValidationError, wallToUtc } from "../src/admin/validation";
import * as writeback from "../src/admin/writeback";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
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

describe("mergePatchInput newline policy", () => {
  const patchBase: PatchBase = {
    title: "Stored",
    game: null,
    description: "one\r\ntwo\rthree",
    accessibilityNotes: "ramp\r\nlift",
    timezone: "UTC",
    location: "hall\rroom",
    organizer_name: "Ada\r\nLovelace",
    join_url: "https://example.com/join",
    join_instructions: "step 1\r\nstep 2\rstep 3",
    capacity: null,
    startsAt: new Date("2026-11-04T20:00:00Z"),
    endsAt: new Date("2026-11-04T22:00:00Z"),
  };

  it("keeps omitted stored CRLF and lone CR exactly (raw machine policy)", () => {
    const input = mergePatchInput(patchBase, { title: "Renamed" });
    expect(input.title).toBe("Renamed");
    expect(input.description).toBe("one\r\ntwo\rthree");
    expect(input.accessibilityNotes).toBe("ramp\r\nlift");
    expect(input.location).toBe("hall\rroom");
    expect(input.organizer_name).toBe("Ada\r\nLovelace");
    expect(input.join_instructions).toBe("step 1\r\nstep 2\rstep 3");
  });

  it("still clears organizer, join link and accessibility notes on explicit blank", () => {
    for (const blank of ["", "  \r\n\t "]) {
      const input = mergePatchInput(patchBase, {
        organizer_name: blank,
        join_url: blank,
        accessibility_notes: blank,
      });
      expect(input.organizer_name).toBeNull();
      expect(input.join_url).toBeNull();
      expect(input.accessibilityNotes).toBeNull();
      expect(input.join_instructions).toBe("step 1\r\nstep 2\rstep 3");
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin event field errors (isolated test DB)", () => {
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
      const key = new URL(res.headers.get("location")!, APP_URL).pathname.split("/").pop()!;
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

  describe("human newline normalization", () => {
    const sevenFields = [
      { name: "title", column: "title", max: 100 },
      { name: "game", column: "game", max: 100 },
      { name: "location", column: "location", max: 255 },
      { name: "organizer_name", column: "organizer_name", max: 500 },
      { name: "description", column: "description", max: 1000 },
      { name: "accessibility_notes", column: "accessibilityNotes", max: 1000 },
      { name: "join_instructions", column: "join_instructions", max: 5000 },
    ] as const;
    // N code points after normalisation: mixed CRLF, CR and LF breaks, astral filler.
    const mixed = (n: number) => `a\r\n😀\rb\n${"😀".repeat(n - 6)}`;
    const mixedStored = (n: number) => `a\n😀\nb\n${"😀".repeat(n - 6)}`;
    const nonMutating = async (run: () => Promise<Response> | Response, status: number) => {
      const before = await fixture.db.select().from(events);
      const res = await run();
      expect(res.status).toBe(status);
      expect(await fixture.db.select().from(events)).toEqual(before);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
      return res;
    };
    const savedRow = async (res: Response, mode: "new" | "edit") => {
      const key =
        mode === "edit"
          ? KEY
          : new URL(res.headers.get("location")!, APP_URL).pathname.split("/").pop()!;
      const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, key));
      return row!;
    };

    for (const mode of ["new", "edit"] as const) {
      const path = mode === "new" ? "/admin/events" : `/admin/events/${KEY}`;
      for (const { name, column, max } of sevenFields) {
        it(`${mode}: ${name} saves ${max} normalised characters as LF`, async () => {
          const res = await post(path, { ...FORM, [name]: mixed(max) });
          expect(res.status).toBe(303);
          const row = (await savedRow(res, mode)) as Record<string, unknown>;
          expect(row[column]).toBe(mixedStored(max));
          expect(String(row[column])).not.toContain("\r");
        });
        it(`${mode}: ${name} at ${max + 1} answers 422 without writes`, async () => {
          const res = await nonMutating(() => post(path, { ...FORM, [name]: mixed(max + 1) }), 422);
          const html = await res.text();
          expect([...html.matchAll(/data-testid="error-([^"]+)"/g)].map((m) => m[1])).toEqual([
            name,
          ]);
        });
        it(`${mode}: ${name} refuses a raw BOM without writes`, async () => {
          const res = await nonMutating(() => post(path, { ...FORM, [name]: "\uFEFFa\r\nb" }), 422);
          expect(await res.text()).toContain('data-testid="error-' + name + '"');
        });
      }
    }

    it("edit: the re-rendered form shows saved LF values with no CR", async () => {
      const values = {
        ...FORM,
        description: "one\r\ntwo\rthree",
        accessibility_notes: "ramp\r\nlift",
        join_instructions: "a\r\nb",
      };
      expect((await post(`/admin/events/${KEY}`, values)).status).toBe(303);
      const res = await app.request(`${APP_URL}/admin/events/${KEY}`, { headers: { cookie } }, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("\r");
      expect(html).toContain("one\ntwo\nthree");
      expect(html).toContain("ramp\nlift");
    });

    it("edit: an explicit blank organizer clears the stored value", async () => {
      await fixture.db
        .update(events)
        .set({ organizer_name: "Ada\nLovelace" })
        .where(eq(events.eventKey, KEY));
      const res = await post(`/admin/events/${KEY}`, { ...FORM, organizer_name: "\r\n \t" });
      expect(res.status).toBe(303);
      expect((await savedRow(res, "edit")).organizer_name).toBeNull();
    });

    it("rejects a cross-origin POST with no writes", async () => {
      await nonMutating(
        () =>
          app.request(
            `${APP_URL}/admin/events/${KEY}`,
            {
              method: "POST",
              headers: { cookie, origin: "https://evil.example.test" },
              body: new URLSearchParams({ ...FORM, description: "a\r\nb" }),
            },
            env,
          ),
        403,
      );
    });

    it("refuses a POST without the session cookie with no writes", async () => {
      const before = await fixture.db.select().from(events);
      const res = await app.request(
        `${APP_URL}/admin/events/${KEY}`,
        {
          method: "POST",
          headers: { origin: APP_URL },
          body: new URLSearchParams({ ...FORM, description: "a\r\nb" }),
        },
        env,
      );
      expect(res.status).not.toBe(303);
      expect(res.status).not.toBe(200);
      expect(await fixture.db.select().from(events)).toEqual(before);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publish: a malformed multipart body answers 400 with no writes or write-back", async () => {
    const dispatch = vi.spyOn(writeback, "dispatchWriteBack").mockResolvedValue(undefined);
    const before = await fixture.db.select().from(events);
    const res = await app.request(
      `${APP_URL}/admin/events/${KEY}/publish`,
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
    expect(before[0]?.status).toBe("draft");
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fresh fold input saves the second occurrence deterministically", async () => {
    const res = await post("/admin/events", {
      ...FORM,
      starts_at: "2026-10-25 01:30",
      ends_at: "2026-10-25 02:30",
    });
    expect(res.status).toBe(303);
    const key = new URL(res.headers.get("location")!, APP_URL).pathname.split("/").pop()!;
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
