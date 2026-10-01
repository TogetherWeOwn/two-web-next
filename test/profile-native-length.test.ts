import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD, profileClientErrors } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const ID = "100000000000000001";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: "test-session-secret-at-least-32-bytes-long" } as Env;
const alphabets = [
  { name: "BMP", text: (length: number) => "遊".repeat(length), units: 1000 },
  { name: "astral", text: (length: number) => "🎮".repeat(length), units: 2000 },
  { name: "mixed", text: (length: number) => "遊🎮".repeat(Math.floor(length / 2)) + (length % 2 ? "遊" : ""), units: 1500 },
];
const paths = ["native POST", "island PATCH"] as const;
type Fields = { bio: string; games_text: string; timezone: string };

async function setup() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({ tokenHash: await hashToken(token), userId: ID, username: "alice", avatar: null, member: true, moderator: false, expiresAt: new Date(Date.now() + 3600_000) });
  const cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  const member = { id: ID, username: "alice", avatar: null, bio: null, games: [], timezone: null };
  const store = createMemoryProfileStore([member]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({ sessionStore: sessions, store, accessLog: async () => true, throttle: async () => ({ limited: false }) });
  const html = async () => (await app.request("/profile", { headers: { cookie } }, env)).text();
  const submit = (path: typeof paths[number], fields: Fields, trap: Record<string, string> = {}) => {
    const body = { ...fields, [PROFILE_HONEY_FIELD]: "", [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000), ...trap };
    return app.request(`/members/${ID}`, path === "native POST" ? {
      method: "POST",
      headers: { cookie, origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _method: "PATCH", ...body }).toString(),
    } : {
      method: "PATCH",
      headers: { cookie, origin: env.APP_URL, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }, env);
  };
  return { store, save, html, submit };
}

function expectCodePointForm(html: string) {
  // HTML maxlength counts UTF-16 units and can stop submission before either
  // code-point validator runs. Omitting it also lets over-limit no-JS input
  // reach the server's established errors instead of being silently truncated.
  for (const name of ["bio", "games_text"]) {
    const textarea = html.match(new RegExp(`<textarea\\b[^>]*name="${name}"[^>]*>`))?.[0];
    expect(textarea).toBeDefined();
    expect(textarea).not.toMatch(/\bmaxlength\s*=/i);
  }
  expect(html).toContain(`<form method="post" action="/members/${ID}"`);
  expect(html).toContain('name="_method" value="PATCH"');
  expect(html).toContain(`name="${PROFILE_HONEY_FIELD}" tabindex="-1" autocomplete="off"`);
  expect(html).toContain(`name="${PROFILE_OPENED_AT_FIELD}"`);
  expect(html).toContain('type="submit" data-testid="profile-save"');
  expect(html).toContain('type="reset" data-testid="profile-cancel"');
}

for (const path of paths) {
  describe(`${path}: code-point boundaries (in-memory fixtures only)`, () => {
    it.each(alphabets)("submits $name boundary values without UTF-16 truncation", async ({ text, units }) => {
      const { html, submit, store, save } = await setup();
      const bio = text(1000);
      const games = Array.from({ length: 20 }, (_, i) => String(i) + text(80 - String(i).length));
      const list = games.join("\n");
      const games_text = list + " ".repeat(1700 - [...list].length);
      const fields = { bio, games_text, timezone: "Europe/London" };
      expect([...bio]).toHaveLength(1000);
      expect(bio.length).toBe(units);
      expect([...games_text]).toHaveLength(1700);
      expect(games.every((game) => [...game].length === 80)).toBe(true);
      expectCodePointForm(await html());
      expect(profileClientErrors(fields)).toEqual({});
      const response = await submit(path, fields);
      expect(response.status).toBe(path === "native POST" ? 303 : 200);
      if (path === "native POST") expect(response.headers.get("location")).toBe(`/members/${ID}`);
      else expect(await response.json()).toEqual({ saved: true, message: "Profile saved." });
      expect(save).toHaveBeenCalledExactlyOnceWith(ID, { bio, games, timezone: "Europe/London" });
      expect(store.rows.get(ID)).toMatchObject({ bio, games });
    });

    for (const alphabet of alphabets) {
      it.each([
        { name: "bio", fields: { bio: alphabet.text(1001), games_text: "Halo", timezone: "" }, error: "Keep your bio to 1000 characters or fewer." },
        { name: "raw games text", fields: { bio: "", games_text: alphabet.text(80) + " ".repeat(1621), timezone: "" }, error: "Games list is too long." },
        { name: "game name", fields: { bio: "", games_text: alphabet.text(81), timezone: "" }, error: "Keep each game name to 80 characters or fewer." },
        { name: "game count", fields: { bio: "", games_text: Array.from({ length: 21 }, (_, i) => String(i) + alphabet.text(1)).join("\n"), timezone: "" }, error: "Add no more than 20 games." },
      ])(`rejects ${alphabet.name} over-limit $name without saving`, async ({ fields, error }) => {
        const { html, submit, save } = await setup();
        expectCodePointForm(await html());
        const response = await submit(path, fields);
        expect(response.status).toBe(422);
        if (path === "native POST") {
          const invalidHtml = await response.text();
          expect(invalidHtml).toContain(error);
          expect(invalidHtml).toContain(fields.bio);
          expect(invalidHtml).toContain(fields.games_text);
          expectCodePointForm(invalidHtml);
        } else {
          expect(await response.json()).toEqual({ errors: { [error.startsWith("Keep your bio") ? "bio" : "games"]: error } });
        }
        expect(save).not.toHaveBeenCalled();
      });
    }

    it("preserves whitespace normalization and ordered deduplication", async () => {
      const { submit, save } = await setup();
      const games = Array.from({ length: 20 }, (_, i) => `${i}🎮`);
      const fields = { bio: "  遊🎮  ", games_text: ["", ...games, ` ${games[0]} `, " "].join("\r\n"), timezone: "" };
      expect(profileClientErrors(fields)).toEqual({});
      expect((await submit(path, fields)).status).toBe(path === "native POST" ? 303 : 200);
      expect(save).toHaveBeenCalledExactlyOnceWith(ID, { bio: "遊🎮", games, timezone: null });
    });

    const noWriteCases: { fields: Fields; trap: Record<string, string>; status: number }[] = [
      { fields: { bio: "bad\u0000bio", games_text: "Halo", timezone: "" }, trap: {}, status: 422 },
      { fields: { bio: "Hello", games_text: "Halo", timezone: "" }, trap: { [PROFILE_HONEY_FIELD]: "spam" }, status: path === "native POST" ? 303 : 200 },
      { fields: { bio: "Hello", games_text: "Halo", timezone: "" }, trap: { [PROFILE_OPENED_AT_FIELD]: String(Date.now() + 60_000) }, status: path === "native POST" ? 303 : 200 },
    ];
    it.each(noWriteCases)("preserves control and honeypot no-write behavior ($status)", async ({ fields, trap, status }) => {
      const { submit, save } = await setup();
      expect((await submit(path, fields, trap)).status).toBe(status);
      expect(save).not.toHaveBeenCalled();
    });
  });
}
