// Independent form-save acceptance for stale moderator event saves.
// The low-level unconditional updateEvent/patchEvent contract remains covered
// by the existing event-write suites, without modification. These tests own
// the form-save precondition: a server-derived baseline for exactly the saved
// content displayed, compared inside the committing lock, with the typed draft
// re-rendered on conflict.
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent } from "../src/agent-events/service";
import { adminApp } from "../src/admin/routes";
import type { EnvWithAdminDb } from "../src/admin/db";
import { updateEvent } from "../src/admin/store";
import { parseEventForm } from "../src/admin/validation";
import { sha256Hex } from "../src/bot/signer";
import { activityLog, events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { draftFields, reviewCurrentHref, savedForm } from "./helpers/event-save-document";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHILD_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const AGENT_CALLER = "stale-save-acceptance-agent";
const agentCfg = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: AGENT_CALLER,
  lockWaitMs: 1500,
};
const AGENT_FIELDS = {
  title: "Agent proof event",
  game: "Chess",
  description: "Stale-save interplay proof.",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Voice",
  capacity: 4,
};
const completeDraft = {
  title: '  B headline & "quoted" <draft>  ',
  game: " B game & <tag> ",
  description: " B paragraph & <not markup>\nSecond line ",
  starts_at: "2099-11-05 20:00",
  ends_at: "2099-11-05 22:00",
  timezone: "Europe/London",
  location: ' B hall & "room" ',
  capacity: "17",
};

// No added skips: fixtures reject unsafe URLs; acceptance needs the explicit
// disposable DATABASE_URL just like the application's database test command.
describe.skipIf(!process.env.DATABASE_URL)(
  "admin event stale Save acceptance (disposable Postgres)",
  () => {
    let fixture: MemberDataFixture;
    let admin: ReturnType<typeof adminApp>;
    let cookie: string;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 3 });
      await fixture.client`SET TIME ZONE 'UTC'`;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`DELETE FROM agent_event_idempotency_keys`;
      await clearAuditRows(fixture.client, ["agent_event_audits"]);
      await fixture.client`DELETE FROM agent_event_hits`;
      await fixture.client`DELETE FROM agent_event_grants`;
      await fixture.db.insert(events).values({
        eventKey: KEY,
        title: "Original title",
        game: "Original game",
        description: "Original description",
        startsAt: new Date("2099-11-04T20:00:00.000Z"),
        endsAt: new Date("2099-11-04T22:00:00.000Z"),
        timezone: "UTC",
        location: "Original hall",
        capacity: 8,
        status: "draft",
        createdBy: "seed-mod",
      });
      const store = createMemorySessionStore();
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "333333333333333333",
        username: "moderator",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date("2035-01-01T00:00:00Z"),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      admin = adminApp({ sessionStore: store, db: fixture.db });
    });

    const bindings = (): EnvWithAdminDb => ({ ...env, ADMIN_DB: fixture.db });
    const read = async (href = `/admin/events/${KEY}`) => {
      const response = await admin.request(
        href.replace(/^\/admin/, ""),
        { headers: { cookie } },
        bindings(),
      );
      expect(response.status).toBe(200);
      return savedForm(await response.text());
    };
    const save = async (fields: Record<string, string>, key = KEY) =>
      admin.request(
        `/events/${key}`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields),
        },
        bindings(),
      );
    const state = async (key = KEY) => {
      const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, key));
      const audits = await fixture.db.select().from(activityLog).orderBy(asc(activityLog.id));
      return { row, audits };
    };
    const conflict = async (response: Response, draft: Record<string, string>, key = KEY) => {
      expect.soft(response.status, "a stale Save is not a redirect/success").toBe(409);
      expect.soft(response.headers.get("cache-control")).toMatch(/private/);
      expect.soft(response.headers.get("cache-control")).toMatch(/no-store/);
      if (response.status !== 409) return null;
      const html = await response.text();
      const form = savedForm(html);
      expect(draftFields(form.fields)).toEqual(draftFields(draft));
      expect(html).not.toMatch(/http-equiv=["']refresh/i);
      reviewCurrentHref(html, key);
      return { html, form };
    };

    it("renders a nonempty saved-content precondition on the actual Hono Save form", async () => {
      const document = await read();
      expect(document.attrs.method?.toLowerCase()).toBe("post");
      expect(document.attrs.action).toBe(`/admin/events/${KEY}`);
      expect(Object.values(document.hidden).some((value) => value.length > 0)).toBe(true);
      expect(draftFields(document.fields)).toMatchObject({
        title: "Original title",
        game: "Original game",
        description: "Original description",
        starts_at: "2099-11-04 20:00",
        ends_at: "2099-11-04 22:00",
        timezone: "UTC",
        location: "Original hall",
        capacity: "8",
      });
    });

    it("A survives B's complete stale draft, repeat Save and explicit fresh review", async () => {
      const a = await read();
      const b = await read();
      expect((await save({ ...a.fields, title: "A committed title" })).status).toBe(303);
      const committed = await state();
      expect(committed.row!.title).toBe("A committed title");
      const draft: Record<string, string> = { ...b.fields, ...completeDraft };
      const rejected = await conflict(await save(draft), draft);
      expect
        .soft(await state(), "stale refusal leaves content and all audit rows untouched")
        .toEqual(committed);
      if (!rejected) return;
      // Re-render must carry B's original baseline, never one minted from A.
      expect(rejected.form.hidden).toEqual(b.hidden);
      await conflict(await save(rejected.form.fields), draft);
      expect(await state()).toEqual(committed);
      const fresh = await read(reviewCurrentHref(rejected.html, KEY));
      expect(fresh.fields.title).toBe("A committed title");
      expect(fresh.hidden).not.toEqual(b.hidden);
      const response = await save({ ...fresh.fields, title: "Reviewed then edited" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/admin/events/${KEY}`);
      const final = await state();
      expect(final.row!.title).toBe("Reviewed then edited");
      expect(final.audits).toHaveLength(2);
      expect(final.audits[1]!.properties).toMatchObject({
        title: { before: "A committed title", after: "Reviewed then edited" },
      });
    });

    it.each(["missing", "malformed", "empty"])(
      "cannot bypass the form precondition with a %s baseline",
      async (kind) => {
        const document = await read();
        const fields: Record<string, string> = { ...document.fields, ...completeDraft };
        const names = Object.keys(document.hidden);
        for (const name of names) {
          if (kind === "missing") delete fields[name];
          else fields[name] = kind === "empty" ? "" : "not-a-saved-content-baseline";
        }
        // On the old document no baseline is rendered at all: exercise the actual
        // unprotected POST too, rather than failing only at a missing selector.
        if (!names.length && kind !== "missing")
          fields.saved_baseline = kind === "empty" ? "" : "not-a-saved-content-baseline";
        const before = await state();
        const response = await save(fields);
        expect
          .soft([400, 409, 422], "invalid preconditions are never treated as unconditional writes")
          .toContain(response.status);
        expect.soft(await state()).toEqual(before);
        if (response.status >= 400 && response.status < 500) {
          expect(response.headers.get("cache-control")).toMatch(
            /private.*no-store|no-store.*private/,
          );
          const html = await response.text();
          expect(draftFields(savedForm(html).fields)).toEqual(draftFields(fields));
          reviewCurrentHref(html, KEY);
          const repeated = await save(savedForm(html).fields);
          expect(
            [400, 409, 422],
            "rejected input cannot acquire a current baseline on retry",
          ).toContain(repeated.status);
          expect(await state()).toEqual(before);
        }
      },
    );

    it.each([
      ["title", "Concurrent title"],
      ["game", "Concurrent game"],
      ["description", "Concurrent description"],
      ["starts_at", "2099-11-04 21:00"],
      ["ends_at", "2099-11-04 23:00"],
      ["timezone", "America/New_York"],
      ["location", "Concurrent hall"],
      ["capacity", "9"],
    ])(
      "detects a changed %s even when updated_at shares the same JavaScript millisecond",
      async (field, value) => {
        const instant = new Date("2026-10-20T12:00:00.123Z");
        await fixture.client`UPDATE events SET updated_at = ${instant.toISOString()}::timestamptz WHERE event_key = ${KEY}`;
        const a = await read();
        const b = await read();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(instant);
        expect((await save({ ...a.fields, [field]: value })).status).toBe(303);
        const committed = await state();
        expect(new Date(committed.row!.updatedAt).getTime()).toBe(instant.getTime());
        await conflict(await save({ ...b.fields, title: "B must not restore old content" }), {
          ...b.fields,
          title: "B must not restore old content",
        });
        expect.soft(await state()).toEqual(committed);
      },
    );

    it("stale refusal leaves future series children unshifted and audits untouched", async () => {
      const [parent] = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
      await fixture.db
        .update(events)
        .set({ recurrenceFrequency: "weekly", recurrenceCount: 3, recurrenceIndex: 1 })
        .where(eq(events.eventKey, KEY));
      await fixture.db.insert(events).values({
        eventKey: CHILD_KEY,
        title: "Original title",
        game: "Original game",
        description: "Original description",
        startsAt: new Date("2099-11-11T20:00:00.000Z"),
        endsAt: new Date("2099-11-11T22:00:00.000Z"),
        timezone: "UTC",
        location: "Original hall",
        capacity: 8,
        status: "draft",
        createdBy: "seed-mod",
        parentEventId: parent!.id,
        recurrenceIndex: 2,
      });
      const a = await read();
      const b = await read();
      // A moves the parent one hour later: the future child shifts by the same delta.
      expect(
        (
          await save({
            ...a.fields,
            starts_at: "2099-11-04 21:00",
            ends_at: "2099-11-04 23:00",
          })
        ).status,
      ).toBe(303);
      const [shiftedChild] = await fixture.db
        .select()
        .from(events)
        .where(eq(events.eventKey, CHILD_KEY));
      expect(shiftedChild!.startsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
      expect(shiftedChild!.endsAt.toISOString()).toBe("2099-11-11T23:00:00.000Z");
      const committedParent = await state(KEY);
      const committedChild = await state(CHILD_KEY);
      const committedAudits = committedParent.audits;
      expect(committedAudits.length).toBeGreaterThanOrEqual(2);
      // B's stale draft tries a different two-hour move from the original times.
      const draft = {
        ...b.fields,
        starts_at: "2099-11-04 22:00",
        ends_at: "2099-11-05 00:00",
        title: "B stale move",
      };
      await conflict(await save(draft), draft);
      expect.soft(await state(KEY)).toEqual(committedParent);
      expect.soft(await state(CHILD_KEY)).toEqual(committedChild);
      const [childAfter] = await fixture.db
        .select()
        .from(events)
        .where(eq(events.eventKey, CHILD_KEY));
      expect.soft(childAfter!.startsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
      expect.soft(childAfter!.endsAt.toISOString()).toBe("2099-11-11T23:00:00.000Z");
    });

    it("fresh saves stay byte-stable: full edit redirects, normalizes and audits once", async () => {
      const document = await read();
      const response = await save({ ...document.fields, ...completeDraft });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/admin/events/${KEY}`);
      const result = await state();
      expect(result.row).toMatchObject({
        title: 'B headline & "quoted" <draft>',
        game: "B game & <tag>",
        description: "B paragraph & <not markup>\nSecond line",
        timezone: "Europe/London",
        location: 'B hall & "room"',
        capacity: 17,
      });
      // November London is GMT: wall 20:00 renders the same UTC instant.
      expect(result.row!.startsAt.toISOString()).toBe("2099-11-05T20:00:00.000Z");
      expect(result.row!.endsAt.toISOString()).toBe("2099-11-05T22:00:00.000Z");
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0]).toMatchObject({
        subjectType: "Event",
        subjectId: KEY,
        description: expect.stringContaining("updated event"),
      });
      expect(result.audits[0]!.properties).toMatchObject({
        title: { before: "Original title", after: 'B headline & "quoted" <draft>' },
      });
    });

    it("retains the original baseline through 422 correction instead of silently rebasing", async () => {
      const document = await read();
      const rejected = await save({ ...document.fields, ...completeDraft, title: "" });
      expect(rejected.status).toBe(422);
      const correction = savedForm(await rejected.text());
      expect(correction.hidden).toEqual(document.hidden);
      expect(draftFields(correction.fields)).toEqual(
        draftFields({ ...document.fields, ...completeDraft, title: "" }),
      );
      expect((await state()).audits).toHaveLength(0);
      const response = await save({ ...correction.fields, title: "  Corrected title  " });
      expect(response.status).toBe(303);
      const result = await state();
      expect(result.row!.title).toBe("Corrected title");
      expect(result.audits).toHaveLength(1);
    });

    it("returns 404 after deletion rather than resurrecting a draft or auditing", async () => {
      const document = await read();
      await fixture.db.delete(events).where(eq(events.eventKey, KEY));
      expect((await save({ ...document.fields, ...completeDraft })).status).toBe(404);
      expect(await state()).toEqual({ row: undefined, audits: [] });
    });

    it("moderator saves keep agent_version interplay: stale agent 409s, fresh agent succeeds", async () => {
      const credential = `fixture-${randomUUID()}`;
      await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${AGENT_CALLER}, 'fixture-company', ${agentCfg.stagingGuildId}, ${await sha256Hex(credential)})`;
      const call = (body: Record<string, unknown>) =>
        handleAgentEvent(
          fixture.client,
          agentCfg,
          { idempotency_key: randomUUID(), ...body },
          credential,
        );
      const created = await call({ op: "create", fields: AGENT_FIELDS });
      expect(created.status).toBe(201);
      const eventKey = created.body.event_key as string;
      expect(created.body.agent_version).toBe(1);
      const readAgent = async () => {
        const response = await admin.request(
          `/events/${eventKey}`,
          { headers: { cookie } },
          bindings(),
        );
        expect(response.status).toBe(200);
        return savedForm(await response.text());
      };
      const document = await readAgent();
      const saved = await save({ ...document.fields, title: "Moderator rename" }, eventKey);
      expect(saved.status).toBe(303);
      const [afterModerator] =
        await fixture.client`SELECT agent_version FROM events WHERE event_key = ${eventKey}`;
      expect(afterModerator!.agent_version).toBe(2);
      const stale = await call({
        op: "update",
        event_key: eventKey,
        version: 1,
        fields: { ...AGENT_FIELDS, title: "Stale agent title" },
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });
      const fresh = await call({
        op: "update",
        event_key: eventKey,
        version: 2,
        fields: { ...AGENT_FIELDS, title: "Fresh agent title" },
      });
      expect(fresh.status).toBe(200);
      expect(fresh.body.agent_version).toBe(3);
      const [final] =
        await fixture.client`SELECT title, agent_version FROM events WHERE event_key = ${eventKey}`;
      expect(final).toMatchObject({ title: "Fresh agent title", agent_version: 3 });
    });

    it("a refused stale moderator save on a grant-owned event leaves agent_version untouched", async () => {
      const credential = `fixture-${randomUUID()}`;
      await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${AGENT_CALLER}, 'fixture-company', ${agentCfg.stagingGuildId}, ${await sha256Hex(credential)})`;
      const call = (body: Record<string, unknown>) =>
        handleAgentEvent(
          fixture.client,
          agentCfg,
          { idempotency_key: randomUUID(), ...body },
          credential,
        );
      const created = await call({ op: "create", fields: AGENT_FIELDS });
      expect(created.status).toBe(201);
      const eventKey = created.body.event_key as string;
      const readAgent = async () => {
        const response = await admin.request(
          `/events/${eventKey}`,
          { headers: { cookie } },
          bindings(),
        );
        expect(response.status).toBe(200);
        return savedForm(await response.text());
      };
      const a = await readAgent();
      const b = await readAgent();
      expect((await save({ ...a.fields, title: "A moderator title" }, eventKey)).status).toBe(303);
      const [committed] =
        await fixture.client`SELECT agent_version FROM events WHERE event_key = ${eventKey}`;
      expect(committed!.agent_version).toBe(2);
      const draft = { ...b.fields, title: "B stale moderator title" };
      await conflict(await save(draft, eventKey), draft, eventKey);
      const [after] =
        await fixture.client`SELECT title, agent_version FROM events WHERE event_key = ${eventKey}`;
      expect.soft(after).toMatchObject({ title: "A moderator title", agent_version: 2 });
    });

    it.each(["commit", "rollback"] as const)(
      "checks the form baseline after the held committing lock resolves (%s)",
      async (outcome) => {
        const b = await read();
        const actor = { id: "444444444444444444", username: "other moderator" };
        let pending: Promise<Response> | undefined;
        let settled = false;
        const rollback = new Error("intentional fixture rollback");
        try {
          try {
            await fixture.db.transaction(async (tx) => {
              const [holder] = await tx.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
              );
              await updateEvent(
                tx as unknown as Db,
                actor,
                KEY,
                parseEventForm({ ...b.fields, title: "Held A title" }),
              );
              pending = save({ ...b.fields, title: "Waiting B title" });
              void pending.then(
                () => {
                  settled = true;
                },
                () => {
                  settled = true;
                },
              );
              const deadline = performance.now() + 3000;
              let observed = false;
              while (performance.now() < deadline) {
                const rows = await fixture.client`select pid from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and ${holder!.pid} = any(pg_blocking_pids(pid))`;
                if (rows.length) {
                  observed = true;
                  break;
                }
              }
              expect(
                observed,
                "independent observer saw B blocked on A's actual PostgreSQL lock",
              ).toBe(true);
              expect(settled).toBe(false);
              if (outcome === "rollback") throw rollback;
            });
          } catch (error) {
            if (error !== rollback) throw error;
          }
          const response = await pending!;
          const result = await state();
          if (outcome === "commit") {
            await conflict(response, { ...b.fields, title: "Waiting B title" });
            expect.soft(result.row!.title).toBe("Held A title");
            expect.soft(result.audits).toHaveLength(1);
          } else {
            expect(response.status).toBe(303);
            expect(result.row!.title).toBe("Waiting B title");
            expect(result.audits).toHaveLength(1);
            expect(result.audits[0]!.properties).toMatchObject({
              title: { before: "Original title", after: "Waiting B title" },
            });
          }
        } finally {
          // Drain the contender after the holder's transaction releases on every
          // assertion/error path; never leave an orphan operation between tests.
          await pending;
        }
      },
    );
  },
);
