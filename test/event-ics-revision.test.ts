// Revision parity with legacy EventIcsRevisionTest; only owned agent-testdb/CI schemas.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { createEvent, transitionEvent, updateEvent } from "../src/admin/store";
import type { EventFormInput } from "../src/admin/validation";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { eventIcs, eventsIcsCollection } from "../src/events/feeds";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const KEY = "01K00000000000000000000030";
const NOW = new Date("2026-09-30T12:00:00Z");
const actor = { id: "synthetic-moderator", username: "Synthetic moderator" };
const input: EventFormInput = {
  title: "Revision fixture", game: null, description: "Latest description", location: "Latest room",
  startsAtUtc: new Date("2099-01-01T18:00:00Z"), endsAtUtc: new Date("2099-01-01T20:00:00Z"),
  timezone: "UTC", capacity: null,
};
const property = (body: string, name: string) => {
  const value = body.replaceAll("\r\n ", "").match(new RegExp(`^${name}:([^\\r\\n]*)`, "m"))?.[1];
  expect(value).toBeDefined();
  return value!;
};
const sequence = (body: string) => BigInt(property(body, "SEQUENCE"));

describe.skipIf(!process.env.DATABASE_URL)("database-owned ICS revisions", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 }); });
  beforeEach(async () => {
    await fixture.reset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await fixture?.dispose(); });

  const insert = async (status = "published") => {
    const [row] = await fixture.db.insert(events).values({
      eventKey: KEY, title: input.title, startsAt: input.startsAtUtc, endsAt: input.endsAtUtc,
      status, createdAt: NOW, updatedAt: NOW,
    }).returning();
    return row!;
  };
  const read = async () => (await fixture.db.select().from(events).where(eq(events.eventKey, KEY)))[0]!;
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, {
    APP_URL, ADMIN_DB: fixture.db,
  } as unknown as Env);

  it.each(["/events.ics", `/events/${KEY}.ics`])("fixed-clock edits, publish/cancel and ETags: %s", async (path) => {
    const draft = await insert("draft");
    const published = (await transitionEvent(fixture.db, actor, KEY, "published")).row;
    expect(published.icsSequence).toBeGreaterThan(draft.icsSequence);
    let response = await request(path);
    expect(response.status).toBe(200);
    let body = await response.text();
    const uid = property(body, "UID");
    let etag = response.headers.get("etag")!;
    for (const title of ["First rapid edit", "Second rapid edit"]) {
      const saved = (await updateEvent(fixture.db, actor, KEY, { ...input, title })).row;
      response = await request(path, { headers: { "if-none-match": etag } });
      expect(response.status).toBe(200);
      const next = await response.text();
      expect(sequence(next)).toBeGreaterThan(sequence(body));
      expect(sequence(next)).toBe(saved.icsSequence);
      expect(property(next, "UID")).toBe(uid);
      expect(property(next, "SUMMARY")).toBe(title);
      expect(property(next, "DESCRIPTION")).toBe(input.description);
      expect(property(next, "LOCATION")).toBe(input.location);
      expect(property(next, "DTSTART")).toBe("20990101T180000Z");
      expect(property(next, "DTEND")).toBe("20990101T200000Z");
      expect(response.headers.get("etag")).not.toBe(etag);
      body = next;
      etag = response.headers.get("etag")!;
    }
    const cancelled = (await transitionEvent(fixture.db, actor, KEY, "cancelled")).row;
    response = await request(path, { headers: { "if-none-match": etag } });
    expect(response.status).toBe(200);
    const latest = await response.text();
    expect(sequence(latest)).toBeGreaterThan(sequence(body));
    expect(sequence(latest)).toBe(cancelled.icsSequence);
    expect(property(latest, "STATUS")).toBe("CANCELLED");
    expect(property(latest, "UID")).toBe(uid);
    expect(cancelled.updatedAt).toEqual(NOW);
    expect(response.headers.get("etag")).not.toBe(etag);
    const currentEtag = response.headers.get("etag")!;
    vi.setSystemTime(new Date(NOW.getTime() + 300_000));
    expect(await (await request(path)).text()).toBe(latest);
    expect((await request(path, { headers: { "if-none-match": currentEtag } })).status).toBe(304);
  });

  it("stale saves, bulk writes, backward clocks and SQL no-ops use persisted revisions", async () => {
    const stale = await insert();
    const sql = fixture.client;
    await sql`update events set title = 'First writer' where event_key = ${KEY}`;
    const first = await read();
    await sql`update events set title = 'Stale writer', ics_sequence = ${String(stale.icsSequence)} where event_key = ${KEY}`;
    const second = await read();
    expect(first.icsSequence).toBe(stale.icsSequence + 1n);
    expect(second.icsSequence).toBe(first.icsSequence + 1n);
    await sql`update events set title = 'Bulk writer', updated_at = '2026-09-30 11:00:00+00' where event_key = ${KEY}`;
    const bulk = await read();
    expect(bulk.icsSequence).toBe(second.icsSequence + 1n);
    await sql`update events set status = 'cancelled' where event_key = ${KEY}`;
    const cancelled = await read();
    expect(cancelled.icsSequence).toBe(bulk.icsSequence + 1n);
    await sql`update events set title = title, updated_at = updated_at, ics_sequence = ics_sequence where event_key = ${KEY}`;
    expect(await read()).toEqual(cancelled);
    expect(eventIcs(await read(), APP_URL)).toBe(eventIcs(cancelled, APP_URL));
    expect(eventsIcsCollection([await read()], APP_URL)).toBe(eventsIcsCollection([cancelled], APP_URL));
  });

  it("quiet inserts and updates cannot supply a revision; concurrent writes each advance", async () => {
    const [created] = await fixture.db.insert(events).values({
      eventKey: KEY, title: input.title, startsAt: input.startsAtUtc, endsAt: input.endsAtUtc,
      createdAt: NOW, updatedAt: NOW, icsSequence: 9007199254740993n,
    }).returning();
    expect(created!.icsSequence).toBe(1790769600n);
    await fixture.client`update events set ics_sequence = 0 where event_key = ${KEY}`;
    expect((await read()).icsSequence).toBe(created!.icsSequence + 1n);
    await Promise.all(["One", "Two", "Three"].map((title) => fixture.client`
      update events set title = ${title} where event_key = ${KEY}
    `));
    expect((await read()).icsSequence).toBe(created!.icsSequence + 4n);
  });

  it("backfills existing events to their old epoch revisions", async () => {
    await insert();
    // Roll back/reapply only inside the owned test schema, never shared/public tables.
    await fixture.client`drop trigger events_ics_sequence on events`;
    await fixture.client`drop function advance_event_ics_sequence()`;
    await fixture.client`alter table events drop column ics_sequence`;
    await fixture.client`update events set updated_at = '2026-07-01 10:00:00.999999+00' where event_key = ${KEY}`;
    const migration = readFileSync(new URL("../drizzle/1012_event-ics-sequence.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) await fixture.client.unsafe(statement);
    expect((await read()).icsSequence).toBe(1782900000n);
    await fixture.client`update events set title = 'First migrated edit' where event_key = ${KEY}`;
    expect((await read()).icsSequence).toBe(1782900001n);
  });

  it("native creates still audit content without serializing the database bigint", async () => {
    const created = await createEvent(fixture.db, actor, input);
    expect(created.row.icsSequence).toBeGreaterThan(0n);
    const [audit] = await fixture.db.select().from(activityLog);
    expect(audit!.properties).toHaveProperty("title.after", input.title);
    expect(audit!.properties).not.toHaveProperty("icsSequence");
  });
});
