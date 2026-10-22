// Acceptance contract: overlay member settings page (spec slice 4).
//
// Owner-approved 2026-10-21. Context: GET /overlay + PATCH config +
// rotate/revoke buttons + token history (created/rotated/last-used/use
// counts). Session gate exactly like GET /profile, owner-only writes,
// 30/min throttle. Theme preset list only (no free hex); the watermark is
// never toggleable.
//
// ## Contract the Builder implements
//
// - `overlayApp(deps)` factory in `src/overlay/routes`, mirroring
//   `profilesApp` (see `src/profiles/routes.tsx`). Deps: `{ sessionStore,
//   configs, tokens, accessLog, throttle }` with the shapes below. The
//   Builder adapts the real slice-1 stores behind `configs`/`tokens`.
// - Routes: `GET /overlay`, `PATCH /overlay` (JSON), `POST
//   /overlay/rotate`, `POST /overlay/revoke` (native form POST + JSON via
//   `Accept: application/json`). No `:user` segment anywhere: the page is
//   viewer-scoped, so owner-only is structural.
// - This file loads that module with a dynamic import so `npm run
//   typecheck` stays green while the slice is missing; every slice-4 case
//   below fails RED with "overlay settings slice not implemented" until
//   the Builder lands the route.
//
// ## Config schema (JSON PATCH body mirrors the storage columns)
//
//   { "elements": { "showIdentity": bool, "avatar": bool,
//                   "liveLine": "auto"|"custom"|"hidden",
//                   "customText": string<=140, "layout": "compact"|"banner" },
//     "theme": { "preset": "<offered-id>", "accent": "<offered-id>" } }
//
// - Unknown keys (including `watermark` / `showWatermark`), off-enum
//   values, free-hex theme values (`/^#[0-9a-fA-F]{3,8}$/`), overlong
//   custom text, and mistyped fields are 422. Tests always send complete
//   objects; partial-object behavior is unspecified.
// - Native form field names: `show_identity`, `avatar`, `live_line`,
//   `custom_text`, `layout`, `theme_preset`, `theme_accent` (absent
//   checkbox means false, `leaderboard_opt_out` precedent). Preset ids are
//   the Builder's choice (spec: dark/translucent default + 2-3
//   alternates); tests harvest them from the rendered page, never
//   hard-code them.
// - Success: JSON PATCH -> 200 `{ saved: true }` (profiles precedent);
//   native POST with `_method=PATCH` -> 303 back to `/overlay`.
//
// ## Rotate / revoke
//
// - Native form POST -> 303 to `/overlay`. JSON POST -> 200 with
//   `{ url }` (rotate, shown once) or `{ revoked: true }`.
// - The new overlay URL is visible exactly once after rotation (flash
//   cookie, `JOIN_RESULT_COOKIE` precedent): the follow-up GET renders it
//   in `data-testid="overlay-new-url"`; a later GET shows a masked
//   reference only. Token format `two_ov_` + base64url is spec-locked.
// - History rows never re-render a rotated/revoked secret.
//
// ## Testids the page must render
//
// - `overlay-settings-form` (the config form), `overlay-theme-preset`,
//   `overlay-theme-accent` (select or radio group; >=2 options each),
//   `overlay-token-history` (panel), `overlay-token-row` (one per token)
//   with `overlay-token-status` (`live|rotated|revoked`),
//   `overlay-token-created`, `overlay-token-rotated`,
//   `overlay-token-last-used`, `overlay-token-use-count`,
//   `overlay-rotate` / `overlay-revoke` (submit controls in forms posting
//   to `/overlay/rotate` / `/overlay/revoke`), `overlay-new-url`
//   (one-time URL after rotation).
//
// ## Slice boundaries (not tested here)
//
// - Token crypto, rotation grace, atomicity: slice 1. `/o/:token` render
//   and watermark node: slice 2. `/data` + polling island: slice 3. Cap
//   notices, auto-pause, IP hints: slice 5.
//
// ## Browser cases
//
// Chromium over the real SSR page on an ephemeral loopback server with
// in-memory stores. Opt-in (repo browser-gate pattern):
// `OVERLAY_SETTINGS_BROWSER_TESTS=true npx vitest run
// test/overlay-member-settings-acceptance.test.ts`. The Builder wires the
// `a11y` job step + `ci/a11y-native-browser-suites.test.mjs` SUITES entry
// + README "Browser regressions" row (title "overlay member settings
// rotate/revoke in a real browser", 3 tests).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Env } from "../src/env";
import { profilesApp, PROFILE_WRITE_THROTTLE_PER_MINUTE } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import testApp from "./app";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const env = { APP_URL, SESSION_SECRET } as Env;

const ALICE = { userId: "100000000000000001", username: "alice", member: true, moderator: false };
const BOB = { userId: "100000000000000002", username: "bob", member: true, moderator: false };
const MOD = { userId: "100000000000000003", username: "mod", member: true, moderator: true };
const OUTSIDER = {
  userId: "100000000000000004",
  username: "out",
  member: false,
  moderator: false,
};

type OverlayConfig = {
  elements: {
    showIdentity: boolean;
    avatar: boolean;
    liveLine: "auto" | "custom" | "hidden";
    customText: string;
    layout: "compact" | "banner";
  };
  theme: { preset: string; accent: string };
};

type OverlayTokenStatus = "live" | "rotated" | "revoked";

type OverlayTokenView = {
  id: string;
  status: OverlayTokenStatus;
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  maskedRef: string;
};

type OverlayConfigStore = {
  get(memberId: string): Promise<OverlayConfig | null>;
  save(memberId: string, config: OverlayConfig): Promise<void>;
};

type OverlayTokenStore = {
  list(memberId: string): Promise<OverlayTokenView[]>;
  rotate(memberId: string): Promise<{ url: string }>;
  revoke(memberId: string): Promise<void>;
};

type OverlayThrottle = (bucket: string) => Promise<{ limited: boolean; retryAfter?: number }>;

type OverlayAppDeps = {
  sessionStore?: SessionStore;
  configs: OverlayConfigStore;
  tokens: OverlayTokenStore;
  accessLog?: (entry: unknown) => Promise<boolean>;
  throttle?: OverlayThrottle;
};

type OverlayApp = {
  request(input: string, init?: RequestInit, env?: Env): Promise<Response>;
};

type OverlayAppFactory = (deps: OverlayAppDeps) => OverlayApp;

type OverlayModule = {
  overlayApp: OverlayAppFactory;
  OVERLAY_WRITE_THROTTLE_PER_MINUTE?: unknown;
};

// Non-literal on purpose: tsc must not resolve it (typecheck stays green
// while the slice is missing) and Vitest resolves it at runtime.
const OVERLAY_ROUTES_SPECIFIER = "../src/overlay/routes";
const NOT_IMPLEMENTED =
  "overlay settings slice not implemented: src/overlay/routes must export overlayApp(deps) (spec slice 4)";

async function loadOverlayModule(): Promise<OverlayModule> {
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ OVERLAY_ROUTES_SPECIFIER);
  } catch {
    throw new Error(NOT_IMPLEMENTED);
  }
  const factory = (mod as Partial<OverlayModule>).overlayApp;
  if (typeof factory !== "function") throw new Error(NOT_IMPLEMENTED);
  return mod as OverlayModule;
}

async function signedCookie(token: string): Promise<string> {
  return (
    await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function seedSession(
  sessions: SessionStore,
  who: typeof ALICE,
): Promise<{ cookie: string; token: string }> {
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: who.userId,
    username: who.username,
    avatar: null,
    member: who.member,
    moderator: who.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { cookie: await signedCookie(token), token };
}

function memoryConfigs(initial: Record<string, OverlayConfig> = {}) {
  const rows = new Map<string, OverlayConfig>(
    Object.entries(initial).map(([id, config]) => [id, structuredClone(config)]),
  );
  return {
    rows,
    get: vi.fn(async (memberId: string): Promise<OverlayConfig | null> => {
      const found = rows.get(memberId);
      return found ? structuredClone(found) : null;
    }),
    save: vi.fn(async (memberId: string, config: OverlayConfig): Promise<void> => {
      rows.set(memberId, structuredClone(config));
    }),
  };
}

const LIVE_TOKEN: OverlayTokenView = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "live",
  createdAt: "2026-10-01T10:00:00.000Z",
  rotatedAt: null,
  revokedAt: null,
  lastUsedAt: "2026-10-20T08:30:00.000Z",
  useCount: 42,
  maskedRef: "…a1b2",
};

const ROTATED_TOKEN: OverlayTokenView = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "rotated",
  createdAt: "2026-09-01T10:00:00.000Z",
  rotatedAt: "2026-10-01T10:00:00.000Z",
  revokedAt: null,
  lastUsedAt: "2026-10-01T09:59:00.000Z",
  useCount: 137,
  maskedRef: "…c3d4",
};

function memoryTokens(initial: Record<string, OverlayTokenView[]> = {}) {
  const rows = new Map<string, OverlayTokenView[]>(
    Object.entries(initial).map(([id, list]) => [id, structuredClone(list)]),
  );
  let counter = 0;
  return {
    rows,
    list: vi.fn(async (memberId: string): Promise<OverlayTokenView[]> => {
      return structuredClone(rows.get(memberId) ?? []);
    }),
    rotate: vi.fn(async (memberId: string): Promise<{ url: string }> => {
      const now = new Date().toISOString();
      const list = rows.get(memberId) ?? [];
      for (const token of list) {
        if (token.status === "live") {
          token.status = "rotated";
          token.rotatedAt = now;
        }
      }
      counter += 1;
      const secret = `two_ov_${"R".repeat(39)}${String(counter).padStart(4, "0")}`;
      list.push({
        id: `rotated-${counter}`,
        status: "live",
        createdAt: now,
        rotatedAt: null,
        revokedAt: null,
        lastUsedAt: null,
        useCount: 0,
        maskedRef: `…${secret.slice(-4)}`,
      });
      rows.set(memberId, list);
      return { url: `${APP_URL}/o/${secret}` };
    }),
    revoke: vi.fn(async (memberId: string): Promise<void> => {
      const now = new Date().toISOString();
      const list = rows.get(memberId) ?? [];
      for (const token of list) {
        if (token.status === "live") {
          token.status = "revoked";
          token.revokedAt = now;
        }
      }
      rows.set(memberId, list);
    }),
  };
}

type Fixture = {
  app: OverlayApp;
  sessions: SessionStore;
  configs: ReturnType<typeof memoryConfigs>;
  tokens: ReturnType<typeof memoryTokens>;
  accessLog: ReturnType<typeof vi.fn>;
  cookies: Record<"alice" | "bob" | "mod" | "outsider", string>;
  get: (cookie?: string) => Promise<Response>;
  patchJson: (body: unknown, cookie?: string, accept?: string) => Promise<Response>;
  postForm: (path: string, fields: Record<string, string>, cookie?: string) => Promise<Response>;
  postJson: (path: string, cookie?: string) => Promise<Response>;
};

async function setup(
  overrides: {
    configs?: ReturnType<typeof memoryConfigs>;
    tokens?: ReturnType<typeof memoryTokens>;
    accessLog?: ReturnType<typeof vi.fn>;
    throttle?: OverlayThrottle;
    sessionStore?: SessionStore;
  } = {},
): Promise<Fixture> {
  const { overlayApp } = await loadOverlayModule();
  const sessions = overrides.sessionStore ?? createMemorySessionStore();
  const seeded = {
    alice: overrides.sessionStore ? null : await seedSession(sessions, ALICE),
    bob: overrides.sessionStore ? null : await seedSession(sessions, BOB),
    mod: overrides.sessionStore ? null : await seedSession(sessions, MOD),
    outsider: overrides.sessionStore ? null : await seedSession(sessions, OUTSIDER),
  };
  const cookies = {
    alice: seeded.alice?.cookie ?? "",
    bob: seeded.bob?.cookie ?? "",
    mod: seeded.mod?.cookie ?? "",
    outsider: seeded.outsider?.cookie ?? "",
  };
  const configs = overrides.configs ?? memoryConfigs();
  const tokens = overrides.tokens ?? memoryTokens();
  const accessLog = overrides.accessLog ?? vi.fn(async () => true);
  const throttle: OverlayThrottle = overrides.throttle ?? (async () => ({ limited: false }));
  const app = overlayApp({
    sessionStore: sessions,
    configs,
    tokens,
    accessLog: accessLog as unknown as (entry: unknown) => Promise<boolean>,
    throttle,
  });
  const withCookie = (cookie?: string): Record<string, string> => (cookie ? { cookie } : {});
  return {
    app,
    sessions,
    configs,
    tokens,
    accessLog,
    cookies,
    get: (cookie?: string) => app.request("/overlay", { headers: withCookie(cookie) }, env),
    patchJson: (body: unknown, cookie?: string, accept?: string) =>
      app.request(
        "/overlay",
        {
          method: "PATCH",
          headers: {
            ...withCookie(cookie),
            "content-type": "application/json",
            ...(accept ? { accept } : {}),
          },
          body: JSON.stringify(body),
        },
        env,
      ),
    postForm: (path: string, fields: Record<string, string>, cookie?: string) =>
      app.request(
        path,
        {
          method: "POST",
          headers: {
            ...withCookie(cookie),
            origin: APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields).toString(),
        },
        env,
      ),
    postJson: (path: string, cookie?: string) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { ...withCookie(cookie), accept: "application/json" },
        },
        env,
      ),
  };
}

function formBlock(html: string): string {
  const match = html.match(
    /<form\b[^>]*data-testid="overlay-settings-form"[^>]*>([\s\S]*?)<\/form>/i,
  );
  if (!match) throw new Error("settings form missing: data-testid=overlay-settings-form");
  return match[0];
}

function historyBlock(html: string): string {
  const match = html.match(
    /<(\w+)\b[^>]*data-testid="overlay-token-history"[^>]*>([\s\S]*?)<\/\1>/i,
  );
  if (!match) throw new Error("token history missing: data-testid=overlay-token-history");
  return match[0];
}

function historyRows(historyHtml: string): string[] {
  const starts = [...historyHtml.matchAll(/data-testid="overlay-token-row"/gi)].map(
    (m) => m.index ?? 0,
  );
  return starts.map((start, i) => historyHtml.slice(start, starts[i + 1] ?? historyHtml.length));
}

function offeredValues(html: string, testid: string): string[] {
  const select = html.match(
    new RegExp(`<select\\b[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</select>`, "i"),
  );
  if (select) {
    return [...select[1]!.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>/gi)]
      .map((m) => m[1] ?? "")
      .filter((v) => v.length > 0);
  }
  const group = html.match(
    new RegExp(`<(\\w+)\\b[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</\\1>`, "i"),
  );
  if (!group) throw new Error(`preset control missing: data-testid=${testid}`);
  return [...group[2]!.matchAll(/<input\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('type="radio"'))
    .map((tag) => tag.match(/value="([^"]+)"/i)?.[1] ?? "")
    .filter((v) => v.length > 0);
}

function fieldText(row: string, testid: string): string {
  const match = row.match(new RegExp(`data-testid="${testid}"[^>]*>([^<]*)`, "i"));
  if (!match) throw new Error(`history field missing: data-testid=${testid}`);
  return match[1]!.trim();
}

function submitFormAttrs(html: string, testid: string): { action: string; method: string } {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    if (form[2]!.includes(`data-testid="${testid}"`)) {
      const action = form[1]!.match(/action="([^"]+)"/i)?.[1] ?? "";
      const method = (form[1]!.match(/method="([^"]+)"/i)?.[1] ?? "get").toLowerCase();
      return { action, method };
    }
  }
  throw new Error(`submit control has no form: data-testid=${testid}`);
}

async function offeredPresets(fixture: Fixture): Promise<{ preset: string; accent: string }> {
  const res = await fixture.get(fixture.cookies.alice);
  expect(res.status).toBe(200);
  const html = await res.text();
  const presets = offeredValues(html, "overlay-theme-preset");
  const accents = offeredValues(html, "overlay-theme-accent");
  expect(presets.length).toBeGreaterThanOrEqual(2);
  expect(accents.length).toBeGreaterThanOrEqual(2);
  return { preset: presets[0]!, accent: accents[0]! };
}

function validConfig(preset: string, accent: string): OverlayConfig {
  return {
    elements: {
      showIdentity: true,
      avatar: false,
      liveLine: "custom",
      customText: "Alice streams Tuesdays",
      layout: "banner",
    },
    theme: { preset, accent },
  };
}

describe("overlay settings contract loader", () => {
  it("fails cleanly while the slice is missing, or returns the factory once it lands", async () => {
    try {
      const mod = await loadOverlayModule();
      expect(typeof mod.overlayApp).toBe("function");
    } catch (error) {
      expect((error as Error).message).toBe(NOT_IMPLEMENTED);
    }
  });

  it("pins the profile gate precedent this slice mirrors: guest bounces to OAuth", async () => {
    const sessions = createMemorySessionStore();
    const app = profilesApp({
      sessionStore: sessions,
      store: createMemoryProfileStore([]),
      accessLog: async () => true,
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request("/profile", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it("pins the profile gate precedent: signed-in non-member gets 403", async () => {
    const sessions = createMemorySessionStore();
    const { cookie } = await seedSession(sessions, OUTSIDER);
    const app = profilesApp({
      sessionStore: sessions,
      store: createMemoryProfileStore([]),
      accessLog: async () => true,
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request("/profile", { headers: { cookie } }, env);
    expect(res.status).toBe(403);
  });

  it("pins the profile write throttle number this slice mirrors", () => {
    expect(PROFILE_WRITE_THROTTLE_PER_MINUTE).toBe(30);
  });
});

describe("overlay settings session gate", () => {
  it("guest GET bounces to OAuth and records the intended page", async () => {
    const fixture = await setup();
    const res = await fixture.get();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("set-cookie") ?? "").toContain("__Host-two_login_intended");
    expect(fixture.accessLog).not.toHaveBeenCalled();
  });

  it("guest PATCH and rotate/revoke POSTs bounce as writes, never into a re-submit", async () => {
    const fixture = await setup();
    for (const res of [
      await fixture.patchJson({ elements: {}, theme: {} }),
      await fixture.postForm("/overlay/rotate", {}),
      await fixture.postForm("/overlay/revoke", {}),
    ]) {
      expect(res.status).toBe(303);
    }
    expect(fixture.configs.save).not.toHaveBeenCalled();
    expect(fixture.tokens.rotate).not.toHaveBeenCalled();
    expect(fixture.tokens.revoke).not.toHaveBeenCalled();
  });

  it("malformed bearer is a guest with zero session-store reads", async () => {
    const fixture = await setup();
    const get = vi.spyOn(fixture.sessions, "get");
    const statusHash = vi.spyOn(fixture.sessions, "statusHash");
    const res = await fixture.get(`${SESSION_COOKIE}=bogus`);
    expect(res.status).toBe(302);
    expect(get).not.toHaveBeenCalled();
    expect(statusHash).not.toHaveBeenCalled();
  });

  it("unknown bearer (revoked/expired/rotated) bounces like a guest", async () => {
    const fixture = await setup();
    const cookie = await signedCookie(newSessionToken());
    const res = await fixture.get(cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it("signed-in non-member gets 403 with nothing rendered and nothing logged", async () => {
    const fixture = await setup({
      tokens: memoryTokens({ [ALICE.userId]: [LIVE_TOKEN] }),
    });
    const res = await fixture.get(fixture.cookies.outsider);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).not.toContain("overlay-settings-form");
    expect(html).not.toContain("overlay-token-history");
    expect(fixture.accessLog).not.toHaveBeenCalled();
    const write = await fixture.patchJson({ elements: {}, theme: {} }, fixture.cookies.outsider);
    expect(write.status).toBe(403);
    expect(fixture.configs.save).not.toHaveBeenCalled();
  });

  it("session-store failure fails closed with 503", async () => {
    const sessions = createMemorySessionStore();
    const { cookie } = await seedSession(sessions, ALICE);
    const failing = {
      ...sessions,
      get: async (): Promise<never> => {
        throw new Error("store down");
      },
    } as SessionStore;
    const fixture = await setup({ sessionStore: failing });
    const res = await fixture.get(cookie);
    expect(res.status).toBe(503);
  });

  it("member GET renders the settings page with private no-store caching", async () => {
    const fixture = await setup();
    const res = await fixture.get(fixture.cookies.alice);
    expect(res.status).toBe(200);
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("private");
    expect(cache).toContain("no-store");
    const html = await res.text();
    expect(html).toContain('data-testid="overlay-settings-form"');
    expect(html).toContain('data-testid="overlay-token-history"');
    expect(html).toContain('data-testid="overlay-rotate"');
    expect(html).toContain('data-testid="overlay-revoke"');
    expect(fixture.accessLog).toHaveBeenCalled();
  });
});

describe("overlay settings owner-only writes", () => {
  it("one member's PATCH leaves every other member's config untouched", async () => {
    const bobBefore = validConfig("seed-preset", "seed-accent");
    const fixture = await setup({
      configs: memoryConfigs({ [BOB.userId]: bobBefore }),
    });
    const { preset, accent } = await offeredPresets(fixture);
    const res = await fixture.patchJson(validConfig(preset, accent), fixture.cookies.alice);
    expect(res.status).toBe(200);
    expect(fixture.configs.rows.get(BOB.userId)).toEqual(bobBefore);
    expect(fixture.configs.rows.get(ALICE.userId)).toEqual(validConfig(preset, accent));
  });

  it("a moderator PATCH writes only the moderator's own row", async () => {
    const fixture = await setup();
    const { preset, accent } = await offeredPresets(fixture);
    const res = await fixture.patchJson(validConfig(preset, accent), fixture.cookies.mod);
    expect(res.status).toBe(200);
    expect(fixture.configs.rows.get(MOD.userId)).toEqual(validConfig(preset, accent));
    expect(fixture.configs.rows.has(ALICE.userId)).toBe(false);
  });

  it("there is no cross-user surface: subpaths and foreign methods 404", async () => {
    const fixture = await setup();
    expect((await fixture.app.request("/overlay/other", {}, env)).status).toBe(404);
    expect((await fixture.app.request(`/overlay/${BOB.userId}`, {}, env)).status).toBe(404);
    expect((await fixture.app.request("/overlay/", {}, env)).status).toBe(404);
    expect(
      (
        await fixture.app.request(
          "/overlay",
          { method: "PUT", headers: { cookie: fixture.cookies.alice } },
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fixture.app.request(
          "/overlay",
          { method: "DELETE", headers: { cookie: fixture.cookies.alice } },
          env,
        )
      ).status,
    ).toBe(404);
  });

  it("one member's rotate leaves the other member's tokens untouched", async () => {
    const bobTokens = [structuredClone(LIVE_TOKEN)];
    const fixture = await setup({
      tokens: memoryTokens({ [BOB.userId]: bobTokens }),
    });
    const res = await fixture.postForm("/overlay/rotate", {}, fixture.cookies.alice);
    expect(res.status).toBe(303);
    expect(fixture.tokens.rows.get(BOB.userId)).toEqual(bobTokens);
  });
});

describe("overlay settings write throttle", () => {
  it("exports the 30/min budget the spec pins", async () => {
    const mod = await loadOverlayModule();
    expect(mod.OVERLAY_WRITE_THROTTLE_PER_MINUTE).toBe(30);
  });

  it("a limited verdict refuses every write with 429 and Retry-After, writing nothing", async () => {
    const fixture = await setup({
      throttle: async () => ({ limited: true, retryAfter: 7 }),
    });
    const { preset, accent } = await offeredPresets(fixture);
    for (const res of [
      await fixture.patchJson(validConfig(preset, accent), fixture.cookies.alice),
      await fixture.postForm("/overlay/rotate", {}, fixture.cookies.alice),
      await fixture.postForm("/overlay/revoke", {}, fixture.cookies.alice),
    ]) {
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("7");
    }
    expect(fixture.configs.save).not.toHaveBeenCalled();
    expect(fixture.tokens.rotate).not.toHaveBeenCalled();
    expect(fixture.tokens.revoke).not.toHaveBeenCalled();
  });

  it("throttles writes per viewer and never reads", async () => {
    const seen: string[] = [];
    const fixture = await setup({
      throttle: async (bucket: string) => {
        seen.push(bucket);
        return { limited: false };
      },
    });
    const { preset, accent } = await offeredPresets(fixture);
    const readsBefore = seen.length;
    await fixture.get(fixture.cookies.alice);
    expect(seen.length).toBe(readsBefore);
    await fixture.patchJson(validConfig(preset, accent), fixture.cookies.alice);
    await fixture.patchJson(validConfig(preset, accent), fixture.cookies.alice);
    await fixture.patchJson(validConfig(preset, accent), fixture.cookies.bob);
    const [aliceFirst, aliceSecond, bobFirst] = seen.slice(-3);
    expect(aliceFirst).toBe(aliceSecond);
    expect(aliceFirst).not.toBe(bobFirst);
    const writesBefore = seen.length;
    await fixture.postForm("/overlay/rotate", {}, fixture.cookies.alice);
    await fixture.postForm("/overlay/revoke", {}, fixture.cookies.alice);
    expect(seen.length).toBe(writesBefore + 2);
  });
});

describe("overlay config PATCH validation", () => {
  it("accepts a complete valid config, persists it, and reflects it on GET", async () => {
    const fixture = await setup();
    const { preset, accent } = await offeredPresets(fixture);
    const body = validConfig(preset, accent);
    const res = await fixture.patchJson(body, fixture.cookies.alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true });
    expect(fixture.configs.save).toHaveBeenCalledTimes(1);
    expect(fixture.configs.rows.get(ALICE.userId)).toEqual(body);
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    expect(html).toContain("Alice streams Tuesdays");
  });

  it.each([
    ["overlong custom text", { customText: "x".repeat(141) }],
    ["unknown element key", { unknownKey: true }],
    ["watermark toggle", { watermark: false }],
    ["renamed watermark toggle", { showWatermark: false }],
    ["off-enum layout", { layout: "masonry" }],
    ["off-enum live line", { liveLine: "ticker" }],
    ["mistyped avatar", { avatar: "yes" }],
  ])("rejects %s with 422 and writes nothing", async (_label, elementsPatch) => {
    const fixture = await setup();
    const { preset, accent } = await offeredPresets(fixture);
    const body = validConfig(preset, accent);
    (body.elements as Record<string, unknown>) = {
      ...(body.elements as Record<string, unknown>),
      ...elementsPatch,
    };
    const res = await fixture.patchJson(body, fixture.cookies.alice);
    expect(res.status).toBe(422);
    expect(fixture.configs.save).not.toHaveBeenCalled();
  });

  it.each([
    ["off-enum theme preset", { preset: "not-a-real-preset", accent: null as string | null }],
    ["free-hex accent", { preset: null, accent: "#ff0000" }],
    ["free-hex theme preset", { preset: "#0b0b0b", accent: null }],
    ["short free hex", { preset: null, accent: "#fff" }],
  ])("rejects %s with 422 and writes nothing", async (_label, themePatch) => {
    const fixture = await setup();
    const { preset, accent } = await offeredPresets(fixture);
    const res = await fixture.patchJson(
      {
        ...validConfig(preset, accent),
        theme: {
          preset: themePatch.preset ?? preset,
          accent: themePatch.accent ?? accent,
        },
      },
      fixture.cookies.alice,
    );
    expect(res.status).toBe(422);
    expect(fixture.configs.save).not.toHaveBeenCalled();
  });

  it("rejects a mistyped theme object with 422", async () => {
    const fixture = await setup();
    const { preset, accent } = await offeredPresets(fixture);
    const res = await fixture.patchJson(
      { ...validConfig(preset, accent), theme: "dark" },
      fixture.cookies.alice,
    );
    expect(res.status).toBe(422);
    expect(fixture.configs.save).not.toHaveBeenCalled();
  });

  it("accepts a native form POST with _method=PATCH, 303s back, and saves", async () => {
    const fixture = await setup();
    const { preset, accent } = await offeredPresets(fixture);
    const res = await fixture.postForm(
      "/overlay",
      {
        _method: "PATCH",
        show_identity: "1",
        live_line: "custom",
        custom_text: "Native save works",
        layout: "compact",
        theme_preset: preset,
        theme_accent: accent,
      },
      fixture.cookies.alice,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toMatch(/\/overlay$/);
    expect(fixture.configs.rows.get(ALICE.userId)).toMatchObject({
      elements: {
        showIdentity: true,
        avatar: false,
        liveLine: "custom",
        customText: "Native save works",
        layout: "compact",
      },
      theme: { preset, accent },
    });
  });

  it("rejects an invalid native form POST with 422 and writes nothing", async () => {
    const fixture = await setup();
    const { preset } = await offeredPresets(fixture);
    const res = await fixture.postForm(
      "/overlay",
      {
        _method: "PATCH",
        show_identity: "1",
        avatar: "1",
        live_line: "auto",
        custom_text: "",
        layout: "compact",
        theme_preset: preset,
        theme_accent: "#ff0000",
      },
      fixture.cookies.alice,
    );
    expect(res.status).toBe(422);
    expect(fixture.configs.save).not.toHaveBeenCalled();
  });
});

describe("overlay settings page content", () => {
  it("offers theme and accent as a closed preset list with no free-hex control", async () => {
    const fixture = await setup();
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    const form = formBlock(html);
    expect(offeredValues(html, "overlay-theme-preset").length).toBeGreaterThanOrEqual(2);
    expect(offeredValues(html, "overlay-theme-accent").length).toBeGreaterThanOrEqual(2);
    expect(form).not.toContain('type="color"');
    expect(form.match(/<input\b[^>]*name="[^"]*(hex|color)[^"]*"[^>]*>/gi) ?? []).toEqual([]);
  });

  it("renders no watermark toggle anywhere on the settings form", async () => {
    const fixture = await setup();
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    const form = formBlock(html);
    const controls = form.match(/<(input|select|textarea|button)\b[^>]*>/gi) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.toLowerCase()).not.toContain("watermark");
    }
  });

  it("renders created/rotated/last-used/use-count history per token", async () => {
    const fixture = await setup({
      tokens: memoryTokens({ [ALICE.userId]: [LIVE_TOKEN, ROTATED_TOKEN] }),
    });
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    const rows = historyRows(historyBlock(html));
    expect(rows).toHaveLength(2);
    const expectations = [
      { status: "live", created: "2026-10-01", lastUsed: "2026-10-20", useCount: "42" },
      { status: "rotated", created: "2026-09-01", lastUsed: "2026-10-01", useCount: "137" },
    ];
    for (const [index, row] of rows.entries()) {
      const expected = expectations[index]!;
      expect(fieldText(row, "overlay-token-status").toLowerCase()).toBe(expected.status);
      expect(fieldText(row, "overlay-token-created")).toContain(expected.created);
      expect(fieldText(row, "overlay-token-last-used")).toContain(expected.lastUsed);
      expect(fieldText(row, "overlay-token-use-count")).toContain(expected.useCount);
    }
    expect(fieldText(rows[1]!, "overlay-token-rotated")).toContain("2026-10-01");
  });

  it("never re-renders a token secret: history shows masked refs, never plaintext", async () => {
    const fixture = await setup({
      tokens: memoryTokens({ [ALICE.userId]: [LIVE_TOKEN, ROTATED_TOKEN] }),
    });
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    expect(html).not.toContain("two_ov_");
    expect(html).toContain("…a1b2");
    expect(html).toContain("…c3d4");
  });

  it("rotate and revoke are native submit controls posting to their endpoints", async () => {
    const fixture = await setup();
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    expect(submitFormAttrs(html, "overlay-rotate")).toEqual({
      action: "/overlay/rotate",
      method: "post",
    });
    expect(submitFormAttrs(html, "overlay-revoke")).toEqual({
      action: "/overlay/revoke",
      method: "post",
    });
  });
});

describe("overlay token rotate and revoke", () => {
  it("native rotate POST 303s and the follow-up GET shows the new URL once", async () => {
    const fixture = await setup();
    const rotated = await fixture.postForm("/overlay/rotate", {}, fixture.cookies.alice);
    expect(rotated.status).toBe(303);
    expect(rotated.headers.get("location") ?? "").toMatch(/\/overlay$/);
    expect(fixture.tokens.rotate).toHaveBeenCalledTimes(1);
    expect(fixture.tokens.rotate).toHaveBeenCalledWith(ALICE.userId);
    const flash = rotated.headers.get("set-cookie") ?? "";
    const first = await fixture.app.request(
      "/overlay",
      { headers: { cookie: [fixture.cookies.alice, flash.split(";")[0]].join("; ") } },
      env,
    );
    expect(first.status).toBe(200);
    const once = await first.text();
    expect(once).toContain('data-testid="overlay-new-url"');
    expect(once).toMatch(/\/o\/two_ov_[A-Za-z0-9_-]+/);
    const rows = historyRows(historyBlock(once));
    expect(rows.map((row) => fieldText(row, "overlay-token-status").toLowerCase())).toEqual([
      "rotated",
      "live",
    ]);
    const later = await (await fixture.get(fixture.cookies.alice)).text();
    expect(later).not.toContain("two_ov_");
  });

  it("JSON rotate POST returns the new URL once", async () => {
    const fixture = await setup();
    const res = await fixture.postJson("/overlay/rotate", fixture.cookies.alice);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: unknown };
    expect(typeof body.url).toBe("string");
    expect(body.url as string).toMatch(/\/o\/two_ov_[A-Za-z0-9_-]+/);
    const later = await (await fixture.get(fixture.cookies.alice)).text();
    expect(later).not.toContain("two_ov_");
  });

  it("native revoke POST 303s and the token reads revoked afterwards", async () => {
    const fixture = await setup({
      tokens: memoryTokens({ [ALICE.userId]: [structuredClone(LIVE_TOKEN)] }),
    });
    const revoked = await fixture.postForm("/overlay/revoke", {}, fixture.cookies.alice);
    expect(revoked.status).toBe(303);
    expect(fixture.tokens.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.tokens.revoke).toHaveBeenCalledWith(ALICE.userId);
    const html = await (await fixture.get(fixture.cookies.alice)).text();
    const rows = historyRows(historyBlock(html));
    expect(rows).toHaveLength(1);
    expect(fieldText(rows[0]!, "overlay-token-status").toLowerCase()).toBe("revoked");
  });

  it("JSON revoke POST answers { revoked: true }", async () => {
    const fixture = await setup();
    const res = await fixture.postJson("/overlay/revoke", fixture.cookies.alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });
  });

  it("non-member rotate/revoke writes are refused without touching the store", async () => {
    const fixture = await setup();
    for (const res of [
      await fixture.postForm("/overlay/rotate", {}, fixture.cookies.outsider),
      await fixture.postForm("/overlay/revoke", {}, fixture.cookies.outsider),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(fixture.tokens.rotate).not.toHaveBeenCalled();
    expect(fixture.tokens.revoke).not.toHaveBeenCalled();
  });
});

describe("overlay settings production wiring", () => {
  it("the worker serves /overlay through the session gate", async () => {
    const res = await testApp.request("/overlay", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it("the worker bounces guest overlay writes", async () => {
    // Same-origin PATCH, as a browser sends it: without Origin the global
    // same-origin guard 403s before the route gate ever runs.
    const res = await testApp.request(
      "/overlay",
      {
        method: "PATCH",
        headers: { origin: APP_URL, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(303);
  });
});

const SCREENSHOT_DIR = join(tmpdir(), "overlay-settings-acceptance");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function overlayScreenshotPaths() {
  return {
    desktop: join(SCREENSHOT_DIR, "overlay-settings-desktop.png"),
    mobile: join(SCREENSHOT_DIR, "overlay-settings-mobile.png"),
  };
}

function expectPng(path: string): void {
  expect(existsSync(path), `screenshot written: ${path}`).toBe(true);
  const bytes = readFileSync(path);
  expect(bytes.length, `${path} non-trivial`).toBeGreaterThan(1024);
  expect(bytes.subarray(0, 4).equals(PNG_MAGIC), `${path} is a PNG`).toBe(true);
}

// Real Chromium over the real SSR page and shipped assets. Browser cases are
// opt-in where Chromium is installed:
// OVERLAY_SETTINGS_BROWSER_TESTS=true npx vitest run test/overlay-member-settings-acceptance.test.ts
describe.skipIf(process.env.OVERLAY_SETTINGS_BROWSER_TESTS !== "true")(
  "overlay member settings rotate/revoke in a real browser",
  () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    const servers: Server[] = [];
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    });

    function staticAsset(pathname: string): { body: Buffer; contentType: string } | null {
      if (
        pathname !== "/styles.css" &&
        !pathname.startsWith("/islands/") &&
        !pathname.startsWith("/public/") &&
        pathname !== "/logo.svg" &&
        pathname !== "/favicon.ico"
      ) {
        return null;
      }
      const file = join("public", pathname.startsWith("/public/") ? pathname.slice(8) : pathname);
      if (!existsSync(file)) return null;
      const contentType = file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : "application/octet-stream";
      return { body: readFileSync(file), contentType };
    }

    async function openSettings(options: {
      width: number;
      height: number;
      javaScriptEnabled: boolean;
    }): Promise<Fixture & { page: Page; base: string }> {
      const fixture = await setup({
        tokens: memoryTokens({ [ALICE.userId]: [structuredClone(LIVE_TOKEN)] }),
      });
      const context = await browser.newContext({
        javaScriptEnabled: options.javaScriptEnabled,
        viewport: { width: options.width, height: options.height },
        serviceWorkers: "block",
      });
      contexts.push(context);
      let base = "";
      const server = createServer(async (request, reply) => {
        try {
          const url = new URL(request.url!, base);
          const asset = staticAsset(url.pathname);
          if (asset) {
            reply.writeHead(200, { "content-type": asset.contentType });
            reply.end(asset.body);
            return;
          }
          if (!url.pathname.startsWith("/overlay")) {
            reply.writeHead(204);
            reply.end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) {
              headers.set(name, Array.isArray(value) ? value.join(",") : value);
            }
          }
          const response = await fixture.app.request(
            url.href,
            {
              method: request.method,
              headers,
              body: chunks.length ? Buffer.concat(chunks) : undefined,
            },
            { ...env, APP_URL: base },
          );
          reply.writeHead(response.status, Object.fromEntries(response.headers));
          reply.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          reply.writeHead(500);
          reply.end(String(error));
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const separator = fixture.cookies.alice.indexOf("=");
      await context.addCookies([
        {
          name: fixture.cookies.alice.slice(0, separator),
          value: fixture.cookies.alice.slice(separator + 1),
          url: `${base.replace("http:", "https:")}/`,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      page.on("dialog", (dialog) => void dialog.accept());
      await page.goto(`${base}/overlay`);
      await page.getByTestId("overlay-settings-form").waitFor();
      return { ...fixture, page, base };
    }

    async function clickAndSettle(page: Page, testid: string): Promise<void> {
      const navigation = page.waitForNavigation({ timeout: 5000 }).catch(() => null);
      await page.getByTestId(testid).click();
      await navigation;
    }

    it("rotates through the UI: new URL once, masked on reload, desktop screenshot", async () => {
      const { page } = await openSettings({ width: 1280, height: 800, javaScriptEnabled: true });
      await clickAndSettle(page, "overlay-rotate");
      const once = page.getByTestId("overlay-new-url");
      await once.waitFor({ timeout: 5000 });
      expect(await once.textContent()).toMatch(/\/o\/two_ov_[A-Za-z0-9_-]+/);
      await page.getByTestId("overlay-token-history").waitFor();
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: overlayScreenshotPaths().desktop });
      expectPng(overlayScreenshotPaths().desktop);
      await page.reload();
      await page.getByTestId("overlay-settings-form").waitFor();
      expect(await page.content()).not.toContain("two_ov_");
    }, 30_000);

    it("renders the settings page on a mobile viewport, mobile screenshot", async () => {
      const { page } = await openSettings({ width: 390, height: 844, javaScriptEnabled: true });
      await page.getByTestId("overlay-token-history").waitFor();
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: overlayScreenshotPaths().mobile });
      expectPng(overlayScreenshotPaths().mobile);
    }, 30_000);

    it("revokes through the UI without JavaScript (native form path)", async () => {
      const { page } = await openSettings({ width: 1280, height: 800, javaScriptEnabled: false });
      await clickAndSettle(page, "overlay-revoke");
      await page.getByTestId("overlay-token-history").waitFor();
      const statuses = await page.getByTestId("overlay-token-status").allTextContents();
      expect(statuses.map((status) => status.trim().toLowerCase())).toContain("revoked");
      await page.reload();
      await page.getByTestId("overlay-token-history").waitFor();
      const again = await page.getByTestId("overlay-token-status").allTextContents();
      expect(again.map((status) => status.trim().toLowerCase())).toContain("revoked");
    }, 30_000);
  },
);
