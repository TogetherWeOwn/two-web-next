// Orthographic joiners stay accepted under RFC 5892 Appendix A.1/A.2: a
// ZWJ/ZWNJ immediately after a virama (ccc=9, Mn or Mc -- Sinhala
// RAKAARAANSAYA U+0DCA U+200D U+0DBB, Unicode 17.0 section 13.2.1 Table 13-3,
// plus Mc viramas like Balinese U+1B44, Javanese U+A9C0, Grantha U+1134D)
// and a ZWNJ between Arabic joining letters (Persian orthography). The
// shared containsControlCharacters rule exempts those contexts in every
// writer; profiles must save such text verbatim while a lone joiner between
// letters, a non-virama Mn-adjacent joiner, a Mn-adjacent ZWSP, bidi
// controls and the other targeted invisibles still refuse.
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
// Non-virama Mn plus joiner/ZWSP must still refuse: e + combining acute is
// an Mn but not a virama (ccc=9), so the contextual exemption must not fire.
const NON_VIRAMA_MN_ZWNJ = F(0x65, 0x0301, 0x200c, 0x78);
const MN_ZWSP = F(0x65, 0x0301, 0x200b);
// A virama followed by ZWSP must still refuse: the exemption covers only
// ZWJ/ZWNJ, so widening it to U+200B must turn the suite red.
const VIRAMA_ZWSP = F(0x0dca, 0x200b);
// Two accepted clusters in one value: pins every occurrence, not just the first.
const MULTI_SINHALA = `${SINHALA} ${SINHALA}`;
// RFC 5892 A.2 Persian ZWNJ: Farsi yeh/beh are Lo joining letters, not Mn.
const PERSIAN_WANT = F(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645);
// "Books": KAF + TEH + ALEF + BEH, then ZWNJ + HEH + ALEF. The old
// fixture omitted BEH and wrongly treated right-joining ALEF as a left boundary.
const PERSIAN_BOOKS = F(0x06a9, 0x062a, 0x0627, 0x0628, 0x200c, 0x0647, 0x0627);
// Mc viramas (ccc=9, General_Category Mc): Balinese, Javanese, Grantha.
const BALINESE_ZWNJ = F(0x1b13, 0x1b44, 0x200c);
const JAVANESE_ZWJ = F(0xa98f, 0xa9c0, 0x200d);
const GRANTHA_ZWJ = F(0x11315, 0x1134d, 0x200d);
// Every virama above U+1134D in the encoded VIRAMA_DELTAS table, in ascending
// order (Newa through Gurung Khema U+1612F). Pinning each one kills any tail
// edit (e.g. final delta 0x41ed -> 0x41ec retargeting U+1612F to U+1612E).
const TAIL_VIRAMAS = [
  0x113ce, 0x113cf, 0x113d0, 0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d,
  0x1193e, 0x119e0, 0x11a34, 0x11a47, 0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42,
  0x1612f,
];

const valid = { bio: "Hello", games: ["Halo"], timezone: "Europe/London" };

describe("the shared oracle exempts orthographic joiners only", () => {
  it("accepts virama-led ZWJ/ZWNJ clusters and still refuses lone joiners and bidi controls", () => {
    for (const value of [
      SINHALA,
      `a${SINHALA}b`,
      DEVANAGARI_ZWJ,
      VIRAMA_ZWNJ,
      MULTI_SINHALA,
      PERSIAN_WANT,
      PERSIAN_BOOKS,
      BALINESE_ZWNJ,
      JAVANESE_ZWJ,
      GRANTHA_ZWJ,
    ]) {
      expect(containsControlCharacters(value)).toBe(false);
    }
    for (const value of [
      LONE_ZWJ,
      LONE_ZWNJ,
      DOUBLED_JOINER,
      NON_VIRAMA_MN_ZWNJ,
      MN_ZWSP,
      VIRAMA_ZWSP,
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

  it("pins every virama above U+1134D: ZWJ/ZWNJ accepted, ZWSP still refused", () => {
    for (const cp of TAIL_VIRAMAS) {
      expect(containsControlCharacters(F(cp, 0x200d, 0x61))).toBe(false);
      expect(containsControlCharacters(F(cp, 0x200c, 0x61))).toBe(false);
      expect(containsControlCharacters(F(cp, 0x200b))).toBe(true);
    }
    // Explicit final-entry pin: the table ends at Gurung Khema U+1612F, so a
    // one-delta typo (0x41ed -> 0x41ec) retargeting U+1612E must refuse.
    expect(containsControlCharacters(F(0x1612f, 0x200d, 0x61))).toBe(false);
    expect(containsControlCharacters(F(0x1612e, 0x200d, 0x61))).toBe(true);
  });

  it("accepts multi-cluster and Persian/Mc-virama text while refusing Mn-adjacent ZWSP", () => {
    expect(validateProfile({ ...valid, bio: MULTI_SINHALA }).ok).toBe(true);
    expect(validateProfile({ ...valid, games: [PERSIAN_WANT, PERSIAN_BOOKS] }).ok).toBe(true);
    expect(validateProfile({ ...valid, games: [BALINESE_ZWNJ] }).ok).toBe(true);
    const refused = validateProfile({ ...valid, bio: `ok ${MN_ZWSP}` });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors.bio).toMatch(/invisible|directional/i);
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

it("refuses invalid joining contexts at every write boundary without persistence", async () => {
  const harness = await routeSetup();
  const family = F(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  for (const value of [F(0x0627, 0x200c, 0x0628), `${F(0x0628, 0x200c)}${family}${F(0x0628)}`]) {
    for (const response of [
      await harness.jsonPatch({ bio: value, games: ["Chess"], timezone: "UTC" }),
      await harness.formPatch({ bio: "Hi", games_text: value, timezone: "UTC" }),
      await harness.nativePost({ bio: value, games_text: "Chess", timezone: "UTC" }),
    ]) {
      expect(response.status).toBe(422);
      const body = await response.text();
      expect(body).toMatch(/invisible|directional/i);
      expect(body).not.toContain(value);
    }
  }
  expect(harness.save).not.toHaveBeenCalled();
  expect(harness.store.rows.get(memberId)).toMatchObject({ bio: "Hi", games: ["Chess"] });
});
