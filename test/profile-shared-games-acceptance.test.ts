// route-inventory: GET /profile
// route-inventory: GET /members/:user
// Acceptance: profiles highlight games shared with the viewing member.
//
// Locked contract (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// The gap: src/profiles/pages.tsx renders member.games as a plain list and
// web/src/lib/ProfileView.svelte mirrors it; no shared/mutual computation
// exists on either twin. Opening another profile never shows which games the
// viewer could play with that member.
//
// The fix (build card): on another member's profile on both twins, every
// listed game the viewer also plays carries a compact shared marker. Match is
// trim + case-insensitive; each matching listed entry is marked (case and
// whitespace variants each marked; duplicates collapse in the match, never by
// dropping list entries). Own profile renders no markers and no
// self-comparison copy. Zero shared renders no empty section, no placeholder
// and no count line; both-empty games keep the existing empty copy verbatim.
// The match reads the viewer's own stored games row (one extra keyed read,
// bounded by the stored list); no new table or column.
//
// Marker HTML contract (identical hooks on both twins):
// - Shared:  <li data-shared-game="true">NAME<span
//   data-testid="profile-shared-marker">Shared</span></li>
// - Plain:   <li>NAME</li> with no data-shared-game attribute and no marker.
// Kit model: ok outcomes carry `sharedGames: string[]` (the member's
// displayed game strings that are shared, in member-list order; [] when none,
// including self reads). ProfileView accepts optional
// `sharedGames?: string[]` and marks entries exactly equal to a value in it;
// the +page.server loads pass outcome.sharedGames through and the +page
// views forward data.sharedGames.
//
// Coverage:
// - Hono (executed profilesApp + memory doubles): exact, case-insensitive
//   and whitespace-tolerant marking; duplicates collapse; no-overlap, own
//   profile, viewer-empty and member-empty render unmarked; HTML-shaped
//   shared names marked AND escaped; the 20-game bound lists all 20 with the
//   shared subset marked; the viewed read adds exactly one keyed viewer
//   self-read; guests bounce with no game text; the access log keeps exactly
//   one row for the viewed member; outage bodies leak no game text.
// - Kit model (executed resolveKitProfile): sharedGames on the same matrix,
//   the same viewer-read bound, guest/forbidden refusal, and the audit
//   boundary still logging the viewed member only.
// - Kit view (SSR-compiled real ProfileView): the sharedGames prop marks per
//   the HTML contract, stays plain without it, escapes HTML-shaped shared
//   names, and keeps the empty copy; one wiring test feeds a model outcome
//   into the view props. Real +page.server loads and +page SSR execute the
//   forwarding chain, with source-expression pins as secondary controls.
//
// Hermetic only: memory session/profile stores plus the real member-read
// boundary (Hono) and memberReadResponse (Kit) — faithful classified reads,
// no live database, no network. SSR HTML is the no-JS render by
// construction; opened desktop/mobile fixtures belong to the build card's UI
// loop. No production code in this file.
//
// RED vs GUARD: tests labelled RED fail on the pre-change head for the
// reason they name (no marker hooks, no sharedGames field, no viewer
// self-read, no wiring strings) and pass with a correct fix. Tests labelled
// GUARD already hold on base and must keep holding: they forbid the fix from
// over-marking, leaking, dropping admission/logging, or changing empty copy.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { Env } from "../src/env";
import { PROFILE_EMPTY_COPY } from "../src/islands/contracts";
import { memberReadResponse } from "../src/member-reads";
import { resolveKitProfile, type KitProfileRequest } from "../src/profiles/kit";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
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

const VIEWER = { userId: "100000000000000011", username: "viewer", member: true };
const MEMBER = { userId: "100000000000000012", username: "member", member: true };
const OUTSIDER = { userId: "100000000000000013", username: "outsider", member: false };

const MARK_HOOK = 'data-shared-game="true"';
const MARKER_TESTID = 'data-testid="profile-shared-marker"';

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; member: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0] ?? "";
}

function memberRow(
  id: string,
  username: string,
  games: string[],
  bio: string | null = null,
): MemberView {
  return { id, username, avatar: null, bio, games, timezone: null };
}

function harness(viewerGames: string[], memberGames: string[], opts: { logDown?: boolean } = {}) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    memberRow(VIEWER.userId, VIEWER.username, viewerGames),
    memberRow(MEMBER.userId, MEMBER.username, memberGames),
  ]);
  const log: AccessEntry[] = [];
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async (e) => {
      if (opts.logDown) throw new Error("log down");
      // Same attribution rule as the real recorder: the viewer is never a
      // subject, and an empty subject set writes nothing.
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
  });
  return { app, sessions, store, log };
}

// --- Rendered-games readers (shared by the Hono and Kit SSR assertions) ---

const gamesBlock = (html: string): string => {
  const match = html.match(/<div data-testid="profile-games">([\s\S]*?)<\/div>/);
  expect(match, "the profile-games block renders").not.toBeNull();
  return match?.[1] ?? "";
};

type GameItem = { attrs: string; inner: string };

const gameItems = (block: string): GameItem[] =>
  [...block.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => ({
    attrs: m[1] ?? "",
    inner: m[2] ?? "",
  }));

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Displayed game text of one item: marker span, comments and tags skipped. */
const itemGameName = (inner: string): string => {
  // Token-walking scanner (no regex-rewritten copy): comments end at the
  // first `-->`, a profile-shared-marker span is skipped through its
  // `</span>`, and any other `<...>` tag is skipped; text is collected.
  let text = "";
  let index = 0;
  while (index < inner.length) {
    if (inner.startsWith("<!--", index)) {
      const end = inner.indexOf("-->", index + 4);
      index = end === -1 ? inner.length : end + 3;
      continue;
    }
    if (inner[index] === "<") {
      const close = inner.indexOf(">", index);
      if (close === -1) {
        text += inner.slice(index);
        break;
      }
      const tag = inner.slice(index, close + 1);
      if (tag.startsWith("<span") && tag.includes("profile-shared-marker")) {
        const endSpan = inner.indexOf("</span>", close + 1);
        index = endSpan === -1 ? close + 1 : endSpan + "</span>".length;
        continue;
      }
      index = close + 1;
      continue;
    }
    const next = inner.indexOf("<", index);
    text += inner.slice(index, next === -1 ? inner.length : next);
    index = next === -1 ? inner.length : next;
  }
  return decodeEntities(text.replace(/\s+/g, " ").trim());
};

const expectMarked = (item: GameItem, name: string) => {
  expect(item.attrs, `${name} carries the shared hook`).toContain(MARK_HOOK);
  expect(item.inner, `${name} shows the marker element`).toContain(MARKER_TESTID);
  expect(item.inner, `${name} marker copy is exactly Shared`).toMatch(
    /profile-shared-marker[^>]*>\s*Shared\s*</,
  );
};

const expectUnmarked = (item: GameItem, name: string) => {
  expect(item.attrs, `${name} has no shared hook`).not.toContain("data-shared-game");
  expect(item.inner, `${name} has no marker element`).not.toContain("profile-shared-marker");
};

/** Zero-marker page: no hooks, no section, no placeholder, no count line. */
const expectNoMarkers = (html: string, why: string) => {
  expect(html, `${why}: no shared hooks`).not.toContain("data-shared-game");
  expect(html, `${why}: no marker elements`).not.toContain("profile-shared-marker");
  expect(html, `${why}: no shared section`).not.toContain('data-testid="profile-shared-games"');
  expect(html, `${why}: no Shared copy`).not.toContain(">Shared<");
  expect(html, `${why}: no empty placeholder`).not.toMatch(/no shared games/i);
  expect(html, `${why}: no shared count line`).not.toMatch(/shared games?\s*\(\d+\)/i);
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Hono shared-games highlight (RED)", () => {
  it("RED: an exact shared game is marked; the rest stay plain", async () => {
    const { app, sessions } = harness(["Go", "Quake"], ["Chess", "Go", "Doom"]);
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go", "Doom"]);
    expectUnmarked(items[0]!, "Chess");
    expectMarked(items[1]!, "Go");
    expectUnmarked(items[2]!, "Doom");
  });

  it("RED: case-insensitive and whitespace-tolerant matches are marked", async () => {
    const { app, sessions } = harness(
      [" chess ", "CATAN", "stardew valley"],
      ["Chess", "catan", "Stardew Valley", "Go"],
    );
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(4);
    expectMarked(items[0]!, "Chess");
    expectMarked(items[1]!, "catan");
    expectMarked(items[2]!, "Stardew Valley");
    expectUnmarked(items[3]!, "Go");
  });

  it("RED: duplicates collapse in the match: every variant entry is marked", async () => {
    const { app, sessions } = harness(["chess"], ["Chess", "CHESS", "Go"]);
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    // The list keeps all three entries; the match collapses, not the list.
    expect(items).toHaveLength(3);
    expectMarked(items[0]!, "Chess");
    expectMarked(items[1]!, "CHESS");
    expectUnmarked(items[2]!, "Go");
  });

  it("RED: HTML-shaped shared names are marked AND escaped", async () => {
    const { app, sessions } = harness(["<b>chess</b>", "d&d"], ["<b>Chess</b>", "D&D", "Go"]);
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(3);
    expectMarked(items[0]!, "<b>Chess</b>");
    expectMarked(items[1]!, "D&D");
    expectUnmarked(items[2]!, "Go");
    expect(html).not.toContain("<b>Chess</b>");
    expect(html).toContain("&lt;b&gt;Chess&lt;/b&gt;");
    expect(html).toContain("D&amp;D");
  });

  it("RED: the 20-game bound lists all 20 with exactly the shared subset marked", async () => {
    const memberGames = Array.from({ length: 20 }, (_, i) => `game-${String(i).padStart(2, "0")}`);
    const { app, sessions } = harness(
      ["GAME-03", " game-07 ", "game-11", "not-played"],
      memberGames,
    );
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(20);
    const marked = items
      .filter((i) => i.attrs.includes(MARK_HOOK))
      .map((i) => itemGameName(i.inner));
    expect(marked).toEqual(["game-03", "game-07", "game-11"]);
  });

  it("RED: reading another member adds exactly one keyed read of the viewer's own row", async () => {
    const { app, sessions, store } = harness(["Go"], ["Chess", "Go"]);
    const find = vi.spyOn(store, "find");
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const ids = find.mock.calls.map((call) => call[0]);
    expect(ids, "the viewer's own row is read for the match").toContain(VIEWER.userId);
    expect(new Set(ids), "no read beyond member + viewer").toEqual(
      new Set([MEMBER.userId, VIEWER.userId]),
    );
    expect(ids, "exactly one member read followed by exactly one viewer read").toEqual([
      MEMBER.userId,
      VIEWER.userId,
    ]);
  });
});

describe("Hono shared-games highlight (GUARD: preserved behavior)", () => {
  it("GUARD: no overlap lists every game with zero markers and no placeholder", async () => {
    const { app, sessions } = harness(["Go"], ["Chess", "Doom"]);
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const items = gameItems(gamesBlock(html));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Doom"]);
    for (const item of items) expectUnmarked(item, itemGameName(item.inner));
    expectNoMarkers(html, "no overlap");
  });

  it("GUARD: the viewer's own profile renders no markers on either read", async () => {
    const { app, sessions } = harness(["Chess", "Go"], ["Chess", "Go"]);
    const cookie = await cookieFor(sessions, VIEWER);
    for (const path of ["/profile", `/members/${VIEWER.userId}`]) {
      const res = await app.request(path, { headers: { cookie } }, env);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expectNoMarkers(html, `own profile ${path}`);
      // The owner keeps the edit form with every stored game editable.
      expect(html, path).toContain('data-testid="profile-edit"');
      const textarea = /<textarea[^>]*name="games_text"[^>]*>([\s\S]*?)<\/textarea>/.exec(
        html,
      )?.[1];
      expect(textarea, path).toBe("Chess\nGo");
    }
  });

  it("GUARD: self reads issue no second store read", async () => {
    const { app, sessions, store } = harness(["Chess"], ["Chess"]);
    const find = vi.spyOn(store, "find");
    const res = await app.request(
      "/profile",
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]?.[0]).toBe(VIEWER.userId);
  });

  it("GUARD: a viewer with no games sees the member list with zero markers", async () => {
    const { app, sessions } = harness([], ["Chess", "Go"]);
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(gameItems(gamesBlock(html))).toHaveLength(2);
    expectNoMarkers(html, "viewer games empty");
  });

  it("GUARD: a member with no games keeps the existing empty copy verbatim", async () => {
    const { app, sessions, store } = harness(["Chess"], []);
    const find = vi.spyOn(store, "find");
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(gamesBlock(html)).toContain(PROFILE_EMPTY_COPY.gamesOther);
    expect(gameItems(gamesBlock(html))).toHaveLength(0);
    expectNoMarkers(html, "member games empty");
    expect(
      find.mock.calls.map((call) => call[0]),
      "empty games need only the member row",
    ).toEqual([MEMBER.userId]);
  });

  it("GUARD: guests bounce with no game text and no markers", async () => {
    const { app } = harness(["Go"], ["Chess", "Go"]);
    const res = await app.request(`/members/${MEMBER.userId}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    const html = await res.text();
    expect(html).not.toContain("Chess");
    expectNoMarkers(html, "logged-out refusal");
  });

  it("GUARD: the viewed read logs exactly one row for the viewed member, never game text", async () => {
    const { app, sessions, log } = harness(
      ["zxq-viewer-canary", "Go"],
      ["zxq-member-canary", "Go"],
    );
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      viewerDiscordId: VIEWER.userId,
      resource: "profile",
      action: "view",
      subjectUserIds: [MEMBER.userId],
      route: "profiles.show",
    });
    const dump = JSON.stringify(log);
    expect(dump).not.toContain("zxq-viewer-canary");
    expect(dump).not.toContain("zxq-member-canary");
    expect(dump).not.toContain("Go");
  });

  it("GUARD: the log-down 503 carries no game text", async () => {
    const { app, sessions } = harness(["zxq-viewer-canary"], ["zxq-member-canary"], {
      logDown: true,
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain("zxq-viewer-canary");
    expect(html).not.toContain("zxq-member-canary");
    expectNoMarkers(html, "log-down refusal");
  });
});

describe("Kit shared-games model (RED + GUARD)", () => {
  const memberSession = (userId: string): KitProfileRequest["session"] =>
    ({
      status: "authenticated",
      session: { userId, username: "viewer", avatar: null, member: true, moderator: false },
    }) as KitProfileRequest["session"];
  const depsFor = (viewerGames: string[], memberGames: string[]) => ({
    store: createMemoryProfileStore([
      memberRow(VIEWER.userId, VIEWER.username, viewerGames),
      memberRow(MEMBER.userId, MEMBER.username, memberGames),
    ]),
  });
  const sharedOf = (outcome: unknown): unknown =>
    (outcome as { sharedGames?: unknown }).sharedGames;

  it("RED: the ok outcome carries the member's shared displayed names in list order", async () => {
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      depsFor(["Go", "Quake"], ["Chess", "Go", "Doom"]),
    );
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(sharedOf(outcome)).toEqual(["Go"]);
  });

  it("RED: model matching is case-insensitive and whitespace-tolerant, variants collapse", async () => {
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      depsFor([" chess ", "CATAN"], ["Chess", "CHESS", "catan", "Go"]),
    );
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(sharedOf(outcome)).toEqual(["Chess", "CHESS", "catan"]);
  });

  it("RED: no overlap, self reads and empty sides resolve to an empty shared list", async () => {
    const none = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      depsFor(["Go"], ["Chess"]),
    );
    expect(sharedOf(none)).toEqual([]);
    const self = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: VIEWER.userId, joinResult: null },
      depsFor(["Chess", "Go"], ["Chess"]),
    );
    expect(self).toMatchObject({ kind: "ok", isOwner: true });
    expect(sharedOf(self)).toEqual([]);
    const viewerEmpty = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      depsFor([], ["Chess"]),
    );
    expect(sharedOf(viewerEmpty)).toEqual([]);
    const emptyDeps = depsFor(["Chess"], []);
    const find = vi.spyOn(emptyDeps.store, "find");
    const memberEmpty = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      emptyDeps,
    );
    expect(sharedOf(memberEmpty)).toEqual([]);
    expect(
      find.mock.calls.map((call) => call[0]),
      "empty games need only the member row",
    ).toEqual([MEMBER.userId]);
  });

  it("RED: the model reads the viewer's own row once, nothing beyond member + viewer", async () => {
    const deps = depsFor(["Go"], ["Chess", "Go"]);
    const find = vi.spyOn(deps.store, "find");
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "ok" });
    const ids = find.mock.calls.map((call) => call[0]);
    expect(ids, "the viewer's own row is read for the match").toContain(VIEWER.userId);
    expect(new Set(ids), "no read beyond member + viewer").toEqual(
      new Set([MEMBER.userId, VIEWER.userId]),
    );
    expect(ids, "exactly one member read followed by exactly one viewer read").toEqual([
      MEMBER.userId,
      VIEWER.userId,
    ]);
  });

  it("GUARD: self reads keep a single store read", async () => {
    const deps = depsFor(["Chess"], ["Chess"]);
    const find = vi.spyOn(deps.store, "find");
    await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: VIEWER.userId, joinResult: null },
      deps,
    );
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]?.[0]).toBe(VIEWER.userId);
  });

  it("GUARD: guests redirect and outsiders 403 with no store read and no member data", async () => {
    const deps = depsFor(["Go"], ["Chess", "Go"]);
    const find = vi.spyOn(deps.store, "find");
    const guest = await resolveKitProfile(
      { session: { status: "guest", session: null }, requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(guest).toEqual({ kind: "redirect", location: "/auth/discord" });
    const outsider = await resolveKitProfile(
      {
        session: {
          status: "authenticated",
          session: {
            userId: OUTSIDER.userId,
            username: OUTSIDER.username,
            avatar: null,
            member: false,
            moderator: false,
          },
        } as KitProfileRequest["session"],
        requestedId: MEMBER.userId,
        joinResult: null,
      },
      deps,
    );
    expect(outsider).toEqual({ kind: "forbidden" });
    expect(find).not.toHaveBeenCalled();
    expect(JSON.stringify([guest, outsider])).not.toContain("Chess");
  });

  it("GUARD: the Kit audit boundary logs the viewed member only", async () => {
    const entries: AccessEntry[] = [];
    const res = await memberReadResponse(
      { method: "GET", route: "/members/:user" },
      {
        resource: "profile",
        action: "view",
        route: "profiles.show",
        viewer: VIEWER.userId,
      },
      async (entry) => {
        entries.push(entry);
        return true;
      },
      async () => {
        const outcome = await resolveKitProfile(
          { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
          depsFor(["Go"], ["Chess", "Go"]),
        );
        if (outcome.kind !== "ok") return new Response("refused-test", { status: 500 });
        return new Response(`<h1>${outcome.member.username}</h1>`, {
          headers: { "content-type": "text/html" },
        });
      },
    );
    expect(res.status).toBe(200);
    expect(entries).toEqual([
      {
        viewerDiscordId: VIEWER.userId,
        viewerUserId: VIEWER.userId,
        resource: "profile",
        action: "view",
        route: "profiles.show",
        subjectUserIds: [MEMBER.userId],
      },
    ]);
  });
});

// --- Kit view: SSR-compile the real ProfileView (kit-profile-output pattern) ---

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderView = (props: Record<string, unknown>) => { html: string; head: string };
type RenderRoute = (
  route: "profile" | "member",
  viewerId: string,
) => Promise<{ html: string; reads: string[]; sharedGames: string[] }>;
let renderView: RenderView;
let renderRoute: RenderRoute;

const viewProps = (memberGames: string[], sharedGames?: string[]): Record<string, unknown> => ({
  member: memberRow(MEMBER.userId, MEMBER.username, memberGames),
  stats: null,
  isOwner: false,
  isModerator: false,
  appUrl: APP_URL,
  joinResult: null,
  ...(sharedGames === undefined ? {} : { sharedGames }),
});

describe("Kit shared-games view (RED + GUARD)", () => {
  beforeAll(async () => {
    const worktree = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "kit-shared-games-"));
    try {
      const entry = join(scratch, "kit-shared-games-entry.mjs");
      writeFileSync(
        entry,
        `
import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
import ProfilePage from ${JSON.stringify(join(worktree, "web/src/routes/profile/+page.svelte"))};
import MemberPage from ${JSON.stringify(join(worktree, "web/src/routes/members/[user]/+page.svelte"))};
import * as profile from ${JSON.stringify(join(worktree, "web/src/routes/profile/+page.server.ts"))};
import * as member from ${JSON.stringify(join(worktree, "web/src/routes/members/[user]/+page.server.ts"))};
import { configure, reads } from "acceptance:shared-games-deps";
export function renderView(props) {
  const { body, head } = render(View, { props });
  return { html: head + body, head };
}
export async function renderRoute(route, viewerId) {
  configure();
  const page = route === "profile" ? profile : member;
  const data = await page.load({
    locals: {
      status: "authenticated",
      session: { userId: viewerId, username: "viewer", avatar: null, member: true, moderator: false },
      joinResult: null,
    },
    params: { user: ${JSON.stringify(MEMBER.userId)} },
    url: new URL(route === "profile" ? "/profile" : "/members/" + ${JSON.stringify(MEMBER.userId)}, ${JSON.stringify(APP_URL)}),
    setHeaders() {},
  });
  const { body, head } = render(route === "profile" ? ProfilePage : MemberPage, { props: { data } });
  return { html: head + body, reads: [...reads], sharedGames: data.sharedGames };
}
`,
      );
      const outfile = join(scratch, "kit-shared-games.mjs");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        absWorkingDir: worktree,
        tsconfig: join(worktree, "tsconfig.json"),
        nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
        plugins: [
          {
            name: "kit-shared-games-svelte-ssr",
            setup(plugin) {
              // Only external env/store/stats wiring is replaced. The model,
              // both route loads, both route pages and ProfileView stay real.
              plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
                path: "env",
                namespace: "fixture",
              }));
              plugin.onResolve({ filter: /^acceptance:shared-games-deps$/ }, () => ({
                path: "deps",
                namespace: "fixture",
              }));
              plugin.onResolve({ filter: /\/src\/profiles\/kit$/ }, (args) =>
                args.importer.endsWith("+page.server.ts")
                  ? { path: "deps", namespace: "fixture" }
                  : undefined,
              );
              plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                resolveDir: worktree,
                contents:
                  args.path === "env"
                    ? `export const env = { APP_URL: ${JSON.stringify(APP_URL)} };`
                    : `
export { resolveKitProfile } from ${JSON.stringify(join(worktree, "src/profiles/kit.ts"))};
import { createMemoryProfileStore } from ${JSON.stringify(join(worktree, "src/profiles/store.ts"))};
export const reads = [];
let store;
export function configure() {
  reads.length = 0;
  store = createMemoryProfileStore(${JSON.stringify([
    memberRow(MEMBER.userId, MEMBER.username, ["Chess", "Go"]),
    memberRow(VIEWER.userId, VIEWER.username, ["Go"]),
  ])});
}
export function kitProfileDeps() {
  return {
    async storeFor() {
      return { ...store, async find(id) { reads.push(id); return store.find(id); } };
    },
    async statsFor() { return null; },
  };
}
`,
              }));
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
                const source = readFileSync(args.path, "utf8");
                const { js } = compile(source, {
                  generate: "server",
                  dev: false,
                  filename: args.path,
                });
                return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
              });
            },
          },
        ],
      });
      ({ renderView, renderRoute } = (await import(pathToFileURL(outfile).href)) as {
        renderView: RenderView;
        renderRoute: RenderRoute;
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);

  it("RED: the sharedGames prop marks exactly the shared entries per the HTML contract", () => {
    const { html } = renderView(viewProps(["Chess", "Go", "Doom"], ["Go"]));
    const items = gameItems(gamesBlock(html));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go", "Doom"]);
    expectUnmarked(items[0]!, "Chess");
    expectMarked(items[1]!, "Go");
    expectUnmarked(items[2]!, "Doom");
  });

  it("RED: an HTML-shaped shared entry is marked AND escaped", () => {
    const { html } = renderView(viewProps(["<b>Chess</b>", "D&D", "Go"], ["<b>Chess</b>", "D&D"]));
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(3);
    expectMarked(items[0]!, "<b>Chess</b>");
    expectMarked(items[1]!, "D&D");
    expectUnmarked(items[2]!, "Go");
    expect(html).not.toContain("<b>Chess</b>");
    // Svelte SSR escapes & and < only (kit-profile-form.test.ts:228 pins the
    // same shape); the escaped < keeps the hostile name inert text.
    expect(html).toContain("&lt;b>Chess&lt;/b>");
    expect(html).toContain("D&amp;D");
  });

  it("RED: a model outcome renders marked when its sharedGames feed the view props", async () => {
    const outcome = await resolveKitProfile(
      {
        session: {
          status: "authenticated",
          session: {
            userId: VIEWER.userId,
            username: VIEWER.username,
            avatar: null,
            member: true,
            moderator: false,
          },
        } as KitProfileRequest["session"],
        requestedId: MEMBER.userId,
        joinResult: null,
      },
      {
        store: createMemoryProfileStore([
          memberRow(VIEWER.userId, VIEWER.username, ["Go"]),
          memberRow(MEMBER.userId, MEMBER.username, ["Chess", "Go"]),
        ]),
      },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const { html } = renderView({
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: APP_URL,
      joinResult: outcome.joinResult,
      sharedGames: (outcome as { sharedGames?: unknown }).sharedGames,
    });
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(2);
    expectUnmarked(items[0]!, "Chess");
    expectMarked(items[1]!, "Go");
  });

  it("RED: real members loader and route page forward the shared marker into SSR", async () => {
    const result = await renderRoute("member", VIEWER.userId);
    const items = gameItems(gamesBlock(result.html));
    expect(items.map((item) => itemGameName(item.inner))).toEqual(["Chess", "Go"]);
    expectUnmarked(items[0]!, "Chess");
    expectMarked(items[1]!, "Go");
    expect(result.sharedGames, "the real loader forwards the model outcome").toEqual(["Go"]);
    expect(result.reads).toEqual([MEMBER.userId, VIEWER.userId]);
  });

  it.each(["profile", "member"] as const)(
    "GUARD: real %s loader and route page keep owner SSR marker-free",
    async (route) => {
      const result = await renderRoute(route, MEMBER.userId);
      const items = gameItems(gamesBlock(result.html));
      expect(items.map((item) => itemGameName(item.inner))).toEqual(["Chess", "Go"]);
      for (const item of items) expectUnmarked(item, itemGameName(item.inner));
      expectNoMarkers(result.html, `Kit ${route} owner`);
      expect(result.sharedGames).toEqual([]);
      expect(result.reads).toEqual([MEMBER.userId]);
    },
  );

  it("GUARD: without the sharedGames prop the list stays plain", () => {
    const { html } = renderView(viewProps(["Chess", "Go"]));
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(2);
    for (const item of items) expectUnmarked(item, itemGameName(item.inner));
    expectNoMarkers(html, "sharedGames prop absent");
  });

  it("GUARD: empty games keep the existing empty copy verbatim", () => {
    const { html } = renderView(viewProps([], []));
    expect(gamesBlock(html)).toContain(PROFILE_EMPTY_COPY.gamesOther);
    expect(gameItems(gamesBlock(html))).toHaveLength(0);
    expectNoMarkers(html, "Kit member games empty");
  });

  it("GUARD: the owner's own view renders no markers", () => {
    const { html } = renderView({
      ...viewProps(["Chess", "Go"], []),
      member: memberRow(VIEWER.userId, VIEWER.username, ["Chess", "Go"]),
      isOwner: true,
    });
    expectNoMarkers(html, "Kit own profile");
  });
});

describe("Kit shared-games wiring (RED source pins)", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p: string): string => readFileSync(p, "utf8");

  it("RED: the loads forward sharedGames and the view consumes it", () => {
    const memberServer = read(join(root, "web/src/routes/members/[user]/+page.server.ts"));
    const memberPage = read(join(root, "web/src/routes/members/[user]/+page.svelte"));
    const profileServer = read(join(root, "web/src/routes/profile/+page.server.ts"));
    const profilePage = read(join(root, "web/src/routes/profile/+page.svelte"));
    const view = read(join(root, "web/src/lib/ProfileView.svelte"));
    for (const [label, source] of [
      ["members +page.server.ts", memberServer],
      ["profile +page.server.ts", profileServer],
    ] as const) {
      expect(source, `${label} returns outcome.sharedGames`).toContain("sharedGames");
      expect(source, `${label} forwards the outcome value, not an empty list`).toMatch(
        /sharedGames\s*:\s*outcome\.sharedGames\b/,
      );
    }
    for (const [label, source] of [
      ["members +page.svelte", memberPage],
      ["profile +page.svelte", profilePage],
    ] as const) {
      expect(source, `${label} forwards data.sharedGames`).toContain("sharedGames");
      expect(source, `${label} forwards the loaded value, not an empty list`).toMatch(
        /sharedGames\s*=\s*\{\s*data\.sharedGames\s*\}/,
      );
    }
    expect(view, "ProfileView consumes sharedGames").toContain("sharedGames");
    expect(view, "ProfileView renders the shared hook").toContain("data-shared-game");
    expect(view, "ProfileView renders the marker element").toContain("profile-shared-marker");
  });
});
