import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// Acceptance suite: NUL (U+0000) in a member's own bio/games must be refused
// with a 422 naming the field, on every profile write transport, and must
// never reach persistence (Postgres text columns reject NUL, so a save call
// carrying one is a production 500). Nothing may be silently stripped and
// partially saved instead.
//
// The JSON PATCH transport and the validateProfile unit contract are already
// pinned in profile-control-validation.test.ts; this suite pins the form
// transports (form PATCH and the `_method=PATCH` form POST the no-JS form
// uses), both-fields naming at the route, and the surrounding behavior that
// must not move: valid/empty/edge-length saves, throttling, ownership.
// Length-limit *rejection* is a separate slice and is not asserted here.
//
// Production change that makes these fail: dropping or weakening the
// control-character guard on the write path (the store's save spy would be
// called with the NUL-bearing value instead of the route answering 422).

const id = "100000000000000001";
const otherId = "100000000000000002";
const secret = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;
const seeded = {
  id,
  username: "alice",
  avatar: null,
  bio: "Hi",
  games: ["Chess"],
  timezone: "UTC",
};
const NUL = "\u0000";
const controlError = "Remove control or invisible characters.";

async function setup(throttleLimited = false) {
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
  const store = createMemoryProfileStore([{ ...seeded }]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () =>
      throttleLimited ? { limited: true, retryAfter: 17 } : { limited: false },
  });
  const form = (
    fields: Record<string, string>,
    { accept = "application/json", method = "PATCH", targetId = id } = {},
  ) =>
    app.request(
      `/members/${targetId}`,
      {
        method,
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
          accept,
        },
        body: new URLSearchParams(fields).toString(),
      },
      env,
    );
  const rawForm = (body: string, { method = "PATCH", targetId = id } = {}) =>
    app.request(
      `/members/${targetId}`,
      {
        method,
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      },
      env,
    );
  const json = (obj: unknown, targetId = id) =>
    app.request(
      `/members/${targetId}`,
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
  return { store, save, form, rawForm, json };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function expectRefused(harness: Harness) {
  expect(harness.save).not.toHaveBeenCalled();
  expect(harness.store.rows.get(id)).toEqual(seeded);
}

const transports = [
  {
    name: "form PATCH",
    send: (h: Harness, fields: Record<string, string>) => h.form(fields),
  },
  {
    name: "_method=PATCH form POST",
    send: (h: Harness, fields: Record<string, string>) =>
      h.form({ _method: "PATCH", ...fields }, { method: "POST" }),
  },
];

const nulPlacements = [
  { name: "sole character", wrap: (_text: string) => NUL },
  { name: "leading", wrap: (text: string) => `${NUL}${text}` },
  { name: "interior", wrap: (text: string) => `${text.slice(0, 2)}${NUL}${text.slice(2)}` },
  { name: "trailing", wrap: (text: string) => `${text}${NUL}` },
];

describe("profile NUL rejection on the form transports", () => {
  it.each(transports)("refuses NUL in bio via $name with a bio-naming 422", async ({ send }) => {
    for (const { wrap } of nulPlacements) {
      const harness = await setup();
      const res = await send(harness, {
        bio: wrap("Hello"),
        timezone: "UTC",
        games_text: "Chess",
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid", fields: { bio: controlError } });
      expectRefused(harness);
    }
  });

  it.each(transports)(
    "refuses NUL in games via $name with a games-naming 422",
    async ({ send }) => {
      for (const { wrap } of nulPlacements) {
        const harness = await setup();
        const res = await send(harness, {
          bio: "Hello",
          timezone: "UTC",
          games_text: wrap("Chess"),
        });
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error: "invalid", fields: { games: controlError } });
        expectRefused(harness);
      }
    },
  );

  it.each(transports)("refuses a NUL in a later games entry via $name", async ({ send }) => {
    const harness = await setup();
    const res = await send(harness, {
      bio: "Hello",
      timezone: "UTC",
      games_text: `Chess\nG${NUL}o`,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", fields: { games: controlError } });
    expectRefused(harness);
  });

  it.each(transports)(
    "names both fields via $name when bio and games carry NUL",
    async ({ send }) => {
      const harness = await setup();
      const res = await send(harness, {
        bio: `bad${NUL}bio`,
        timezone: "UTC",
        games_text: `bad${NUL}game`,
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "invalid",
        fields: { bio: controlError, games: controlError },
      });
      expectRefused(harness);
    },
  );

  it("refuses a raw %00 byte in the form body, not only a URLSearchParams-built one", async () => {
    const bioHarness = await setup();
    const bioRes = await bioHarness.rawForm("bio=a%00b&timezone=UTC&games_text=Chess");
    expect(bioRes.status).toBe(422);
    expect(await bioRes.json()).toEqual({ error: "invalid", fields: { bio: controlError } });
    expectRefused(bioHarness);

    const gamesHarness = await setup();
    const gamesRes = await gamesHarness.rawForm(
      "_method=PATCH&bio=ok&timezone=UTC&games_text=Ch%00ess",
      { method: "POST" },
    );
    expect(gamesRes.status).toBe(422);
    expect(await gamesRes.json()).toEqual({ error: "invalid", fields: { games: controlError } });
    expectRefused(gamesHarness);
  });

  it("answers the HTML form path with a 422 page carrying the field error, not a save", async () => {
    const harness = await setup();
    const res = await harness.form(
      { _method: "PATCH", bio: `bad${NUL}bio`, timezone: "UTC", games_text: "Chess" },
      { method: "POST", accept: "text/html" },
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(controlError);
    expectRefused(harness);
  });

  it("names both fields on a JSON PATCH carrying NUL in bio and games", async () => {
    const harness = await setup();
    const res = await harness.json({
      bio: `bad${NUL}bio`,
      timezone: "UTC",
      games: [`bad${NUL}game`],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { bio: controlError, games: controlError },
    });
    expectRefused(harness);
  });
});

describe("profile NUL rejection leaves the surrounding contract unchanged", () => {
  it.each(transports)("still saves a valid profile via $name", async ({ send }) => {
    const harness = await setup();
    const res = await send(harness, {
      bio: "Plays 🎮 and 遊戲",
      timezone: "Europe/London",
      games_text: "Chess\nGo",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.store.rows.get(id)).toMatchObject({
      bio: "Plays 🎮 and 遊戲",
      games: ["Chess", "Go"],
      timezone: "Europe/London",
    });
  });

  it.each(transports)(
    "still saves an empty bio and an empty games list via $name",
    async ({ send }) => {
      const harness = await setup();
      const res = await send(harness, { bio: "", timezone: "UTC", games_text: "" });
      expect(res.status).toBe(200);
      expect(harness.save).toHaveBeenCalledTimes(1);
      expect(harness.store.rows.get(id)).toMatchObject({ bio: null, games: [] });
    },
  );

  it.each(transports)("still saves edge-length valid input via $name", async ({ send }) => {
    const harness = await setup();
    const bio = "🎮".repeat(1000);
    const game = "🎮".repeat(80);
    const res = await send(harness, { bio, timezone: "UTC", games_text: game });
    expect(res.status).toBe(200);
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.store.rows.get(id)).toMatchObject({ bio, games: [game] });
  });

  it("throttling still answers 429 before any save, NUL-bearing or valid", async () => {
    for (const fields of [
      { bio: `bad${NUL}bio`, timezone: "UTC", games_text: "Chess" },
      { bio: "Hello", timezone: "UTC", games_text: `bad${NUL}game` },
      { bio: "Hello", timezone: "UTC", games_text: "Chess" },
    ]) {
      const harness = await setup(true);
      const res = await harness.form({ _method: "PATCH", ...fields }, { method: "POST" });
      expect(res.status).toBe(429);
      expectRefused(harness);
    }
  });

  it("ownership still answers 403 for another member's profile, NUL-bearing or valid", async () => {
    for (const fields of [
      { bio: `bad${NUL}bio`, timezone: "UTC", games_text: "Chess" },
      { bio: "Hello", timezone: "UTC", games_text: "Chess" },
    ]) {
      const harness = await setup();
      const res = await harness.form(fields, { targetId: otherId });
      expect(res.status).toBe(403);
      expect(harness.save).not.toHaveBeenCalled();
      expect(harness.store.rows.get(otherId)).toBeUndefined();
      expect(harness.store.rows.get(id)).toEqual(seeded);
    }
  });
});
