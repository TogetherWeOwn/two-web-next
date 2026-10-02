// route-inventory: GET /events.rss
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const NOW = "2026-10-01T12:00:00Z";
const END = "2026-10-01T14:00:00Z";
const UPDATED = new Date("2026-09-30T12:00:00Z");
const KEY = "01J0000000000000000000RSS1";

describe.skipIf(!process.env.DATABASE_URL)("empty RSS validators (isolated test schema)", () => {
  let fixture: MemberDataFixture;
  let env: Env;
  const sessionAccess = vi.fn(() => { throw new Error("Public RSS must not read sessions"); });

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = { APP_URL, ADMIN_DB: fixture.db } as unknown as Env;
    Object.defineProperty(env, "SESSION_SECRET", { get: sessionAccess });
    Object.defineProperty(env, "SESSION_STORE", { get: sessionAccess });
  });
  beforeEach(async () => {
    await fixture.reset();
    sessionAccess.mockClear();
    // Only fake Date: Postgres I/O and request deadlines keep real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    expect(sessionAccess).not.toHaveBeenCalled();
  });
  afterAll(async () => { await fixture?.dispose(); });

  const request = (etag?: string) => app.request("/events.rss", {
    headers: etag ? { "if-none-match": etag } : {},
  }, env);
  const insert = (overrides: Partial<typeof events.$inferInsert> = {}) => fixture.db.insert(events).values({
    eventKey: KEY,
    title: "RSS event",
    startsAt: new Date("2026-10-01T13:00:00Z"),
    endsAt: new Date(END),
    timezone: "UTC",
    status: "published",
    updatedAt: UPDATED,
    ...overrides,
  });
  const read = async (etag?: string) => {
    const response = await request(etag);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=300, public");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    const validator = response.headers.get("etag")!;
    expect(validator).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    return { body, etag: validator };
  };
  const unchanged = async (etag: string) => {
    const response = await request(etag);
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("max-age=300, public");
    expect(response.headers.get("set-cookie")).toBeNull();
  };

  it("keeps initially empty bytes and strong ETag stable across clock advances", async () => {
    const empty = await read();
    expect(empty.body).not.toContain("<item>");
    expect(empty.body).toContain("<lastBuildDate>Thu, 01 Jan 1970 00:00:00 +0000</lastBuildDate>");
    for (const now of ["2026-10-01T12:00:01Z", "2026-10-08T12:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      expect(await read()).toEqual(empty);
      await unchanged(empty.etag);
    }
    const withCookie = await app.request("/events.rss", {
      headers: { cookie: "__Host-two_session=not-a-session", "if-none-match": empty.etag },
    }, env);
    expect(withCookie.status).toBe(304);
    expect(withCookie.headers.get("set-cookie")).toBeNull();
  });

  it("invalidates at final-event expiry, then settles on the same stable empty representation", async () => {
    const empty = await read();
    await insert();
    const populated = await read(empty.etag);
    expect(populated.etag).not.toBe(empty.etag);
    expect(populated.body).toContain(KEY);
    vi.setSystemTime(new Date(END));
    // ends_at >= now remains eligible at the exact boundary.
    expect(await read()).toEqual(populated);
    await unchanged(populated.etag);
    vi.setSystemTime(new Date("2026-10-01T14:00:00.001Z"));
    const expired = await read(populated.etag);
    expect(expired).toEqual(empty);
    expect(expired.body).not.toContain(KEY);
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    expect(await read()).toEqual(expired);
    await unchanged(expired.etag);
  });

  it("invalidates empty and populated validators for eligible additions and edits", async () => {
    const empty = await read();
    await insert();
    const first = await read(empty.etag);
    expect(first.etag).not.toBe(empty.etag);
    expect(first.body).toContain("<lastBuildDate>Wed, 30 Sep 2026 12:00:00 +0000</lastBuildDate>");
    vi.setSystemTime(new Date("2026-10-01T12:30:00Z"));
    expect(await read()).toEqual(first);
    await unchanged(first.etag);
    await fixture.db.update(events).set({ title: "Edited RSS event", updatedAt: new Date("2026-10-01T12:30:00Z") }).where(eq(events.eventKey, KEY));
    const edited = await read(first.etag);
    expect(edited.etag).not.toBe(first.etag);
    expect(edited.body).toContain("<title>Edited RSS event</title>");
    expect(edited.body).toContain("<lastBuildDate>Thu, 01 Oct 2026 12:30:00 +0000</lastBuildDate>");
    await insert({ eventKey: "01J0000000000000000000RSS2", title: "Another RSS event", updatedAt: new Date("2026-10-01T12:31:00Z") });
    const added = await read(edited.etag);
    expect(added.etag).not.toBe(edited.etag);
    expect(added.body.match(/<item>/g)).toHaveLength(2);
    expect(added.body).toContain("<lastBuildDate>Thu, 01 Oct 2026 12:31:00 +0000</lastBuildDate>");
    await unchanged(added.etag);
  });

  it("does not invalidate empty RSS for drafts, cancelled or already expired events", async () => {
    const empty = await read();
    await insert({ eventKey: "01J0000000000000000000DRF1", status: "draft" });
    await insert({ eventKey: "01J0000000000000000000CAN1", status: "cancelled" });
    await insert({ endsAt: new Date("2026-10-01T11:59:59Z") });
    vi.setSystemTime(new Date("2026-10-01T12:01:00Z"));
    expect(await read()).toEqual(empty);
    await unchanged(empty.etag);
  });
});
