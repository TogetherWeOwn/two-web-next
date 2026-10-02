// Legacy ProfileAvatarFailureTest pin: a broken avatar URL falls back to the
// initial on /profile, /members/:user and the event attendee list — no
// broken-image icon, no layout shift of the name/rank row.
//
// DB-free: mounted profilesApp with memory doubles plus direct EventPage
// renders from local fixtures. No DATABASE_URL, no fetch, no session/DB reads
// beyond the memory doubles. The "broken" URL is a valid-format Discord hash
// whose CDN fetch fails client-side; SSR still ships img + hidden initial and
// the shared public/islands/avatar.js binder swaps on error.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { PROFILE_AVATAR_TESTID, profileAvatarSrcset } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
};

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";
// Valid-format hash: SSR renders the CDN img. A CDN 404 then fails client-side
// and the binder must reveal the initial — that failure is simulated via the
// error listener, never via network.
const AVATAR_HASH = "abc123";

const binder = readFileSync(new NodeURL("../public/islands/avatar.js", import.meta.url), "utf8");
const styles = readFileSync(new NodeURL("../public/styles.css", import.meta.url), "utf8");

type AvatarMock = {
  root: { querySelector: (selector: string) => unknown };
  image: {
    hidden: boolean;
    complete: boolean;
    naturalWidth: number;
    addEventListener: ReturnType<typeof vi.fn>;
  };
  initial: { hidden: boolean };
  fireError: () => void;
};

function mockAvatar(opts: { complete?: boolean; naturalWidth?: number } = {}): AvatarMock {
  const listeners = new Map<string, () => void>();
  const image = {
    hidden: false,
    complete: opts.complete ?? false,
    naturalWidth: opts.naturalWidth ?? 0,
    addEventListener: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
  };
  const initial = { hidden: true };
  const root = {
    querySelector: (selector: string) => {
      if (selector === "img") return image;
      if (selector === "[data-avatar-initial]") return initial;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  return {
    root,
    image,
    initial,
    fireError: () => listeners.get("error")?.(),
  };
}

function runBinder(avatars: AvatarMock[]): void {
  runInNewContext(binder, {
    document: {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe("[data-avatar]");
        return avatars.map((a) => a.root);
      },
    },
  });
}

async function setup() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    {
      id: ALICE_ID,
      username: "alice",
      avatar: AVATAR_HASH,
      bio: null,
      games: [],
      timezone: null,
      rank: "Veteran",
      joinedAt: new Date("2024-03-15T00:00:00Z"),
    },
    {
      id: BOB_ID,
      username: "bob",
      avatar: AVATAR_HASH,
      bio: null,
      games: [],
      timezone: "Europe/London",
      rank: "Regular",
      joinedAt: new Date("2024-04-01T00:00:00Z"),
    },
  ]);
  const app = profilesApp({
    sessionStore: sessions,
    store,
    // Fixtures only: no DB read, no log sink, no throttle store.
    stats: async () => null,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: ALICE_ID,
    username: "alice",
    avatar: AVATAR_HASH,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { app, cookie };
}

async function getHtml(path: string): Promise<string> {
  const { app, cookie } = await setup();
  const res = await app.request(path, { headers: { cookie } }, env);
  expect(res.status).toBe(200);
  return res.text();
}

function eventFixture(): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Voice lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    goingCount: 2,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: start,
    updatedAt: start,
  };
}

describe("avatar load-failure fallback render", () => {
  it("profile SSR ships img + hidden initial + external binder with no inline handlers", async () => {
    const html = await getHtml("/profile");
    const expected = profileAvatarSrcset(ALICE_ID, AVATAR_HASH)!;
    expect(html).toContain(
      `data-testid="${PROFILE_AVATAR_TESTID}" data-avatar="" aria-hidden="true" class="avatar"`,
    );
    expect(html).toContain(`src="${expected.src}"`);
    expect(html).toContain(`srcset="${expected.srcset}"`);
    expect(html).toContain('alt="" width="64" height="64" loading="eager"');
    expect(html).toContain(
      '<span data-avatar-initial="" class="avatar-initial" hidden="">A</span>',
    );
    expect(html).toContain('<script src="/islands/avatar.js" defer=""></script>');
    expect(html).not.toMatch(/\son(?:error|load)=/i);
    // Name/rank row survives alongside the avatar — the row the fallback must not shift.
    expect(html).toContain('data-testid="profile-name"');
    expect(html).toContain('data-testid="profile-rank">Veteran');
  });

  it("member page SSR matches the profile fallback markup", async () => {
    const html = await getHtml(`/members/${BOB_ID}`);
    const expected = profileAvatarSrcset(BOB_ID, AVATAR_HASH)!;
    expect(html).toContain(
      `data-testid="${PROFILE_AVATAR_TESTID}" data-avatar="" aria-hidden="true" class="avatar"`,
    );
    expect(html).toContain(`src="${expected.src}"`);
    expect(html).toContain(`srcset="${expected.srcset}"`);
    expect(html).toContain(
      '<span data-avatar-initial="" class="avatar-initial" hidden="">B</span>',
    );
    expect(html).toContain('<script src="/islands/avatar.js" defer=""></script>');
    expect(html).not.toMatch(/\son(?:error|load)=/i);
    expect(html).toContain('data-testid="profile-name"');
    expect(html).toContain('data-testid="profile-rank">Regular');
  });

  it("a load failure swaps to the initial while the name/rank row stays put", async () => {
    const before = await getHtml("/profile");
    const avatar = mockAvatar();
    runBinder([avatar]);
    expect(avatar.image.addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    // Valid load so far: img visible, initial hidden — matches SSR.
    expect(avatar.image.hidden).toBe(false);
    expect(avatar.initial.hidden).toBe(true);
    // Broken CDN fetch: error fires, binder hides the img and reveals the initial.
    avatar.fireError();
    expect(avatar.image.hidden).toBe(true);
    expect(avatar.initial.hidden).toBe(false);
    // No layout shift: the SSR row is still rendered; the swap only toggles
    // hidden inside the size-reserved avatar box (pinned below).
    expect(before).toContain('data-testid="profile-name"');
    expect(before).toContain('data-testid="profile-rank">Veteran');
    expect(before).not.toContain("broken-image");
  });

  it("a valid avatar load leaves the img visible and the initial hidden", () => {
    const avatar = mockAvatar({ complete: true, naturalWidth: 64 });
    runBinder([avatar]);
    expect(avatar.image.hidden).toBe(false);
    expect(avatar.initial.hidden).toBe(true);
  });

  it("event attendee list is initial-only: no img to break, link and mark preserved", () => {
    const html = EventPage({
      e: eventFixture(),
      neighbors: { previous: null, next: null },
      related: [],
      attendees: [
        { id: ALICE_ID, name: "alice" },
        { id: BOB_ID, name: "bob" },
      ],
      appUrl: APP_URL,
      jsonLd: "{}",
    })!.toString();
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toContain('<ul class="event-attendee-grid">');
    expect(html).toContain('<span class="event-attendee-mark" aria-hidden="true">a</span>');
    expect(html).toContain(`<a href="/members/${ALICE_ID}">alice</a>`);
    expect(html).toContain(`<a href="/members/${BOB_ID}">bob</a>`);
    // No avatar img anywhere in the attendee list — a broken URL cannot render
    // a broken-image icon here; the initial mark is the only visual.
    const list = html.slice(html.indexOf('<ul class="event-attendee-grid">'));
    expect(list).not.toContain("<img");
    expect(html).not.toMatch(/\son(?:error|load)=/i);
  });

  it("size is reserved so the fallback cannot shift the name/rank row", () => {
    // Profile avatar box: fixed size + no shrink; both states fill it; hidden
    // never displays. Img carries width/height attributes (asserted above).
    expect(styles).toMatch(/\.avatar \{[^}]*width: 64px;[^}]*height: 64px;[^}]*flex-shrink: 0;/);
    expect(styles).toContain(".avatar img, .avatar-initial { width: 100%; height: 100%; }");
    expect(styles).toContain(".avatar [hidden] { display: none; }");
    const eventCss = readFileSync(
      new NodeURL("../public/event-theme.css", import.meta.url),
      "utf8",
    );
    expect(eventCss).toContain(".event-attendee-mark { width: 3rem; height: 3rem; flex-shrink: 0;");
  });
});
