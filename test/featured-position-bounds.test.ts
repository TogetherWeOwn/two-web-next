import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import type { EnvWithAdminDb } from "../src/admin/db";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const rejected = [
  { label: "negative", raw: "-1" },
  { label: "fractional", raw: "0.5" },
  { label: "decimal spelling", raw: "1.0" },
  { label: "integer overflow", raw: "2147483648" },
  { label: "large safe integer", raw: "9007199254740991" },
  { label: "unsafe integer", raw: "9007199254740992" },
  { label: "rounded unsafe integer", raw: "9007199254740993" },
  { label: "digits becoming Infinity", raw: "9".repeat(400) },
  { label: "Infinity", raw: "Infinity" },
  { label: "NaN", raw: "NaN" },
  { label: "exponent", raw: "1e3" },
  { label: "hexadecimal", raw: "0x10" },
];
const accepted = [
  { label: "omitted", raw: undefined, position: 0 },
  { label: "empty", raw: "", position: 0 },
  { label: "whitespace", raw: "  ", position: 0 },
  { label: "zero", raw: "0", position: 0 },
  { label: "normal", raw: "42", position: 42 },
  { label: "leading zeroes", raw: "00042", position: 42 },
  { label: "trimmed", raw: " 42 ", position: 42 },
  { label: "maximum", raw: "2147483647", position: 2147483647 },
];

function form(raw: string | undefined, title = "Featured"): Record<string, string> {
  return raw === undefined ? { title } : { title, position: raw };
}

describe("featured position parser bounds", () => {
  it.each(accepted)("accepts $label without changing its value", ({ raw, position }) => {
    expect(parseFeaturedForm(form(raw)).position).toBe(position);
  });

  it.each(rejected)("rejects $label with a position field error", ({ raw }) => {
    expect(() => parseFeaturedForm(form(raw))).toThrow(ValidationError);
    try {
      parseFeaturedForm(form(raw));
    } catch (error) {
      expect((error as ValidationError).fields).toEqual({ position: expect.any(String) });
    }
  });
});

const env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe.skipIf(!process.env.DATABASE_URL)(
  "featured position create/edit (isolated test Postgres)",
  () => {
    let fixture: MemberDataFixture;
    let app: ReturnType<typeof adminApp>;
    let bindings: EnvWithAdminDb;
    let cookie: string;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await clearAuditRows(fixture.db, ["activity_log"]);
      await fixture.db.delete(featuredContents);
      const store = createMemorySessionStore();
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "position-mod",
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      app = adminApp({ sessionStore: store, db: fixture.db });
      bindings = { ...env, ADMIN_DB: fixture.db };
    });

    function post(path: string, raw: string | undefined, title = "Featured") {
      return app.request(
        path,
        {
          method: "POST",
          headers: { cookie, origin: env.APP_URL },
          body: new URLSearchParams(form(raw, title)),
        },
        bindings,
      );
    }

    for (const mode of ["create", "edit"] as const) {
      it.each(rejected)(
        `${mode} rejects $label with 422 feedback and no content or audit write`,
        async ({ raw }) => {
          const [existing] = await fixture.db
            .insert(featuredContents)
            .values({
              title: "Unchanged",
              body: "Keep this body",
              position: 7,
              isPublished: true,
            })
            .returning();
          const before = await fixture.db.select().from(featuredContents);
          const response = await post(
            mode === "create" ? "/featured" : `/featured/${existing!.id}`,
            raw,
            "Rejected change",
          );
          expect(response.status).toBe(422);
          const html = await response.text();
          expect(html).toContain('data-testid="error-position"');
          expect(html).toContain('name="position"');
          expect(html).toContain(`value="${raw}"`);
          expect(await fixture.db.select().from(featuredContents)).toEqual(before);
          expect(await fixture.db.select().from(activityLog)).toEqual([]);
        },
      );

      it.each(accepted)(
        `${mode} persists $label with 303 and retains position ordering`,
        async ({ raw, position }) => {
          const rows = await fixture.db
            .insert(featuredContents)
            .values([
              { title: "Later", position: 2147483647 },
              { title: "Middle", position: 21 },
              { title: "Earlier", position: 0 },
            ])
            .returning();
          const response = await post(
            mode === "create" ? "/featured" : `/featured/${rows[1]!.id}`,
            raw,
            "Accepted change",
          );
          expect(response.status).toBe(303);
          const stored = await listFeatured(fixture.db, {});
          expect(stored.find((row) => row.title === "Accepted change")?.position).toBe(position);
          const expectedPositions =
            mode === "create" ? [2147483647, 21, 0, position] : [2147483647, position, 0];
          expect(stored.map((row) => row.position)).toEqual(
            expectedPositions.sort((a, b) => a - b),
          );
          expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
        },
      );
    }
  },
);
