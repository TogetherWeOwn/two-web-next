import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profileClientErrors } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { validateProfile } from "../src/profiles/validation";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const forbidden = [
  ...Array.from({ length: 9 }, (_, i) => i),
  0x0b,
  0x0c,
  ...Array.from({ length: 18 }, (_, i) => 0x0e + i),
  0x7f,
].map((code) => String.fromCodePoint(code));
const valid = { bio: "Hello", games: ["Halo"], timezone: "Europe/London" };
const unicodeBreaks = String.fromCodePoint(0x2028, 0x2029);
const shapes = [
  { name: "bio", field: "bio", input: (value: string) => ({ ...valid, bio: value }) },
  { name: "JSON games", field: "games", input: (value: string) => ({ ...valid, games: [value] }) },
  {
    name: "games_text",
    field: "games",
    input: (value: string) => ({ ...valid, games_text: value }),
  },
];

describe("profile control-character validation", () => {
  it.each(shapes)(
    "rejects every forbidden control in $name before normalization",
    ({ field, input }) => {
      for (const control of forbidden) {
        // Edge-only controls include VT/FF, which trim() would otherwise discard.
        for (const value of [control, `${control}Halo`, `Ha${control}lo`, `Halo${control}`]) {
          expect(validateProfile(input(value))).toEqual({
            ok: false,
            errors: { [field]: "Remove control characters." },
          });
        }
      }
    },
  );

  it("reports both fields without returning persistable attributes", () => {
    expect(validateProfile({ ...valid, bio: "bad\u0000bio", games: ["bad\u007fgame"] })).toEqual({
      ok: false,
      errors: { bio: "Remove control characters.", games: "Remove control characters." },
    });
  });

  it("matches the browser contract for every ASCII character", () => {
    for (let code = 0; code <= 0x7f; code++) {
      const value = `a${String.fromCodePoint(code)}b`;
      const client = profileClientErrors({ bio: value, games_text: value, timezone: "" });
      for (const shape of shapes) {
        expect(validateProfile(shape.input(value)).ok).toBe(!client.control);
      }
    }
  });

  it.each(shapes)("accepts Unicode and permitted whitespace in $name", ({ input }) => {
    for (const character of ["\t", "\n", "\r", "\r\n", "\u0085", " ", " ", " ", "‍", "🎮", "遊"]) {
      const value = `a${character}b`;
      expect(profileClientErrors({ bio: value, games_text: value, timezone: "" })).toEqual({});
      expect(validateProfile(input(value)).ok).toBe(true);
    }
  });

  it("preserves bio trimming and interior tabs/newlines/Unicode line separators", () => {
    const bio = "Hello\t世界\r\n🎮 next line";
    expect(validateProfile({ ...valid, bio: ` \t${bio}\r\n ` })).toEqual({
      ok: true,
      attrs: { ...valid, bio },
    });
    expect(validateProfile({ ...valid, bio: ` \t\r\n${unicodeBreaks} ` })).toEqual({
      ok: true,
      attrs: { ...valid, bio: null },
    });
  });

  it("preserves CR/LF splitting, trimming, blanks and ordered de-duplication", () => {
    const games = ["Halo", "遊戲🎮", "Team\tGame", `a${unicodeBreaks}b`];
    const normalized = { ok: true, attrs: { ...valid, games } };
    expect(
      validateProfile({ ...valid, games: [" Halo ", "", "\t", "Halo", ...games.slice(1)] }),
    ).toEqual(normalized);
    expect(
      validateProfile({
        ...valid,
        games_text: ` Halo \r\n\rHalo\n \n${games.slice(1).join("\r")}`,
      }),
    ).toEqual(normalized);
    expect(validateProfile({ ...valid, games_text: ` \t\r\n${unicodeBreaks} ` })).toEqual({
      ok: true,
      attrs: { ...valid, games: [] },
    });
  });

  it("keeps games_text precedence over the JSON array", () => {
    expect(validateProfile({ ...valid, games: ["bad\u0000"], games_text: "Halo" })).toEqual({
      ok: true,
      attrs: valid,
    });
    expect(validateProfile({ ...valid, games_text: "bad\u0000" })).toEqual({
      ok: false,
      errors: { games: "Remove control characters." },
    });
  });

  it("keeps Unicode code-point length and normalized list boundaries", () => {
    const bio = "🎮".repeat(1000);
    const game = "🎮".repeat(80);
    for (const gamesInput of [{ games: [` ${game} `] }, { games_text: ` ${game} ` }]) {
      expect(validateProfile({ ...valid, ...gamesInput, bio })).toEqual({
        ok: true,
        attrs: { ...valid, bio, games: [game] },
      });
    }
    expect(validateProfile({ ...valid, bio: `${bio}🎮` })).toEqual({
      ok: false,
      errors: { bio: "Keep your bio to 1000 characters or fewer." },
    });
    for (const gamesInput of [{ games: [`${game}🎮`] }, { games_text: `${game}🎮` }]) {
      expect(validateProfile({ ...valid, ...gamesInput })).toEqual({
        ok: false,
        errors: { games: "Keep each game name to 80 characters or fewer." },
      });
    }
    const games = Array.from({ length: 20 }, (_, i) => `game${i}`);
    for (const gamesInput of [
      { games: [...games, games[0], " "] },
      { games_text: [...games, games[0], " "].join("\n") },
    ]) {
      expect(validateProfile({ ...valid, ...gamesInput })).toEqual({
        ok: true,
        attrs: { ...valid, games },
      });
    }
    expect(validateProfile({ ...valid, games: [...games, "extra"] })).toEqual({
      ok: false,
      errors: { games: "Add no more than 20 games." },
    });
    // 20 unique 80-code-point names + 19 CRLFs + padding = existing 1700 limit.
    const gamesText = games.map((_, i) => `${i}${"🎮".repeat(80 - String(i).length)}`).join("\r\n");
    const atLimit = gamesText + " ".repeat(1700 - [...gamesText].length);
    expect(validateProfile({ ...valid, games_text: atLimit }).ok).toBe(true);
    expect(validateProfile({ ...valid, games_text: `${atLimit} ` })).toEqual({
      ok: false,
      errors: { games: "Games list is too long." },
    });
  });

  it("keeps existing type checks and timezone behavior", () => {
    expect(validateProfile({ ...valid, bio: 1, games: [1], timezone: 1 })).toEqual({
      ok: false,
      errors: {
        bio: "Bio must be text.",
        games: "Each game must be text.",
        timezone: "Timezone must be text.",
      },
    });
    expect(validateProfile({ ...valid, games: "Halo" })).toEqual({
      ok: false,
      errors: { games: "Games must be a list." },
    });
    for (const timezone of ["", null]) {
      expect(validateProfile({ ...valid, timezone })).toEqual({
        ok: true,
        attrs: { ...valid, timezone: null },
      });
    }
    expect(validateProfile({ ...valid, timezone: "UTC" })).toEqual({
      ok: true,
      attrs: { ...valid, timezone: "UTC" },
    });
    expect(validateProfile({ ...valid, timezone: "Mars/Base" })).toEqual({
      ok: false,
      errors: { timezone: "Choose a valid IANA timezone, e.g. Europe/London." },
    });
  });
});

describe("profile write boundary (in-memory fixtures only)", () => {
  it.each(shapes)(
    "returns 422 for NUL in $name without calling persistence",
    async ({ field, input }) => {
      const id = "100000000000000001";
      const secret = "test-session-secret-at-least-32-bytes-long";
      const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;
      const sessions = createMemorySessionStore();
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: id,
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
      const store = createMemoryProfileStore([{ id, username: "alice", avatar: null, ...valid }]);
      const save = vi.spyOn(store, "save");
      const app = profilesApp({
        sessionStore: sessions,
        store,
        accessLog: async () => true,
        throttle: async () => ({ limited: false }),
      });
      const response = await app.request(
        `/members/${id}`,
        {
          method: "PATCH",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(input("bad\u0000value")),
        },
        env,
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ errors: { [field]: "Remove control characters." } });
      expect(save).not.toHaveBeenCalled();
      expect(store.rows.get(id)).toEqual({ id, username: "alice", avatar: null, ...valid });
    },
  );
});
