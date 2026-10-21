// route-inventory: GET /profile
// route-inventory: GET /members/:user
// route-inventory: PATCH /members/:user
// route-inventory: POST /members/:user
// Profiles editor acceptance: visibility toggles, handle, indexing opt-in and
// customization (spec decisions 1-3, 8-9). Failing-first contract for the
// Builder: every test in this file fails on the base revision and passes once
// the editor slice lands. The Builder builds on this branch and never edits
// this file.
//
// Spec interface pinned here (JSON body keys are snake_case, mirroring
// leaderboard_opt_out; attrs are camelCase, mirroring leaderboardOptOut):
// - visibility: partial map of field -> "public" | "members". Accepted fields:
//   bio, games, timezone, steam, links, featured_games (default members-only)
//   and display_name, avatar, rank, member_since (default public). Unknown
//   fields and other levels are errors.visibility. Absent keys preserve the
//   stored level. The editor renders one Public/Members radio pair per field
//   named visibility[<field>] with values public|members, the stored level
//   checked.
// - handle: 2-32 chars of [a-z0-9_.], trimmed first. A taken handle is a 422
//   naming the handle; a second change within 30 days is a 422 naming the
//   next-allowed ISO date. Absent preserves. A member's first change is
//   always allowed.
// - index_opt_in: boolean, same truthy/falsy convention as
//   leaderboard_opt_out. Garbage is errors.index_opt_in. Absent preserves.
//   The editor renders a checkbox named index_opt_in.
// - accent: absent preserves, "" clears (attrs null), otherwise exactly
//   #rrggbb reaching WCAG AA (4.5:1) as foreground text on BOTH theme
//   backgrounds (#151720 page, #222430 surface). Anything else is
//   errors.accent.
// - links: array of at most 5 {label, url}; labels are required, trimmed,
//   <= 80 chars; urls are trimmed http(s) URLs <= 2000 chars. Order kept.
//   Violations are errors.links.
// - featured_games: array of at most 6 names, trimmed, blank dropped,
//   de-duplicated in order, each <= 80 chars (the games rules). Violations
//   are errors.featured_games.
// - The 30/min per-member profile write throttle still guards every save,
//   with the same bucket, constant and 429 envelope.
//
// Hermetic by design: memory doubles only, no DATABASE_URL. The /u/<handle>
// public view is a sibling slice, so reflection there is covered by the
// staging journey (e2e/staging/profile-editor.spec.ts), not here.

import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { profilesApp, PROFILE_WRITE_THROTTLE_PER_MINUTE } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { validateProfile } from "../src/profiles/validation";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

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

const ALICE = { userId: "100000000000000001", username: "alice", member: true, moderator: false };
const BOB = { userId: "100000000000000002", username: "bob", member: true, moderator: false };

async function cookieFor(store: SessionStore, row: typeof ALICE): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const seedMembers = (): MemberView[] => [
  {
    id: ALICE.userId,
    username: "alice",
    avatar: null,
    bio: "Alice bio",
    games: ["Chess", "Go"],
    timezone: "Europe/London",
  },
  { id: BOB.userId, username: "bob", avatar: "abc123", bio: null, games: [], timezone: null },
];

function harness() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(seedMembers());
  const app = profilesApp({ sessionStore: sessions, store });
  return { app, sessions, store };
}

const jsonPatch = (cookie: string, body: Record<string, unknown>) => ({
  method: "PATCH" as const,
  headers: {
    cookie,
    origin: APP_URL,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(body),
});

// Attribute-order agnostic radio reader: every visibility field is a
// Public/Members radio pair named visibility[<field>].
function radios(html: string, field: string): { value: string; checked: boolean }[] {
  const tags = html.match(/<input[^>]*>/g) ?? [];
  return tags
    .filter((tag) => tag.includes(`name="visibility[${field}]"`) && /type="radio"/.test(tag))
    .map((tag) => ({
      value: tag.match(/value="([^"]*)"/)?.[1] ?? "",
      checked: /(?:\s|^)checked(?:\s|=|>|\/)/.test(tag),
    }));
}

function checkbox(html: string, name: string): { found: boolean; checked: boolean } {
  const tags = html.match(/<input[^>]*>/g) ?? [];
  const tag = tags.find(
    (candidate) => candidate.includes(`name="${name}"`) && /type="checkbox"/.test(candidate),
  );
  if (!tag) return { found: false, checked: false };
  return { found: true, checked: /(?:\s|^)checked(?:\s|=|>|\/)/.test(tag) };
}

const valid = { bio: "Hello", games: ["Halo"], timezone: "Europe/London" };

describe("validateProfile: visibility toggles", () => {
  it("echoes a validated partial visibility map", () => {
    expect(validateProfile({ ...valid, visibility: { bio: "members" } })).toEqual({
      ok: true,
      attrs: { ...valid, visibility: { bio: "members" } },
    });
  });

  it("accepts every spec field at both levels", () => {
    for (const field of [
      "bio",
      "games",
      "timezone",
      "steam",
      "links",
      "featured_games",
      "display_name",
      "avatar",
      "rank",
      "member_since",
    ]) {
      for (const level of ["public", "members"]) {
        expect(validateProfile({ ...valid, visibility: { [field]: level } })).toEqual({
          ok: true,
          attrs: { ...valid, visibility: { [field]: level } },
        });
      }
    }
  });

  it("rejects levels outside Public/Members", () => {
    expect(validateProfile({ ...valid, visibility: { bio: "everyone" } })).toEqual({
      ok: false,
      errors: { visibility: "Visibility must be Public or Members only." },
    });
  });

  it("rejects unknown visibility fields", () => {
    expect(validateProfile({ ...valid, visibility: { password: "public" } })).toEqual({
      ok: false,
      errors: { visibility: "Unknown profile field in visibility settings." },
    });
  });

  it("rejects a non-object visibility map", () => {
    expect(validateProfile({ ...valid, visibility: "public" })).toEqual({
      ok: false,
      errors: { visibility: "Visibility must be Public or Members only." },
    });
  });

  it("leaves attrs without visibility when the key is absent", () => {
    expect(validateProfile({ ...valid })).toEqual({ ok: true, attrs: { ...valid } });
  });
});

describe("validateProfile: handle", () => {
  it("accepts lowercase names with dots and underscores, trimmed", () => {
    expect(validateProfile({ ...valid, handle: "  good.name_9 " })).toEqual({
      ok: true,
      attrs: { ...valid, handle: "good.name_9" },
    });
    expect(validateProfile({ ...valid, handle: "ab" }).ok).toBe(true);
    expect(validateProfile({ ...valid, handle: "a".repeat(32) }).ok).toBe(true);
  });

  it("rejects bad charset and bad length with one message", () => {
    const message = "Handles use 2 to 32 lowercase letters, numbers, dots and underscores.";
    for (const handle of ["Bad Name!", "UPPER", "a", "x".repeat(33), "with space", "sla/sh"]) {
      expect(validateProfile({ ...valid, handle })).toEqual({
        ok: false,
        errors: { handle: message },
      });
    }
  });
});

describe("validateProfile: indexing opt-in", () => {
  it("accepts booleans and the leaderboard truthy/falsy convention", () => {
    for (const [value, expected] of [
      [true, true],
      [false, false],
      ["1", true],
      ["0", false],
      ["true", true],
      ["off", false],
    ] as const) {
      expect(validateProfile({ ...valid, index_opt_in: value })).toEqual({
        ok: true,
        attrs: { ...valid, indexOptIn: expected },
      });
    }
  });

  it("rejects garbage opt-in values", () => {
    expect(validateProfile({ ...valid, index_opt_in: "maybe" })).toEqual({
      ok: false,
      errors: { index_opt_in: "Choose whether search engines may index your profile." },
    });
  });
});

describe("validateProfile: accent colour", () => {
  it("rejects malformed colours", () => {
    const message = "Choose a colour as six hex digits, e.g. #a3ff12.";
    for (const accent of ["red", "#12345", "#gggggg", "a3ff12", "#a3ff123"]) {
      expect(validateProfile({ ...valid, accent })).toEqual({
        ok: false,
        errors: { accent: message },
      });
    }
  });

  it("rejects colours failing WCAG AA on the theme backgrounds", () => {
    // #1e3a8a is 1.73:1 on #151720 and 1.49:1 on #222430: decisive on both.
    expect(validateProfile({ ...valid, accent: "#1e3a8a" })).toEqual({
      ok: false,
      errors: {
        accent: "Pick an accent colour with stronger contrast on the profile background.",
      },
    });
  });

  it("accepts colours passing WCAG AA on the theme backgrounds", () => {
    // The profile brand lime (#a3ff12, 14.35:1 / 12.38:1) must stay usable.
    expect(validateProfile({ ...valid, accent: "#a3ff12" })).toEqual({
      ok: true,
      attrs: { ...valid, accent: "#a3ff12" },
    });
    expect(validateProfile({ ...valid, accent: "#ffffff" }).ok).toBe(true);
  });

  it("clears on empty string and preserves when absent", () => {
    expect(validateProfile({ ...valid, accent: "" })).toEqual({
      ok: true,
      attrs: { ...valid, accent: null },
    });
    expect(validateProfile({ ...valid })).toEqual({ ok: true, attrs: { ...valid } });
  });
});

describe("validateProfile: links and featured games", () => {
  const link = { label: "Blog", url: "https://example.com/blog" };

  it("echoes up to 5 trimmed http(s) links", () => {
    expect(validateProfile({ ...valid, links: [{ ...link, label: "  Blog " }] })).toEqual({
      ok: true,
      attrs: { ...valid, links: [link] },
    });
    expect(
      validateProfile({
        ...valid,
        links: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, url: `https://example.com/${n}` })),
      }).ok,
    ).toBe(true);
  });

  it("rejects a sixth link", () => {
    expect(
      validateProfile({
        ...valid,
        links: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `L${n}`, url: `https://example.com/${n}` })),
      }),
    ).toEqual({ ok: false, errors: { links: "Add no more than 5 links." } });
  });

  it("rejects non-http(s) urls", () => {
    for (const url of ["ftp://example.com/x", "javascript:alert(1)", "notaurl"]) {
      expect(validateProfile({ ...valid, links: [{ label: "X", url }] })).toEqual({
        ok: false,
        errors: { links: "Links must use http or https." },
      });
    }
  });

  it("rejects blank or oversized labels and shapeless links", () => {
    expect(validateProfile({ ...valid, links: [{ label: "  ", url: link.url }] })).toEqual({
      ok: false,
      errors: { links: "Give each link a label of 80 characters or fewer." },
    });
    expect(
      validateProfile({ ...valid, links: [{ label: "x".repeat(81), url: link.url }] }),
    ).toEqual({
      ok: false,
      errors: { links: "Give each link a label of 80 characters or fewer." },
    });
    expect(validateProfile({ ...valid, links: ["https://example.com"] })).toEqual({
      ok: false,
      errors: { links: "Each link needs a label and a URL." },
    });
  });

  it("echoes up to 6 featured games, trimmed and de-duplicated", () => {
    expect(validateProfile({ ...valid, featured_games: [" Halo ", "Halo", "", "Go"] })).toEqual({
      ok: true,
      attrs: { ...valid, featuredGames: ["Halo", "Go"] },
    });
    expect(validateProfile({ ...valid, featured_games: ["1", "2", "3", "4", "5", "6"] }).ok).toBe(
      true,
    );
  });

  it("rejects a seventh featured game and oversized names", () => {
    expect(
      validateProfile({ ...valid, featured_games: ["1", "2", "3", "4", "5", "6", "7"] }),
    ).toEqual({ ok: false, errors: { featured_games: "Feature no more than 6 games." } });
    expect(validateProfile({ ...valid, featured_games: ["x".repeat(81)] })).toEqual({
      ok: false,
      errors: { featured_games: "Keep each featured game to 80 characters or fewer." },
    });
  });
});

describe("PATCH /members/:user: editor saves", () => {
  it("saves a visibility map and the editor re-read shows the stored levels", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const save = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, {
        bio: "Hello",
        games: ["Halo"],
        timezone: "",
        visibility: { bio: "members" },
      }),
      env,
    );
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ saved: true });

    const reread = await app.request(`/members/${ALICE.userId}`, { headers: { cookie } }, env);
    expect(reread.status).toBe(200);
    const html = await reread.text();
    // The saved level is checked; untouched fields show their stored default
    // (members-only for content fields).
    expect(radios(html, "bio")).toEqual([
      { value: "public", checked: false },
      { value: "members", checked: true },
    ]);
    expect(radios(html, "games")).toEqual([
      { value: "public", checked: false },
      { value: "members", checked: true },
    ]);
  });

  it("a partial visibility map preserves the other stored levels", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const first = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, {
        bio: "Hello",
        games: [],
        timezone: "",
        visibility: { bio: "public", games: "members" },
      }),
      env,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", visibility: { bio: "members" } }),
      env,
    );
    expect(second.status).toBe(200);
    const html = await (
      await app.request(`/members/${ALICE.userId}`, { headers: { cookie } }, env)
    ).text();
    expect(radios(html, "bio").find((radio) => radio.checked)?.value).toBe("members");
    expect(radios(html, "games").find((radio) => radio.checked)?.value).toBe("members");
  });

  it("saves visibility through the form-override POST", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      {
        method: "POST",
        headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _method: "PATCH",
          bio: "Hello",
          games_text: "",
          timezone: "",
          "visibility[bio]": "members",
        }),
      },
      env,
    );
    expect(res.status).toBe(303);
    const html = await (
      await app.request(`/members/${ALICE.userId}`, { headers: { cookie } }, env)
    ).text();
    expect(radios(html, "bio").find((radio) => radio.checked)?.value).toBe("members");
  });

  it("changes the handle once, then refuses with the next-allowed date", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const first = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", handle: "alice.2" }),
      env,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", handle: "alice.3" }),
      env,
    );
    expect(second.status).toBe(422);
    const body = (await second.json()) as { errors: Record<string, string> };
    const match = body.errors.handle?.match(/again on (\d{4}-\d{2}-\d{2})/);
    expect(body.errors.handle, "refusal names the next-allowed date").toMatch(/again on /);
    expect(match?.[1], "date is ISO").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const nextAllowed = new Date(`${match?.[1]}T00:00:00Z`).getTime();
    const inDays = (nextAllowed - Date.now()) / 86_400_000;
    expect(inDays, "about 30 days out").toBeGreaterThan(28);
    expect(inDays).toBeLessThan(32);
  });

  it("refuses a taken handle with a message naming it", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    // Handles default to the Discord username, so "bob" is taken.
    const res = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", handle: "bob" }),
      env,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      errors: { handle: 'The handle "bob" is already taken.' },
    });
  });

  it("saves the indexing opt-in and the editor re-read keeps it checked", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const save = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", index_opt_in: true }),
      env,
    );
    expect(save.status).toBe(200);
    const html = await (
      await app.request(`/members/${ALICE.userId}`, { headers: { cookie } }, env)
    ).text();
    expect(checkbox(html, "index_opt_in")).toEqual({ found: true, checked: true });
  });

  it("rejects a low-contrast accent and accepts a passing one", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const rejected = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", accent: "#1e3a8a" }),
      env,
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      errors: {
        accent: "Pick an accent colour with stronger contrast on the profile background.",
      },
    });
    const accepted = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "Hello", games: [], timezone: "", accent: "#a3ff12" }),
      env,
    );
    expect(accepted.status).toBe(200);
  });

  it("saves links and featured games, and rejects over-cap writes", async () => {
    const { app, sessions, store } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const links = [{ label: "Blog", url: "https://example.com/blog" }];
    const save = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, {
        bio: "Hello",
        games: [],
        timezone: "",
        links,
        featured_games: ["Halo", "Go"],
      }),
      env,
    );
    expect(save.status).toBe(200);
    expect(store.rows.get(ALICE.userId)).toMatchObject({ links, featuredGames: ["Halo", "Go"] });
    const over = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, {
        bio: "Hello",
        games: [],
        timezone: "",
        links: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `L${n}`, url: `https://example.com/${n}` })),
      }),
      env,
    );
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ errors: { links: "Add no more than 5 links." } });
  });

  it("throttles extended saves at 30/min with the one 429 envelope", async () => {
    let n = 0;
    const sessions = createMemorySessionStore();
    const store = createMemoryProfileStore(seedMembers());
    const app = profilesApp({
      sessionStore: sessions,
      store,
      throttle: async () =>
        ++n > PROFILE_WRITE_THROTTLE_PER_MINUTE
          ? { limited: true, retryAfter: 17 }
          : { limited: false },
    });
    const cookie = await cookieFor(sessions, ALICE);
    expect(PROFILE_WRITE_THROTTLE_PER_MINUTE).toBe(30);
    let first!: Response;
    let last!: Response;
    for (let i = 0; i < PROFILE_WRITE_THROTTLE_PER_MINUTE + 1; i++) {
      const res = await app.request(
        `/members/${ALICE.userId}`,
        jsonPatch(cookie, {
          bio: `b${i}`,
          games: [],
          timezone: "",
          visibility: { bio: "public" },
        }),
        env,
      );
      if (i === 0) first = res;
      last = res;
    }
    expect(first.status).toBe(200);
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("17");
    expect(await last.json()).toMatchObject({ reason: "rate_limited", retry_after: 17 });
  });
});

describe("editor acceptance controls (pass before and after)", () => {
  it("a classic save still succeeds", async () => {
    const { app, sessions, store } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(await cookieFor(sessions, ALICE), {
        bio: "Still here",
        games: ["Halo"],
        timezone: "UTC",
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.rows.get(ALICE.userId)).toMatchObject({ bio: "Still here" });
  });

  it("a truly unknown field is still refused", async () => {
    const { app, sessions } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(await cookieFor(sessions, ALICE), { ...valid, user_id: "x" }),
      env,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.fields).toMatch(/Only your/);
  });

  it("classic validator limits are untouched", () => {
    expect(validateProfile({ bio: "x".repeat(1001), games: [], timezone: "" }).ok).toBe(false);
    expect(
      validateProfile({ bio: "ok", games: [], timezone: "", leaderboard_opt_out: true }),
    ).toEqual({
      ok: true,
      attrs: { bio: "ok", games: [], timezone: null, leaderboardOptOut: true },
    });
  });
});
