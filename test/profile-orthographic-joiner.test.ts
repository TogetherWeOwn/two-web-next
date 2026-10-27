// Orthographic joiners stay accepted: a ZWJ/ZWNJ immediately after a
// nonspacing mark is an Indic-style conjunct control (Sinhala RAKAARAANSAYA
// U+0DCA U+200D U+0DBB, Unicode 17.0 section 13.2.1 Table 13-3), not a
// standalone invisible. The shared containsControlCharacters rule exempts
// that context in every writer; profiles must save such text verbatim while
// a lone joiner between letters, bidi controls and the other targeted
// invisibles still refuse.
//
// Special characters as explicit code points (never literal bytes: joiners
// and bidi controls are invisible in diffs).
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import { containsControlCharacters } from "../src/admin/validation";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { validateProfile } from "../src/profiles/validation";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const F = String.fromCodePoint;
// "sri" with the RAKAARAANSAYA cluster: KA + AL-LAKUNA + ZWJ + RA + AALAPILLA.
const SINHALA = F(0x0dc1, 0x0dca, 0x200d, 0x0dbb, 0x0dd3);
// Devanagari SHA + VIRAMA + ZWJ + RA: same conjunct-control shape.
const DEVANAGARI_ZWJ = F(0x0936, 0x094d, 0x200d, 0x0930);
// KA + VIRAMA + ZWNJ + SSA: an explicit-halant ZWNJ, also orthographic.
const VIRAMA_ZWNJ = F(0x0915, 0x094d, 0x200c, 0x0937);
const LONE_ZWJ = F(0x61, 0x200d, 0x62);
const LONE_ZWNJ = F(0x61, 0x200c, 0x62);
const DOUBLED_JOINER = F(0x0dca, 0x200d, 0x200d);
const BIDI_OVERRIDE = F(0x202e);
const ZWSP = F(0x200b);
const BOM = F(0xfeff);

const valid = { bio: "Hello", games: ["Halo"], timezone: "Europe/London" };

describe("the shared oracle exempts orthographic joiners only", () => {
  it("accepts virama-led ZWJ/ZWNJ clusters and still refuses lone joiners and bidi controls", () => {
    for (const value of [SINHALA, `a${SINHALA}b`, DEVANAGARI_ZWJ, VIRAMA_ZWNJ]) {
      expect(containsControlCharacters(value)).toBe(false);
    }
    for (const value of [
      LONE_ZWJ,
      LONE_ZWNJ,
      DOUBLED_JOINER,
      `a${BIDI_OVERRIDE}b`,
      `a${ZWSP}b`,
      `${BOM}Halo`,
    ]) {
      expect(containsControlCharacters(value)).toBe(true);
    }
  });
});

describe("validateProfile saves orthographic joiners verbatim", () => {
  it("accepts a Sinhala bio, JSON game and games_text line without rewriting them", () => {
    expect(validateProfile({ ...valid, bio: `I play ${SINHALA}` })).toEqual({
      ok: true,
      attrs: { ...valid, bio: `I play ${SINHALA}` },
    });
    expect(validateProfile({ ...valid, games: [SINHALA, "Chess"] })).toEqual({
      ok: true,
      attrs: { ...valid, games: [SINHALA, "Chess"] },
    });
    expect(validateProfile({ ...valid, games_text: `Chess\n${SINHALA}` })).toEqual({
      ok: true,
      attrs: { ...valid, games: ["Chess", SINHALA] },
    });
  });

  it("still refuses a bidi override riding alongside an accepted cluster", () => {
    const result = validateProfile({ ...valid, bio: `${SINHALA}${BIDI_OVERRIDE}` });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.bio).toMatch(/invisible|directional/i);
  });
});

// --- Route boundary: accepted text saves on every write shape. ---------------

const memberId = "100000000000000001";
const secret = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;

async function routeSetup() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: memberId,
    username: "alice",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, secret, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const seededRow = {
    id: memberId,
    username: "alice",
    avatar: null,
    bio: "Hi",
    games: ["Chess"],
    timezone: "UTC",
  };
  const store = createMemoryProfileStore([{ ...seededRow }]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  const jsonPatch = (obj: unknown) =>
    app.request(
      `/members/${memberId}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(obj),
      },
      env,
    );
  const formPatch = (fields: Record<string, string>) =>
    app.request(
      `/members/${memberId}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(fields).toString(),
      },
      env,
    );
  const nativePost = (fields: Record<string, string>) =>
    app.request(
      `/members/${memberId}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ _method: "PATCH", ...fields }).toString(),
      },
      env,
    );
  return { store, save, jsonPatch, formPatch, nativePost };
}

describe("profile write boundary saves orthographic joiners (in-memory fixtures only)", () => {
  it("saves a Sinhala bio and game through JSON PATCH verbatim", async () => {
    const harness = await routeSetup();
    const bio = `I play ${SINHALA}`;
    const res = await harness.jsonPatch({ bio, games: [SINHALA], timezone: "UTC" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.store.rows.get(memberId)).toMatchObject({ bio, games: [SINHALA] });
  });

  it("saves a Sinhala games_text line through form PATCH verbatim", async () => {
    const harness = await routeSetup();
    const res = await harness.formPatch({
      bio: "Hello",
      timezone: "UTC",
      games_text: `Chess\n${SINHALA}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.store.rows.get(memberId)).toMatchObject({ games: ["Chess", SINHALA] });
  });

  it("saves a Sinhala bio through the native _method=PATCH POST verbatim", async () => {
    const harness = await routeSetup();
    const bio = `I play ${SINHALA}`;
    const res = await harness.nativePost({ bio, games_text: "Chess", timezone: "UTC" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.store.rows.get(memberId)).toMatchObject({ bio });
  });
});
