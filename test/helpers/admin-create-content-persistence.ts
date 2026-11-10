import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEventCreateView } from "../../src/admin/kit-event-create";
import { adminApp } from "../../src/admin/routes";
import { activityLog, events } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import { getPublicEvent } from "../../src/events/reads";
import { registerDetailRoutes } from "../../src/events/routes";
import { sameOrigin } from "../../src/same-origin";
import { createMemorySessionStore } from "../../src/sessions";
import { decode, fields, nativeForm, values } from "./admin-create-content-form";
import { compileKitForms } from "./admin-validation-correction";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./member-data-db";

// Register under admin.test.ts's existing DB gate, with an owned schema and
// component lifecycle. The DB-free form/validation proofs remain ungated.
export function registerCreateContentPersistenceAcceptance() {
  describe("Kit native create persistence and public readback (disposable Postgres)", () => {
    let fixture: MemberDataFixture;
    let kit: Awaited<ReturnType<typeof compileKitForms>>;
    const renderKit = (v: Record<string, string>) => kit.renderForm(0, buildEventCreateView(v));
    beforeAll(async () => {
      kit = await compileKitForms();
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      kit?.dispose();
      await fixture?.dispose();
    });
    beforeEach(async () => fixture.reset());

    async function submit(
      body: URLSearchParams,
      actor: typeof MEMBER | null = MODERATOR,
      origin = env.APP_URL,
    ) {
      const sessions = createMemorySessionStore();
      const cookie = actor ? await cookieFor(sessions, actor) : "";
      const app = new Hono<{ Bindings: Env }>()
        .use("*", sameOrigin)
        .route("/admin", adminApp({ sessionStore: sessions, db: fixture.db }));
      registerDetailRoutes(
        app,
        async () => null,
        async () => null,
      );
      const bindings = { ...env, ADMIN_DB: fixture.db };
      const response = await app.request(
        "/admin/events",
        {
          method: "POST",
          headers: {
            cookie,
            origin,
            accept: "text/html",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
        bindings,
      );
      return { response, app, bindings };
    }

    for (const state of ["populated", "blank", "whitespace", "omitted"] as const) {
      it(`${state} controls survive native create, storage and the guest detail read`, async () => {
        const empty = Object.fromEntries(
          fields.map((field) => [field.name, state === "whitespace" ? "   " : ""]),
        );
        const form = nativeForm(
          renderKit({
            ...values,
            ...(state === "populated" ? {} : empty),
            recurrence_frequency: "",
            recurrence_count: "",
          }),
        );
        if (state === "omitted") for (const field of fields) form.body.delete(field.name);
        const { response, app, bindings } = await submit(form.body);
        expect(response.status).toBe(303);
        const redirect = new URL(response.headers.get("location")!, env.APP_URL);
        expect(redirect.pathname).toMatch(/^\/admin\/events\/[0-9A-Z]{26}$/);
        expect(redirect.search).toBe("?saved=1");
        const stored = await fixture.db.select().from(events);
        expect(stored).toHaveLength(1);
        const row = stored[0]!;
        const expected =
          state === "populated"
            ? {
                accessibilityNotes: "Step-free entrance; quiet room available.",
                organizer_name: "Riley & friends",
                join_url: "https://meet.example.test/lobby?room=9&mode=public",
                join_instructions: "Use the public lobby.\r\nAsk the host for the next game.",
              }
            : {
                accessibilityNotes: null,
                organizer_name: null,
                join_url: null,
                join_instructions: null,
              };
        expect(redirect.pathname).toBe(`/admin/events/${row.eventKey}`);
        expect(response.headers.get("location")).toBe(`/admin/events/${row.eventKey}?saved=1`);
        expect(row).toMatchObject({
          ...expected,
          status: "draft",
          createdBy: MODERATOR.userId,
          startsAt: new Date("2030-06-05T19:00:00Z"),
          endsAt: new Date("2030-06-05T21:00:00Z"),
          timezone: "Europe/London",
        });
        expect(await fixture.db.select().from(activityLog)).toEqual([
          expect.objectContaining({
            subjectType: "Event",
            subjectId: row.eventKey,
            causerId: MODERATOR.userId,
            description: "created event Public game night",
          }),
        ]);
        const path = `/e/${row.eventKey}`;
        const draft = await app.request(path, {}, bindings);
        expect(draft.status).toBe(403);
        expect(await draft.text()).not.toContain('data-testid="event-organizer"');

        // Fixture-only publication models a later authorized publish. The create
        // endpoint above must never publish, and no bot/write-back is invoked here.
        await fixture.db.update(events).set({ status: "published" }).where(eq(events.id, row.id));
        expect(await getPublicEvent(fixture.db, row.eventKey)).toMatchObject(expected);
        const published = await app.request(path, {}, bindings);
        expect(published.status).toBe(200);
        expect(published.headers.get("cache-control")).toContain("private");
        expect(published.headers.get("cache-control")).toContain("no-store");
        const html = await published.text();
        for (const id of [
          "event-accessibility",
          "event-organizer",
          "event-public-join-link",
          "event-join-instructions",
        ]) {
          if (state === "populated") expect(html).toContain(`data-testid="${id}"`);
          else expect(html).not.toContain(`data-testid="${id}"`);
        }
        if (state === "populated") {
          const text = decode(html).replace(/\r\n/g, "\n");
          for (const value of Object.values(expected))
            expect(text).toContain(value!.replace(/\r\n/g, "\n"));
          expect(html).toContain('href="https://meet.example.test/lobby?room=9&amp;mode=public"');
        }
      });
    }

    it.each([null, MEMBER])("denies %j before creating any row or audit", async (actor) => {
      const form = nativeForm(renderKit(values));
      const { response } = await submit(form.body, actor);
      expect(response.status).toBe(actor ? 403 : 303);
      expect(await fixture.db.select().from(events)).toEqual([]);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
    });

    it("denies a cross-origin serialized form without a row or audit", async () => {
      const form = nativeForm(renderKit(values));
      const { response } = await submit(form.body, MODERATOR, "https://other.example.test");
      expect(response.status).toBe(403);
      expect(await fixture.db.select().from(events)).toEqual([]);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
    });
  });
}
