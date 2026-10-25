// Member leaderboard self-serve opt-out: the owner flips
// `leaderboard_opt_out` from the profile form; nobody else can.
// - owner PATCH (JSON or form) writes true/false, creating the profile row
//   when the roster row has none yet (upsert-safe);
// - an absent key preserves the stored choice (old clients never silently
//   opt a member back in);
// - garbage values 422 with nothing written;
// - cross-member writes (even a moderator's) stay 403;
// - the edit form renders the switch with its stored state;
// - the privacy policy names the profile switch.
import { readFileSync } from "node:fs";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { profiles, users } from "../src/db/schema";
import { POLICY_FILE } from "../src/privacy";
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
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

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

const ALICE = { userId: "326474832151838731", username: "alice", member: true, moderator: false };
const BOB = { userId: "326474832151838732", username: "bob", member: true, moderator: false };
const MOD = { userId: "326474832151838733", username: "mod", member: true, moderator: true };
type Who = typeof ALICE;

async function cookieFor(sessions: SessionStore, who: Who): Promise<string> {
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

type Seeded = { store: ProfileStore; snapshot: () => Promise<unknown> };
type Backend = {
  name: string;
  open?: () => Promise<() => Promise<void>>;
  seed: () => Promise<Seeded>;
};

// Alice and Bob have profile rows; Carol is a roster row with none yet.
const CAROL = { userId: "326474832151838734", username: "carol" };

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

let fixture: MemberDataFixture | undefined;
const db = (): Db => fixture!.db;
const postgresBackend: Backend = {
  name: "postgres store",
  async open() {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    return () => fixture!.dispose();
  },
  async seed() {
    await fixture!.reset();
    await db()
      .insert(users)
      .values([
        { id: ALICE.userId, username: "alice", member: true },
        { id: BOB.userId, username: "bob", member: true },
        { id: CAROL.userId, username: "carol", member: true },
      ]);
    await db()
      .insert(profiles)
      .values({ userId: ALICE.userId, bio: null, games: [], timezone: null });
    return {
      store: createDbProfileStore(db()),
      snapshot: async () => ({
        users: await db().select().from(users).orderBy(users.id),
        profiles: await db().select().from(profiles).orderBy(profiles.userId),
      }),
    };
  },
};

const backends = process.env.DATABASE_URL ? [memoryBackend, postgresBackend] : [memoryBackend];

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

describe("profile validation accepts the leaderboard opt-out", () => {
  it("maps booleans and form strings to the stored flag", () => {
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: true })).toEqual({
      ok: true,
      attrs: { ...FULL_JSON, bio: "bio", leaderboardOptOut: true },
    });
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: false })).toMatchObject({
      ok: true,
    });
    for (const truthy of ["1", "true", "on"]) {
      expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: truthy })).toMatchObject({
        ok: true,
        attrs: { leaderboardOptOut: true },
      });
    }
    for (const falsy of ["0", "false", "off", ""]) {
      expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: falsy })).toMatchObject({
        ok: true,
        attrs: { leaderboardOptOut: false },
      });
    }
  });

  it("leaves the stored choice alone when the key is absent", () => {
    expect(validateProfile({ ...FULL_JSON })).toEqual({
      ok: true,
      attrs: { bio: "bio", games: ["Chess"], timezone: "Europe/London" },
    });
  });

  it("reads the browser's hidden-fallback pair as one choice", () => {
    // The no-JS form pairs a hidden 0 with the checkbox, so a ticked switch
    // arrives as ["0", "1"] and an unticked one as ["0"].
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: ["0", "1"] })).toMatchObject({
      ok: true,
      attrs: { leaderboardOptOut: true },
    });
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: ["0"] })).toMatchObject({
      ok: true,
      attrs: { leaderboardOptOut: false },
    });
  });

  it("rejects garbage with a field error", () => {
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: "maybe" })).toEqual({
      ok: false,
      errors: { leaderboard_opt_out: expect.any(String) },
    });
  });
});

describe.each(backends)("owner-only leaderboard opt-out ($name)", (backend) => {
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
  const send = (path: string, init: RequestInit) => app.request(path, init, env);

  it("the owner opts out and back in over JSON", async () => {
    const cookie = await cookieFor(sessions, ALICE);
    const out = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, leaderboard_opt_out: true }),
    );
    expect(out.status).toBe(200);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: true });

    const backIn = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, leaderboard_opt_out: false }),
    );
    expect(backIn.status).toBe(200);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: false });
  });

  it("the form checkbox writes true on 1 and false on 0", async () => {
    const cookie = await cookieFor(sessions, ALICE);
    const checked = await send(
      `/members/${ALICE.userId}`,
      formPatch(cookie, { ...FULL_FORM, leaderboard_opt_out: "1" }, "POST"),
    );
    expect(checked.status).toBe(303);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: true });

    const unchecked = await send(
      `/members/${ALICE.userId}`,
      formPatch(cookie, { ...FULL_FORM, leaderboard_opt_out: "0" }, "POST"),
    );
    expect(unchecked.status).toBe(303);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: false });
  });

  it("the shipped hidden-fallback pair round-trips as one choice", async () => {
    const cookie = await cookieFor(sessions, ALICE);
    const pair = (values: string[]) => {
      const body = new URLSearchParams({ _method: "PATCH", ...FULL_FORM });
      body.delete("leaderboard_opt_out");
      for (const value of values) body.append("leaderboard_opt_out", value);
      return {
        method: "POST",
        headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body,
      };
    };
    expect((await send(`/members/${ALICE.userId}`, pair(["0", "1"]))).status).toBe(303);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: true });
    expect((await send(`/members/${ALICE.userId}`, pair(["0"]))).status).toBe(303);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: false });
  });

  it("an absent key preserves an existing opt-out", async () => {
    const cookie = await cookieFor(sessions, BOB);
    expect(
      (
        await send(
          `/members/${BOB.userId}`,
          jsonPatch(cookie, { ...FULL_JSON, leaderboard_opt_out: true }),
        )
      ).status,
    ).toBe(200);
    expect(await seeded.store.find(BOB.userId)).toMatchObject({ leaderboardOptOut: true });

    // An old client that never sends the key must not opt the member back in.
    const legacy = await send(`/members/${BOB.userId}`, jsonPatch(cookie, { ...FULL_JSON }));
    expect(legacy.status).toBe(200);
    expect(await seeded.store.find(BOB.userId)).toMatchObject({ leaderboardOptOut: true });

    const legacyForm = await send(
      `/members/${BOB.userId}`,
      formPatch(cookie, { ...FULL_FORM }, "POST"),
    );
    expect(legacyForm.status).toBe(303);
    expect(await seeded.store.find(BOB.userId)).toMatchObject({ leaderboardOptOut: true });
  });

  it("a roster row with no profile row yet is created with the choice", async () => {
    if (backend.name !== "postgres store") return;
    const carolCookie = await cookieFor(sessions, {
      userId: CAROL.userId,
      username: "carol",
      member: true,
      moderator: false,
    });
    // Carol must exist for the test below; the postgres seed already inserted her.
    const res = await send(
      `/members/${CAROL.userId}`,
      jsonPatch(carolCookie, { ...FULL_JSON, leaderboard_opt_out: true }),
    );
    expect(res.status).toBe(200);
    const rows = await db().select().from(profiles);
    expect(rows.filter((p) => p.userId === CAROL.userId)).toHaveLength(1);
    expect(rows.find((p) => p.userId === CAROL.userId)).toMatchObject({
      leaderboardOptOut: true,
    });
  });

  it("garbage 422s and writes nothing", async () => {
    const before = await seeded.snapshot();
    const cookie = await cookieFor(sessions, ALICE);
    const res = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...FULL_JSON, leaderboard_opt_out: "maybe" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "invalid",
      fields: { leaderboard_opt_out: expect.any(String) },
    });
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("another member or a moderator cannot flip someone else's switch", async () => {
    const before = await seeded.snapshot();
    const aliceCookie = await cookieFor(sessions, ALICE);
    expect(
      (
        await send(
          `/members/${ALICE.userId}`,
          jsonPatch(aliceCookie, { ...FULL_JSON, leaderboard_opt_out: true }),
        )
      ).status,
    ).toBe(200);
    for (const who of [BOB, MOD]) {
      const cookie = await cookieFor(sessions, who);
      const res = await send(
        `/members/${ALICE.userId}`,
        jsonPatch(cookie, { ...FULL_JSON, leaderboard_opt_out: false }),
      );
      expect(res.status, who.username).toBe(403);
    }
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({ leaderboardOptOut: true });
    expect(await seeded.snapshot()).not.toEqual(before);
  });

  it("the edit form renders the switch with its stored state", async () => {
    const aliceCookie = await cookieFor(sessions, ALICE);
    expect(
      (
        await send(
          `/members/${ALICE.userId}`,
          jsonPatch(aliceCookie, { ...FULL_JSON, leaderboard_opt_out: true }),
        )
      ).status,
    ).toBe(200);
    const optedOut = await send(`/members/${ALICE.userId}`, { headers: { cookie: aliceCookie } });
    expect(optedOut.status).toBe(200);
    const outHtml = await optedOut.text();
    expect(outHtml).toContain('name="leaderboard_opt_out"');
    expect(outHtml).toMatch(
      /name="leaderboard_opt_out"[^>]*checked|checked[^>]*name="leaderboard_opt_out"/,
    );

    const bobCookie = await cookieFor(sessions, BOB);
    const optedIn = await send(`/members/${BOB.userId}`, { headers: { cookie: bobCookie } });
    const inHtml = await optedIn.text();
    expect(inHtml).toContain('name="leaderboard_opt_out"');
    expect(inHtml).not.toMatch(/<input[^>]*name="leaderboard_opt_out"[^>]*checked/);
  });
});

describe("privacy policy names the profile switch", () => {
  it("the leaderboard paragraph points at the profile form", () => {
    const policy = readFileSync(POLICY_FILE, "utf8");
    const paragraph = policy
      .split(/\n\s*\n/)
      .find((block) => /member leaderboard is members-only/i.test(block));
    expect(paragraph).toBeTruthy();
    expect(paragraph!).toMatch(/switch/i);
    expect(paragraph!).toMatch(/profile/i);
  });
});
