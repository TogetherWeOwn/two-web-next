// Acceptance-owned: Builder consumes this file unchanged. A permissive URL
// parser, validation after trim, or a write before refusal must fail these pins.
// Only persistence/audit are faked; the parser, auth and POST handlers are real.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { adminApp } from "../src/admin/routes";
import {
  createFeatured,
  featuredSaveBaseline,
  getFeatured,
  updateFeatured,
} from "../src/admin/store";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("../src/admin/store", async (original) => ({
  ...(await original<typeof import("../src/admin/store")>()),
  createFeatured: vi.fn(),
  getFeatured: vi.fn(),
  updateFeatured: vi.fn(),
  recordAccess: vi.fn().mockResolvedValue(true),
}));

const base = { title: "Draft evening", body: "Bring a friend", position: "7" };
const accepted = [
  "http://example.test/",
  "https://example.test/path?query=yes#frag",
  "http://example.test:8080/path?query=yes#frag",
  "https://example.test:8443/path?query=yes#frag",
  "https://example.test:443/path",
  "https://example.test/team@home?email=user@example.test",
  "https://example.test/a%20b?next=%5C#part",
];
const refused = [
  {
    label: "username",
    url: "https://trusted.example@evil.example/",
    rule: /credentials|userinfo|user.?name/i,
  },
  {
    label: "password",
    url: "https://user:pass@example.test/",
    rule: /credentials|userinfo|user.?name/i,
  },
  {
    label: "empty userinfo",
    url: "https://@example.test/",
    rule: /credentials|userinfo|user.?name/i,
  },
  {
    label: "empty username and password",
    url: "https://:@example.test/",
    rule: /credentials|userinfo|user.?name/i,
  },
  {
    label: "authority backslash",
    url: "https://trusted.example\\@evil.example/",
    rule: /backslash/i,
  },
  { label: "path backslash", url: "https://example.test/a\\b", rule: /backslash/i },
  { label: "space in path", url: "https://example.test/a b", rule: /white.?space|spaces?/i },
  { label: "leading space", url: " https://example.test/path", rule: /white.?space|spaces?/i },
  { label: "trailing space", url: "https://example.test/path ", rule: /white.?space|spaces?/i },
  { label: "NBSP", url: "https://example.test/a b", rule: /white.?space|spaces?/i },
  { label: "em space", url: "https://example.test/a b", rule: /white.?space|spaces?/i },
  { label: "leading BOM", url: "﻿https://example.test/path", rule: /white.?space|spaces?/i },
];
// Exhaust C0 + DEL at all three positions: URL() strips HT/LF/CR and
// trim() hides edge controls, so embedded-only cases miss real bypasses.
const controls = [...Array.from({ length: 32 }, (_, i) => i), 0x7f].flatMap((code) => {
  const char = String.fromCodePoint(code);
  const rule = code === 0 ? /NUL|control|C0/i : /control|C0|white.?space/i;
  return [
    {
      label: `U+${code.toString(16).padStart(4, "0")} leading`,
      url: `${char}https://example.test/path`,
      rule,
    },
    {
      label: `U+${code.toString(16).padStart(4, "0")} embedded`,
      url: `https://example.test/a${char}b`,
      rule,
    },
    {
      label: `U+${code.toString(16).padStart(4, "0")} trailing`,
      url: `https://example.test/path${char}`,
      rule,
    },
  ];
});

function errors(url: string): Record<string, string> | null {
  try {
    parseFeaturedForm({ ...base, url });
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
}

const existing = {
  id: 1,
  legacyId: null,
  title: "Saved headline",
  body: null,
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: false,
  position: 0,
  startsAt: null,
  endsAt: null,
  startsAtText: null,
  endsAtText: null,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  ADMIN_DB: new Proxy({} as Db, {
    get(_, key) {
      if (key === "then") return undefined;
      throw new Error("acceptance fixture must not query a database");
    },
  }),
};
const fetchSpy = vi.fn(() => {
  throw new Error("link validation must not fetch");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchSpy);
  vi.mocked(getFeatured).mockResolvedValue(existing);
  vi.mocked(createFeatured).mockResolvedValue(existing);
  vi.mocked(updateFeatured).mockResolvedValue(existing);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function moderator() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: "111111111111111111",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { app: adminApp(sessions), cookie };
}

function input(html: string, name: string): string {
  const tag = html.match(new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`))?.[0];
  expect(tag, `missing ${name} input`).toBeDefined();
  return tag!;
}

// Wording is semantic, not a literal sentence: moderators must learn what to
// remove. Helper reuse and absence of DNS APIs remain independent review gates.
function expectGuidance(copy: string) {
  expect(copy).toMatch(/credentials|userinfo|user.?name/i);
  expect(copy).toMatch(/backslash/i);
  expect(copy).toMatch(/white.?space|spaces?/i);
  expect(copy).toMatch(/control|C0/i);
}

describe("featured link spelling acceptance: shared form parser", () => {
  it.each([...refused, ...controls])(
    "refuses $label on url only with actionable copy",
    ({ url, rule }) => {
      const fields = errors(url);
      expect(fields, "unsafe raw spelling must be refused before URL normalization").not.toBeNull();
      expect(Object.keys(fields!)).toEqual(["url"]);
      expect(fields!.url).toMatch(rule);
    },
  );
  it.each(accepted)("accepts non-deceptive links verbatim, including explicit ports: %s", (url) => {
    expect(parseFeaturedForm({ ...base, url }).url).toBe(url);
  });
  it.each([undefined, ""])("keeps no-link optional for %s", (url) => {
    expect(parseFeaturedForm({ ...base, url }).url).toBeNull();
  });
  it.each(["javascript:alert(1)", "//example.test/path", "not-a-url"])(
    "still refuses non-http(s) input %s",
    (url) => {
      expect(Object.keys(errors(url)!)).toEqual(["url"]);
    },
  );
});

// The edit form carries the server-derived saved-content baseline; these
// proofs pin link validation, so the edit POST submits the fresh one.
async function savedBaseline(path: string): Promise<Record<string, string>> {
  return path === "/featured" ? {} : { saved_baseline: await featuredSaveBaseline(existing) };
}

describe("featured link spelling acceptance: real create/edit POST", () => {
  for (const path of ["/featured", "/featured/1"]) {
    it.each([
      ...refused,
      ...[0, 7, 9, 10, 13, 31, 127].map(
        (code) =>
          controls.find((row) => row.label === `U+${code.toString(16).padStart(4, "0")} embedded`)!,
      ),
    ])(`${path} refuses $label without writes and keeps the draft`, async ({ url, rule }) => {
      const { app, cookie } = await moderator();
      const res = await app.request(
        path,
        {
          method: "POST",
          headers: { cookie, origin: env.APP_URL },
          body: new URLSearchParams({
            ...(await savedBaseline(path)),
            ...base,
            url,
            image_alt: "Draft photo description",
          }),
        },
        env,
      );
      expect(res.status).toBe(422);
      expect(createFeatured).not.toHaveBeenCalled();
      expect(updateFeatured).not.toHaveBeenCalled();
      const html = await res.text();
      const link = input(html, "url");
      expect(link).toContain('aria-invalid="true"');
      const errorId = link
        .match(/aria-describedby="([^"]+)"/)?.[1]
        ?.split(/\s+/)
        .find((id) => id.endsWith("-error"));
      expect(errorId).toBeDefined();
      const copy = html.match(new RegExp(`id="${errorId}"[^>]*>([^<]+)`))?.[1];
      expect(copy).toMatch(rule);
      expect(link).toContain(`value="${url}"`);
      expect(input(html, "title")).toContain('value="Draft evening"');
      expect(html).toContain("Bring a friend</textarea>");
      expect(input(html, "image_alt")).toContain('value="Draft photo description"');
      expect(input(html, "position")).toContain('value="7"');
    });
    it(`${path} saves an explicit-port link without applying the image port policy`, async () => {
      const { app, cookie } = await moderator();
      const url = "https://example.test:8443/path";
      const res = await app.request(
        path,
        {
          method: "POST",
          headers: { cookie, origin: env.APP_URL },
          body: new URLSearchParams({ ...(await savedBaseline(path)), ...base, url }),
        },
        env,
      );
      expect(res.status).toBe(303);
      const write = path === "/featured" ? createFeatured : updateFeatured;
      expect(write).toHaveBeenCalledOnce();
      // create(db, actor, input); update(db, actor, id, input, { expectedBaseline }).
      const inputAt = path === "/featured" ? 2 : 3;
      expect(vi.mocked(write).mock.calls[0]![inputAt]).toMatchObject({ url });
    });
  }
  it.each(["/featured/new", "/featured/1"])(
    "%s associates link guidance with its input before submission",
    async (path) => {
      const { app, cookie } = await moderator();
      const res = await app.request(path, { headers: { cookie } }, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      const ids =
        input(html, "url")
          .match(/aria-describedby="([^"]+)"/)?.[1]
          ?.split(/\s+/) ?? [];
      expect(ids.length).toBeGreaterThan(0);
      const copy = ids
        .map((id) => html.match(new RegExp(`id="${id}"[^>]*>([^<]+)`))?.[1] ?? "")
        .join(" ");
      expectGuidance(copy);
    },
  );
});
