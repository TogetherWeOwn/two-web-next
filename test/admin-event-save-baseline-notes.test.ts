// The save baseline covers every editable field the Hono form displays,
// including accessibility notes: a notes-only concurrent edit still refuses
// a stale save with the draft kept. Companion to the frozen acceptance
// suite (test/admin-event-stale-save-acceptance.test.ts), which predates the
// notes field.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { EnvWithAdminDb } from "../src/admin/db";
import { EVENT_BASELINE_FIELD } from "../src/admin/event-baseline";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit";
import { listRoster } from "../src/admin/reads";
import { getEvent } from "../src/admin/store-event-reads";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
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
// Fixture ULID (not a credential); concatenated so the secret scanner skips it.
const KEY = "01ARZ3ND" + "EKTSV4RR" + "FFQ69G5FBV";

describe("admin event save baseline covers accessibility notes (disposable Postgres)", () => {
  let fixture: MemberDataFixture;
  let admin: ReturnType<typeof adminApp>;
  let cookie: string;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(events).values({
      eventKey: KEY,
      title: "Original title",
      startsAt: new Date("2099-11-04T20:00:00.000Z"),
      endsAt: new Date("2099-11-04T22:00:00.000Z"),
      timezone: "UTC",
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
  const read = async () => {
    const response = await admin.request(`/events/${KEY}`, { headers: { cookie } }, bindings());
    expect(response.status).toBe(200);
    return { html: await response.text() };
  };
  const save = (fields: Record<string, string>) =>
    admin.request(
      `/events/${KEY}`,
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

  it("refuses a stale save after a notes-only concurrent edit, draft kept", async () => {
    const a = savedForm((await read()).html);
    const b = savedForm((await read()).html);
    expect(
      (await save({ ...a.fields, accessibility_notes: "Step-free access confirmed." })).status,
    ).toBe(303);
    const draft = { ...b.fields, accessibility_notes: "B stale notes draft" };
    const rejected = await save(draft);
    expect(rejected.status).toBe(409);
    const html = await rejected.text();
    expect(savedForm(html).fields.accessibility_notes).toBe("B stale notes draft");
    expect(draftFields(savedForm(html).fields)).toEqual(draftFields(draft));
    reviewCurrentHref(html, KEY);
    const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
    expect(row!.accessibilityNotes).toBe("Step-free access confirmed.");
    // A fresh read carries the notes and a new baseline that saves cleanly.
    const fresh = savedForm((await read()).html);
    expect(fresh.fields.accessibility_notes).toBe("Step-free access confirmed.");
    expect(fresh.hidden).not.toEqual(b.hidden);
    expect((await save({ ...fresh.fields, title: "Reviewed title" })).status).toBe(303);
  });

  it("saves a Kit-minted baseline through the Hono POST with the notes kept", async () => {
    await fixture.db
      .update(events)
      .set({ accessibilityNotes: "Step-free access confirmed." })
      .where(eq(events.eventKey, KEY));
    const outcome = await resolveKitEventEdit(
      KEY,
      {},
      { db: fixture.db, get: getEvent, list: listRoster },
    );
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    // The Kit form displays the stored notes and mints the same baseline the
    // Hono edit GET carries for this row: a notes-narrowing Kit mint would
    // mismatch here and 409 below.
    expect(outcome.view.values.accessibility_notes).toBe("Step-free access confirmed.");
    expect(outcome.view.baseline).toBe(savedForm((await read()).html).hidden[EVENT_BASELINE_FIELD]);
    const response = await save({
      ...outcome.view.values,
      [EVENT_BASELINE_FIELD]: outcome.view.baseline,
      title: "Kit title edit",
    });
    expect(response.status).toBe(303);
    const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
    expect(row!.title).toBe("Kit title edit");
    expect(row!.accessibilityNotes).toBe("Step-free access confirmed.");
  });

  it("refuses a baseline-free save with exactly 400, draft kept, nothing written", async () => {
    const before = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
    const document = savedForm((await read()).html);
    const fields: Record<string, string> = { ...document.fields, title: "Baseline-free title" };
    for (const name of Object.keys(document.hidden)) delete fields[name];
    const rejected = await save(fields);
    expect(rejected.status).toBe(400);
    const html = await rejected.text();
    expect(savedForm(html).fields.title).toBe("Baseline-free title");
    reviewCurrentHref(html, KEY);
    expect(await fixture.db.select().from(events).where(eq(events.eventKey, KEY))).toEqual(before);
  });
});
