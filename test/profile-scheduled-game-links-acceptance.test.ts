// route-inventory: GET /profile
// route-inventory: GET /members/:user
// route-inventory: GET /events
// Acceptance: profiles link games that have scheduled nights to the
// game-filtered schedule.
//
// Locked contract (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
// Agent-runnable command:
//   npx vitest run test/profile-scheduled-game-links-acceptance.test.ts
//
// The gap: src/profiles/pages.tsx and web/src/lib/ProfileView.svelte render
// member.games as plain text, so "when is the next night for this game?" is a
// dead end. The target already exists: /events?game= resolves trim +
// case-insensitively against the published-games list, and an unknown game
// silently degrades to the UNFILTERED schedule (resolveGameFilter,
// src/islands/contracts-calendar.ts). That is exactly why only resolvable
// games may link: a link must never land a member on a silently unfiltered
// schedule believing it is scoped.
//
// The fix (build card): on both twins, in owner and other-member views, a
// game entry links to /events?game=<canonical stored game> only when it
// resolves (trim + case-insensitive exact) against the published-games list
// (listPublishedGames, src/events/reads.ts, one LIMIT-bound read).
// Unresolvable free-text stays byte-identical plain text.
//
// Locked seams (names are part of the contract, mirroring the sharedGames
// precedent in test/profile-shared-games-acceptance.test.ts):
// - Matcher: `findScheduledGames(memberGames, publishedGames)` exported from
//   src/profiles/shared-games.ts beside findSharedGames, using the same
//   normalizeGameName rule. Returns Record<string, string> keyed by the
//   member's EXACT displayed entry (case/whitespace variants each get a key),
//   valued with the canonical published entry; the first published match in
//   list order wins (resolveGameFilter parity). Exact match only, never
//   substring; blank entries never link.
// - Reads: `ProfileDeps.publishedGames?: () => Promise<string[]>` (Hono) and
//   `KitProfileDeps.publishedGames?: () => Promise<string[]>` (Kit model);
//   kitProfileDeps(env) additionally returns `publishedGamesFor` and both
//   +page.server loads pass `publishedGames: () => publishedGamesFor()`.
//   Production defaults wrap listPublishedGames over the request DB. The
//   read is public schedule data through the non-sensitive boundary: it adds
//   no member-read/access-log subject, runs at most once per profile render,
//   is skipped when the member lists no games (and on guest/forbidden/
//   not-found refusals), and FAILS OPEN — any throw from the seam (sync or
//   async) or an empty list renders
//   today's plain list with shared markers intact, never a profile 503.
// - Model/view: Kit ok outcomes carry `scheduledGames: Record<string,
//   string>` ({} when none, including read failure); ProfileView and the
//   Hono ProfilePage accept optional `scheduledGames` and link entries
//   exactly equal to a key; both loads return `scheduledGames:
//   outcome.scheduledGames` and both +page views forward
//   `scheduledGames={data.scheduledGames}`. Absent prop renders plain
//   (e.g. the Hono 422 re-render).
//
// Link HTML contract (identical hooks on both twins; CANONICAL is the
// published spelling, DISPLAYED is the member's stored entry, escaped):
// - Linked:  <li><a href="/events?game=ENCODED_CANONICAL"
//   aria-label="CANONICAL — upcoming events">DISPLAYED</a></li>
// - Linked + shared: the Shared marker stays a SIBLING after the anchor:
//   <li data-shared-game="true"><a ...>DISPLAYED</a><span
//   data-testid="profile-shared-marker">Shared</span></li>
// - Plain (unresolvable): today's markup byte-for-byte — <li>DISPLAYED</li>,
//   or with the shared hook/marker exactly as today. No anchor, ever.
// - ENCODED_CANONICAL is encodeURIComponent(canonical), so `chess ` on a
//   profile links as game=Chess, "Stardew Valley" as Stardew%20Valley and
//   "D&D" as D%26D (never a raw & that would truncate the parameter).
//
// Coverage:
// - Matcher units: variants each keyed, first published wins, no substring,
//   blanks never match.
// - Hono (executed profilesApp + memory doubles): exact and case/whitespace
//   variant links with canonical href + accessible name, URL encoding,
//   HTML-shaped names linked AND escaped, shared+resolvable (marker sibling)
//   and shared+unresolvable (byte-identical), owner views link with a single
//   store read, the 20-game bound links exactly the resolvable subset with
//   one published read, access log keeps exactly the viewed subject with no
//   game text, game-less and not-found renders add zero reads, read failure
//   and empty list fail open, guests bounce read-free.
// - Kit model (executed resolveKitProfile): scheduledGames on the same
//   matrix, owner included, one published read, zero on empty/refusals,
//   fail-open keeps sharedGames, audit boundary unchanged.
// - Kit view (SSR-compiled real ProfileView + real +page.server loads and
//   +page views): the same link contract and forwarding chain.
// - Click-through: the rendered profile href, followed against the real
//   Hono events routes, lands on the announced scoped schedule
//   (eventsGameFilterCopy) with only that game's night; the unresolvable
//   entry beside it offers no href to follow.
//
// Hermetic only: memory session/profile stores, an injected published-games
// seam, the real member-read boundary (Hono) and memberReadResponse (Kit),
// and the pg-proxy calendar fixture for the click-through — faithful
// classified reads, no live database, no network. SSR HTML is the no-JS
// render by construction; opened 1280x800 + 390x844 profile evidence belongs
// to the build card's Human-UI delivery. No production code in this file.
//
// RED vs GUARD: tests labelled RED fail on the pre-change head for the
// reason they name (no findScheduledGames, no publishedGames seam consumed,
// no scheduledGames field/prop, no anchors in the games list) and pass with
// a correct fix. Tests labelled GUARD already hold on base and must keep
// holding: they forbid the fix from linking unresolvable games, failing the
// profile on a schedule-read outage, adding reads or log subjects, or
// changing plain/shared markup.

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
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { PROFILE_EMPTY_COPY } from "../src/islands/contracts";
import { eventsGameFilterCopy, resolveGameFilter } from "../src/islands/contracts-calendar";
import { memberReadResponse } from "../src/member-reads";
import {
  resolveKitProfile,
  type KitProfileDeps,
  type KitProfileRequest,
} from "../src/profiles/kit";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import * as sharedGamesModule from "../src/profiles/shared-games";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { gameRecoveryFixture } from "./helpers/calendar-game-recovery";

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

const VIEWER = { userId: "100000000000000021", username: "viewer", member: true };
const MEMBER = { userId: "100000000000000022", username: "member", member: true };
const OUTSIDER = { userId: "100000000000000023", username: "outsider", member: false };
const UNKNOWN_ID = "100000000000000099";

const MARK_HOOK = 'data-shared-game="true"';
const MARKER_TESTID = 'data-testid="profile-shared-marker"';

type PublishedFn = () => Promise<string[]>;
const publishedList =
  (games: string[]): PublishedFn =>
  async () => [...games];
const publishedFailure: PublishedFn = async () => {
  throw new Error("published games read down");
};
// A seam that throws before it can return a promise (e.g. a wiring layer
// calling an absent factory): fail-open must cover this too, so neither the
// model nor the route may assume the call itself succeeds.
const publishedSyncFailure: PublishedFn = () => {
  throw new Error("published games seam miswired");
};

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

function harness(
  viewerGames: string[],
  memberGames: string[],
  opts: { logDown?: boolean; published?: PublishedFn } = {},
) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    memberRow(VIEWER.userId, VIEWER.username, viewerGames),
    memberRow(MEMBER.userId, MEMBER.username, memberGames),
  ]);
  const publishedGames = vi.fn(opts.published ?? publishedList([]));
  const log: AccessEntry[] = [];
  const deps = {
    sessionStore: sessions,
    store,
    publishedGames,
    accessLog: async (e: AccessEntry) => {
      if (opts.logDown) throw new Error("log down");
      // Same attribution rule as the real recorder: the viewer is never a
      // subject, and an empty subject set writes nothing.
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
  } as unknown as ProfileDeps;
  const app = profilesApp(deps);
  return { app, sessions, store, log, publishedGames };
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

type Anchor = {
  hrefRaw: string | null;
  href: string | null;
  ariaLabel: string | null;
  text: string;
};

const anchorOf = (item: GameItem): Anchor | null => {
  const match = /<a\b([^>]*)>([\s\S]*?)<\/a>/.exec(item.inner);
  if (!match) return null;
  const attrs = match[1] ?? "";
  const hrefRaw = /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? null;
  const ariaRaw = /\baria-label="([^"]*)"/.exec(attrs)?.[1] ?? null;
  // Svelte SSR may leave comment anchors around interpolated text; the
  // displayed text is what remains once they are gone.
  const rawText = (match[2] ?? "").replace(/<!--[\s\S]*?-->/g, "");
  return {
    hrefRaw,
    href: hrefRaw === null ? null : decodeEntities(hrefRaw),
    ariaLabel: ariaRaw === null ? null : decodeEntities(ariaRaw),
    text: decodeEntities(rawText),
  };
};

const expectLinked = (item: GameItem, displayed: string, canonical: string) => {
  const anchor = anchorOf(item);
  expect(anchor, `${displayed} renders as a link`).not.toBeNull();
  expect(anchor!.href, `${displayed} href uses the canonical spelling, URL-encoded`).toBe(
    `/events?game=${encodeURIComponent(canonical)}`,
  );
  expect(anchor!.hrefRaw, `${displayed} raw href stays percent-encoded`).toContain(
    encodeURIComponent(canonical),
  );
  expect(
    new URL(anchor!.href!, APP_URL).searchParams.get("game"),
    `${displayed} game parameter decodes to the canonical game`,
  ).toBe(canonical);
  expect(anchor!.ariaLabel, `${displayed} accessible name`).toBe(`${canonical} — upcoming events`);
  expect(anchor!.text, `${displayed} visible text stays the stored entry`).toBe(displayed);
};

const expectUnlinked = (item: GameItem, name: string) => {
  expect(anchorOf(item), `${name} renders no anchor`).toBeNull();
  expect(item.inner, `${name} carries no schedule href`).not.toContain("/events?game=");
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("findScheduledGames matcher (RED)", () => {
  const findScheduled = (): ((m: string[], p: readonly string[]) => Record<string, string>) => {
    const fn = (sharedGamesModule as Record<string, unknown>).findScheduledGames;
    expect(typeof fn, "findScheduledGames is exported beside findSharedGames").toBe("function");
    return fn as (m: string[], p: readonly string[]) => Record<string, string>;
  };

  it("RED: case/whitespace variants each key to the canonical published spelling", () => {
    expect(findScheduled()(["chess ", "CHESS", "Stardew Valley", "Doom"], ["Chess", "Go"])).toEqual(
      { "chess ": "Chess", CHESS: "Chess" },
    );
  });

  it("RED: the first published match in list order wins", () => {
    expect(findScheduled()(["chess"], ["CHESS", "Chess"])).toEqual({ chess: "CHESS" });
  });

  it("RED: exact match only — substrings and blanks never link", () => {
    const find = findScheduled();
    expect(find(["Che", "Chess Night"], ["Chess"])).toEqual({});
    expect(find(["", "   "], ["", "   ", "Chess"])).toEqual({});
    expect(find([], ["Chess"])).toEqual({});
    expect(find(["Chess"], [])).toEqual({});
  });
});

describe("Hono scheduled-game links (RED)", () => {
  it("RED: resolvable games link with canonical href and accessible name; the rest stay byte-identical", async () => {
    const { app, sessions, publishedGames } = harness([], ["Chess", "Go", "Doom"], {
      published: publishedList(["Chess", "Go"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go", "Doom"]);
    expectLinked(items[0]!, "Chess", "Chess");
    expectLinked(items[1]!, "Go", "Go");
    expectUnlinked(items[2]!, "Doom");
    // Byte-identical plain text: exactly today's <li>Doom</li>.
    expect(items[2]!.attrs.trim()).toBe("");
    expect(items[2]!.inner).toBe("Doom");
    for (const item of items) expectUnmarked(item, itemGameName(item.inner));
    expect(publishedGames, "one published-games read per render").toHaveBeenCalledTimes(1);
  });

  it("RED: case/whitespace variants link as the canonical published spelling", async () => {
    const { app, sessions } = harness([], ["chess ", "CATAN", "Stardew Valley"], {
      published: publishedList(["Chess", "Catan"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(3);
    expectLinked(items[0]!, "chess ", "Chess");
    expectLinked(items[1]!, "CATAN", "Catan");
    expectUnlinked(items[2]!, "Stardew Valley");
    expect(items[2]!.inner).toBe("Stardew Valley");
  });

  it("RED: canonical names are URL-encoded so spaces and ampersands survive the parameter", async () => {
    const { app, sessions } = harness([], ["d&d", "stardew valley"], {
      published: publishedList(["D&D", "Stardew Valley"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const block = gamesBlock(await res.text());
    const items = gameItems(block);
    expect(items).toHaveLength(2);
    expectLinked(items[0]!, "d&d", "D&D");
    expectLinked(items[1]!, "stardew valley", "Stardew Valley");
    expect(block).toContain("game=D%26D");
    expect(block).toContain("game=Stardew%20Valley");
    expect(block).not.toContain("game=D&D");
    expect(block).toContain("d&amp;d");
  });

  it("RED: HTML-shaped resolvable names are linked AND escaped everywhere", async () => {
    const { app, sessions } = harness([], ["<b>chess</b>", "Go"], {
      published: publishedList(["<b>Chess</b>"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(2);
    expectLinked(items[0]!, "<b>chess</b>", "<b>Chess</b>");
    expectUnlinked(items[1]!, "Go");
    expect(html).not.toContain("<b>Chess</b>");
    expect(html).not.toContain("<b>chess</b>");
    expect(html).toContain("&lt;b&gt;chess&lt;/b&gt;");
  });

  it("RED: shared + resolvable keeps the marker as a sibling after the anchor", async () => {
    const { app, sessions } = harness(["Go"], ["Chess", "Go"], {
      published: publishedList(["Chess", "Go"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(2);
    expectLinked(items[0]!, "Chess", "Chess");
    expectUnmarked(items[0]!, "Chess");
    expectLinked(items[1]!, "Go", "Go");
    expectMarked(items[1]!, "Go");
    // Sibling, never nested: anchor first, marker after it, nothing else.
    const anchorEnd = items[1]!.inner.indexOf("</a>");
    const markerStart = items[1]!.inner.indexOf("<span");
    expect(anchorEnd, "anchor closes before the marker opens").toBeGreaterThanOrEqual(0);
    expect(markerStart).toBeGreaterThan(anchorEnd);
    expect(items[1]!.inner.slice(0, items[1]!.inner.indexOf("<a"))).toBe("");
  });

  it("RED: the owner's own profile links too, with one store read and the editor intact", async () => {
    for (const path of ["/profile", `/members/${VIEWER.userId}`]) {
      const { app, sessions, store, publishedGames } = harness(["Chess", "Doom"], ["Go"], {
        published: publishedList(["Chess", "Go"]),
      });
      const find = vi.spyOn(store, "find");
      const res = await app.request(
        path,
        { headers: { cookie: await cookieFor(sessions, VIEWER) } },
        env,
      );
      expect(res.status, path).toBe(200);
      const html = await res.text();
      const items = gameItems(gamesBlock(html));
      expect(
        items.map((i) => itemGameName(i.inner)),
        path,
      ).toEqual(["Chess", "Doom"]);
      expectLinked(items[0]!, "Chess", "Chess");
      expectUnlinked(items[1]!, "Doom");
      for (const item of items) expectUnmarked(item, itemGameName(item.inner));
      expect(
        find.mock.calls.map((c) => c[0]),
        `${path}: self read stays single`,
      ).toEqual([VIEWER.userId]);
      expect(publishedGames, `${path}: one published read`).toHaveBeenCalledTimes(1);
      const textarea = /<textarea[^>]*name="games_text"[^>]*>([\s\S]*?)<\/textarea>/.exec(
        html,
      )?.[1];
      expect(textarea, `${path}: editor keeps the stored games`).toBe("Chess\nDoom");
    }
  });

  it("RED: the 20-game bound lists all 20 with exactly the resolvable subset linked, one read", async () => {
    const memberGames = Array.from({ length: 20 }, (_, i) => `game-${String(i).padStart(2, "0")}`);
    const { app, sessions, publishedGames } = harness([], memberGames, {
      published: publishedList(["Game-03", "Game-07", "Game-11", "Not Played"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(20);
    const linked = items
      .map((i) => anchorOf(i))
      .filter((a) => a !== null)
      .map((a) => new URL(a.href!, APP_URL).searchParams.get("game"));
    expect(linked).toEqual(["Game-03", "Game-07", "Game-11"]);
    expect(publishedGames).toHaveBeenCalledTimes(1);
  });

  it("RED: duplicate published spellings link as the first in list order", async () => {
    const { app, sessions } = harness([], ["chess"], {
      published: publishedList(["CHESS", "Chess"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expectLinked(items[0]!, "chess", "CHESS");
  });

  it("RED: a linked read still logs exactly one row for the viewed member, never game text", async () => {
    const { app, sessions, log } = harness(["zxq-viewer-canary"], ["Zxq Published", "Go"], {
      published: publishedList(["Zxq Published", "Go"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expectLinked(items[0]!, "Zxq Published", "Zxq Published");
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
    expect(dump).not.toContain("Zxq Published");
    expect(dump).not.toContain("Go");
  });
});

describe("Hono scheduled-game links (GUARD: preserved behavior)", () => {
  it("GUARD: shared but unresolvable stays marked and byte-identical, with no anchor", async () => {
    const { app, sessions } = harness(["Doom"], ["Doom", "Chess"], {
      published: publishedList(["Chess"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(2);
    expectUnlinked(items[0]!, "Doom");
    expectMarked(items[0]!, "Doom");
    expect(items[0]!.inner).toBe('Doom<span data-testid="profile-shared-marker">Shared</span>');
  });

  it("GUARD: a published-games read failure fails open to today's plain list, markers intact", async () => {
    const { app, sessions, log } = harness(["Go"], ["Chess", "Go"], {
      published: publishedFailure,
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status, "a schedule-read outage is never a profile 503").toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go"]);
    expectUnlinked(items[0]!, "Chess");
    expect(items[0]!.inner).toBe("Chess");
    expectUnlinked(items[1]!, "Go");
    expectMarked(items[1]!, "Go");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ subjectUserIds: [MEMBER.userId] });
  });

  it("GUARD: a synchronously throwing seam fails open the same way", async () => {
    const { app, sessions } = harness([], ["Chess"], { published: publishedSyncFailure });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status, "a miswired seam is never a profile 503").toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    expect(items).toHaveLength(1);
    expectUnlinked(items[0]!, "Chess");
    expect(items[0]!.inner).toBe("Chess");
  });

  it("GUARD: an empty published list renders today's plain list", async () => {
    const { app, sessions } = harness([], ["Chess", "Go"], {
      published: publishedList([]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const block = gamesBlock(await res.text());
    const items = gameItems(block);
    expect(items).toHaveLength(2);
    for (const item of items) expectUnlinked(item, itemGameName(item.inner));
    expect(block).not.toContain("/events?game=");
  });

  it("GUARD: a game-less profile adds zero reads and keeps the empty copy verbatim", async () => {
    const { app, sessions, store, publishedGames } = harness(["Chess"], [], {
      published: publishedList(["Chess"]),
    });
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
    expect(gamesBlock(html)).not.toContain("/events?game=");
    expect(publishedGames, "no games, no published-games read").not.toHaveBeenCalled();
    expect(
      find.mock.calls.map((c) => c[0]),
      "only the member row is read",
    ).toEqual([MEMBER.userId]);
  });

  it("GUARD: an unknown member 404s with no published-games read and no game text", async () => {
    const { app, sessions, publishedGames } = harness([], ["Chess"], {
      published: publishedList(["Chess"]),
    });
    const res = await app.request(
      `/members/${UNKNOWN_ID}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("/events?game=");
    expect(publishedGames).not.toHaveBeenCalled();
  });

  it("GUARD: guests bounce with no game text, no links and no published-games read", async () => {
    const { app, publishedGames } = harness([], ["Chess"], {
      published: publishedList(["Chess"]),
    });
    const res = await app.request(`/members/${MEMBER.userId}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    const html = await res.text();
    expect(html).not.toContain("Chess");
    expect(html).not.toContain("/events?game=");
    expect(publishedGames).not.toHaveBeenCalled();
  });

  it("GUARD: the log-down 503 carries no game text and no links", async () => {
    const { app, sessions } = harness([], ["zxq-member-canary"], {
      logDown: true,
      published: publishedList(["zxq-member-canary"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain("zxq-member-canary");
    expect(html).not.toContain("/events?game=");
  });
});

describe("Click-through to the announced scoped schedule (RED)", () => {
  beforeEach(() => __resetAnonEventCacheForTests());

  it("RED: following a profile game link lands on the announced, scoped schedule", async () => {
    const { app, sessions } = harness([], ["chess", "Doom"], {
      published: publishedList(["Chess", "Go"]),
    });
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, VIEWER) } },
      env,
    );
    expect(res.status).toBe(200);
    const items = gameItems(gamesBlock(await res.text()));
    const anchor = anchorOf(items[0]!);
    expect(anchor, "the resolvable game offers an href to follow").not.toBeNull();
    expect(anchorOf(items[1]!), "the unresolvable game offers no href").toBeNull();

    // The schedule's own resolver agrees the parameter is scoped, not a
    // silent degrade to unfiltered (resolveGameFilter -> null).
    const param = new URL(anchor!.href!, APP_URL).searchParams.get("game");
    expect(resolveGameFilter(["Chess", "Go"], param)).toBe("Chess");

    const fixture = gameRecoveryFixture();
    const landed = await fixture.render("Hono", anchor!.href!);
    expect(landed.status).toBe(200);
    const html = await landed.text();
    expect(html, "the schedule announces the scoped game").toContain(eventsGameFilterCopy("Chess"));
    expect(html).toContain("Chess fixture night");
    expect(html).not.toContain("Go fixture night");
  });
});

describe("Kit scheduled-games model (RED + GUARD)", () => {
  const memberSession = (userId: string): KitProfileRequest["session"] =>
    ({
      status: "authenticated",
      session: { userId, username: "viewer", avatar: null, member: true, moderator: false },
    }) as KitProfileRequest["session"];
  const depsFor = (viewerGames: string[], memberGames: string[], published?: PublishedFn) => {
    const store = createMemoryProfileStore([
      memberRow(VIEWER.userId, VIEWER.username, viewerGames),
      memberRow(MEMBER.userId, MEMBER.username, memberGames),
    ]);
    const publishedGames = vi.fn(published ?? publishedList([]));
    const deps = { store, publishedGames } as unknown as KitProfileDeps;
    return { deps, store, publishedGames };
  };
  const scheduledOf = (outcome: unknown): unknown =>
    (outcome as { scheduledGames?: unknown }).scheduledGames;
  const sharedOf = (outcome: unknown): unknown =>
    (outcome as { sharedGames?: unknown }).sharedGames;

  it("RED: the ok outcome maps displayed variants to canonical published spellings", async () => {
    const { deps, publishedGames } = depsFor(
      [],
      ["chess ", "CATAN", "Doom"],
      publishedList(["Chess", "Catan"]),
    );
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(scheduledOf(outcome)).toEqual({ "chess ": "Chess", CATAN: "Catan" });
    expect(publishedGames, "one published-games read").toHaveBeenCalledTimes(1);
  });

  it("RED: self reads carry the map too, with a single store read", async () => {
    const { deps, store, publishedGames } = depsFor(
      ["Chess", "Doom"],
      ["Go"],
      publishedList(["Chess"]),
    );
    const find = vi.spyOn(store, "find");
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: VIEWER.userId, joinResult: null },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "ok", isOwner: true });
    expect(scheduledOf(outcome)).toEqual({ Chess: "Chess" });
    expect(sharedOf(outcome)).toEqual([]);
    expect(find.mock.calls.map((c) => c[0])).toEqual([VIEWER.userId]);
    expect(publishedGames).toHaveBeenCalledTimes(1);
  });

  it("RED: shared and scheduled resolve together without extra store reads", async () => {
    const { deps, store, publishedGames } = depsFor(
      ["Go"],
      ["Chess", "Go"],
      publishedList(["Chess", "Go"]),
    );
    const find = vi.spyOn(store, "find");
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(sharedOf(outcome)).toEqual(["Go"]);
    expect(scheduledOf(outcome)).toEqual({ Chess: "Chess", Go: "Go" });
    expect(
      find.mock.calls.map((c) => c[0]),
      "member + viewer, nothing more",
    ).toEqual([MEMBER.userId, VIEWER.userId]);
    expect(publishedGames).toHaveBeenCalledTimes(1);
  });

  it("RED: a read failure fails open to an empty map and keeps sharedGames", async () => {
    const { deps, publishedGames } = depsFor(["Go"], ["Chess", "Go"], publishedFailure);
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(outcome, "a schedule-read outage never refuses the profile").toMatchObject({
      kind: "ok",
    });
    expect(scheduledOf(outcome)).toEqual({});
    expect(sharedOf(outcome)).toEqual(["Go"]);
    expect(publishedGames).toHaveBeenCalledTimes(1);
  });

  it("RED: a synchronously throwing seam fails open the same way", async () => {
    const { deps } = depsFor(["Go"], ["Chess", "Go"], publishedSyncFailure);
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(outcome, "a miswired seam never refuses the profile").toMatchObject({ kind: "ok" });
    expect(scheduledOf(outcome)).toEqual({});
    expect(sharedOf(outcome)).toEqual(["Go"]);
  });

  it("RED: empty published list and no-overlap resolve to an empty map", async () => {
    const empty = depsFor([], ["Chess"], publishedList([]));
    const emptyOutcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      empty.deps,
    );
    expect(scheduledOf(emptyOutcome)).toEqual({});
    const none = depsFor([], ["Doom"], publishedList(["Chess"]));
    const noneOutcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      none.deps,
    );
    expect(scheduledOf(noneOutcome)).toEqual({});
  });

  it("RED: a game-less member resolves an empty map with zero added reads", async () => {
    const { deps, store, publishedGames } = depsFor(["Chess"], [], publishedList(["Chess"]));
    const find = vi.spyOn(store, "find");
    const outcome = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: MEMBER.userId, joinResult: null },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(scheduledOf(outcome)).toEqual({});
    expect(publishedGames, "no games, no published-games read").not.toHaveBeenCalled();
    expect(find.mock.calls.map((c) => c[0])).toEqual([MEMBER.userId]);
  });

  it("GUARD: guests, outsiders and missing members refuse with no published-games read", async () => {
    const { deps, store, publishedGames } = depsFor([], ["Chess"], publishedList(["Chess"]));
    const find = vi.spyOn(store, "find");
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
    const missing = await resolveKitProfile(
      { session: memberSession(VIEWER.userId), requestedId: UNKNOWN_ID, joinResult: null },
      deps,
    );
    expect(missing).toEqual({ kind: "notFound" });
    expect(publishedGames).not.toHaveBeenCalled();
    expect(
      find.mock.calls.map((c) => c[0]),
      "only the missing-member lookup ran",
    ).toEqual([UNKNOWN_ID]);
    expect(JSON.stringify([guest, outsider, missing])).not.toContain("Chess");
  });

  it("GUARD: the Kit audit boundary still logs the viewed member only", async () => {
    const entries: AccessEntry[] = [];
    const { deps } = depsFor(["Go"], ["Chess", "Go"], publishedList(["Chess", "Go"]));
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
          deps,
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
) => Promise<{
  html: string;
  reads: string[];
  sharedGames: string[];
  scheduledGames: Record<string, string>;
}>;
let renderView: RenderView;
let renderRoute: RenderRoute;

const viewProps = (
  memberGames: string[],
  opts: { sharedGames?: string[]; scheduledGames?: Record<string, string> } = {},
): Record<string, unknown> => ({
  member: memberRow(MEMBER.userId, MEMBER.username, memberGames),
  stats: null,
  isOwner: false,
  isModerator: false,
  appUrl: APP_URL,
  joinResult: null,
  ...(opts.sharedGames === undefined ? {} : { sharedGames: opts.sharedGames }),
  ...(opts.scheduledGames === undefined ? {} : { scheduledGames: opts.scheduledGames }),
});

describe("Kit scheduled-game links view (RED + GUARD)", () => {
  beforeAll(async () => {
    const worktree = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "kit-scheduled-links-"));
    try {
      const entry = join(scratch, "kit-scheduled-links-entry.mjs");
      writeFileSync(
        entry,
        `
import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
import ProfilePage from ${JSON.stringify(join(worktree, "web/src/routes/profile/+page.svelte"))};
import MemberPage from ${JSON.stringify(join(worktree, "web/src/routes/members/[user]/+page.svelte"))};
import * as profile from ${JSON.stringify(join(worktree, "web/src/routes/profile/+page.server.ts"))};
import * as member from ${JSON.stringify(join(worktree, "web/src/routes/members/[user]/+page.server.ts"))};
import { configure, reads } from "acceptance:scheduled-links-deps";
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
    cookies: { set() {} },
    setHeaders() {},
  });
  const { body, head } = render(route === "profile" ? ProfilePage : MemberPage, { props: { data } });
  return { html: head + body, reads: [...reads], sharedGames: data.sharedGames, scheduledGames: data.scheduledGames };
}
`,
      );
      const outfile = join(scratch, "kit-scheduled-links.mjs");
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
            name: "kit-scheduled-links-svelte-ssr",
            setup(plugin) {
              // Only external env/store/stats/games wiring is replaced. The
              // model, both route loads, both route pages and ProfileView
              // stay real.
              plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
                path: "env",
                namespace: "fixture",
              }));
              plugin.onResolve({ filter: /^acceptance:scheduled-links-deps$/ }, () => ({
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
    async publishedGamesFor() { return ["Chess", "Go"]; },
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

  it("RED: the scheduledGames prop links exactly the mapped entries per the HTML contract", () => {
    const { html } = renderView(
      viewProps(["Chess", "Go", "Doom"], { scheduledGames: { Chess: "Chess", Go: "Go" } }),
    );
    const items = gameItems(gamesBlock(html));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go", "Doom"]);
    expectLinked(items[0]!, "Chess", "Chess");
    expectLinked(items[1]!, "Go", "Go");
    expectUnlinked(items[2]!, "Doom");
    for (const item of items) expectUnmarked(item, itemGameName(item.inner));
  });

  it("RED: a variant entry displays as stored and links as the canonical spelling", () => {
    const { html } = renderView(viewProps(["CATAN"], { scheduledGames: { CATAN: "Catan" } }));
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(1);
    expectLinked(items[0]!, "CATAN", "Catan");
  });

  it("RED: shared + scheduled renders the marker as a sibling after the anchor", () => {
    const { html } = renderView(
      viewProps(["Go"], { sharedGames: ["Go"], scheduledGames: { Go: "Go" } }),
    );
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(1);
    expectLinked(items[0]!, "Go", "Go");
    expectMarked(items[0]!, "Go");
    const anchorEnd = items[0]!.inner.indexOf("</a>");
    const markerStart = items[0]!.inner.indexOf("<span");
    expect(anchorEnd, "anchor closes before the marker opens").toBeGreaterThanOrEqual(0);
    expect(markerStart).toBeGreaterThan(anchorEnd);
  });

  it("RED: an ampersand canonical is URL-encoded in href and escaped in text and label", () => {
    const { html } = renderView(viewProps(["d&d"], { scheduledGames: { "d&d": "D&D" } }));
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(1);
    expectLinked(items[0]!, "d&d", "D&D");
    expect(html).toContain("game=D%26D");
    expect(html).toContain("d&amp;d");
    expect(html).not.toContain("game=D&D");
  });

  it("RED: a model outcome renders linked when its scheduledGames feed the view props", async () => {
    const store = createMemoryProfileStore([
      memberRow(VIEWER.userId, VIEWER.username, []),
      memberRow(MEMBER.userId, MEMBER.username, ["chess", "Doom"]),
    ]);
    const deps = {
      store,
      publishedGames: publishedList(["Chess"]),
    } as unknown as KitProfileDeps;
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
      deps,
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
      sharedGames: outcome.sharedGames,
      scheduledGames: (outcome as { scheduledGames?: unknown }).scheduledGames,
    });
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(2);
    expectLinked(items[0]!, "chess", "Chess");
    expectUnlinked(items[1]!, "Doom");
  });

  it("RED: real members loader and route page forward scheduled links into SSR", async () => {
    const result = await renderRoute("member", VIEWER.userId);
    const items = gameItems(gamesBlock(result.html));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go"]);
    expectLinked(items[0]!, "Chess", "Chess");
    expectUnmarked(items[0]!, "Chess");
    // Go is both shared (viewer plays it) and scheduled.
    expectLinked(items[1]!, "Go", "Go");
    expectMarked(items[1]!, "Go");
    expect(result.sharedGames).toEqual(["Go"]);
    expect(result.scheduledGames, "the real loader forwards the model outcome").toEqual({
      Chess: "Chess",
      Go: "Go",
    });
    expect(result.reads).toEqual([MEMBER.userId, VIEWER.userId]);
  });

  it("RED: real profile loader links the owner's own games with a single store read", async () => {
    const result = await renderRoute("profile", MEMBER.userId);
    const items = gameItems(gamesBlock(result.html));
    expect(items.map((i) => itemGameName(i.inner))).toEqual(["Chess", "Go"]);
    expectLinked(items[0]!, "Chess", "Chess");
    expectLinked(items[1]!, "Go", "Go");
    for (const item of items) expectUnmarked(item, itemGameName(item.inner));
    expect(result.sharedGames).toEqual([]);
    expect(result.scheduledGames).toEqual({ Chess: "Chess", Go: "Go" });
    expect(result.reads).toEqual([MEMBER.userId]);
  });

  it("GUARD: without the scheduledGames prop the list stays plain, markers aside", () => {
    const { html } = renderView(viewProps(["Chess", "Go"], { sharedGames: ["Go"] }));
    const items = gameItems(gamesBlock(html));
    expect(items).toHaveLength(2);
    for (const item of items) expectUnlinked(item, itemGameName(item.inner));
    expectMarked(items[1]!, "Go");
    expect(gamesBlock(html)).not.toContain("/events?game=");
  });

  it("GUARD: empty games keep the existing empty copy verbatim and link nothing", () => {
    const { html } = renderView(viewProps([], { scheduledGames: {} }));
    expect(gamesBlock(html)).toContain(PROFILE_EMPTY_COPY.gamesOther);
    expect(gameItems(gamesBlock(html))).toHaveLength(0);
    expect(gamesBlock(html)).not.toContain("/events?game=");
  });
});

describe("Scheduled-game links wiring (RED source pins)", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p: string): string => readFileSync(p, "utf8");

  it("RED: one shared matcher and one published-games seam serve both twins", () => {
    const matcher = read(join(root, "src/profiles/shared-games.ts"));
    expect(matcher, "the shared matcher lives beside findSharedGames").toMatch(
      /export function findScheduledGames\b/,
    );
    const deps = read(join(root, "src/profiles/routes-shared.ts"));
    expect(deps, "ProfileDeps gains the publishedGames seam").toContain("publishedGames");
    const kit = read(join(root, "src/profiles/kit.ts"));
    expect(kit, "the Kit model uses the shared matcher").toContain("findScheduledGames");
    expect(kit, "kitProfileDeps exposes publishedGamesFor").toContain("publishedGamesFor");
    expect(kit, "the Kit ok outcome carries scheduledGames").toContain("scheduledGames");
    const honoReads = read(join(root, "src/profiles/routes-reads.tsx"));
    expect(honoReads, "the Hono read uses the shared matcher").toContain("findScheduledGames");
    expect(honoReads, "the Hono read passes scheduledGames to the page").toContain(
      "scheduledGames",
    );
  });

  it("RED: the loads forward scheduledGames, the views consume it, hrefs are encoded", () => {
    const memberServer = read(join(root, "web/src/routes/members/[user]/+page.server.ts"));
    const memberPage = read(join(root, "web/src/routes/members/[user]/+page.svelte"));
    const profileServer = read(join(root, "web/src/routes/profile/+page.server.ts"));
    const profilePage = read(join(root, "web/src/routes/profile/+page.svelte"));
    for (const [label, source] of [
      ["members +page.server.ts", memberServer],
      ["profile +page.server.ts", profileServer],
    ] as const) {
      expect(source, `${label} wires the published-games seam`).toContain("publishedGamesFor");
      expect(source, `${label} returns outcome.scheduledGames`).toMatch(
        /scheduledGames\s*:\s*outcome\.scheduledGames\b/,
      );
    }
    for (const [label, source] of [
      ["members +page.svelte", memberPage],
      ["profile +page.svelte", profilePage],
    ] as const) {
      expect(source, `${label} forwards data.scheduledGames`).toMatch(
        /scheduledGames\s*=\s*\{\s*data\.scheduledGames\s*\}/,
      );
    }
    for (const [label, source] of [
      ["ProfileView.svelte", read(join(root, "web/src/lib/ProfileView.svelte"))],
      ["pages.tsx", read(join(root, "src/profiles/pages.tsx"))],
    ] as const) {
      expect(source, `${label} consumes scheduledGames`).toContain("scheduledGames");
      expect(source, `${label} builds the game-filtered href`).toContain("/events?game=");
      expect(source, `${label} URL-encodes the canonical game`).toContain("encodeURIComponent");
      expect(source, `${label} names the link for assistive tech`).toContain("upcoming events");
    }
  });
});
