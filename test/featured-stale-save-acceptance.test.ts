// Independent form-save acceptance. The low-level unconditional update contract
// remains covered by featured-write-concurrency.test.ts, without modification.
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../src/db/index";
import { deleteFeatured, updateFeatured } from "../src/admin/store";
import { parseFeaturedForm } from "../src/admin/validation";
import { cachedFeatured, __resetHomeGuestCacheForTests } from "../src/home-cache";
import { compileKitForms } from "./helpers/admin-validation-correction";
import { compileFeaturedSaveLoad } from "./helpers/featured-save-kit-load";
import type { EnvWithAdminDb } from "../src/admin/db";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { draftFields, reviewCurrentHref, savedForm } from "./helpers/featured-save-document";
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
const preciseStart = "2026-10-01 12:34:56.789123";
const preciseEnd = "2026-11-01 13:45:12.345678";
const completeDraft = {
  title: '  B headline & "quoted" <draft>  ',
  body: " B paragraph & <not markup>\nSecond line with 'quotes' ",
  url: "https://example.test/draft?a=1&b=2",
  image_url: "https://cdn.discordapp.com/attachments/draft.png",
  image_alt: ' Draft image & "alt" ',
  position: "17",
  starts_at: "2026-10-02 12:34:56.789124",
  ends_at: "2026-11-02 13:45:12.345679",
  is_published: "on",
};

// No added skips: fixtures reject unsafe URLs; acceptance needs the explicit
// disposable DATABASE_URL just like the application's database test command.
describe("featured stale Save acceptance (disposable Postgres)", () => {
  let fixture: MemberDataFixture;
  let admin: ReturnType<typeof adminApp>;
  let cookie: string;
  let id: number;

  let kit: Awaited<ReturnType<typeof compileKitForms>>;
  let kitLoad: Awaited<ReturnType<typeof compileFeaturedSaveLoad>>;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 3 });
    await fixture.client`SET TIME ZONE 'UTC'`;
    kit = await compileKitForms();
    kitLoad = await compileFeaturedSaveLoad(env);
  });
  afterAll(async () => {
    kit?.dispose();
    await fixture?.dispose();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetHomeGuestCacheForTests();
  });
  beforeEach(async () => {
    __resetHomeGuestCacheForTests();
    await fixture.reset();
    await fixture.db.delete(featuredContents);
    const [row] = await fixture.db
      .insert(featuredContents)
      .values({
        title: "Original headline",
        body: "Original body",
        position: 2,
        isPublished: true,
        imageUrl: "https://cdn.discordapp.com/attachments/original.png",
        imageAlt: "Original alt",
      })
      .returning();
    id = row!.id;
    await fixture.client`UPDATE featured_contents SET starts_at = ${preciseStart}::timestamptz,
      ends_at = ${preciseEnd}::timestamptz WHERE id = ${id}`;
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
  const read = async (href = `/admin/featured/${id}`) => {
    const response = await admin.request(
      href.replace(/^\/admin/, ""),
      { headers: { cookie } },
      bindings(),
    );
    expect(response.status).toBe(200);
    return savedForm(await response.text());
  };
  const save = async (fields: Record<string, string>) =>
    admin.request(
      `/featured/${id}`,
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
  const state = async () => {
    const [row] = await fixture.client`SELECT *, starts_at::text AS precise_start,
      ends_at::text AS precise_end FROM featured_contents WHERE id = ${id}`;
    const audits = await fixture.db.select().from(activityLog).orderBy(asc(activityLog.id));
    return { row, audits };
  };
  const conflict = async (response: Response, draft: Record<string, string>) => {
    expect.soft(response.status, "a stale Save is not a redirect/success").toBe(409);
    expect.soft(response.headers.get("cache-control")).toMatch(/private/);
    expect.soft(response.headers.get("cache-control")).toMatch(/no-store/);
    if (response.status !== 409) return null;
    const html = await response.text();
    const form = savedForm(html);
    expect(draftFields(form.fields)).toEqual(draftFields(draft));
    expect(html).not.toMatch(/http-equiv=["']refresh/i);
    reviewCurrentHref(html, id);
    return { html, form };
  };

  it("renders a nonempty saved-content precondition on the actual Hono Save form", async () => {
    const document = await read();
    expect(document.attrs.method?.toLowerCase()).toBe("post");
    expect(document.attrs.action).toBe(`/admin/featured/${id}`);
    expect(Object.values(document.hidden).some((value) => value.length > 0)).toBe(true);
    expect(draftFields(document.fields)).toMatchObject({
      title: "Original headline",
      body: "Original body",
      starts_at: preciseStart,
      ends_at: preciseEnd,
    });
  });

  it.each([true, false])(
    "A survives B's complete stale draft, repeat Save and explicit fresh review (published=%s)",
    async (published) => {
      const a = await read();
      const b = await read();
      expect((await save({ ...a.fields, title: "A committed headline" })).status).toBe(303);
      const committed = await state();
      const draft: Record<string, string> = { ...b.fields, ...completeDraft };
      if (!published) delete draft.is_published;
      const rejected = await conflict(await save(draft), draft);
      expect
        .soft(await state(), "stale refusal leaves content and all audit rows untouched")
        .toEqual(committed);
      if (!rejected) return;
      // Re-render must carry B's original baseline, never one minted from A.
      expect(rejected.form.hidden).toEqual(b.hidden);
      await conflict(await save(rejected.form.fields), draft);
      expect(await state()).toEqual(committed);
      const fresh = await read(reviewCurrentHref(rejected.html, id));
      expect(fresh.fields.title).toBe("A committed headline");
      expect(fresh.hidden).not.toEqual(b.hidden);
      const response = await save({ ...fresh.fields, title: "Reviewed then edited" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/admin/featured/${id}`);
      const final = await state();
      expect(final.row!.title).toBe("Reviewed then edited");
      expect(final.audits).toHaveLength(2);
      expect(final.audits[1]!.properties).toMatchObject({
        title: { before: "A committed headline", after: "Reviewed then edited" },
      });
    },
  );

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
        reviewCurrentHref(html, id);
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
    ["body", "Concurrent body"],
    ["url", "https://example.test/concurrent"],
    ["image_url", "https://cdn.discordapp.com/attachments/concurrent.png"],
    ["image_alt", "Concurrent alt"],
    ["position", "9"],
    ["is_published", ""],
    ["starts_at", "2026-10-01 12:34:56.789124"],
    ["ends_at", "2026-11-01 13:45:12.345679"],
  ])(
    "detects a changed %s even when updated_at shares the same JavaScript millisecond",
    async (field, value) => {
      const instant = new Date("2026-10-20T12:00:00.123Z");
      await fixture.client`UPDATE featured_contents SET updated_at = ${instant.toISOString()}::timestamptz WHERE id = ${id}`;
      const a = await read();
      const b = await read();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(instant);
      const first = { ...a.fields, [field]: value };
      if (field === "is_published") delete first.is_published;
      expect((await save(first)).status).toBe(303);
      const committed = await state();
      expect(new Date(committed.row!.updated_at).getTime()).toBe(instant.getTime());
      await conflict(await save({ ...b.fields, title: "B must not restore old content" }), {
        ...b.fields,
        title: "B must not restore old content",
      });
      expect.soft(await state()).toEqual(committed);
    },
  );

  it("retains the original baseline through 422 correction instead of silently rebasing a stale draft", async () => {
    const a = await read();
    const b = await read();
    const rejected = await save({ ...b.fields, ...completeDraft, title: "" });
    expect(rejected.status).toBe(422);
    const correction = savedForm(await rejected.text());
    expect(correction.hidden).toEqual(b.hidden);
    expect(draftFields(correction.fields)).toEqual(
      draftFields({ ...b.fields, ...completeDraft, title: "" }),
    );
    expect((await state()).audits).toHaveLength(0);
    expect((await save({ ...a.fields, title: "A during B correction" })).status).toBe(303);
    const committed = await state();
    const corrected = { ...correction.fields, title: "B corrected" };
    await conflict(await save(corrected), corrected);
    expect.soft(await state()).toEqual(committed);
  });

  it("fresh correction still normalizes inputs, preserves microseconds and audits once", async () => {
    const document = await read();
    const invalid = await save({ ...document.fields, ...completeDraft, title: "" });
    expect(invalid.status).toBe(422);
    const retry = savedForm(await invalid.text());
    const response = await save({ ...retry.fields, title: "  Corrected headline  " });
    expect(response.status).toBe(303);
    const result = await state();
    expect(result.row).toMatchObject({
      title: "Corrected headline",
      position: 17,
      precise_start: "2026-10-02 12:34:56.789124+00",
      precise_end: "2026-11-02 13:45:12.345679+00",
    });
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]!.properties).toMatchObject({
      title: { before: "Original headline", after: "Corrected headline" },
    });
  });

  it("returns 404 after deletion rather than resurrecting a draft or inserting a mutation audit", async () => {
    const document = await read();
    await fixture.db.delete(featuredContents).where(eq(featuredContents.id, id));
    expect((await save({ ...document.fields, ...completeDraft })).status).toBe(404);
    expect(await state()).toEqual({ row: undefined, audits: [] });
  });

  it("Kit load renders a real precondition and its native POST participates in Hono conflict/review recovery", async () => {
    const headers: Record<string, string> = {};
    const data = await kitLoad(fixture.db, id, (value) => Object.assign(headers, value));
    expect(headers["Cache-Control"] ?? headers["cache-control"]).toBe("private, no-store");
    const kitDocument = savedForm(kit.renderForm(3, data));
    expect.soft(Object.values(kitDocument.hidden).some((value) => value.length > 0)).toBe(true);
    expect(kitDocument.attrs.method?.toLowerCase()).toBe("post");
    expect(kitDocument.attrs.action).toBe(`/admin/featured/${id}`);
    expect(draftFields(kitDocument.fields)).toMatchObject({
      title: "Original headline",
      starts_at: preciseStart,
      ends_at: preciseEnd,
    });
    // A Kit-loaded form can save through Hono, without a Kit mutation endpoint.
    const honoDocument = await read();
    expect((await save({ ...kitDocument.fields, title: "Kit committed headline" })).status).toBe(
      303,
    );
    const committed = await state();
    const draft = { ...honoDocument.fields, ...completeDraft };
    await conflict(await save(draft), draft);
    expect.soft(await state()).toEqual(committed);
    const freshData = await kitLoad(fixture.db, id, () => {});
    const fresh = savedForm(kit.renderForm(3, freshData));
    expect(fresh.fields.title).toBe("Kit committed headline");
    expect.soft(fresh.hidden).not.toEqual(kitDocument.hidden);
    expect((await save({ ...fresh.fields, title: "Fresh Kit edit" })).status).toBe(303);
  });

  it("does not retire a warmed homepage cache on conflict, but does on a successful Save", async () => {
    const b = await read();
    const visible = () =>
      cachedFeatured(
        bindings(),
        async () => fixture.db,
        new Date("2026-10-20T12:00:00Z"),
        undefined,
      );
    expect((await visible()).map((row) => row.title)).toContain("Original headline");
    expect((await save({ ...b.fields, title: "A visible headline" })).status).toBe(303);
    const warm = await visible();
    expect(warm.map((row) => row.title)).toContain("A visible headline");
    // A direct fixture write deliberately does not retire. If the refused POST
    // retires anyway, the next cache read exposes this sentinel body.
    await fixture.client`UPDATE featured_contents SET body = 'unretired cache sentinel' WHERE id = ${id}`;
    const committed = await state();
    const draft: Record<string, string> = { ...b.fields, ...completeDraft };
    await conflict(await save(draft), draft);
    expect.soft(await state()).toEqual(committed);
    expect
      .soft(await visible(), "refusal must not evict a valid existing cache generation")
      .toEqual(warm);
  });

  it.each(["commit", "rollback", "delete"] as const)(
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
            const [holder] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            if (outcome === "delete") await deleteFeatured(tx as unknown as Db, actor, id);
            else
              await updateFeatured(
                tx as unknown as Db,
                actor,
                id,
                parseFeaturedForm({ ...b.fields, title: "Held A headline" }),
              );
            pending = save({ ...b.fields, title: "Waiting B headline" });
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
          await conflict(response, { ...b.fields, title: "Waiting B headline" });
          expect.soft(result.row!.title).toBe("Held A headline");
          expect.soft(result.audits).toHaveLength(1);
          expect(result.row!.precise_start).toBe(`${preciseStart}+00`);
          expect(result.row!.precise_end).toBe(`${preciseEnd}+00`);
        } else if (outcome === "delete") {
          expect(response.status).toBe(404);
          expect(result.row).toBeUndefined();
          expect(result.audits).toHaveLength(1);
        } else {
          expect(response.status).toBe(303);
          expect(result.row!.title).toBe("Waiting B headline");
          expect(result.audits).toHaveLength(1);
          expect(result.audits[0]!.properties).toMatchObject({
            title: { before: "Original headline", after: "Waiting B headline" },
          });
        }
      } finally {
        // Drain the contender after the holder's transaction releases on every
        // assertion/error path; never leave an orphan operation between tests.
        await pending;
      }
    },
  );

  it("a failed audit rolls back the save without consuming its baseline, then permits a fresh retry", async () => {
    const document = await read();
    const [sentinel] = await fixture.db
      .insert(featuredContents)
      .values({
        title: "Sibling cache sentinel",
        body: "Cached sibling body",
        isPublished: true,
        position: 99,
      })
      .returning();
    const visible = () =>
      cachedFeatured(
        bindings(),
        async () => fixture.db,
        new Date("2026-10-20T12:00:00Z"),
        undefined,
      );
    const warm = await visible();
    await fixture.client`UPDATE featured_contents SET body = 'unretired sibling body' WHERE id = ${sentinel!.id}`;
    const before = await state();
    const schema = fixture.schemaName;
    await fixture.client.unsafe(`CREATE FUNCTION "${schema}".reject_featured_save_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic featured save audit failure'; END; $$;
      CREATE TRIGGER reject_featured_save_audit BEFORE INSERT ON "${schema}".activity_log
      FOR EACH ROW WHEN (NEW.subject_type = 'FeaturedContent')
      EXECUTE FUNCTION "${schema}".reject_featured_save_audit();`);
    try {
      const response = await save({ ...document.fields, title: "Must roll back" });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await state()).toEqual(before);
      expect(await visible(), "rollback must not retire the existing homepage cache").toEqual(warm);
    } finally {
      await fixture.client.unsafe(
        `DROP TRIGGER reject_featured_save_audit ON "${schema}".activity_log`,
      );
    }
    expect((await save({ ...document.fields, title: "Retry after rollback" })).status).toBe(303);
    expect((await state()).audits).toHaveLength(1);
  });
});
