// Acceptance contract for "Events: reminder preferences and per-event mute
// API + UI" (spec: parent design card, slices 1-2). The Builder implements on
// this branch and never edits this file. RED until slice 2 lands (slice 1
// tables must be present for the DB sections).
//
// Pinned contract:
// - Profile global toggle: PATCH /members/:user accepts `reminder_opt_out`
//   with leaderboard_opt_out-identical semantics (true = opted out / no
//   reminders; absent key preserves; garbage 422s; owner only). The edit
//   form shows an "Event reminders" setting with a checkbox named
//   `reminder_opt_out` whose checked state is the stored opt-out.
//   Rationale: opt-out framing matches the `profiles.reminder_opt_out`
//   column and the leaderboard precedent, so no layer inverts the bit.
// - Per-event mute: PUT /events/:key/reminder-mute with JSON
//   `{muted: boolean}` (strict booleans; missing/other 422s) answers 200
//   `{data: {muted}}` and writes exactly one row keyed by the SESSION user
//   (a `user_id` body key that differs from the session 403s, RSVP
//   precedent). Auth mirrors PUT /events/:key/rsvp: anon 401, non-member
//   403, unknown/invalid key 404, other-case key 308s to canonical before
//   any session or DB read. The HTML detail page (/e/:key) shows the going
//   member a checkbox named `muted` labelled exactly "Mute reminders for
//   this event", checked exactly when the mute row exists, wired to the
//   PUT route.
// - Immediate effect: every PUT/PATCH is readable on the very next GET;
//   no caching delay on either toggle.
// - Un-RSVP deletes the RSVP row only: the mute row survives withdrawal,
//   so a re-RSVP is still muted (mutes are preferences, not sends).
// - Both toggles are real checkboxes with an associated label naming
//   reminders, keyboard-focusable, exposed to screen readers.
//
// Deliberately NOT pinned (builder's choice): mute visibility for members
// without a going/maybe RSVP, mute writes on draft/cancelled/past events,
// mute rate-limiting, no-JS form fallback mechanics, exact profile label
// copy beyond the "Event reminders" setting name.
//
// NOTE for the builder: do NOT add a `// route-inventory:` line for the new
// route to THIS file (it would be a stale reference until the route and the
// fixture entry exist). Put it in your own implementation test file with the
// test/fixtures/route-inventory.json entry and the docs/parity.md entry.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import {
  createDbProfileStore,
  createMemoryProfileStore,
  type ProfileStore,
} from "../src/profiles/store";
import { validateProfile } from "../src/profiles/validation";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import app from "./app";
import {
  cookieFor as memberCookieFor,
  env as memberEnv,
  EVENT_KEY,
  MEMBER,
  OUTSIDER,
  seed as seedMemberData,
} from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const profileEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const ALICE = { userId: "326474832151838731", username: "alice", member: true, moderator: false };
const BOB = { userId: "326474832151838732", username: "bob", member: true, moderator: false };
const MOD = { userId: "326474832151838733", username: "mod", member: true, moderator: true };
const OUTSIDER_PROFILE = {
  userId: "326474832151838735",
  username: "outsider",
  member: false,
  moderator: false,
};
type Who = typeof ALICE;

async function profileCookieFor(sessions: SessionStore, who: Who): Promise<string> {
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: who.userId,
    username: who.username,
    avatar: null,
    member: who.member,
    moderator: who.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

// The store type gains `reminderOptOut` with the builder's change; read it
// loosely so this file typechecks both before and after.
const reminderOptOutOf = async (store: ProfileStore, id: string): Promise<unknown> =>
  ((await store.find(id)) as unknown as Record<string, unknown> | null)?.["reminderOptOut"];

type Seeded = { store: ProfileStore; snapshot: () => Promise<unknown> };
type Backend = {
  name: string;
  open?: () => Promise<() => Promise<void>>;
  seed: () => Promise<Seeded>;
};

const memoryBackend: Backend = {
  name: "memory store",
  async seed() {
    const store = createMemoryProfileStore([
      {
        id: ALICE.userId,
        username: "alice",
        avatar: null,
        bio: null,
        games: [],
        timezone: null,
      },
      {
        id: BOB.userId,
        username: "bob",
        avatar: null,
        bio: null,
        games: [],
        timezone: null,
      },
    ]);
    return { store, snapshot: async () => structuredClone([...store.rows.entries()]) };
  },
};

let profileFixture: MemberDataFixture | undefined;
const profileDb = (): Db => profileFixture!.db;
const postgresBackend: Backend = {
  name: "postgres store",
  async open() {
    profileFixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    return () => profileFixture!.dispose();
  },
  async seed() {
    await profileFixture!.reset();
    await profileDb()
      .insert(users)
      .values([
        { id: ALICE.userId, username: "alice", member: true },
        { id: BOB.userId, username: "bob", member: true },
      ]);
    await profileDb()
      .insert(profiles)
      .values({ userId: ALICE.userId, bio: null, games: [], timezone: null });
    return {
      store: createDbProfileStore(profileDb()),
      snapshot: async () => ({
        users: await profileDb().select().from(users).orderBy(users.id),
        profiles: await profileDb().select().from(profiles).orderBy(profiles.userId),
      }),
    };
  },
};

const profileBackends = process.env.DATABASE_URL
  ? [memoryBackend, postgresBackend]
  : [memoryBackend];

const jsonPatch = (cookie: string, body: Record<string, unknown>) => ({
  method: "PATCH",
  headers: {
    cookie,
    origin: APP_URL,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(body),
});
const formPatch = (cookie: string, fields: Record<string, string>, method = "PATCH") => ({
  method,
  headers: {
    cookie,
    origin: APP_URL,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams(method === "POST" ? { _method: "PATCH", ...fields } : fields),
});
const FULL_JSON = { bio: "bio", games: ["Chess"], timezone: "Europe/London" };
const FULL_FORM = { bio: "bio", games_text: "Chess", timezone: "Europe/London" };

// Label text for a checkbox: an explicit for/id association wins, otherwise
// the wrapping label (the leaderboard pattern).
function labelTextFor(html: string, inputTag: string): string | null {
  const id = /id="([^"]+)"/.exec(inputTag)?.[1];
  if (id) {
    const assoc = new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`, "i").exec(
      html,
    )?.[1];
    if (assoc !== undefined) return assoc;
  }
  const chunk = html.split("</label>").find((part) => part.includes(inputTag));
  if (chunk && chunk.includes("<label")) return chunk.slice(chunk.lastIndexOf("<label"));
  return null;
}

function inputTag(html: string, name: string): string | null {
  return new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? null;
}

describe("reminder preference validation", () => {
  it("maps booleans and form strings to the stored opt-out", () => {
    for (const value of [true, "1", "true", "on", "yes"]) {
      const res = validateProfile({ ...FULL_JSON, reminder_opt_out: value });
      expect(res.ok, JSON.stringify(value)).toBe(true);
      if (res.ok)
        expect(
          (res.attrs as unknown as Record<string, unknown>).reminderOptOut,
          JSON.stringify(value),
        ).toBe(true);
    }
    for (const value of [false, "0", "false", "off", "no", ""]) {
      const res = validateProfile({ ...FULL_JSON, reminder_opt_out: value });
      expect(res.ok, JSON.stringify(value)).toBe(true);
      if (res.ok)
        expect(
          (res.attrs as unknown as Record<string, unknown>).reminderOptOut,
          JSON.stringify(value),
        ).toBe(false);
    }
  });

  it("leaves the stored choice alone when the key is absent", () => {
    const res = validateProfile({ ...FULL_JSON });
    expect(res.ok).toBe(true);
    if (res.ok) expect("reminderOptOut" in res.attrs).toBe(false);
  });

  it("reads the browser's hidden-fallback pair as one choice", () => {
    const on = validateProfile({ ...FULL_JSON, reminder_opt_out: ["0", "1"] });
    expect(on.ok).toBe(true);
    if (on.ok) expect((on.attrs as unknown as Record<string, unknown>).reminderOptOut).toBe(true);
    const off = validateProfile({ ...FULL_JSON, reminder_opt_out: ["0"] });
    expect(off.ok).toBe(true);
    if (off.ok)
      expect((off.attrs as unknown as Record<string, unknown>).reminderOptOut).toBe(false);
  });

  it("rejects garbage with a field error", () => {
    expect(validateProfile({ ...FULL_JSON, reminder_opt_out: "maybe" })).toEqual({
      ok: false,
      errors: { reminder_opt_out: expect.any(String) },
    });
  });
});

describe.each(profileBackends)("owner-only reminder preference ($name)", (backend) => {
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    close = await backend.open?.();
  });
  afterAll(async () => {
    await close?.();
  });

  let app: ReturnType<typeof profilesApp>;
  let sessions: SessionStore;
  let seeded: Seeded;
  beforeEach(async () => {
    seeded = await backend.seed();
    sessions = createMemorySessionStore();
    app = profilesApp({
      sessionStore: sessions,
      store: seeded.store,
      throttle: async () => ({ limited: false }),
    });
  });
  const send = (path: string, init: RequestInit) => app.request(path, init, profileEnv);

  it("the owner opts out and back in over JSON, effective on the next read", async () => {
    const cookie = await profileCookieFor(sessions, ALICE);
    const out = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: true }),
    );
    expect(out.status).toBe(200);
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(true);

    const backIn = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: false }),
    );
    expect(backIn.status).toBe(200);
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(false);
  });

  it("the form checkbox writes true on 1 and false on 0", async () => {
    const cookie = await profileCookieFor(sessions, ALICE);
    const checked = await send(
      `/members/${ALICE.userId}`,
      formPatch(cookie, { ...FULL_FORM, reminder_opt_out: "1" }, "POST"),
    );
    expect(checked.status).toBe(303);
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(true);

    const unchecked = await send(
      `/members/${ALICE.userId}`,
      formPatch(cookie, { ...FULL_FORM, reminder_opt_out: "0" }, "POST"),
    );
    expect(unchecked.status).toBe(303);
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(false);
  });

  it("the shipped hidden-fallback pair round-trips as one choice", async () => {
    const cookie = await profileCookieFor(sessions, ALICE);
    const pair = (values: string[]) => {
      const body = new URLSearchParams({ _method: "PATCH", ...FULL_FORM });
      body.delete("reminder_opt_out");
      for (const value of values) body.append("reminder_opt_out", value);
      return {
        method: "POST",
        headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body,
      };
    };
    expect((await send(`/members/${ALICE.userId}`, pair(["0", "1"]))).status).toBe(303);
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(true);
    expect((await send(`/members/${ALICE.userId}`, pair(["0"]))).status).toBe(303);
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(false);
  });

  it("an absent key preserves an existing opt-out", async () => {
    const cookie = await profileCookieFor(sessions, BOB);
    expect(
      (
        await send(
          `/members/${BOB.userId}`,
          jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: true }),
        )
      ).status,
    ).toBe(200);
    expect(await reminderOptOutOf(seeded.store, BOB.userId)).toBe(true);

    // An old client that never sends the key must not opt the member back in.
    const legacy = await send(`/members/${BOB.userId}`, jsonPatch(cookie, { ...FULL_JSON }));
    expect(legacy.status).toBe(200);
    expect(await reminderOptOutOf(seeded.store, BOB.userId)).toBe(true);

    const legacyForm = await send(
      `/members/${BOB.userId}`,
      formPatch(cookie, { ...FULL_FORM }, "POST"),
    );
    expect(legacyForm.status).toBe(303);
    expect(await reminderOptOutOf(seeded.store, BOB.userId)).toBe(true);
  });

  it("garbage 422s and writes nothing", async () => {
    const before = await seeded.snapshot();
    const cookie = await profileCookieFor(sessions, ALICE);
    const res = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: "maybe" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ errors: { reminder_opt_out: expect.any(String) } });
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("another member or a moderator cannot flip someone else's switch", async () => {
    const aliceCookie = await profileCookieFor(sessions, ALICE);
    expect(
      (
        await send(
          `/members/${ALICE.userId}`,
          jsonPatch(aliceCookie, { ...FULL_JSON, reminder_opt_out: true }),
        )
      ).status,
    ).toBe(200);
    for (const who of [BOB, MOD]) {
      const cookie = await profileCookieFor(sessions, who);
      const res = await send(
        `/members/${ALICE.userId}`,
        jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: false }),
      );
      expect(res.status, who.username).toBe(403);
    }
    expect(await reminderOptOutOf(seeded.store, ALICE.userId)).toBe(true);
  });

  it("an unauthenticated write is refused and writes nothing", async () => {
    const before = await seeded.snapshot();
    const res = await send(`/members/${ALICE.userId}`, {
      method: "PATCH",
      headers: {
        origin: APP_URL,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ ...FULL_JSON, reminder_opt_out: true }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ recovery: expect.any(String) });
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("a non-member write is refused and writes nothing", async () => {
    const before = await seeded.snapshot();
    const cookie = await profileCookieFor(sessions, {
      ...OUTSIDER_PROFILE,
      member: false,
      moderator: false,
    });
    const res = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: true }),
    );
    expect(res.status).toBe(403);
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("no body key can name another member, matching or not", async () => {
    const before = await seeded.snapshot();
    const cookie = await profileCookieFor(sessions, ALICE);
    for (const userId of [ALICE.userId, BOB.userId]) {
      const res = await send(
        `/members/${ALICE.userId}`,
        jsonPatch(cookie, { ...FULL_JSON, reminder_opt_out: true, user_id: userId }),
      );
      expect(res.status, userId).toBe(422);
    }
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("the edit form renders the Event reminders switch with its stored state", async () => {
    const aliceCookie = await profileCookieFor(sessions, ALICE);
    expect(
      (
        await send(
          `/members/${ALICE.userId}`,
          jsonPatch(aliceCookie, { ...FULL_JSON, reminder_opt_out: true }),
        )
      ).status,
    ).toBe(200);
    const optedOut = await send(`/members/${ALICE.userId}`, { headers: { cookie: aliceCookie } });
    expect(optedOut.status).toBe(200);
    const outHtml = await optedOut.text();
    expect(outHtml).toContain("Event reminders");
    const outTag = inputTag(outHtml, "reminder_opt_out");
    expect(outTag, "opted-out toggle is a real input").toBeTruthy();
    expect(outTag).toContain("checked");

    const bobCookie = await profileCookieFor(sessions, BOB);
    const optedIn = await send(`/members/${BOB.userId}`, { headers: { cookie: bobCookie } });
    expect(optedIn.status).toBe(200);
    const inHtml = await optedIn.text();
    const inTag = inputTag(inHtml, "reminder_opt_out");
    expect(inTag, "opted-in toggle is a real input").toBeTruthy();
    expect(inTag).not.toContain("checked");
  });

  it("the Event reminders switch is keyboard- and screen-reader-usable", async () => {
    const cookie = await profileCookieFor(sessions, ALICE);
    const page = await send(`/members/${ALICE.userId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const tag = inputTag(html, "reminder_opt_out");
    expect(tag, "toggle is a real input").toBeTruthy();
    expect(tag).toContain('type="checkbox"');
    // Focusable: no tabindex removal, no hidden-until-hover wrapper on the control.
    expect(tag).not.toMatch(/tabindex="-1"/);
    expect(tag).not.toContain("aria-hidden");
    expect(tag).not.toContain("disabled");
    const label = labelTextFor(html, tag!);
    expect(label, "toggle has an associated label").toBeTruthy();
    expect(label!).toMatch(/remind/i);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "per-event reminder mute API + UI (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const fullEnv = () =>
      ({
        ...memberEnv,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
      }) as unknown as Env;

    const mutePath = (key: string) => `/events/${encodeURIComponent(key)}/reminder-mute`;
    const putMute = (actor: typeof MEMBER, body: Record<string, unknown>) =>
      memberCookieFor(sessions, actor).then((cookie) =>
        app.request(
          mutePath(EVENT_KEY),
          {
            method: "PUT",
            headers: {
              cookie,
              origin: APP_URL,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(body),
          },
          fullEnv(),
        ),
      );
    // Table and columns come from slice 1 (spec section 3); raw SQL keeps
    // this file decoupled from the builder's Drizzle table placement. Until
    // slice 1 lands, a missing relation reads as "no rows" so failures pin
    // slice 2 behavior instead of erroring on slice 1's absence.
    const isMissingRelation = (err: unknown): boolean =>
      typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
    const muteRows = async () => {
      try {
        return await fixture.client`select event_id, user_id from event_reminder_mutes`;
      } catch (err) {
        if (isMissingRelation(err)) return [];
        throw err;
      }
    };
    const detailHtml = async (actor?: typeof MEMBER) => {
      const headers: Record<string, string> = actor
        ? { cookie: await memberCookieFor(sessions, actor) }
        : {};
      const res = await app.request(`/e/${EVENT_KEY}`, { headers }, fullEnv());
      expect(res.status).toBe(200);
      return res.text();
    };

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      sessions = createMemorySessionStore();
      await fixture.reset();
      await fixture.client`delete from web_throttle_hits`;
      await seedMemberData(fixture.db);
      const [event] = await fixture.db.select().from(events);
      await fixture.db
        .insert(rsvps)
        .values({ eventId: event!.id, userId: MEMBER.userId, status: "going" });
    });

    it("an unauthenticated mute write is refused and writes nothing", async () => {
      const res = await app.request(
        mutePath(EVENT_KEY),
        {
          method: "PUT",
          headers: {
            origin: APP_URL,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ muted: true }),
        },
        fullEnv(),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthenticated" });
      expect(await muteRows()).toHaveLength(0);
    });

    it("a non-member mute write is refused and writes nothing", async () => {
      const res = await putMute(OUTSIDER, { muted: true });
      expect(res.status).toBe(403);
      expect(await muteRows()).toHaveLength(0);
    });

    it("the owner mutes and unmutes over PUT, effective on the next read", async () => {
      const muted = await putMute(MEMBER, { muted: true });
      expect(muted.status).toBe(200);
      expect(await muted.json()).toMatchObject({ data: { muted: true } });
      expect(await muteRows()).toHaveLength(1);

      // Immediate effect: the detail page shows the mute without delay.
      expect(inputTag(await detailHtml(MEMBER), "muted")).toContain("checked");

      const unmuted = await putMute(MEMBER, { muted: false });
      expect(unmuted.status).toBe(200);
      expect(await unmuted.json()).toMatchObject({ data: { muted: false } });
      expect(await muteRows()).toHaveLength(0);

      const tag = inputTag(await detailHtml(MEMBER), "muted");
      expect(tag, "toggle survives the round-trip").toBeTruthy();
      expect(tag).not.toContain("checked");
    });

    it("a user_id that differs from the session is refused; a matching one is ignored", async () => {
      const foreign = await putMute(MEMBER, { muted: true, user_id: OUTSIDER.userId });
      expect(foreign.status).toBe(403);
      expect(await muteRows()).toHaveLength(0);

      // The session wins: a matching user_id changes nothing about the write.
      const own = await putMute(MEMBER, { muted: true, user_id: MEMBER.userId });
      expect(own.status).toBe(200);
      expect(await muteRows()).toEqual([{ event_id: expect.any(Number), user_id: MEMBER.userId }]);
    });

    it("garbage 422s and writes nothing", async () => {
      for (const body of [{}, { muted: "maybe" }, { muted: 1 }, { muted: null }]) {
        const res = await putMute(MEMBER, body);
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect(await res.json()).toMatchObject({ error: "invalid" });
      }
      expect(await muteRows()).toHaveLength(0);
    });

    it("unknown and invalid keys 404 and write nothing", async () => {
      const unknown = await memberCookieFor(sessions, MEMBER).then((cookie) =>
        app.request(
          mutePath("01ARZ3NDEKTSV4RRFFQ69G5FAA"),
          {
            method: "PUT",
            headers: {
              cookie,
              origin: APP_URL,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ muted: true }),
          },
          fullEnv(),
        ),
      );
      expect(unknown.status).toBe(404);

      const invalid = await memberCookieFor(sessions, MEMBER).then((cookie) =>
        app.request(
          "/events/%21%21%21/reminder-mute",
          {
            method: "PUT",
            headers: {
              cookie,
              origin: APP_URL,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ muted: true }),
          },
          fullEnv(),
        ),
      );
      expect(invalid.status).toBe(404);
      expect(await muteRows()).toHaveLength(0);
    });

    it("a valid key in another letter case 308s to the canonical mute URL", async () => {
      const res = await app.request(
        mutePath(EVENT_KEY.toLowerCase()),
        {
          method: "PUT",
          headers: {
            origin: APP_URL,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ muted: true }),
        },
        fullEnv(),
      );
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(mutePath(EVENT_KEY));
      expect(await muteRows()).toHaveLength(0);
    });

    it("un-RSVP keeps the mute: a re-RSVP is still muted", async () => {
      expect((await putMute(MEMBER, { muted: true })).status).toBe(200);
      expect(await muteRows()).toHaveLength(1);

      const cookie = await memberCookieFor(sessions, MEMBER);
      const withdraw = await app.request(
        `/events/${EVENT_KEY}/rsvp`,
        { method: "DELETE", headers: { cookie, origin: APP_URL, accept: "application/json" } },
        fullEnv(),
      );
      expect(withdraw.status).toBe(204);
      // The RSVP row is gone but the preference survives: mutes are
      // preferences, not sends, and pending sends derive from live rows.
      expect(await muteRows()).toHaveLength(1);

      const again = await app.request(
        `/events/${EVENT_KEY}/rsvp`,
        {
          method: "PUT",
          headers: {
            cookie,
            origin: APP_URL,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ status: "going" }),
        },
        fullEnv(),
      );
      expect([200, 201]).toContain(again.status);
      expect(inputTag(await detailHtml(MEMBER), "muted")).toContain("checked");
    });

    it('the detail page shows "Mute reminders for this event" with its stored state', async () => {
      const fresh = await detailHtml(MEMBER);
      expect(fresh).toContain("Mute reminders for this event");
      const freshTag = inputTag(fresh, "muted");
      expect(freshTag, "unmuted toggle is a real input").toBeTruthy();
      expect(freshTag).not.toContain("checked");

      expect((await putMute(MEMBER, { muted: true })).status).toBe(200);
      const html = await detailHtml(MEMBER);
      expect(html).toContain("Mute reminders for this event");
      expect(inputTag(html, "muted")).toContain("checked");
    });

    it("the detail toggle submits to the mute route", async () => {
      const html = await detailHtml(MEMBER);
      // Form action or island wiring: either way the control must name the
      // real endpoint, or the toggle cannot work.
      expect(html).toContain(mutePath(EVENT_KEY));
    });

    it("the detail toggle is keyboard- and screen-reader-usable", async () => {
      const html = await detailHtml(MEMBER);
      const tag = inputTag(html, "muted");
      expect(tag, "toggle is a real input").toBeTruthy();
      expect(tag).toContain('type="checkbox"');
      expect(tag).not.toMatch(/tabindex="-1"/);
      expect(tag).not.toContain("aria-hidden");
      expect(tag).not.toContain("disabled");
      const label = labelTextFor(html, tag!);
      expect(label, "toggle has an associated label").toBeTruthy();
      expect(label!).toContain("Mute reminders for this event");
    });

    it("guests see no functional mute toggle", async () => {
      const html = await detailHtml();
      expect(html).not.toContain('name="muted"');
    });
  },
);
