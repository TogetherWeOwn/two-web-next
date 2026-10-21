// Acceptance oracle: NUL (U+0000) in the featured form's free-text fields
// (title, body, image_alt) is rejected by the shared featured-form validator
// with a field error on the offending field, before anything is persisted —
// for both create and edit. Postgres text cannot represent NUL, so a NUL that
// passes validation only fails later as a persistence error instead of the
// form's field-level 422.
//
// Contract notes for the implementer:
// - Only the field-error key is pinned; the exact message wording is the
//   implementer's choice (asserted non-empty, never matched literally).
// - A single NUL field must be the ONLY error: no collateral broadening.
// - NUL keeps its field-specific copy. Other control, bidi and invisible
//   characters are now rejected too, with the event form's shared copy (see
//   test/featured-control-invisible-acceptance.test.ts). Normal Unicode, emoji
//   ZWJ sequences, multiline/tabbed body text, the 255-code-point limits and
//   optional-empty behaviour all keep working exactly as today.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { activityLog, events, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NUL = "\u0000";
const ZWJ_EMOJI = "\u{1F469}\u200D\u{1F4BB}"; // woman technologist: emoji + ZWJ + emoji

const base = {
  title: "Game night",
  body: "Bring a friend",
  image_url: "https://cdn.discordapp.com/photo.png",
  image_alt: "Players together",
};

const freeTextFields = [
  { input: "title", output: "title" },
  { input: "body", output: "body" },
  { input: "image_alt", output: "imageAlt" },
] as const;

function errors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected featured validation to fail");
}

function expectOnlyFieldError(data: Record<string, unknown>, field: string): void {
  const fields = errors(data);
  expect(Object.keys(fields)).toEqual([field]);
  expect(typeof fields[field]).toBe("string");
  expect(fields[field]!.length).toBeGreaterThan(0);
}

describe("featured form rejects NUL before persistence (validator)", () => {
  for (const { input } of freeTextFields) {
    describe(input, () => {
      it.each([
        { label: "embedded", value: `before${NUL}after` },
        { label: "leading", value: `${NUL}before` },
        { label: "trailing", value: `after${NUL}` },
        { label: "NUL only", value: NUL },
        { label: "repeated", value: `a${NUL}b${NUL}c` },
      ])("rejects a $label NUL with a field error on that field only", ({ value }) => {
        expectOnlyFieldError({ ...base, [input]: value }, input);
      });
    });
  }

  it("reports every offending field when several fields carry NUL", () => {
    const fields = errors({
      ...base,
      title: `before${NUL}after`,
      body: `before${NUL}after`,
      image_alt: `before${NUL}after`,
    });
    expect(Object.keys(fields).sort()).toEqual(["body", "image_alt", "title"]);
    for (const message of Object.values(fields)) expect(message.length).toBeGreaterThan(0);
  });

  it("rejects NUL in image_alt even when no image URL makes it required", () => {
    expectOnlyFieldError(
      { title: "Game night", body: "Bring a friend", image_alt: `before${NUL}after` },
      "image_alt",
    );
  });

  it("rejects a 255-code-point title whose last character is NUL (length alone passes)", () => {
    expectOnlyFieldError({ ...base, title: `${"x".repeat(254)}${NUL}` }, "title");
  });

  it("rejects a 255-code-point image_alt whose last character is NUL (length alone passes)", () => {
    expectOnlyFieldError({ ...base, image_alt: `${"x".repeat(254)}${NUL}` }, "image_alt");
  });
});

describe("featured form keeps accepting everything that is not NUL (validator controls)", () => {
  for (const { input, output } of freeTextFields) {
    it(`accepts an emoji ZWJ sequence in ${input} verbatim`, () => {
      const value = `Hosted by ${ZWJ_EMOJI} tonight`;
      expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
    });

    it(`accepts normal Unicode (accents, CJK, combining marks) in ${input} verbatim`, () => {
      const value = "Café 界 é — all welcome";
      expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
    });
  }

  it("accepts a multiline, tabbed body verbatim", () => {
    const body = "line one\nline two\r\nline three\twith a tab";
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
  });

  it("rejects a non-NUL control character (BEL) in the body with the shared control copy", () => {
    expect(errors({ ...base, body: "before\u0007after" })).toEqual({
      body: "Remove control or invisible characters.",
    });
  });

  it("still accepts exactly 255 code points of astral title text", () => {
    const title = "\u{1F600}".repeat(255);
    expect(parseFeaturedForm({ ...base, title }).title).toBe(title);
  });

  it("keeps optional-empty behaviour: blank body and image_alt stay null", () => {
    const parsed = parseFeaturedForm({ title: "Game night", body: " \n\t ", image_alt: "  " });
    expect(parsed.body).toBeNull();
    expect(parsed.imageAlt).toBeNull();
    const omitted = parseFeaturedForm({ title: "Game night" });
    expect(omitted.body).toBeNull();
    expect(omitted.imageAlt).toBeNull();
  });
});

// --- Route boundary: the 422 / no-row / no-audit and edit-unchanged contract.

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(
  store: ReturnType<typeof createMemorySessionStore>,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "featured NUL create/edit boundary (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore(() => Date.now());
    const modId = "100000000000000111";
    let cookie = "";
    const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
    const app = () => adminApp({ sessionStore: store, db });
    const form = (fields: Record<string, string>) => ({
      method: "POST" as const,
      headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    const seed = () =>
      db
        .insert(featuredContents)
        .values({
          title: "Original slot",
          body: "Original body",
          url: null,
          imageUrl: "https://cdn.discordapp.com/photo.png",
          imageAlt: "Original alt",
          isPublished: false,
          position: 4,
          startsAt: null,
          endsAt: null,
        })
        .returning();

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(() => fixture?.dispose());

    beforeEach(async () => {
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
      await db.delete(featuredContents);
      cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
    });

    // The clean sibling value that must survive as preserved draft input.
    const createCases: { field: string; fields: Record<string, string>; preserved: string }[] = [
      {
        field: "title",
        fields: { title: `before${NUL}after`, body: "Kept draft body", position: "0" },
        preserved: "Kept draft body",
      },
      {
        field: "body",
        fields: { title: "Kept draft title", body: `before${NUL}after`, position: "0" },
        preserved: "Kept draft title",
      },
      {
        field: "image_alt",
        fields: {
          title: "Kept draft title",
          image_url: "https://cdn.discordapp.com/photo.png",
          image_alt: `before${NUL}after`,
          position: "0",
        },
        preserved: "Kept draft title",
      },
    ];

    it.each(createCases)(
      "422s a create with NUL in $field, preserving the draft, with no row and no audit",
      async ({ fields, preserved }) => {
        const res = await app().request("/featured", form(fields), liveEnv());
        expect(res.status).toBe(422);
        expect(res.headers.get("content-type")).toContain("text/html");
        const html = await res.text();
        expect(html).toContain('data-testid="form-errors"');
        expect(html).toContain(preserved);
        expect(await db.select().from(featuredContents)).toHaveLength(0);
        expect(await db.select().from(activityLog)).toEqual([]);
      },
    );

    const editCases = [
      { field: "title", patch: { title: `before${NUL}after` } },
      { field: "body", patch: { body: `before${NUL}after` } },
      { field: "image_alt", patch: { image_alt: `before${NUL}after` } },
    ];

    it.each(editCases)(
      "422s an edit with NUL in $field and leaves the existing row unchanged, with no audit",
      async ({ patch }) => {
        const [seeded] = await seed();
        const id = seeded!.id;
        const res = await app().request(
          `/featured/${id}`,
          form({
            title: "Original slot",
            body: "Original body",
            image_url: "https://cdn.discordapp.com/photo.png",
            image_alt: "Original alt",
            position: "4",
            ...patch,
          }),
          liveEnv(),
        );
        expect(res.status).toBe(422);
        const html = await res.text();
        expect(html).toContain('data-testid="form-errors"');
        const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
        expect(row).toMatchObject({
          title: "Original slot",
          body: "Original body",
          imageUrl: "https://cdn.discordapp.com/photo.png",
          imageAlt: "Original alt",
          position: 4,
          isPublished: false,
        });
        expect(await db.select().from(activityLog)).toEqual([]);
      },
    );

    it("still creates Unicode content with a 303, the stored row and its audit (control)", async () => {
      const fields = {
        title: `Hosted by ${ZWJ_EMOJI} tonight`,
        body: "line one\nline two\r\nline three",
        image_url: "https://cdn.discordapp.com/photo.png",
        image_alt: `Hosted by ${ZWJ_EMOJI} tonight`,
        position: "0",
      };
      const res = await app().request("/featured", form(fields), liveEnv());
      expect(res.status).toBe(303);
      const id = Number(res.headers.get("location")!.split("/").pop());
      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row).toMatchObject({ title: fields.title, body: fields.body });
      const audit = await db.select().from(activityLog);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ subjectType: "FeaturedContent", subjectId: String(id) });
    });
  },
);
