// route-inventory: GET /e/:key
// route-inventory: GET /events.json
// route-inventory: GET /events/:file{.+\.ics}
// route-inventory: GET /events.ics
// DST-paired cross-surface agreement for Europe/London 2026 (TOG-11669):
// legacy Feature/Events/EventTimezoneDisplayTest.php, narrowed to the spring
// gap shoulders and the autumn fold pair. A fresh JSON create resolves the
// fold wall time to the SECOND (GMT) occurrence, as legacy/Carbon did
// (EventTimezoneTest.php:295-300); whichever instant is stored, the event
// page, member JSON, per-event ICS, collection ICS and Google link all carry
// that same instant. Clock-only fake (Date): full fake timers hang the
// postgres-js socket timers. Isolated test DB only.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "fold-display-agreement-secret-at-least-32-bytes";
// Before every case, so feeds (ends_at >= now) list them all.
const NOW = new Date("2026-03-01T12:00:00.000Z");

// [label, wall text in Europe/London, stored instant]. 2026-03-29 skips
// 01:00 GMT -> 02:00 BST; 2026-10-25 repeats 01:00-02:00 (BST, then GMT).
const CASES = [
  ["spring shoulder before the gap (GMT)", "2026-03-29 00:59", "2026-03-29T00:59:00.000Z"],
  ["spring shoulder after the gap (BST)", "2026-03-29 02:00", "2026-03-29T01:00:00.000Z"],
  ["fold first occurrence (BST)", "2026-10-25 01:30", "2026-10-25T00:30:00.000Z"],
  ["fold second occurrence (GMT)", "2026-10-25 01:30", "2026-10-25T01:30:00.000Z"],
] as const;

// 26-char Crockford keys: /e/:key and /events/:key.ics 404 anything else.
const key = (n: number) => String(n).padStart(26, "0");
const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3600_000).toISOString();
const icsInstant = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

describe.skipIf(!process.env.DATABASE_URL)("DST-paired page/JSON/ICS agreement (isolated test DB)", () => {
  let fixture: MemberDataFixture;
  let env: Env;
  // Late-bound clock: the default captures the real Date.now before the fake.
  const store = createMemorySessionStore(() => Date.now());
  // The queue is incidental here (never asserted); the binding name must still
  // match what the producers read so writes exercise the real enqueue path.
  const sent: Extract<QueueMessage, { kind: "sync-event" }>[] = [];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = {
      APP_URL, SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730", DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      ADMIN_DB: fixture.db,
      SESSION_STORE: store,
      SYNC_EVENT_QUEUE: { send: async (message: Extract<QueueMessage, { kind: "sync-event" }>) => void sent.push(message) },
    } as unknown as Env;
  });
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await fixture.reset();
    sent.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  async function cookieFor(moderator: boolean) {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId: moderator ? "fold-display-mod" : "fold-display-member",
      username: moderator ? "Moderator" : "Member", avatar: null, member: true, moderator,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
  }

  const seed = (n: number, startsAt: string) =>
    fixture.db.insert(events).values({
      eventKey: key(n), title: `DST case ${n}`, timezone: "Europe/London", status: "published",
      startsAt: new Date(startsAt), endsAt: new Date(plusHours(startsAt, 2)),
    });

  it.each([
    ["spring shoulder before the gap", "2026-03-29 00:59", "2026-03-29T00:59:00.000Z"],
    ["spring shoulder after the gap", "2026-03-29 02:00", "2026-03-29T01:00:00.000Z"],
    ["fold wall time", "2026-10-25 01:30", "2026-10-25T01:30:00.000Z"],
  ])("a fresh JSON create at the %s stores the legacy instant", async (_, wall, iso) => {
    const res = await app.request("/events", {
      method: "POST",
      headers: { cookie: await cookieFor(true), origin: APP_URL, "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh DST parse", starts_at: wall, ends_at: "2026-10-25 04:00", timezone: "Europe/London" }),
    }, env);
    expect(res.status).toBe(201);
    const { data } = await res.json() as { data: { event_key: string; starts_at: string } };
    expect(data.starts_at).toBe(iso);
    const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, data.event_key));
    expect(row!.startsAt.toISOString()).toBe(iso);
  });

  it.each(CASES.map(([label, wall, iso], i) => [label, wall, iso, i + 1] as const))(
    "%s: page, JSON, ICS and Google link carry the stored instant",
    async (_, wall, iso, n) => {
      await seed(n, iso);
      const ics = icsInstant(iso);

      const page = await app.request(`/e/${key(n)}`, {}, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      const time = html.match(new RegExp(`<p>\\s*<time datetime="${iso}">([^<]*)</time>\\s*</p>`));
      expect(time, "show-page <time> carries the stored instant").not.toBeNull();
      // Visible text is the host-zone wall clock of that instant.
      expect(time![1]).toContain(wall.slice(11));
      expect(html).toContain(`dates=${ics}%2F${icsInstant(plusHours(iso, 2))}`);

      const json = await app.request(`/events.json?event_key=${key(n)}`, { headers: { cookie: await cookieFor(false) } }, env);
      expect(json.status).toBe(200);
      const { data } = await json.json() as { data: { starts_at: string; ends_at: string; timezone: string }[] };
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ starts_at: iso, ends_at: plusHours(iso, 2), timezone: "Europe/London" });

      const single = await app.request(`/events/${key(n)}.ics`, {}, env);
      expect(single.status).toBe(200);
      const body = await single.text();
      expect(body).toContain(`DTSTART:${ics}\r\n`);
      expect(body).toContain(`DTEND:${icsInstant(plusHours(iso, 2))}\r\n`);
    },
  );

  it("the fold pair stays two distinct instants on every surface", async () => {
    const [, , first] = CASES[2];
    const [, , second] = CASES[3];
    await seed(3, first);
    await seed(4, second);

    const feed = await (await app.request("/events.ics", {}, env)).text();
    expect(feed).toContain(`DTSTART:${icsInstant(first)}\r\n`);
    expect(feed).toContain(`DTSTART:${icsInstant(second)}\r\n`);

    const json = await app.request("/events.json", { headers: { cookie: await cookieFor(false) } }, env);
    const { data } = await json.json() as { data: { event_key: string; starts_at: string }[] };
    expect(Object.fromEntries(data.map((e) => [e.event_key, e.starts_at]))).toEqual({ [key(3)]: first, [key(4)]: second });

    for (const [n, iso] of [[3, first], [4, second]] as const) {
      const html = await (await app.request(`/e/${key(n)}`, {}, env)).text();
      expect(html).toMatch(new RegExp(`<time datetime="${iso}">`));
    }
  });
});
