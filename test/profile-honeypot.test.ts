import { Hono } from "hono";
import { jsx } from "hono/jsx";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_HONEY_FIELD,
  PROFILE_MIN_FILL_MS,
  PROFILE_OPENED_AT_FIELD,
} from "../src/islands/contracts";
import { ProfilePage } from "../src/profiles/pages";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { serializeSigned } from "hono/utils/cookie";
import type { Env } from "../src/env";

const NOW = 1_800_000_000_000;
const member = {
  id: "100000000000000001",
  username: "alice",
  avatar: null,
  bio: null,
  games: [],
  timezone: null,
};
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "1",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

afterEach(() => vi.restoreAllMocks());

describe("profile honeypot rendering", () => {
  it.each([false, true])(
    "hides the SSR trap with external CSS, including validation rerender=%s",
    async (invalid) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const app = new Hono().get("/", (c) =>
        c.html(
          jsx(ProfilePage, {
            member,
            isOwner: true,
            appUrl: env.APP_URL,
            ...(invalid
              ? {
                  errors: { bio: "Bio is too long." },
                  values: { bio: "attempt", games_text: "", timezone: "" },
                }
              : {}),
          }).toString(),
        ),
      );
      const html = await (await app.request("/")).text();
      const form = html.match(
        /<form\b[^>]*data-testid="profile-form"[^>]*>([\s\S]*?)<\/form>/,
      )?.[0];
      expect(form).toBeDefined();
      const trap = form!.match(
        /<div\b[^>]*>\s*<label>Website <input\b[^>]*>\s*<\/label>\s*<\/div>/,
      )?.[0];
      expect(trap).toBeDefined();
      expect(trap).toMatch(/class="sr-only"/);
      expect(trap).toContain('aria-hidden="true"');
      expect(trap).not.toMatch(/\bstyle=/);
      expect(trap).toContain(`name="${PROFILE_HONEY_FIELD}"`);
      expect(trap).toContain('tabindex="-1"');
      expect(trap).toContain('autocomplete="off"');
      expect(trap).not.toMatch(/\bdisabled\b/);
      expect(form).toContain('method="post"');
      expect(form).toContain('name="_method" value="PATCH"');
      expect(form).toContain(`type="hidden" name="${PROFILE_OPENED_AT_FIELD}" value="${NOW}"`);
      expect(html).toContain('rel="stylesheet" href="/styles.css"');
      expect(html).toContain('<script src="/islands/member-profile.js" defer=""></script>');
      const css = readFileSync("public/styles.css", "utf8");
      expect(css).toMatch(
        /\.sr-only\s*\{[^}]*position:\s*absolute;[^}]*width:\s*1px;[^}]*height:\s*1px;[^}]*overflow:\s*hidden;[^}]*clip:\s*rect\(0 0 0 0\)/,
      );
    },
  );
});

it("no-JS real, filled-trap and fast-fill POSTs keep identical responses without decoy writes or logging", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const log = vi.fn(async () => true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([member]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: log,
    throttle: async () => ({ limited: false }),
  });
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: member.id,
    username: member.username,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(NOW + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
  const responses: { status: number; location: string | null; body: string }[] = [];
  for (const [website, elapsed] of [
    ["https://spam.example", PROFILE_MIN_FILL_MS],
    ["", PROFILE_MIN_FILL_MS - 1],
    ["", PROFILE_MIN_FILL_MS],
  ] as const) {
    const res = await app.request(
      `/members/${member.id}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _method: "PATCH",
          bio: "saved",
          games_text: "Chess",
          timezone: "UTC",
          [PROFILE_HONEY_FIELD]: website,
          [PROFILE_OPENED_AT_FIELD]: String(NOW - elapsed),
        }),
      },
      env,
    );
    responses.push({
      status: res.status,
      location: res.headers.get("location"),
      body: await res.text(),
    });
    if (responses.length < 3) {
      expect(save).not.toHaveBeenCalled();
      expect(store.rows.get(member.id)!.bio).toBeNull();
    }
  }
  expect(responses).toEqual(
    Array(3).fill({ status: 303, location: `/members/${member.id}`, body: "" }),
  );
  expect(save).toHaveBeenCalledExactlyOnceWith(member.id, {
    bio: "saved",
    games: ["Chess"],
    timezone: "UTC",
  });
  expect(log).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});
