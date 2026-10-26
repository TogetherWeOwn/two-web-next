// Acceptance oracle: profile bio and game names refuse bidi controls and
// targeted invisible format characters, exactly like every admin/machine
// writer already does through the shared containsControlCharacters rule
// (src/admin/validation-shared.ts).
//
// Today validateProfile refuses only C0/DEL control characters through a
// profile-local regex, so a member can store a right-to-left-override or
// zero-width-laden bio/game name that no moderator tool would accept — a
// spoofing / moderation-evasion hole on public profiles.
//
// Contract notes for the implementer (Builder):
// - validateProfile must apply the EXISTING shared containsControlCharacters
//   rule to the RAW bio and to each RAW game entry (JSON `games` entries and
//   each `games_text` line), checked BEFORE trim/blank-dropping, replacing
//   the profile-local C0/DEL regex. No second character-class copy: the
//   exhaustive BMP agreement sweep below pins validateProfile to the oracle's
//   verdict on every BMP code point, so a copied-but-drifting class fails.
// - Refusals keep the current field-error shape (`bio` / `games` keys, no
//   persistable attrs) with a member-readable message naming invisible or
//   directional characters. The literal wording is free (the shared admin
//   copy "Remove control or invisible characters." satisfies the pin); the
//   message must never contain the rejected input.
// - Intentional existing-suite contract changes for the Builder (behavior of
//   C0/DEL refusals does not move; only the points below do):
//   1. The accepted-characters list in test/profile-control-validation.test.ts
//      ("accepts Unicode and permitted whitespace") contains U+0085 and a
//      lone U+200D between letters. Under the shared rule both are refusals
//      (C1 control; non-emoji joiner), so those two entries leave that list.
//      Tab/LF/CR, NBSP, U+2028/U+2029, astral emoji and CJK stay accepted.
//   2. If the refusal copy changes to name invisible/directional characters,
//      the exact old-copy ("Remove control characters.") assertions in
//      test/profile-control-validation.test.ts and
//      test/profile-nul-rejection.test.ts move to the new copy.
// - The browser mirror profileClientErrors (src/islands/contracts-member-
//   profile.ts) is NOT pinned here: the build card lets the Builder align it
//   or name it advisory-only in the PR. Server validation is the authority,
//   which is what the route-boundary suite below pins. Its ASCII agreement
//   with the server is unaffected (the oracle agrees with the old rule on
//   all of ASCII).
// - Length, count, dedupe, games_text splitting and games_text-over-JSON
//   precedence are unchanged. Previously stored text is not rewritten; a
//   stored value that now refuses gets the same field error on next save,
//   with no silent strip and no save.
// - Username/display-name (Discord-owned), timezone and website are out of
//   scope and unpinned here.
//
// Production change that makes these fail: keeping any profile-local
// character class, checking after trim (a leading/trailing U+FEFF or a
// blank-after-trim game entry would slip through), or silently stripping
// the offending characters instead of refusing.
//
// Hermetic: pure validator pins plus the real profilesApp over in-memory
// stores (no DB), synthetic rows only.
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import { containsControlCharacters } from "../src/admin/validation";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { validateProfile } from "../src/profiles/validation";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// Special characters as explicit code points (never literal bytes: bidi and
// zero-width characters are invisible in diffs).
const BIDI_OVERRIDE = String.fromCodePoint(0x202e); // U+202E right-to-left override
const BIDI_ISOLATE = String.fromCodePoint(0x2066); // U+2066 left-to-right isolate
const ZWSP = String.fromCodePoint(0x200b); // U+200B zero-width space
const BOM = String.fromCodePoint(0xfeff); // U+FEFF byte order mark / ZWNBSP
const NUL = String.fromCodePoint(0x00);
const BEL = String.fromCodePoint(0x07);
const DEL = String.fromCodePoint(0x7f);
// Family: man + ZWJ + woman + ZWJ + girl + ZWJ + boy — a genuine multi-person
// emoji ZWJ sequence the shared rule admits.
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466);
const WOMAN_TECHNOLOGIST = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);

const NAMED = [
  { label: "bidi override U+202E", char: BIDI_OVERRIDE },
  { label: "bidi isolate U+2066", char: BIDI_ISOLATE },
  { label: "zero-width space U+200B", char: ZWSP },
  { label: "BOM U+FEFF", char: BOM },
] as const;

const MESSAGE_NAMES_THE_CLASS = /invisible|directional/i;

const valid = { bio: "Hello", games: ["Halo"], timezone: "Europe/London" };

const shapes = [
  { name: "bio", field: "bio", input: (value: string) => ({ ...valid, bio: value }) },
  { name: "JSON games", field: "games", input: (value: string) => ({ ...valid, games: [value] }) },
  {
    name: "games_text",
    field: "games",
    input: (value: string) => ({ ...valid, games_text: value }),
  },
] as const;

type Result = ReturnType<typeof validateProfile>;

function expectRefusal(result: Result, field: string, offending?: string): void {
  expect(result.ok, "expected profile validation to fail").toBe(false);
  if (result.ok) return;
  expect(Object.keys(result.errors)).toEqual([field]);
  const message = result.errors[field as keyof typeof result.errors];
  expect(typeof message).toBe("string");
  expect(message).toMatch(MESSAGE_NAMES_THE_CLASS);
  if (offending) expect(message).not.toContain(offending);
}

describe("the shared oracle itself (spec sanity)", () => {
  it("refuses each named character on raw text and admits genuine emoji ZWJ sequences", () => {
    for (const { char } of NAMED) {
      expect(containsControlCharacters(`a${char}b`)).toBe(true);
      expect(containsControlCharacters(`${char}Halo`)).toBe(true);
    }
    // Only the BOM is trim-hidden; that is why the raw check matters.
    expect(`${BOM}Halo`.trim()).toBe("Halo");
    expect(containsControlCharacters(`${BOM}Halo`.trim())).toBe(false);
    expect(containsControlCharacters(FAMILY)).toBe(false);
    expect(containsControlCharacters(`Hosted by ${WOMAN_TECHNOLOGIST} tonight`)).toBe(false);
  });
});

describe("validateProfile refuses bidi and invisible format characters (raw, pre-trim)", () => {
  for (const shape of shapes) {
    describe(shape.name, () => {
      it.each(NAMED)("refuses $label as sole/leading/interior/trailing text", ({ char }) => {
        for (const value of [char, `${char}Halo`, `Ha${char}lo`, `Halo${char}`]) {
          expectRefusal(validateProfile(shape.input(value)), shape.field, char);
        }
      });

      it.each(NAMED)("refuses $label behind or between ordinary spaces", ({ char }) => {
        // Spaces alone trim away; the raw entry must still refuse, never be
        // silently cleaned into an accepted value.
        for (const value of [` ${char}Halo`, `Halo${char} `, ` ${char} `]) {
          expectRefusal(validateProfile(shape.input(value)), shape.field, char);
        }
      });
    });
  }

  it("refuses a BOM-only bio instead of trimming it to an accepted empty bio", () => {
    expectRefusal(validateProfile({ ...valid, bio: BOM }), "bio", BOM);
    expectRefusal(validateProfile({ ...valid, bio: ` \t${BOM}\r\n ` }), "bio", BOM);
  });

  it("refuses a blank-after-trim JSON game entry carrying a BOM instead of dropping it", () => {
    expectRefusal(validateProfile({ ...valid, games: ["Halo", ` ${BOM} `] }), "games", BOM);
  });

  it("refuses an offending second JSON game entry (every raw entry is checked)", () => {
    for (const { char } of NAMED) {
      expectRefusal(validateProfile({ ...valid, games: ["Halo", `Che${char}ss`] }), "games", char);
    }
  });

  it("refuses an offending later games_text line (every raw line is checked)", () => {
    for (const { char } of NAMED) {
      expectRefusal(validateProfile({ ...valid, games_text: `Halo\nChe${char}ss` }), "games", char);
    }
  });

  it("refuses a BOM-only games_text line between valid lines instead of dropping it", () => {
    expectRefusal(validateProfile({ ...valid, games_text: `Halo\n${BOM}\nChess` }), "games", BOM);
    expectRefusal(validateProfile({ ...valid, games_text: `${BOM}Halo\r\nChess` }), "games", BOM);
  });

  it("names both fields when bio and games each carry a refused character", () => {
    const result = validateProfile({
      ...valid,
      bio: `bad${BIDI_OVERRIDE}bio`,
      games: [`bad${ZWSP}game`],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["bio", "games"]);
    expect(result.errors.bio).toMatch(MESSAGE_NAMES_THE_CLASS);
    expect(result.errors.games).toMatch(MESSAGE_NAMES_THE_CLASS);
  });

  it("keeps games_text precedence: an offending JSON array is ignored when games_text is clean", () => {
    expect(
      validateProfile({ ...valid, games: [`bad${BIDI_OVERRIDE}`], games_text: "Halo" }),
    ).toEqual({ ok: true, attrs: valid });
    expectRefusal(
      validateProfile({ ...valid, games: ["Halo"], games_text: `bad${BIDI_ISOLATE}` }),
      "games",
      BIDI_ISOLATE,
    );
  });

  it("refuses at-limit text whose last character is a bidi override (length alone passes)", () => {
    expectRefusal(
      validateProfile({ ...valid, bio: `${"x".repeat(999)}${BIDI_OVERRIDE}` }),
      "bio",
      BIDI_OVERRIDE,
    );
    expectRefusal(
      validateProfile({ ...valid, games: [`${"x".repeat(79)}${ZWSP}`] }),
      "games",
      ZWSP,
    );
  });

  it("still refuses the existing C0/DEL pins", () => {
    for (const shape of shapes) {
      for (const char of [NUL, BEL, DEL]) {
        expectRefusal(validateProfile(shape.input(`a${char}b`)), shape.field, char);
      }
    }
  });
});

describe("validateProfile agrees with the shared oracle (no second character class)", () => {
  it("matches containsControlCharacters on every BMP code point, interior in bio and in a game", () => {
    const bioMismatches: string[] = [];
    const gameMismatches: string[] = [];
    let bioCount = 0;
    let gameCount = 0;
    const record = (list: string[], cp: number) => {
      if (list.length < 25) list.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    };
    for (let cp = 0; cp <= 0xffff; cp++) {
      const value = `a${String.fromCodePoint(cp)}b`;
      const expectedOk = !containsControlCharacters(value);
      if (validateProfile({ bio: value, games: ["Halo"], timezone: "" }).ok !== expectedOk) {
        bioCount++;
        record(bioMismatches, cp);
      }
      if (validateProfile({ bio: "Hello", games: [value], timezone: "" }).ok !== expectedOk) {
        gameCount++;
        record(gameMismatches, cp);
      }
    }
    expect({ bioCount, bioMismatches, gameCount, gameMismatches }).toEqual({
      bioCount: 0,
      bioMismatches: [],
      gameCount: 0,
      gameMismatches: [],
    });
  });

  it("matches containsControlCharacters on astral samples", () => {
    for (const cp of [0x10000, 0x1f3ae, 0x1f600, 0xe0001, 0xe01ef, 0x10ffff]) {
      const value = `a${String.fromCodePoint(cp)}b`;
      const expectedOk = !containsControlCharacters(value);
      expect(validateProfile({ ...valid, bio: value }).ok).toBe(expectedOk);
      expect(validateProfile({ ...valid, games: [value] }).ok).toBe(expectedOk);
    }
  });
});

describe("validateProfile keeps accepting what the shared rule admits (controls)", () => {
  it.each(shapes)(
    "accepts a genuine multi-person emoji ZWJ sequence in $name verbatim",
    (shape) => {
      const bioOrGame = shape.field === "bio" ? `We are ${FAMILY} gamers` : FAMILY;
      const result = validateProfile(shape.input(bioOrGame));
      expect(result).toEqual({
        ok: true,
        attrs: shape.field === "bio" ? { ...valid, bio: bioOrGame } : { ...valid, games: [FAMILY] },
      });
    },
  );

  it("accepts emoji ZWJ text with tab/LF/CR in the bio verbatim", () => {
    const bio = `Hosted by ${WOMAN_TECHNOLOGIST}\nline two\r\nline three\twith a tab`;
    expect(validateProfile({ ...valid, bio })).toEqual({ ok: true, attrs: { ...valid, bio } });
  });

  it("still accepts NBSP, Unicode line/paragraph separators, accents and CJK", () => {
    for (const char of [
      String.fromCodePoint(0x00a0),
      String.fromCodePoint(0x2028),
      String.fromCodePoint(0x2029),
    ]) {
      const value = `a${char}b`;
      expect(validateProfile({ ...valid, bio: value }).ok).toBe(true);
      expect(validateProfile({ ...valid, games: [value] }).ok).toBe(true);
    }
    expect(validateProfile({ ...valid, bio: "Café 遊戲 🎮" })).toEqual({
      ok: true,
      attrs: { ...valid, bio: "Café 遊戲 🎮" },
    });
  });

  it("still accepts empty/blank bio and games as empty, not as refusals", () => {
    expect(validateProfile({ ...valid, bio: "", games: [] })).toEqual({
      ok: true,
      attrs: { ...valid, bio: null, games: [] },
    });
    expect(validateProfile({ ...valid, bio: " \t\r\n ", games_text: " \n\t " })).toEqual({
      ok: true,
      attrs: { ...valid, bio: null, games: [] },
    });
  });

  it("keeps dedupe and trimming of genuinely valid games unchanged", () => {
    expect(validateProfile({ ...valid, games: [" Halo ", "Halo", FAMILY] })).toEqual({
      ok: true,
      attrs: { ...valid, games: ["Halo", FAMILY] },
    });
  });
});

// --- Route boundary: 422 field shape, no save, no silent strip. -------------

const memberId = "100000000000000001";
const secret = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;

async function routeSetup(
  seed: { bio: string | null; games: string[]; timezone: string | null } = {
    bio: "Hi",
    games: ["Chess"],
    timezone: "UTC",
  },
) {
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
  const seededRow = { id: memberId, username: "alice", avatar: null, ...seed };
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
  return { store, save, seededRow, jsonPatch, formPatch };
}

describe("profile write boundary refuses bidi/invisible text (in-memory fixtures only)", () => {
  it("answers a JSON PATCH with a bidi override in bio as a bio-naming 422 and never saves", async () => {
    const harness = await routeSetup();
    const res = await harness.jsonPatch({
      bio: `bad${BIDI_OVERRIDE}bio`,
      games: ["Chess"],
      timezone: "UTC",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe("invalid");
    expect(Object.keys(body.fields)).toEqual(["bio"]);
    expect(body.fields.bio).toMatch(MESSAGE_NAMES_THE_CLASS);
    // The rejected input is never reflected in the refusal.
    expect(JSON.stringify(body)).not.toContain(BIDI_OVERRIDE);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.store.rows.get(memberId)).toEqual(harness.seededRow);
  });

  it("answers a JSON PATCH with a zero-width second game as a games-naming 422 and never saves", async () => {
    const harness = await routeSetup();
    const res = await harness.jsonPatch({
      bio: "Hello",
      games: ["Chess", `G${ZWSP}o`],
      timezone: "UTC",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe("invalid");
    expect(Object.keys(body.fields)).toEqual(["games"]);
    expect(body.fields.games).toMatch(MESSAGE_NAMES_THE_CLASS);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.store.rows.get(memberId)).toEqual(harness.seededRow);
  });

  it("answers a form PATCH with a BOM-led games_text line as a games-naming 422 and never saves", async () => {
    const harness = await routeSetup();
    const res = await harness.formPatch({
      bio: "Hello",
      timezone: "UTC",
      games_text: `Chess\n${BOM}Go`,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe("invalid");
    expect(Object.keys(body.fields)).toEqual(["games"]);
    expect(body.fields.games).toMatch(MESSAGE_NAMES_THE_CLASS);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.store.rows.get(memberId)).toEqual(harness.seededRow);
  });

  it("handles a previously stored now-refused bio on next save: same 422, row untouched, no strip", async () => {
    const legacyBio = `Legacy${BIDI_OVERRIDE}bio`;
    const harness = await routeSetup({ bio: legacyBio, games: ["Chess"], timezone: "UTC" });
    // The member resubmits the stored bio unchanged while editing the timezone.
    const res = await harness.jsonPatch({
      bio: legacyBio,
      games: ["Chess"],
      timezone: "Europe/London",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(Object.keys(body.fields)).toEqual(["bio"]);
    expect(body.fields.bio).toMatch(MESSAGE_NAMES_THE_CLASS);
    expect(harness.save).not.toHaveBeenCalled();
    // Stored text is neither rewritten nor silently cleaned: the row is the
    // seeded row byte-for-byte, legacy bio and old timezone included.
    expect(harness.store.rows.get(memberId)).toEqual(harness.seededRow);
  });

  it("still saves a genuine multi-person emoji ZWJ bio and game verbatim", async () => {
    const harness = await routeSetup();
    const bio = `We are ${FAMILY} gamers`;
    const res = await harness.jsonPatch({ bio, games: [FAMILY], timezone: "UTC" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.store.rows.get(memberId)).toMatchObject({ bio, games: [FAMILY] });
  });
});
