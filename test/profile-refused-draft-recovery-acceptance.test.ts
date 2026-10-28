// Acceptance contract: a profile save that passes owner admission, bounded
// parsing and validation but hits a classified retryable store failure must
// return the private no-store editor with the submitted bounded draft, the
// original saved baseline intact, and honest failure/uncertainty guidance.
// Pre-admission 429/403/auth refusals must never echo a draft or add reads.
//
// Stored profile "A" and submitted draft "B" below are synthetic. Everything
// runs on the real profiles routes, the real SSR page and the shipped
// public/islands/member-profile.js binder over in-memory stores. No database,
// staging identity or external service is used.
//
// Contract definitions used here (the builder implements these exact shapes):
// - Unavailable (definitely failed, safe to retry): a transport / server
//   outage error where isDatabaseUnavailable is true and
//   isDatabaseQueryCancellation is false (for example ECONNREFUSED). Native
//   answers 503 HTML editor; JSON answers 503 {error:"db_unavailable"} with
//   explicit try-again guidance and no uncertain language.
// - Unknown-write (outcome unknown, may have committed): a cancellation error
//   where isDatabaseQueryCancellation is true (PostgresError 57014 or 55P03).
//   Native answers 503 HTML editor with uncertain guidance ("may still have
//   gone through", never "not saved"/"failed"); JSON answers 503
//   {error:"profile_save_uncertain"} with the same uncertain copy. The island
//   maps that code to the existing profile-uncertain notice, never saveFailed.
// - Throttled (429): the island reads a bounded Retry-After (header wins,
//   body retry_after falls back, using the shared parseRetryAfterSeconds
//   posture: numeric-only delta-seconds, fractions round up, absurd caps at
//   86400, anything else falls back) and names a useful manual retry time in
//   a throttled notice (profile-save-throttled when present, otherwise the
//   enhanced profile-save-failed). No automatic resend.
// - Arbitrary programming faults (no transport/cancellation code) stay generic
//   500s with no draft echo. Unproven 2xx bodies stay saveFailed (existing
//   pins stand; out of scope to reclassify here).
// - Recovery is manual Save/Cancel (existing keyboard-reachable controls).
//   Any new retry control the builder adds must meet the same bar: keyboard
//   reachable, submits the current draft (never a stale B), and never sends
//   while a write is pending.
//
// The browser cases are opt-in where Chromium is installed:
// A11Y_BROWSER_TESTS=true npx vitest run test/profile-refused-draft-recovery-acceptance.test.ts
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { isDatabaseQueryCancellation, isDatabaseUnavailable } from "../src/db/errors";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("postgres", () => ({
  default: () => {
    throw new Error("refused-draft fixtures must not open a database");
  },
}));

const ID = "100000000000000001";
const OTHER = "100000000000000002";
const env = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const BROWSER_ACCEPT = "text/html,application/xhtml+xml";
const MACHINE_ACCEPT = "application/json";

// A: what the server has stored. B: the valid bounded draft the member
// submits; every field differs so A/B separation is observable.
const A = {
  bio: "Stored bio A",
  games: ["Stored Game A"],
  games_text: "Stored Game A",
  timezone: "Europe/London",
  leaderboardOptOut: false,
};
const B = {
  bio: "Submitted bio B keeps accents café",
  games_text: "Submitted Game B\nSecond Game B",
  timezone: "Asia/Tokyo",
  leaderboard_opt_out: "1",
};
// Boundary-valid draft: every bounded field at its documented max.
const B_MAX = {
  bio: "m".repeat(1000),
  games_text: Array.from({ length: 20 }, (_, i) => `game-${i}-${"g".repeat(70)}`.slice(0, 80)).join(
    "\n",
  ),
  timezone: "Pacific/Kiritimati",
  leaderboard_opt_out: "1",
};

function unavailableError() {
  // Transport outage: definitely failed before commit, safe to retry.
  const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  expect(isDatabaseUnavailable(err)).toBe(true);
  expect(isDatabaseQueryCancellation(err)).toBe(false);
  return err;
}

function unknownWriteError(code = "57014") {
  // Statement cancellation: the write may still have committed.
  const err = Object.assign(new Error("statement cancelled"), {
    name: "PostgresError",
    code,
  });
  expect(isDatabaseUnavailable(err)).toBe(true);
  expect(isDatabaseQueryCancellation(err)).toBe(true);
  return err;
}

function genericError() {
  const err = new Error("plain programming fault");
  expect(isDatabaseUnavailable(err)).toBe(false);
  expect(isDatabaseQueryCancellation(err)).toBe(false);
  return err;
}

async function setup(
  options: {
    saveThrows?: () => unknown;
    throttle?: (
      bucket: string,
    ) => Promise<{ limited: false } | { limited: true; retryAfter: number }>;
  } = {},
) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: ID,
    username: "alice",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const otherToken = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(otherToken),
    userId: OTHER,
    username: "bob",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const sign = (value: string) =>
    serializeSigned("__Host-two_session", value, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    }).then((signed) => signed.split(";")[0]!);
  const cookie = await sign(token);
  const otherCookie = await sign(otherToken);
  const member = {
    id: ID,
    username: "alice",
    avatar: null,
    bio: A.bio,
    games: [...A.games],
    timezone: A.timezone,
    leaderboardOptOut: A.leaderboardOptOut,
  };
  const store = createMemoryProfileStore([
    member,
    { id: OTHER, username: "bob", avatar: null, bio: null, games: [], timezone: null },
  ]);
  const find = vi.spyOn(store, "find");
  const save = vi.spyOn(store, "save");
  if (options.saveThrows) {
    const throws = options.saveThrows;
    save.mockImplementation(async () => {
      throw throws();
    });
  }
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: options.throttle ?? (async () => ({ limited: false })),
  });
  const nativePost = (fields: Record<string, string>, accept = BROWSER_ACCEPT, auth = cookie) =>
    app.request(
      `/members/${ID}`,
      {
        method: "POST",
        headers: {
          cookie: auth,
          origin: env.APP_URL,
          accept,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _method: "PATCH",
          [PROFILE_HONEY_FIELD]: "",
          [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000),
          ...fields,
        }).toString(),
      },
      env,
    );
  const jsonPatch = (
    body: Record<string, unknown>,
    accept = MACHINE_ACCEPT,
    auth = cookie,
    target = ID,
  ) =>
    app.request(
      `/members/${target}`,
      {
        method: "PATCH",
        headers: {
          cookie: auth,
          origin: env.APP_URL,
          accept,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          [PROFILE_HONEY_FIELD]: "",
          [PROFILE_OPENED_AT_FIELD]: Date.now() - 5000,
        }),
      },
      env,
    );
  return { app, sessions, cookie, otherCookie, store, find, save, nativePost, jsonPatch };
}

function cacheDirectives(value: string | null) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .sort();
}

describe("refused drafts: native editor retains classified failures", () => {
  it("unavailable native save returns the 503 editor with B in the controls and A intact", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { nativePost, save, find, store } = await setup({
        saveThrows: unavailableError,
      });
      const res = await nativePost({ ...B });
      expect(res.status).toBe(503);
      expect(cacheDirectives(res.headers.get("cache-control"))).toEqual(["no-store", "private"]);
      expect(res.headers.get("vary")).toContain("Accept");
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();

      // The editor survives: not the generic outage shell.
      expect(html).toContain('data-testid="profile-form"');
      expect(html).toContain('data-testid="profile-save"');
      expect(html).toContain('data-testid="profile-cancel"');
      expect(html).not.toContain("We will be right back");
      expect(html).not.toContain("Something broke on our side");
      // B stays in the controls so the member can retry it manually.
      expect(html).toContain(`>${B.bio}</textarea>`);
      expect(html).toContain(`>${B.games_text}</textarea>`);
      expect(html).toContain(`value="${B.timezone}"`);
      expect(html).toMatch(/id="profile-leaderboard-opt-out"[^>]*checked/);
      // The saved baseline is still A: display, data-saved-* and storage.
      expect(html).toContain(A.bio);
      expect(html).toContain(`Timezone: ${A.timezone}`);
      expect(html).toContain(`data-saved-bio="${A.bio}"`);
      expect(html).toContain(`data-saved-games-text="${A.games_text}"`);
      expect(html).toContain(`data-saved-timezone="${A.timezone}"`);
      expect(html).toContain('data-saved-leaderboard-opt-out="0"');
      // Honest unavailable guidance: definitely failed, safe to retry; never uncertain.
      expect(html).toMatch(/try again/i);
      expect(html).not.toMatch(/may still have gone through/i);
      // One admission read plus the attempted write; nothing persisted.
      expect(find).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(await store.find(ID)).toMatchObject({
        bio: A.bio,
        games: A.games,
        timezone: A.timezone,
        leaderboardOptOut: A.leaderboardOptOut,
      });
      // The failure log carries no draft text.
      expect(errorSpy.mock.calls.map((args) => String(args[0])).join("\n")).not.toContain(B.bio);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(["57014", "55P03"])(
    "unknown-write native save (%s) returns the 503 editor with uncertain guidance, never a failure claim",
    async (code) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { nativePost, save, find, store } = await setup({
          saveThrows: () => unknownWriteError(code),
        });
        const res = await nativePost({ ...B });
        expect(res.status).toBe(503);
        expect(cacheDirectives(res.headers.get("cache-control"))).toEqual(["no-store", "private"]);
        expect(res.headers.get("content-type")).toContain("text/html");
        const html = await res.text();

        expect(html).toContain('data-testid="profile-form"');
        expect(html).toContain(`>${B.bio}</textarea>`);
        expect(html).toContain(`data-saved-bio="${A.bio}"`);
        expect(html).toContain(A.bio);
        // Uncertain copy: may have committed, so check before retrying; never
        // a definitive failure claim.
        expect(html).toMatch(/may still have gone through/i);
        expect(html).not.toMatch(
          /was not saved|did not save|not saved|save failed|failed to save/i,
        );
        expect(find).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(1);
        expect(await store.find(ID)).toMatchObject({ bio: A.bio });
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("boundary-valid draft is retained bounded without truncation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { nativePost, store } = await setup({ saveThrows: unavailableError });
      const res = await nativePost({ ...B_MAX });
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain('data-testid="profile-form"');
      expect(html).toContain(`>${B_MAX.bio}</textarea>`);
      expect(html).toContain(`>${B_MAX.games_text}</textarea>`);
      expect(html).toContain(`value="${B_MAX.timezone}"`);
      expect(html).toContain(`data-saved-bio="${A.bio}"`);
      expect(await store.find(ID)).toMatchObject({ bio: A.bio });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a retry after the outage saves the retained draft once", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let attempts = 0;
      const { nativePost, save, store } = await setup({
        saveThrows: () => {
          attempts += 1;
          if (attempts === 1) throw unavailableError();
          return undefined as never;
        },
      });
      // First attempt hits the outage and keeps the editor; the mock above
      // throws only once, so remove it for the manual retry.
      const refused = await nativePost({ ...B });
      expect(refused.status).toBe(503);
      expect(await refused.text()).toContain('data-testid="profile-form"');
      save.mockRestore();
      const retrySave = vi.spyOn(store, "save");
      const retry = await nativePost({ ...B });
      expect(retry.status).toBe(303);
      expect(retrySave).toHaveBeenCalledTimes(1);
      expect(await store.find(ID)).toMatchObject({
        bio: B.bio,
        games: ["Submitted Game B", "Second Game B"],
        timezone: B.timezone,
        leaderboardOptOut: true,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("arbitrary programming faults stay generic 500s with no draft echo", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { nativePost, jsonPatch, store } = await setup({ saveThrows: genericError });
      const page = await nativePost({ ...B });
      expect(page.status).toBe(500);
      const html = await page.text();
      expect(html).toContain("Something broke on our side");
      expect(html).not.toContain('data-testid="profile-form"');
      expect(html).not.toContain(B.bio);
      const machine = await jsonPatch({ bio: B.bio, games: [], timezone: B.timezone });
      expect(machine.status).toBe(500);
      expect(await machine.text()).toBe("Could not save your profile.");
      expect(await store.find(ID)).toMatchObject({ bio: A.bio });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("pre-admission refusals never echo drafts or add reads", () => {
  it("throttled native save is the generic 429 with no draft and no store touch", async () => {
    const { nativePost, find, save } = await setup({
      throttle: async () => ({ limited: true, retryAfter: 37 }),
    });
    const res = await nativePost({ ...B });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("37");
    const html = await res.text();
    expect(html).toContain("Slow down a little");
    expect(html).not.toContain(B.bio);
    expect(html).not.toContain(B.games_text);
    expect(html).not.toContain('data-testid="profile-form"');
    expect(find).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("throttled JSON save keeps the rate-limited envelope with no draft", async () => {
    const { jsonPatch, find, save } = await setup({
      throttle: async () => ({ limited: true, retryAfter: 17 }),
    });
    const res = await jsonPatch({ bio: B.bio, games: [], timezone: B.timezone });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 17 });
    expect(find).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("non-owner native and JSON writes 403 without echo or save", async () => {
    const { app, otherCookie, store } = await setup();
    const before = await store.find(ID);
    const form = await app.request(
      `/members/${ID}`,
      {
        method: "POST",
        headers: {
          cookie: otherCookie,
          origin: env.APP_URL,
          accept: BROWSER_ACCEPT,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _method: "PATCH",
          [PROFILE_HONEY_FIELD]: "",
          [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000),
          bio: B.bio,
          games_text: B.games_text,
          timezone: B.timezone,
        }).toString(),
      },
      env,
    );
    expect(form.status).toBe(403);
    expect(await form.text()).not.toContain(B.bio);
    const machine = await app.request(
      `/members/${ID}`,
      {
        method: "PATCH",
        headers: {
          cookie: otherCookie,
          origin: env.APP_URL,
          accept: MACHINE_ACCEPT,
          "content-type": "application/json",
        },
        body: JSON.stringify({ bio: B.bio, games: [], timezone: B.timezone }),
      },
      env,
    );
    expect(machine.status).toBe(403);
    expect(await machine.text()).not.toContain(B.bio);
    expect(await store.find(ID)).toEqual(before);
  });

  it("expired-session JSON write 401s with recovery and no draft echo", async () => {
    const sessions = createMemorySessionStore(() => Date.now());
    const token = newSessionToken();
    const now = Date.now();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: ID,
      username: "alice",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(now - 1000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const store = createMemoryProfileStore([
      {
        id: ID,
        username: "alice",
        avatar: null,
        bio: A.bio,
        games: [...A.games],
        timezone: A.timezone,
      },
    ]);
    const save = vi.spyOn(store, "save");
    const app = profilesApp({
      sessionStore: sessions,
      store,
      accessLog: async () => true,
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request(
      `/members/${ID}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          origin: env.APP_URL,
          accept: MACHINE_ACCEPT,
          "content-type": "application/json",
        },
        body: JSON.stringify({ bio: B.bio, games: [], timezone: B.timezone }),
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthenticated",
      recovery: "/auth/recover?next=%2Fprofile",
    });
    expect(save).not.toHaveBeenCalled();
    expect(await store.find(ID)).toMatchObject({ bio: A.bio });
  });

  it("expired-session native write bounces without the draft in the destination", async () => {
    const sessions = createMemorySessionStore(() => Date.now());
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: ID,
      username: "alice",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() - 1000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const store = createMemoryProfileStore([
      {
        id: ID,
        username: "alice",
        avatar: null,
        bio: A.bio,
        games: [...A.games],
        timezone: A.timezone,
      },
    ]);
    const app = profilesApp({
      sessionStore: sessions,
      store,
      accessLog: async () => true,
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request(
      `/members/${ID}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _method: "PATCH",
          [PROFILE_HONEY_FIELD]: "",
          [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000),
          bio: B.bio,
          games_text: B.games_text,
          timezone: B.timezone,
        }).toString(),
      },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).not.toContain(encodeURIComponent(B.bio.slice(0, 8)));
    expect(res.headers.get("location")).not.toContain("Submitted");
  });
});

describe("JSON classified failures distinguish unavailable from unknown", () => {
  it("unavailable JSON names try-again without uncertain language", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { jsonPatch, store } = await setup({ saveThrows: unavailableError });
      const res = await jsonPatch({
        bio: B.bio,
        games: ["Submitted Game B"],
        timezone: B.timezone,
      });
      expect(res.status).toBe(503);
      expect(cacheDirectives(res.headers.get("cache-control"))).toEqual(["no-store", "private"]);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("db_unavailable");
      expect(String(body.message)).toMatch(/try again/i);
      expect(String(body.message)).not.toMatch(/may still have gone through/i);
      expect(JSON.stringify(body)).not.toContain(B.bio);
      expect(await store.find(ID)).toMatchObject({ bio: A.bio });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("unknown-write JSON is uncertain, never a failure claim", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { jsonPatch, store } = await setup({ saveThrows: () => unknownWriteError("57014") });
      const res = await jsonPatch({
        bio: B.bio,
        games: ["Submitted Game B"],
        timezone: B.timezone,
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("profile_save_uncertain");
      expect(String(body.message)).toMatch(/may still have gone through/i);
      expect(String(body.message)).not.toMatch(/was not saved|did not save|not saved|failed/i);
      expect(JSON.stringify(body)).not.toContain(B.bio);
      expect(await store.find(ID)).toMatchObject({ bio: A.bio });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Island fixtures over the shipped binder with deferred fetch/header/body,
// a controllable timer queue, and departure observation. No browser, clock,
// database or live service is used.
const binder = readFileSync("public/islands/member-profile.js", "utf8");
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type IslandResponse = {
  ok: boolean;
  status: number;
  type?: string;
  headers?: { get: (name: string) => string | null };
  json?: () => Promise<unknown>;
};

function headerFixture(entries: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

class IslandElement {
  children: IslandElement[] = [];
  parentNode: IslandElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  hidden = false;
  href = "";
  value = "";
  defaultValue = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  scrolls: unknown[] = [];
  private text = "";
  constructor(
    readonly tag: string,
    readonly document: { activeElement: IslandElement | null },
  ) {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get nextSibling(): IslandElement | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  getAttribute(key: string) {
    return this.attributes[key] ?? null;
  }
  removeAttribute(key: string) {
    delete this.attributes[key];
  }
  appendChild(child: IslandElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: IslandElement, before: IslandElement | null) {
    child.parentNode = this;
    if (before === null) this.children.push(child);
    else this.children.splice(this.children.indexOf(before), 0, child);
  }
  after(node: IslandElement) {
    const parent = this.parentNode!;
    node.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  scrollIntoView(options: unknown) {
    this.scrolls.push(options);
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() {
    this.document.activeElement = this;
  }
  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string) {
    const event = { preventDefault: vi.fn() };
    this.listeners[type]?.forEach((listener) => listener(event));
    return event;
  }
  querySelectorAll(selector: string): IslandElement[] {
    const attr = selector.match(/^\[([^=\^]+)(\^?=)["']([^"']*)["']\]$/);
    return this.children.flatMap((child) => {
      const matches = attr
        ? attr[2] === "^="
          ? child.getAttribute(attr[1]!)?.startsWith(attr[3]!)
          : child.getAttribute(attr[1]!) === attr[3]
        : child.tag === selector;
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface IslandTimer {
  id: number;
  cb: () => void;
  at: number;
}

function islandFixture() {
  const document = {
    activeElement: null as IslandElement | null,
    createElement: (tag: string): IslandElement => new IslandElement(tag, document),
    createTextNode: (text: string): IslandElement => {
      const node = new IslandElement("#text", document);
      node.textContent = text;
      return node;
    },
    querySelector: (selector: string): IslandElement | null => page.querySelector(selector),
  };
  const page = document.createElement("main");
  const node = (parent: IslandElement, tag: string, testid?: string, text?: string) => {
    const el = document.createElement(tag);
    if (testid) el.setAttribute("data-testid", testid);
    if (text) el.textContent = text;
    return parent.appendChild(el);
  };
  const name = node(page, "h1", "profile-name", "Fixture member");
  const bioView = node(page, "p", "profile-bio", "Original bio");
  node(page, "div", "profile-games");
  node(page, "p", "profile-timezone", "Timezone: UTC");
  const root = node(page, "section", "profile-edit");
  root.setAttribute("data-island", "member-profile");
  root.setAttribute("data-member-id", ID);
  const editControl = node(root, "div", "profile-edit-control");
  editControl.hidden = true;
  node(editControl, "button", "profile-edit-again", "Edit your profile");
  const form = Object.assign(node(root, "form", "profile-form"), {
    elements: {} as Record<string, IslandElement>,
  });
  for (const [key, tag, value] of [
    ["bio", "textarea", "Original bio"],
    ["games_text", "textarea", "Chess"],
    ["timezone", "input", "UTC"],
    ["website", "input", ""],
    ["formOpenedAt", "input", "1800000000000"],
  ] as const) {
    const field = document.createElement(tag);
    field.value = field.defaultValue = value;
    (form as IslandElement).appendChild(field);
    form.elements[key] = field;
  }
  const saveButton = document.createElement("button");
  saveButton.setAttribute("data-testid", "profile-save");
  form.appendChild(saveButton);
  const cancelButton = document.createElement("button");
  cancelButton.setAttribute("data-testid", "profile-cancel");
  form.appendChild(cancelButton);
  const requests: (ReturnType<typeof deferred<IslandResponse>> & {
    url: string;
    body: string;
  })[] = [];
  const fetch = vi.fn((url: string, init: { body?: string } = {}) => {
    const request = deferred<IslandResponse>();
    requests.push({ url, body: String(init.body ?? ""), ...request });
    return request.promise;
  });
  const timers: IslandTimer[] = [];
  let timerSeq = 0;
  let elapsed = 0;
  const setTimeout = (cb: () => void, ms = 0) => {
    const id = ++timerSeq;
    timers.push({ id, cb, at: elapsed + ms });
    return id;
  };
  const clearTimeout = (id: number) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };
  const window = new EventTarget();
  runInNewContext(binder, {
    document,
    window,
    fetch,
    location: { pathname: `/members/${ID}`, search: "" },
    setTimeout,
    clearTimeout,
    Intl,
  });
  const notice = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const throttledNotice = () =>
    root.querySelector('[data-testid="profile-save-throttled"]') ??
    root.querySelector('[data-testid="profile-save-failed"]');
  const submit = (draft = "Submitted bio") => {
    form.elements.bio!.value = draft;
    form.elements.bio!.focus();
    form.dispatch("submit");
  };
  const deliberate = (key = "games_text", draft = "Newer draft typed after save") => {
    const control = form.elements[key]!;
    control.focus();
    form.dispatch("focusin");
    control.value = draft;
    control.selectionStart = 6;
    control.selectionEnd = 11;
    form.dispatch("input");
    return control;
  };
  const cancel = () => {
    form.dispatch("reset");
    Object.values(form.elements).forEach((field) => {
      field.value = field.defaultValue;
    });
    timers
      .filter((t) => t.at - elapsed < 10_000)
      .splice(0)
      .forEach((t) => {
        const at = timers.indexOf(t);
        if (at >= 0) timers.splice(at, 1);
        t.cb();
      });
  };
  const advance = (ms: number) => {
    elapsed += ms;
    timers
      .filter((t) => t.at <= elapsed)
      .sort((a, b) => a.id - b.id)
      .splice(0)
      .forEach((t) => {
        const at = timers.indexOf(t);
        if (at >= 0) timers.splice(at, 1);
        t.cb();
      });
  };
  const departure = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };
  return {
    document,
    root,
    name,
    bioView,
    form,
    saveButton,
    cancelButton,
    fetch,
    requests,
    timers,
    notice,
    throttledNotice,
    submit,
    deliberate,
    cancel,
    advance,
    departure,
  };
}

const UNCERTAIN_BODY = {
  error: "profile_save_uncertain",
  message: "Your save may still have gone through. Check your profile before trying again.",
};

describe("island throttling reads a bounded Retry-After and names the retry time", () => {
  it("429 with Retry-After 120 names the wait, keeps the draft and allows a manual retry", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "120" }),
      json: async () => ({ reason: "rate_limited", retry_after: 120 }),
    });
    await flush();
    const alert = f.throttledNotice();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toMatch(/slow down|too many|throttl/i);
    expect(alert?.textContent).toContain("120");
    expect(alert?.textContent).toMatch(/second|minute/i);
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
    expect(f.form.hidden).toBe(false);
    expect(f.form.getAttribute("aria-busy")).toBeNull();
    expect(f.document.activeElement).toBe(alert);
    // No automatic resend over the cooldown and the owned deadline.
    f.advance(120_000 + 10_000);
    await flush();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    // A deliberate retry sends the current draft once.
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.requests[1]!.body).bio).toBe("Submitted bio");
    f.requests[1]!.resolve({
      ok: true,
      status: 200,
      json: async () => ({ saved: true, message: "Profile saved." }),
    });
    await flush();
    expect(f.notice("profile-saved")?.getAttribute("role")).toBe("status");
  });

  it("429 with Retry-After 1 uses the singular second", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "1" }),
      json: async () => ({ reason: "rate_limited", retry_after: 1 }),
    });
    await flush();
    expect(f.throttledNotice()?.textContent).toContain("1 second");
    expect(f.throttledNotice()?.textContent).not.toContain("1 seconds");
  });

  it("429 rounds a fractional Retry-After up, never sooner", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "1.2" }),
      json: async () => ({ reason: "rate_limited", retry_after: 2 }),
    });
    await flush();
    expect(f.throttledNotice()?.textContent).toContain("2 second");
  });

  it("429 caps an absurd Retry-After instead of echoing it", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "999999999" }),
      json: async () => ({ reason: "rate_limited", retry_after: 999999999 }),
    });
    await flush();
    const text = f.throttledNotice()?.textContent ?? "";
    expect(text).toMatch(/slow down|too many|throttl/i);
    expect(text).not.toContain("999999999");
    const numbers = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(numbers.some((n) => n >= 1 && n <= 86400)).toBe(true);
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
  });

  it.each(["Wed, 21 Oct 2015 07:28:00 GMT", "0", "-5", "soon", ""])(
    "429 with unusable Retry-After %s falls back without echoing it",
    async (retryAfter) => {
      const f = islandFixture();
      f.submit();
      f.requests[0]!.resolve({
        ok: false,
        status: 429,
        headers: headerFixture({ "Retry-After": retryAfter }),
        json: async () => ({ reason: "rate_limited", message: "Too many requests." }),
      });
      await flush();
      const text = f.throttledNotice()?.textContent ?? "";
      expect(text).toMatch(/slow down|too many|throttl/i);
      if (retryAfter !== "") expect(text).not.toContain(retryAfter);
      expect(text).not.toMatch(/0 second/);
      expect(f.form.elements.bio!.value).toBe("Submitted bio");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("429 without a header falls back to the bounded body retry_after", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({}),
      json: async () => ({ reason: "rate_limited", retry_after: 45 }),
    });
    await flush();
    expect(f.throttledNotice()?.textContent).toContain("45");
    expect(f.throttledNotice()?.textContent).toMatch(/second|minute/i);
  });

  it("429 with neither header nor body time uses the moment fallback", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({}),
      json: async () => ({ reason: "rate_limited" }),
    });
    await flush();
    const text = f.throttledNotice()?.textContent ?? "";
    expect(text).toMatch(/slow down|too many|throttl/i);
    expect(text).toMatch(/moment/i);
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
  });

  it("delayed 429 after deliberate editing keeps focus, caret and the newer draft", async () => {
    const f = islandFixture();
    f.submit();
    const control = f.deliberate();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "90" }),
      json: async () => ({ reason: "rate_limited", retry_after: 90 }),
    });
    await flush();
    const alert = f.throttledNotice();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("90");
    expect(f.document.activeElement).toBe(control);
    expect(control.value).toBe("Newer draft typed after save");
    expect(control.selectionStart).toBe(6);
    expect(control.selectionEnd).toBe(11);
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("island distinguishes unavailable from unknown-write", () => {
  it("503 db_unavailable stays failed-safe with try-again and no uncertain claim", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 503,
      headers: headerFixture({}),
      json: async () => ({
        error: "db_unavailable",
        message: "The service is temporarily unavailable. Try again shortly.",
      }),
    });
    await flush();
    const failed = f.notice("profile-save-failed");
    expect(failed?.getAttribute("role")).toBe("alert");
    expect(failed?.textContent).toMatch(/try again/i);
    expect(failed?.textContent).not.toMatch(/may still have gone through/i);
    expect(f.notice("profile-uncertain")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("503 uncertain maps to the uncertain notice, never saveFailed", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 503,
      headers: headerFixture({}),
      json: async () => ({ ...UNCERTAIN_BODY }),
    });
    await flush();
    const uncertain = f.notice("profile-uncertain");
    expect(uncertain?.getAttribute("role")).toBe("status");
    expect(uncertain?.textContent).toMatch(/may still have gone through/i);
    expect(uncertain?.textContent).not.toMatch(/was not saved|did not save|not saved|failed/i);
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
    expect(f.form.getAttribute("aria-busy")).toBeNull();
    f.advance(30_000);
    await flush();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("generic 500 and bare 503 stay saveFailed, never uncertain", async () => {
    for (const status of [500, 503]) {
      const f = islandFixture();
      f.submit();
      f.requests[0]!.resolve({ ok: false, status });
      await flush();
      expect(f.notice("profile-save-failed")?.getAttribute("role")).toBe("alert");
      expect(f.notice("profile-uncertain")).toBeNull();
      expect(f.form.elements.bio!.value).toBe("Submitted bio");
    }
  });

  it("delayed uncertain after deliberate editing keeps focus, caret and the newer draft", async () => {
    const f = islandFixture();
    f.submit();
    const control = f.deliberate();
    f.requests[0]!.resolve({
      ok: false,
      status: 503,
      headers: headerFixture({}),
      json: async () => ({ ...UNCERTAIN_BODY }),
    });
    await flush();
    expect(f.notice("profile-uncertain")?.getAttribute("role")).toBe("status");
    expect(f.document.activeElement).toBe(control);
    expect(control.value).toBe("Newer draft typed after save");
    expect(control.selectionStart).toBe(6);
    expect(control.selectionEnd).toBe(11);
  });
});

describe("recovery preserves Cancel, departure, fencing and manual retry", () => {
  it("Cancel after a throttled refusal restores the baseline and releases departure", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "30" }),
      json: async () => ({ reason: "rate_limited", retry_after: 30 }),
    });
    await flush();
    expect(f.throttledNotice()).not.toBeNull();
    expect(f.departure().defaultPrevented).toBe(true);
    f.cancel();
    expect(f.throttledNotice()).toBeNull();
    expect(f.notice("profile-uncertain")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.document.activeElement).toBe(f.name);
    expect(f.departure().defaultPrevented).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("Cancel after an uncertain refusal clears it and restores the baseline", async () => {
    const f = islandFixture();
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 503,
      headers: headerFixture({}),
      json: async () => ({ ...UNCERTAIN_BODY }),
    });
    await flush();
    expect(f.notice("profile-uncertain")).not.toBeNull();
    expect(f.departure().defaultPrevented).toBe(true);
    f.cancel();
    expect(f.notice("profile-uncertain")).toBeNull();
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.document.activeElement).toBe(f.name);
    expect(f.departure().defaultPrevented).toBe(false);
  });

  it("failed drafts stay departure-protected until Cancel", async () => {
    const f = islandFixture();
    expect(f.departure().defaultPrevented).toBe(false);
    f.submit();
    f.requests[0]!.resolve({
      ok: false,
      status: 503,
      headers: headerFixture({}),
      json: async () => ({ error: "db_unavailable", message: "Try again shortly." }),
    });
    await flush();
    expect(f.departure().defaultPrevented).toBe(true);
    f.cancel();
    expect(f.departure().defaultPrevented).toBe(false);
  });

  it.each([
    ["throttled", 429, { "Retry-After": "30" }, { reason: "rate_limited", retry_after: 30 }],
    ["uncertain", 503, {}, UNCERTAIN_BODY],
  ] as const)("%s settling after Cancel stays inert", async (_label, status, headers, body) => {
    const f = islandFixture();
    f.submit();
    f.cancel();
    expect(f.document.activeElement).toBe(f.name);
    f.requests[0]!.resolve({
      ok: false,
      status,
      headers: headerFixture(headers),
      json: async () => body,
    });
    await flush();
    expect(f.throttledNotice()).toBeNull();
    expect(f.notice("profile-uncertain")).toBeNull();
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.document.activeElement).toBe(f.name);
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("a manual retry after throttling sends the current draft, never a stale B", async () => {
    const f = islandFixture();
    f.submit("Stale submitted B");
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "30" }),
      json: async () => ({ reason: "rate_limited", retry_after: 30 }),
    });
    await flush();
    f.form.elements.bio!.value = "Current draft C";
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.requests[1]!.body).bio).toBe("Current draft C");
    expect(JSON.parse(f.requests[1]!.body).bio).not.toBe("Stale submitted B");
  });

  it("Save while a write is pending sends nothing more", async () => {
    const f = islandFixture();
    f.submit();
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.notice("profile-pending")?.textContent).toMatch(/still finishing|earlier save/i);
    f.requests[0]!.resolve({
      ok: false,
      status: 429,
      headers: headerFixture({ "Retry-After": "30" }),
      json: async () => ({ reason: "rate_limited", retry_after: 30 }),
    });
    await flush();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("Save and Cancel stay keyboard-reachable after throttled, unavailable and uncertain refusals", async () => {
    const cases: IslandResponse[] = [
      {
        ok: false,
        status: 429,
        headers: headerFixture({ "Retry-After": "30" }),
        json: async () => ({ reason: "rate_limited", retry_after: 30 }),
      },
      {
        ok: false,
        status: 503,
        headers: headerFixture({}),
        json: async () => ({ error: "db_unavailable", message: "Try again shortly." }),
      },
      {
        ok: false,
        status: 503,
        headers: headerFixture({}),
        json: async () => ({ ...UNCERTAIN_BODY }),
      },
    ];
    for (const response of cases) {
      const f = islandFixture();
      f.submit();
      f.requests[0]!.resolve(response);
      await flush();
      for (const control of [f.saveButton, f.cancelButton]) {
        expect(control.hidden).toBe(false);
        control.focus();
        expect(f.document.activeElement).toBe(control);
      }
      expect(f.form.getAttribute("aria-busy")).toBeNull();
    }
  });
});

describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "refused-draft recovery in a real browser",
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

    async function openProfile(saveThrows: () => unknown, withholdIslandUntilWrite = true) {
      const sessions = createMemorySessionStore();
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: ID,
        username: "alice",
        avatar: null,
        member: true,
        moderator: false,
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
      const store = createMemoryProfileStore([
        {
          id: ID,
          username: "alice",
          avatar: null,
          bio: A.bio,
          games: [...A.games],
          timezone: A.timezone,
          leaderboardOptOut: A.leaderboardOptOut,
        },
      ]);
      const save = vi.spyOn(store, "save").mockImplementation(async () => {
        throw saveThrows();
      });
      const app = profilesApp({
        sessionStore: sessions,
        store,
        accessLog: async () => true,
        throttle: async () => ({ limited: false }),
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
      });
      contexts.push(context);
      const writes: { method: string; status: number }[] = [];
      // Withheld only until the first native write navigates; the 503 page
      // and everything after get the shipped binder.
      let withholdIsland = withholdIslandUntilWrite;
      const assets: Record<string, { body: string; contentType: string }> = {
        "/styles.css": { body: readFileSync("public/styles.css", "utf8"), contentType: "text/css" },
        "/islands/member-profile.js": {
          body: readFileSync("public/islands/member-profile.js", "utf8"),
          contentType: "text/javascript",
        },
        "/islands/avatar.js": {
          body: readFileSync("public/islands/avatar.js", "utf8"),
          contentType: "text/javascript",
        },
      };
      let base: string;
      const server = createServer(async (request, reply) => {
        try {
          const url = new URL(request.url!, base);
          const asset = assets[url.pathname];
          if (asset) {
            if (url.pathname === "/islands/member-profile.js" && withholdIsland) {
              reply.writeHead(404);
              reply.end();
              return;
            }
            reply.writeHead(200, { "content-type": asset.contentType });
            reply.end(asset.body);
            return;
          }
          if (url.pathname !== "/profile" && !url.pathname.startsWith("/members/")) {
            reply.writeHead(204);
            reply.end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const input = Buffer.concat(chunks).toString("utf8");
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(",") : value);
          }
          const response = await app.request(
            url.href,
            { method: request.method, headers, body: input || undefined },
            { ...env, APP_URL: base },
          );
          let body = await response.text();
          if (response.headers.get("content-type")?.includes("text/html")) {
            body = body.replace(
              new RegExp(`(name="${PROFILE_OPENED_AT_FIELD}" value=")[^"]+`),
              (_, prefix) => prefix + String(Date.now() - 5000),
            );
          }
          if (request.method !== "GET") {
            writes.push({ method: request.method!, status: response.status });
            withholdIsland = false;
          }
          reply.writeHead(response.status, Object.fromEntries(response.headers));
          reply.end(body);
        } catch (error) {
          reply.writeHead(500);
          reply.end(String(error));
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const separator = cookie.indexOf("=");
      await context.addCookies([
        {
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: base.replace("http:", "https:") + "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`${base}/profile`);
      return { page, writes, save, errorSpy, base };
    }

    async function field(page: Page, name: string) {
      return page.locator(`[name="${name}"]`).first();
    }

    async function submitDraftB(page: Page) {
      await (await field(page, "bio")).fill(B.bio);
      await (await field(page, "games_text")).fill(B.games_text);
      await (await field(page, "timezone")).fill(B.timezone);
      await page.locator("#profile-leaderboard-opt-out").check();
      await Promise.all([page.waitForNavigation(), page.getByTestId("profile-save").click()]);
    }

    it("unavailable native save keeps B visible, protects departure and Cancel restores A", async () => {
      const { page, writes, save, errorSpy } = await openProfile(unavailableError);
      try {
        await submitDraftB(page);
        expect(writes).toEqual([{ method: "POST", status: 503 }]);
        expect(save).toHaveBeenCalledTimes(1);
        expect(await (await field(page, "bio")).inputValue()).toBe(B.bio);
        expect(await (await field(page, "games_text")).inputValue()).toBe(B.games_text);
        expect(await (await field(page, "timezone")).inputValue()).toBe(B.timezone);
        expect(await page.getByTestId("profile-bio").textContent()).toContain(A.bio);
        expect(
          await page.evaluate<boolean>(
            "(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()",
          ),
        ).toBe(true);
        await page.getByTestId("profile-cancel").click();
        expect(await (await field(page, "bio")).inputValue()).toBe(A.bio);
        expect(await (await field(page, "timezone")).inputValue()).toBe(A.timezone);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("unknown-write native save keeps B visible with uncertain guidance", async () => {
      const { page, writes, errorSpy } = await openProfile(() => unknownWriteError("57014"));
      try {
        await submitDraftB(page);
        expect(writes).toEqual([{ method: "POST", status: 503 }]);
        expect(await (await field(page, "bio")).inputValue()).toBe(B.bio);
        expect(await page.locator("main").textContent()).toMatch(/may still have gone through/i);
      } finally {
        errorSpy.mockRestore();
      }
    });
  },
);
