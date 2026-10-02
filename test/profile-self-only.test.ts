// UserPolicy::updateProfile parity (W7, TOG-11985): PATCH /members/:user is
// self-only, proven at the HTTP layer against both store seams.
// - cross-member (member or moderator) → 403 and not one row changes, even
//   when the target has no profile row yet or does not exist;
// - self with valid fields → saved (JSON 200, form 303) and only the owner's
//   row moves;
// - guest → the site auth flow (explicit write recovery: 303 for forms, 401
//   plus the recovery link for JSON), never a 200 write;
// - unsupported fields (user_id, username, member…) → 422, nothing written.
// The Postgres backend runs only with DATABASE_URL (agent-testdb or CI).

import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { PROFILE_COPY } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import {
  createDbProfileStore,
  createMemoryProfileStore,
  type ProfileStore,
} from "../src/profiles/store";
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

const ALICE = { userId: "326474832151838721", username: "alice", member: true, moderator: false };
const BOB = { userId: "326474832151838722", username: "bob", member: true, moderator: false };
const MOD = { userId: "326474832151838723", username: "mod", member: true, moderator: true };
const OUTSIDER = {
  userId: "326474832151838724",
  username: "outsider",
  member: false,
  moderator: false,
};
const NOBODY = "326474832151838799";
type Who = typeof ALICE;

const ALICE_PROFILE = { bio: "alice original", games: ["Chess", "Go"], timezone: "Europe/London" };

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

// Alice has a profile row; Bob and the moderator are roster rows with none yet.
const memoryBackend: Backend = {
  name: "memory store",
  async seed() {
    const store = createMemoryProfileStore([
      { id: ALICE.userId, username: "alice", avatar: null, ...ALICE_PROFILE },
      { id: BOB.userId, username: "bob", avatar: null, bio: null, games: [], timezone: null },
      { id: MOD.userId, username: "mod", avatar: null, bio: null, games: [], timezone: null },
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
        { id: MOD.userId, username: "mod", member: true },
      ]);
    await db()
      .insert(profiles)
      .values({ userId: ALICE.userId, ...ALICE_PROFILE });
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

const jsonPatch = (cookie: string | null, body: Record<string, unknown>) => ({
  method: "PATCH",
  headers: {
    ...(cookie ? { cookie } : {}),
    origin: APP_URL,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(body),
});
const formPatch = (
  cookie: string | null,
  fields: Record<string, string>,
  method: "PATCH" | "POST" = "PATCH",
) => ({
  method,
  headers: {
    ...(cookie ? { cookie } : {}),
    origin: APP_URL,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams(method === "POST" ? { _method: "PATCH", ...fields } : fields),
});
const VALID = { bio: "rewritten", games: ["Doom"], timezone: "America/New_York" };
const VALID_FORM = { bio: "rewritten", games_text: "Doom", timezone: "America/New_York" };

describe.each(backends)("PATCH /members/:user is self-only ($name)", (backend) => {
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

  it("another member or a moderator gets 403 on every write shape and no row changes", async () => {
    const before = await seeded.snapshot();
    for (const who of [BOB, MOD]) {
      const cookie = await cookieFor(sessions, who);
      // Alice has a profile row, Bob/mod's peers have none, NOBODY has no user row:
      // the refusal is the same 403 either way (no existence oracle), never a 404.
      for (const target of [ALICE.userId, who === BOB ? MOD.userId : BOB.userId, NOBODY]) {
        for (const init of [
          jsonPatch(cookie, VALID),
          formPatch(cookie, VALID_FORM),
          formPatch(cookie, VALID_FORM, "POST"),
        ]) {
          const res = await send(`/members/${target}`, init);
          expect(res.status, `${who.username} → ${target} ${init.method}`).toBe(403);
          expect(await res.text()).toBe("Forbidden");
        }
      }
    }
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("a body naming the victim cannot redirect the owner's write", async () => {
    const before = await seeded.snapshot();
    const cookie = await cookieFor(sessions, BOB);
    const res = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { ...VALID, user_id: BOB.userId, id: BOB.userId }),
    );
    expect(res.status).toBe(403);
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("the owner saves valid fields over JSON and the form, and only their row moves", async () => {
    const cookie = await cookieFor(sessions, ALICE);
    const viaJson = await send(`/members/${ALICE.userId}`, jsonPatch(cookie, VALID));
    expect(viaJson.status).toBe(200);
    expect(await viaJson.json()).toEqual({ saved: true, message: PROFILE_COPY.saved });
    expect(await seeded.store.find(ALICE.userId)).toMatchObject(VALID);

    const bob = await cookieFor(sessions, BOB);
    const bobBefore = await seeded.store.find(BOB.userId);
    const viaForm = await send(
      `/members/${BOB.userId}`,
      formPatch(bob, { bio: " bob ", games_text: "Quake\nQuake", timezone: "" }, "POST"),
    );
    expect(viaForm.status).toBe(303);
    expect(viaForm.headers.get("location")).toBe(`/members/${BOB.userId}`);
    expect(await seeded.store.find(BOB.userId)).toMatchObject({
      bio: "bob",
      games: ["Quake"],
      timezone: null,
    });
    // Bob's save created his row without touching Alice's accepted values.
    expect(await seeded.store.find(ALICE.userId)).toMatchObject(VALID);
    expect(bobBefore).toMatchObject({ bio: null, games: [] });
  });

  it("a guest is sent into the site auth flow and never gets a 200 write", async () => {
    const before = await seeded.snapshot();
    const forged = "__Host-two_session=forged";
    for (const cookie of [null, forged]) {
      // JSON callers keep a 401 carrying the same recovery link, never an OAuth redirect.
      const json = await send(`/members/${ALICE.userId}`, jsonPatch(cookie, VALID));
      expect(json.status, `${cookie ?? "no cookie"} JSON`).toBe(401);
      expect(await json.json()).toEqual({
        error: "Unauthorized",
        recovery: "/auth/recover?next=%2Fprofile",
      });
      for (const init of [formPatch(cookie, VALID_FORM), formPatch(cookie, VALID_FORM, "POST")]) {
        const res = await send(`/members/${ALICE.userId}`, init);
        expect(res.status, `${cookie ?? "no cookie"} ${init.method}`).toBe(303);
        expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fprofile");
        expect(await res.text()).not.toContain("saved");
      }
    }
    expect(await seeded.snapshot()).toEqual(before);
  });

  it("a signed-in non-member is refused before any write", async () => {
    const before = await seeded.snapshot();
    const cookie = await cookieFor(sessions, OUTSIDER);
    expect((await send(`/members/${OUTSIDER.userId}`, jsonPatch(cookie, VALID))).status).toBe(403);
    expect((await send(`/members/${ALICE.userId}`, jsonPatch(cookie, VALID))).status).toBe(403);
    expect(await seeded.snapshot()).toEqual(before);
  });

  it.each([
    ["user_id", BOB.userId],
    ["userId", BOB.userId],
    ["id", BOB.userId],
    ["username", "renamed"],
    ["avatar", "abc123"],
    ["member", false],
    ["moderator", true],
    ["created_at", "2000-01-01T00:00:00Z"],
  ] as const)(
    "the owner sending unsupported field %s gets 422 and nothing is written",
    async (field, value) => {
      const before = await seeded.snapshot();
      const cookie = await cookieFor(sessions, ALICE);
      const res = await send(
        `/members/${ALICE.userId}`,
        jsonPatch(cookie, { ...VALID, [field]: value }),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        errors: { fields: "Only your bio, games and timezone can be changed." },
      });

      const form = await send(
        `/members/${ALICE.userId}`,
        formPatch(cookie, { ...VALID_FORM, [field]: String(value) }, "POST"),
      );
      expect(form.status).toBe(422);
      const html = await form.text();
      expect(html).toContain("Only your bio, games and timezone can be changed.");
      // The re-rendered form keeps the draft but never echoes the unsupported key.
      expect(html).toContain("rewritten");
      expect(html).not.toContain(`name="${field}"`);
      expect(await seeded.snapshot()).toEqual(before);
    },
  );

  it("the shipped form and island fields, including the spam-trap pair, stay accepted", async () => {
    const cookie = await cookieFor(sessions, ALICE);
    const res = await send(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, {
        bio: "island",
        games_text: "Go",
        timezone: "UTC",
        website: "",
        formOpenedAt: Date.now() - 5_000,
      }),
    );
    expect(res.status).toBe(200);
    expect(await seeded.store.find(ALICE.userId)).toMatchObject({
      bio: "island",
      games: ["Go"],
      timezone: "UTC",
    });
  });
});
