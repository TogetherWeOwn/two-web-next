// Acceptance oracle: the featured editorial `body` has an explicit field
// maximum of 1000 Unicode code points, enforced by the shared featured-form
// validator on both create and update, ahead of persistence.
//
// Why 1000 (moderator workflow): the featured body is the homepage slot's
// short editorial blurb under a 255-character headline, not an article.
// 1000 code points is roughly 150-180 words — several short paragraphs,
// over twice the longest body this repo exercises anywhere — so no
// legitimate moderator draft is cut. It is also the site's established
// long-text ceiling (event description and profile bio are both 1000),
// so moderators meet a number they already know: short fields 255, long
// fields 1000. The 256 KiB transport allowance for the featured routes is
// unchanged and still refuses oversized submissions with 413 first.
//
// Contract notes for the implementer:
// - The count is Unicode code points of the stored value, following the
//   sibling fields: the existing trim runs first (a whitespace-only body
//   is still null, however long), and astral characters count once, not
//   as two UTF-16 units. Combining marks and ZWJ sequences count as their
//   separate code points, exactly like the 255 fields.
// - The field error is pinned exactly: key `body`, message
//   "Keep the body to 1000 characters." (the siblings' phrasing), in the
//   existing errors shape, aggregated with any other field errors.
// - An over-max body alone must be the ONLY error: no collateral changes
//   to other fields' rules, trimming, or optional-empty behaviour.
// - A non-string body keeps today's behaviour: treated as absent (null),
//   never coerced, never an over-max error, however large it is.
// - Over-max input is never truncated: the 422 hands the whole draft back.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { activityLog, events, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";
import { clearAuditRows } from "./helpers/audit-rows";
import { featuredBaselineFields } from "./helpers/featured-baseline";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

export const FEATURED_BODY_MAX = 1000;
const BODY_ERROR = "Keep the body to 1000 characters.";

const base = {
  title: "Game night",
  image_url: "https://cdn.discordapp.com/photo.png",
  image_alt: "Players together",
};

const characters = [
  { label: "ASCII", pattern: ["x"] },
  { label: "BMP", pattern: ["界"] },
  { label: "astral", pattern: ["😀"] },
  { label: "mixed astral/BMP/ASCII", pattern: ["😀", "界", "x"] },
];

function text(pattern: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => pattern[i % pattern.length]).join("");
}

function errors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected featured validation to fail");
}

describe("featured body field maximum (validator)", () => {
  it.each(characters)("accepts exactly 1000 $label code points verbatim", ({ pattern }) => {
    const body = text(pattern, FEATURED_BODY_MAX);
    expect([...body]).toHaveLength(FEATURED_BODY_MAX);
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
  });

  it.each(characters)(
    "rejects 1001 $label code points with the body field error only",
    ({ pattern }) => {
      const body = text(pattern, FEATURED_BODY_MAX + 1);
      expect(errors({ ...base, body })).toEqual({ body: BODY_ERROR });
    },
  );

  it("accepts 999 code points (one under the maximum)", () => {
    const body = "x".repeat(FEATURED_BODY_MAX - 1);
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
  });

  it("counts astral characters once: 1000 astral code points are 2000 UTF-16 units", () => {
    const body = "😀".repeat(FEATURED_BODY_MAX);
    expect(body.length).toBe(2000);
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
    expect(errors({ ...base, body: `${body}😀` })).toEqual({ body: BODY_ERROR });
  });

  it.each([
    // e + combining acute: 2 code points per unit, 500 units = 1000.
    { label: "combining marks", body: "é".repeat(500) },
    // woman + ZWJ + laptop: 3 code points per unit, 333 units + "x" = 1000.
    { label: "emoji joiners", body: `${"👩‍💻".repeat(333)}x` },
  ])("counts $label as separate code points at the boundary", ({ body }) => {
    expect([...body]).toHaveLength(FEATURED_BODY_MAX);
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
    expect(errors({ ...base, body: `${body}x` })).toEqual({ body: BODY_ERROR });
  });

  it("accepts a multiline body of exactly 1000 code points, newlines included in the count", () => {
    const body = `${"line\n".repeat(199)}last!`;
    expect([...body]).toHaveLength(FEATURED_BODY_MAX);
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
    expect(errors({ ...base, body: `${body}x` })).toEqual({ body: BODY_ERROR });
  });

  it("measures after the existing trim, like the sibling fields", () => {
    const body = "😀".repeat(FEATURED_BODY_MAX);
    expect(parseFeaturedForm({ ...base, body: ` \t${body}\r\n ` }).body).toBe(body);
    expect(errors({ ...base, body: ` \t${body}x\r\n ` })).toEqual({ body: BODY_ERROR });
  });

  it("keeps a whitespace-only body null however long it is (trim before counting)", () => {
    expect(parseFeaturedForm({ ...base, body: " \n\t".repeat(2000) }).body).toBeNull();
  });

  it("aggregates the body error with other field errors in the existing shape", () => {
    expect(
      errors({
        ...base,
        title: "😀".repeat(256),
        body: "x".repeat(FEATURED_BODY_MAX + 1),
      }),
    ).toEqual({
      title: "Keep the headline to 255 characters.",
      body: BODY_ERROR,
    });
  });

  it("admits an at-maximum body alongside at-maximum sibling fields", () => {
    const parsed = parseFeaturedForm({
      title: "😀".repeat(255),
      body: "😀".repeat(FEATURED_BODY_MAX),
      image_url: "https://cdn.discordapp.com/photo.png",
      image_alt: "😀".repeat(255),
    });
    expect([...parsed.body!]).toHaveLength(FEATURED_BODY_MAX);
    expect([...parsed.title]).toHaveLength(255);
  });
});

describe("featured body maximum controls (validator)", () => {
  it.each([
    { label: "a number", value: 42 },
    { label: "a boolean", value: true },
    { label: "null", value: null },
    { label: "an array of strings", value: ["a", "b"] },
    { label: "an object", value: { text: "hello" } },
  ])("keeps treating a non-string body ($label) as absent, never an error", ({ value }) => {
    expect(parseFeaturedForm({ ...base, body: value }).body).toBeNull();
  });

  it("never coerces a large non-string body into an over-maximum string", () => {
    const value = Array.from({ length: FEATURED_BODY_MAX + 500 }, () => "word");
    expect(parseFeaturedForm({ ...base, body: value }).body).toBeNull();
  });

  it("keeps optional-empty behaviour: omitted, empty and blank bodies stay null", () => {
    expect(parseFeaturedForm({ title: "Game night" }).body).toBeNull();
    expect(parseFeaturedForm({ ...base, body: "" }).body).toBeNull();
    expect(parseFeaturedForm({ ...base, body: " \n\t " }).body).toBeNull();
  });

  it("keeps accepting the short bodies moderators actually write", () => {
    const body = "Bring a friend.\nEveryone is welcome.";
    expect(parseFeaturedForm({ ...base, body }).body).toBe(body);
  });
});

// --- Transport boundary: the featured class cap still refuses first. ------

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

describe("featured transport cap is unchanged by the field maximum", () => {
  it.each(["/admin/featured", "/admin/featured/1"])(
    "still 413s a submission over the featured transport cap on %s before validation",
    async (path) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, {
        userId: "111111111111111111",
        username: "mod",
        moderator: true,
      });
      const marker = "transport-marker";
      const fields = new URLSearchParams({
        title: "Game night",
        // Over the field maximum and over the transport cap together: the
        // transport refusal must win, with no validation output at all.
        body: `${marker}${"x".repeat(BODY_LIMIT_BYTES.featured)}`,
        position: "0",
      });
      const res = await app.request(
        path,
        {
          method: "POST",
          headers: {
            cookie,
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: fields,
        },
        { ...env, SESSION_STORE: store } as unknown as Env,
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        reason: "payload_too_large",
        message: "Reduce the size of your request and try again.",
      });
    },
  );
});

// --- Route boundary: 422 / no-row / no-audit and edit-unchanged contract. --

describe.skipIf(!process.env.DATABASE_URL)(
  "featured body maximum create/edit boundary (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore(() => Date.now());
    const modId = "100000000000000111";
    let cookie = "";
    const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
    const routeApp = () => adminApp({ sessionStore: store, db });
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

    // 1001 code points; the tail marker proves the draft is handed back
    // whole on the 422, never truncated to the maximum.
    const overMaxBody = `${"x".repeat(FEATURED_BODY_MAX - 6)}ENDTAIL`;
    const atMaxBody = "😀".repeat(FEATURED_BODY_MAX);

    it("422s a create with an over-maximum body, handing the whole draft back, with no row and no audit", async () => {
      const res = await routeApp().request(
        "/featured",
        form({ title: "Kept draft title", body: overMaxBody, position: "0" }),
        liveEnv(),
      );
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(html).toContain(BODY_ERROR);
      expect(html).toContain("Kept draft title");
      expect(html).toContain(overMaxBody);
      expect(await db.select().from(featuredContents)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toEqual([]);
    });

    it("creates an at-maximum body with a 303 and stores it verbatim (control)", async () => {
      const res = await routeApp().request(
        "/featured",
        form({ title: "Boundary slot", body: atMaxBody, position: "0" }),
        liveEnv(),
      );
      expect(res.status).toBe(303);
      const id = Number(res.headers.get("location")!.split("/").pop());
      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row!.body).toBe(atMaxBody);
      expect(await db.select().from(activityLog)).toHaveLength(1);
    });

    it("422s an edit with an over-maximum body and leaves the existing row unchanged, with no audit", async () => {
      const [seeded] = await seed();
      const id = seeded!.id;
      const res = await routeApp().request(
        `/featured/${id}`,
        form({
          ...(await featuredBaselineFields(db, id)),
          title: "Original slot",
          body: overMaxBody,
          image_url: "https://cdn.discordapp.com/photo.png",
          image_alt: "Original alt",
          position: "4",
        }),
        liveEnv(),
      );
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(html).toContain(BODY_ERROR);
      expect(html).toContain(overMaxBody);
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
    });

    it("edits an existing row to an at-maximum body with a 303 (control)", async () => {
      const [seeded] = await seed();
      const id = seeded!.id;
      const res = await routeApp().request(
        `/featured/${id}`,
        form({
          ...(await featuredBaselineFields(db, id)),
          title: "Original slot",
          body: atMaxBody,
          image_url: "https://cdn.discordapp.com/photo.png",
          image_alt: "Original alt",
          position: "4",
        }),
        liveEnv(),
      );
      expect(res.status).toBe(303);
      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row!.body).toBe(atMaxBody);
    });
  },
);
