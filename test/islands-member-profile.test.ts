import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import {
  MEMBER_PROFILE_ISLAND,
  POLLING,
  PROFILE_COPY,
  PROFILE_HONEY_FIELD,
  PROFILE_MIN_FILL_MS,
  PROFILE_OPENED_AT_FIELD,
  profileAvatarSrcset,
  profileClientErrors,
  profileEditVisible,
  profileFocusTarget,
  profileJoinedMonth,
  profileTrapTripped,
  profileWriteRequest,
} from "../src/islands/contracts";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const SECRET = "test-session-secret-at-least-32-bytes-long";
const env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "c",
  DISCORD_GUILD_ID: "1",
  DISCORD_INVITE_URL: "x",
  DISCORD_CLIENT_SECRET: "s",
  DISCORD_BOT_TOKEN: "b",
  SESSION_SECRET: SECRET,
} as Env;
const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const seed = (id: string, username: string) => ({
  id, username, avatar: null, bio: null, games: [], timezone: null, joinedAt: new Date("2024-03-15T00:00:00Z"),
});

async function setup() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([seed(ALICE, "alice"), seed(BOB, "bob")]);
  const app = profilesApp({ sessionStore: sessions, store, accessLog: async () => true, throttle: async () => ({ limited: false }) });
  const cookie = async (userId: string, username: string) => {
    const token = newSessionToken();
    await sessions.create({ tokenHash: await hashToken(token), userId, username, avatar: null, member: true, moderator: false, expiresAt: new Date(Date.now() + 3600_000) });
    return (await serializeSigned("__Host-two_session", token, SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  };
  return { app, store, cookie };
}

const patch = (app: ReturnType<typeof profilesApp>, id: string, cookie: string, body: Record<string, unknown>) =>
  app.request(
    `/members/${id}`,
    { method: "PATCH", headers: { cookie, "content-type": "application/json", accept: "application/json", origin: env.APP_URL }, body: JSON.stringify(body) },
    env,
  );

describe("member-profile requests fired", () => {
  it("one PATCH per save against /members/{id}", () => {
    const body = { bio: "b", games_text: "", timezone: "", website: "", formOpenedAt: 1 };
    expect(profileWriteRequest(ALICE, body)).toEqual({ method: "PATCH", url: `/members/${ALICE}`, body });
  });
  it("no polling", () => expect(POLLING[MEMBER_PROFILE_ISLAND].pollMs).toBeNull());
  it("binder sends a single PATCH and none on cancel", () => {
    const js = readFileSync("public/islands/member-profile.js", "utf8");
    expect(js.match(/fetch\(/g)?.length).toBe(1);
    expect(js).toContain('method: "PATCH"');
    expect(js).toContain('addEventListener("reset"');
  });
});

describe("member-profile states rendered", () => {
  it("client validation mirrors the server rules", () => {
    expect(profileClientErrors({ bio: "x".repeat(1001), games_text: "", timezone: "" }).bio).toBeTruthy();
    expect(profileClientErrors({ bio: "", games_text: "a".repeat(81), timezone: "" }).games).toBeTruthy();
    expect(profileClientErrors({ bio: "", games_text: Array.from({ length: 21 }, (_, i) => `g${i}`).join("\n"), timezone: "" }).games).toBeTruthy();
    expect(profileClientErrors({ bio: "", games_text: "a\na\n a ", timezone: "" })).toEqual({});
    expect(profileClientErrors({ bio: "", games_text: "", timezone: "Mars/Base" }).timezone).toBeTruthy();
    expect(profileClientErrors({ bio: "a\u0007", games_text: "", timezone: "" }).control).toBeTruthy();
  });
  it("binder carries every state's copy", () => {
    const js = readFileSync("public/islands/member-profile.js", "utf8");
    for (const c of [PROFILE_COPY.saved, PROFILE_COPY.saveFailed, PROFILE_COPY.sessionExpired, PROFILE_COPY.logIn]) expect(js).toContain(c);
    for (const t of ["profile-saved", "profile-error", "profile-save-failed", "profile-session-expired"]) expect(js).toContain(t);
  });
  it("focus targets per outcome", () => {
    expect(profileFocusTarget("saved")).toBe("profile-saved");
    expect(profileFocusTarget("invalid")).toBe("profile-error");
    expect(profileFocusTarget("failed")).toBe("profile-save-failed");
    expect(profileFocusTarget("session-expired")).toBe("profile-session-expired");
    expect(profileFocusTarget("cancelled")).toBe("profile-name");
  });
  it("avatar: CDN srcset or null for the initial fallback; joined month", () => {
    expect(profileAvatarSrcset(ALICE, "abc")?.srcset).toContain("size=256 3x");
    expect(profileAvatarSrcset(ALICE, "../x")).toBeNull();
    expect(profileJoinedMonth(new Date("2024-03-15T00:00:00Z"))).toBe("March 2024");
  });
  it("SSR view: avatar fallback, name, joined month, honeypot + opened-at", async () => {
    const { app, cookie } = await setup();
    const html = await (await app.request("/profile", { headers: { cookie: await cookie(ALICE, "alice") } }, env)).text();
    expect(html).toContain('data-testid="profile-avatar"');
    expect(html).toContain("Joined March 2024");
    expect(html).toContain(`data-island="${MEMBER_PROFILE_ISLAND}"`);
    expect(html).toContain(`name="${PROFILE_HONEY_FIELD}"`);
    expect(html).toContain(`name="${PROFILE_OPENED_AT_FIELD}"`);
    expect(html).toContain("/islands/member-profile.js");
  });
});

describe("member-profile exposure rule", () => {
  it("edit control only for the owner", async () => {
    expect(profileEditVisible(ALICE, ALICE)).toBe(true);
    expect(profileEditVisible(ALICE, BOB)).toBe(false);
    const { app, cookie } = await setup();
    const html = await (await app.request(`/members/${BOB}`, { headers: { cookie: await cookie(ALICE, "alice") } }, env)).text();
    expect(html).toContain("bob");
    expect(html).not.toContain("data-testid=\"profile-form\"");
    expect(html).not.toContain(`name="${PROFILE_HONEY_FIELD}"`);
  });
});

describe("member-profile spam trap", () => {
  const valid = { bio: "hi", games_text: "Halo", timezone: "Europe/London" };
  it("trap verdict rules", () => {
    const now = 10_000;
    expect(profileTrapTripped({ [PROFILE_HONEY_FIELD]: "x" }, now)).toBe(true);
    expect(profileTrapTripped({ [PROFILE_OPENED_AT_FIELD]: now - PROFILE_MIN_FILL_MS + 1 }, now)).toBe(true);
    expect(profileTrapTripped({ [PROFILE_OPENED_AT_FIELD]: now - PROFILE_MIN_FILL_MS }, now)).toBe(false);
    expect(profileTrapTripped({ [PROFILE_HONEY_FIELD]: "" }, now)).toBe(false);
    expect(profileTrapTripped({}, now)).toBe(false);
  });
  it("tripped and real saves answer identically; only the real one writes; nothing is logged", async () => {
    const { app, store, cookie } = await setup();
    const c = await cookie(ALICE, "alice");
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a) => void errors.push(a);
    try {
      const trapped = await patch(app, ALICE, c, { ...valid, website: "http://spam", formOpenedAt: Date.now() - 5000 });
      expect(store.rows.get(ALICE)!.bio).toBeNull();
      const fast = await patch(app, ALICE, c, { ...valid, website: "", formOpenedAt: Date.now() });
      expect(store.rows.get(ALICE)!.bio).toBeNull();
      const real = await patch(app, ALICE, c, { ...valid, website: "", formOpenedAt: Date.now() - 5000 });
      expect(store.rows.get(ALICE)!.bio).toBe("hi");
      for (const r of [trapped, fast, real]) {
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ saved: true, message: "Profile saved." });
      }
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual([]);
  });
  it("validation errors surface first, even when the trap is tripped", async () => {
    const { app, store, cookie } = await setup();
    const r = await patch(app, ALICE, await cookie(ALICE, "alice"), { bio: "x".repeat(1001), website: "spam", formOpenedAt: Date.now() });
    expect(r.status).toBe(422);
    expect((await r.json()) as { errors: object }).toHaveProperty("errors.bio");
    expect(store.rows.get(ALICE)!.bio).toBeNull();
  });
});
