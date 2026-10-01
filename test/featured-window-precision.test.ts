import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { parseFeaturedForm, ValidationError, wallToUtc } from "../src/admin/validation";
import { featuredContents } from "../src/db/admin-schema";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Env } from "../src/env";
import { listVisibleFeatured } from "../src/featured";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const startsAt = new Date("2026-10-01T12:34:56.789Z");
const endsAt = new Date("2026-10-01T13:45:12.345Z");

// Read the actual form values, not a copy of the route's formatter.
function windowFields(html: string): Record<string, string> {
  return Object.fromEntries(["starts_at", "ends_at"].map((name) => {
    const match = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html);
    expect(match, name).not.toBeNull();
    return [name, match![1]!];
  }));
}

function fieldErrors(fields: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm({ title: "Slot", ...fields });
    throw new Error("Expected invalid featured window");
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).fields;
  }
}

describe("featured UTC window precision (local fixtures)", () => {
  it.each([
    ["2026-10-01 12:34", "2026-10-01T12:34:00.000Z"],
    ["2026-10-01T12:34:56", "2026-10-01T12:34:56.000Z"],
    ["2026-10-01 12:34:56.7", "2026-10-01T12:34:56.700Z"],
    ["2026-10-01 12:34:56.78", "2026-10-01T12:34:56.780Z"],
    ["2026-10-01 12:34:56.789", "2026-10-01T12:34:56.789Z"],
  ])("parses %s as a UTC instant without truncation", (raw, expected) => {
    const parsed = parseFeaturedForm({ title: "Slot", starts_at: raw, ends_at: raw.replace("12:", "13:") });
    expect(parsed.startsAtUtc?.toISOString()).toBe(expected);
    expect(parsed.endsAtUtc?.toISOString()).toBe(expected.replace("12:", "13:"));
  });

  it.each([
    "2026-02-30 12:34:56.789", "2026-10-01 24:00:00.000", "2026-10-01 12:60:00.000",
    "2026-10-01 12:34:60.000", "2026-10-01 12:34:56.7891", "2026-10-01 12:34.789",
    "2026-10-01T12:34:56.789Z", "2026-10-01T12:34:56.789+01:00", "not a date",
  ])("rejects invalid or offset-bearing UTC window text: %s", (raw) => {
    expect(fieldErrors({ starts_at: raw })).toHaveProperty("starts_at");
    expect(fieldErrors({ ends_at: raw })).toHaveProperty("ends_at");
  });

  it("keeps absent and cleared windows nullable", () => {
    for (const fields of [{}, { starts_at: "", ends_at: " " }, { starts_at: null, ends_at: null }]) {
      expect(parseFeaturedForm({ title: "Slot", ...fields })).toMatchObject({ startsAtUtc: null, endsAtUtc: null });
    }
  });

  it("orders windows at millisecond precision, including within the same minute", () => {
    const start = "2026-10-01 12:34:56.789";
    expect(parseFeaturedForm({ title: "Slot", starts_at: start, ends_at: "2026-10-01 12:34:56.790" }).endsAtUtc)
      .toEqual(new Date("2026-10-01T12:34:56.790Z"));
    for (const end of [start, "2026-10-01 12:34:56.788"]) {
      expect(fieldErrors({ starts_at: start, ends_at: end }).ends_at).toBe("The window ends after it starts.");
    }
  });

  it("does not broaden event wall-time parsing to seconds or milliseconds", () => {
    expect(wallToUtc("2026-10-01 12:34", "UTC")).toEqual(new Date("2026-10-01T12:34:00.000Z"));
    for (const raw of ["2026-10-01 12:34:56", "2026-10-01 12:34:56.789"]) {
      expect(() => wallToUtc(raw, "UTC")).toThrow(ValidationError);
    }
  });
});

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe.skipIf(!process.env.DATABASE_URL)("featured edit precision (isolated test Postgres)", () => {
  let fixture: MemberDataFixture;
  let admin: ReturnType<typeof adminApp>;
  let bindings: EnvWithAdminDb & { SESSION_STORE: SessionStore };
  let cookie: string;
  let id: number;
  const fields = { title: "Precise slot", body: "Original body", position: "2", is_published: "on" };

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterAll(async () => { await fixture?.dispose(); });
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(async () => {
    await fixture.db.delete(featuredContents);
    const [row] = await fixture.db.insert(featuredContents).values({
      title: fields.title, body: fields.body, position: 2, isPublished: true, startsAt, endsAt,
    }).returning();
    id = row!.id;
    const store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId: "precision-mod", username: "moderator",
      avatar: null, member: true, moderator: true, expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
    bindings = { ...env, ADMIN_DB: fixture.db, SESSION_STORE: store };
    admin = adminApp({ sessionStore: store, db: fixture.db });
  });

  const read = async () => {
    const response = await admin.request(`/featured/${id}`, { headers: { cookie } }, bindings);
    expect(response.status).toBe(200);
    return response.text();
  };
  const save = (values: Record<string, string>) => admin.request(`/featured/${id}`, {
    method: "POST",
    headers: { cookie, origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, ...values }),
  }, bindings);
  const stored = async () => (await fixture.db.select().from(featuredContents).where(eq(featuredContents.id, id)))[0]!;

  it.each([
    ["title", "New headline"], ["body", "New body"], ["position", "7"],
  ])("retains exact windows after a %s-only edit", async (field, value) => {
    const response = await save({ ...windowFields(await read()), [field]: value });
    expect(response.status).toBe(303);
    const row = await stored();
    expect(row.startsAt).toEqual(startsAt);
    expect(row.endsAt).toEqual(endsAt);
    expect(row[field as "title" | "body" | "position"]).toBe(field === "position" ? Number(value) : value);
  });

  it.each([
    ["starts_at", "2026-10-01 12:35", "2026-10-01T12:35:00.000Z"],
    ["ends_at", "2026-10-01 13:46:23.456", "2026-10-01T13:46:23.456Z"],
    ["starts_at", "", null], ["ends_at", "", null],
  ])("changes only the explicitly edited %s to %s", async (field, value, expected) => {
    expect((await save({ ...windowFields(await read()), [field]: value })).status).toBe(303);
    expect(await stored()).toMatchObject({
      startsAt: field === "starts_at" ? (expected === null ? null : new Date(expected)) : startsAt,
      endsAt: field === "ends_at" ? (expected === null ? null : new Date(expected)) : endsAt,
    });
  });

  it("keeps null windows empty on the edit form and unrelated saves", async () => {
    await fixture.db.update(featuredContents).set({ startsAt: null, endsAt: null }).where(eq(featuredContents.id, id));
    const windows = windowFields(await read());
    expect(windows).toEqual({ starts_at: "", ends_at: "" });
    expect((await save({ ...windows, title: "Open window" })).status).toBe(303);
    expect(await stored()).toMatchObject({ startsAt: null, endsAt: null });
  });

  it("preserves precise fields through a 422 rerender and corrected retry", async () => {
    const windows = windowFields(await read());
    const rejected = await save({ ...windows, title: "" });
    expect(rejected.status).toBe(422);
    const html = await rejected.text();
    expect(html).toContain("UTC");
    expect(windowFields(html)).toEqual(windows);
    expect((await save({ ...windowFields(html), title: "Corrected" })).status).toBe(303);
    expect(await stored()).toMatchObject({ startsAt, endsAt });
  });

  it("does not write invalid or reversed window edits", async () => {
    const windows = windowFields(await read());
    const invalid: Record<string, string>[] = [{ starts_at: "not a date" }, { ends_at: "2026-10-01 12:34:56.788" }];
    for (const values of invalid) {
      expect((await save({ ...windows, ...values })).status).toBe(422);
      expect(await stored()).toMatchObject({ startsAt, endsAt });
    }
  });

  it("keeps homepage visibility at the original inclusive start and exclusive end after saving", async () => {
    const windows = windowFields(await read());
    vi.useFakeTimers({ toFake: ["Date"] });
    const boundaries = [
      [startsAt.getTime() - 1, false], [startsAt.getTime(), true], [startsAt.getTime() + 1, true],
      [endsAt.getTime() - 1, true], [endsAt.getTime(), false], [endsAt.getTime() + 1, false],
    ] as const;
    for (const saveFirst of [false, true]) {
      if (saveFirst) expect((await save({ ...windows, body: "Edited body" })).status).toBe(303);
      for (const [time, visible] of boundaries) {
        const at = new Date(time);
        vi.setSystemTime(at);
        expect((await listVisibleFeatured(fixture.db, at)).some((row) => row.id === id)).toBe(visible);
        const response = await app.request("/", {}, bindings);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html.includes(`<h3>${fields.title}</h3>`), `${at.toISOString()} afterSave=${saveFirst}`).toBe(visible);
      }
    }
  });
});
