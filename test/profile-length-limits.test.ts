// Route-level length limits for profile saves: bio at most 1000 characters,
// each game name at most 80, at most 20 games (characters count as Unicode
// code points). Overlong input is refused with a 422 naming the field and
// its limit, nothing is saved, and the refusal is identical for direct
// PATCH requests and native `_method=PATCH` form POSTs. The games_text
// spelling of the list is pinned by the profile native-length suite; this
// suite pins the JSON games array at the route, combined-field refusals,
// multipart forms, and admission precedence under overlong payloads.
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const secret = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;
const seeded = {
  id: ALICE,
  username: "alice",
  avatar: null,
  bio: "Hi",
  games: ["Chess"],
  timezone: "UTC",
};

const bioAtLimit = "🎮".repeat(1000);
const bioOverLimit = "🎮".repeat(1001);
const gameAtLimit = "🎮".repeat(80);
const gameOverLimit = "🎮".repeat(81);
const gamesAtLimit = Array.from({ length: 20 }, (_, i) => `game${i}`);
const gamesOverLimit = Array.from({ length: 21 }, (_, i) => `game${i}`);
const BIO_ERROR = "Keep your bio to 1000 characters or fewer.";
const GAME_NAME_ERROR = "Keep each game name to 80 characters or fewer.";
const GAME_COUNT_ERROR = "Add no more than 20 games.";

async function setup(options: { limited?: boolean } = {}) {
  const sessions = createMemorySessionStore();
  const cookieFor = async (userId: string, username: string) => {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId,
      username,
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, secret, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };
  const aliceCookie = await cookieFor(ALICE, "alice");
  const bobCookie = await cookieFor(BOB, "bob");
  const store = createMemoryProfileStore([{ ...seeded }]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () =>
      options.limited ? { limited: true, retryAfter: 17 } : { limited: false },
  });
  const send = (
    target: string,
    cookie: string,
    method: string,
    body: BodyInit,
    contentType: string | null,
    accept: string,
  ) =>
    app.request(
      `/members/${target}`,
      {
        method,
        headers: {
          cookie,
          origin: env.APP_URL,
          ...(contentType ? { "content-type": contentType } : {}),
          accept,
        },
        body,
      },
      env,
    );
  const jsonPatch = (body: unknown, target = ALICE, cookie = aliceCookie) =>
    send(target, cookie, "PATCH", JSON.stringify(body), "application/json", "application/json");
  const formPost = (fields: Record<string, string>, accept = "text/html") =>
    send(
      ALICE,
      aliceCookie,
      "POST",
      new URLSearchParams({ _method: "PATCH", ...fields }).toString(),
      "application/x-www-form-urlencoded",
      accept,
    );
  return { store, save, send, jsonPatch, formPost, aliceCookie, bobCookie };
}

describe("profile length limits at the route (in-memory fixtures only)", () => {
  it.each([
    {
      name: "bio over 1000",
      body: { bio: bioOverLimit, games: ["Chess"] },
      errors: { bio: BIO_ERROR },
    },
    {
      name: "a JSON array game name over 80",
      body: { bio: "a", games: [gameOverLimit] },
      errors: { games: GAME_NAME_ERROR },
    },
    {
      name: "a JSON array of 21 games",
      body: { bio: "a", games: gamesOverLimit },
      errors: { games: GAME_COUNT_ERROR },
    },
    {
      name: "bio and games over their limits together",
      body: { bio: bioOverLimit, games: [gameOverLimit] },
      errors: { bio: BIO_ERROR, games: GAME_NAME_ERROR },
    },
  ])("PATCH refuses $name with a field-naming 422 and saves nothing", async ({ body, errors }) => {
    const { store, save, jsonPatch } = await setup();
    const res = await jsonPatch({ timezone: "UTC", ...body });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", fields: errors });
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(ALICE)).toEqual(seeded);
  });

  it("PATCH accepts astral boundary values given as a JSON games array", async () => {
    const { store, save, jsonPatch } = await setup();
    const res = await jsonPatch({
      bio: bioAtLimit,
      games: [gameAtLimit, ...gamesAtLimit.slice(1)],
      timezone: "UTC",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.rows.get(ALICE)?.bio).toBe(bioAtLimit);
    expect(store.rows.get(ALICE)?.games).toHaveLength(20);
    expect(store.rows.get(ALICE)?.games[0]).toBe(gameAtLimit);
  });

  it("PATCH accepts an empty bio and an empty games array", async () => {
    const { store, jsonPatch } = await setup();
    const res = await jsonPatch({ bio: "", games: [], timezone: "UTC" });
    expect(res.status).toBe(200);
    expect(store.rows.get(ALICE)?.bio).toBeNull();
    expect(store.rows.get(ALICE)?.games).toEqual([]);
  });

  it("form POST refuses overlong bio and games together, naming both, and saves nothing", async () => {
    const { store, save, formPost } = await setup();
    const asJson = await formPost(
      { bio: bioOverLimit, games_text: gameOverLimit, timezone: "UTC" },
      "application/json",
    );
    expect(asJson.status).toBe(422);
    expect(await asJson.json()).toEqual({
      error: "invalid",
      fields: { bio: BIO_ERROR, games: GAME_NAME_ERROR },
    });

    const asHtml = await formPost({
      bio: bioOverLimit,
      games_text: gamesOverLimit.join("\n"),
      timezone: "UTC",
    });
    expect(asHtml.status).toBe(422);
    const html = await asHtml.text();
    expect(html).toContain(BIO_ERROR);
    expect(html).toContain(GAME_COUNT_ERROR);
    expect(html).toContain(bioOverLimit);
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(ALICE)).toEqual(seeded);
  });

  it("form POST still accepts boundary and empty values", async () => {
    const boundary = await setup();
    const ok = await boundary.formPost({
      bio: bioAtLimit,
      games_text: gameAtLimit,
      timezone: "UTC",
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/members/${ALICE}`);
    expect(boundary.store.rows.get(ALICE)?.bio).toBe(bioAtLimit);
    expect(boundary.store.rows.get(ALICE)?.games).toEqual([gameAtLimit]);

    const empty = await setup();
    const cleared = await empty.formPost({ bio: "", games_text: "", timezone: "UTC" });
    expect(cleared.status).toBe(303);
    expect(empty.store.rows.get(ALICE)?.bio).toBeNull();
    expect(empty.store.rows.get(ALICE)?.games).toEqual([]);
  });

  it.each(["PATCH", "POST"] as const)(
    "multipart form %s refuses an overlong bio by name and saves nothing",
    async (method) => {
      const { store, save, send, aliceCookie } = await setup();
      const form = new FormData();
      if (method === "POST") form.set("_method", "PATCH");
      form.set("bio", bioOverLimit);
      form.set("games_text", "Chess");
      form.set("timezone", "UTC");
      const res = await send(ALICE, aliceCookie, method, form, null, "application/json");
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid", fields: { bio: BIO_ERROR } });
      expect(save).not.toHaveBeenCalled();
      expect(store.rows.get(ALICE)).toEqual(seeded);
    },
  );

  it("keeps ownership ahead of length: another member's overlong write is 403 and changes nothing", async () => {
    const { store, save, jsonPatch, bobCookie } = await setup();
    const res = await jsonPatch(
      { bio: bioOverLimit, games: gamesOverLimit, timezone: "UTC" },
      ALICE,
      bobCookie,
    );
    expect(res.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(ALICE)).toEqual(seeded);
  });

  it("keeps throttling ahead of length: a throttled overlong write is the usual 429 and saves nothing", async () => {
    const { store, save, jsonPatch } = await setup({ limited: true });
    const res = await jsonPatch({ bio: bioOverLimit, games: [gameOverLimit], timezone: "UTC" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 17 });
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(ALICE)).toEqual(seeded);
  });
});
