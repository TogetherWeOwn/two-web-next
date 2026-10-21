// Acceptance contract: public /u/<handle> profile pages with per-field
// visibility, served by SvelteKit.
//
// Criterion map (the profiles epic spec decisions are binding; this file pins
// the view slice only):
// - /u/<handle> renders for guests (public fields only), members (public +
//   members fields + Discord username + "Message on Discord") and the owner
//   (all fields plus an edit link).
// - The Discord username and ID never appear in the guest outcome: not in the
//   filtered view, not in robots/canonical/OG signals, not anywhere in the
//   outcome JSON. The served-HTML half of this rule lives in the staging
//   companion spec, which greps the guest bytes for the fixture IDs.
// - noindex unless the member opted in; opted in means index plus an absolute
//   canonical and correct OG tags. The opt-in flip is hermetic-only: no editor
//   exists yet to flip it on staging.
// - Former members: guests get notFound; members get the profile marked
//   former. The served-former journey (seeded staging fixture) lives in the
//   staging companion spec.
// - /members/<id> and /profile 301-redirect to /u/<handle> for resolved
//   reads, and the three profile routes move to Kit ownership. The bindings
//   keep calling the legacy read model, so the guest bounce (302 + intended
//   cookie), the outsider 403 and the outage 503 pinned by the guest-bounce
//   acceptance suite stay intact; only the ok outcome maps to a 301.
//
// Required Builder seam (this file is the specification; do not edit it):
// - `resolvePublicProfile(req, deps)` exported from src/profiles/kit.ts.
//   req is { session, handle, appUrl }; deps is { store, stats? } where stats
//   mirrors the existing KitProfileDeps shape. No other required inputs.
// - `ProfileStore.findByHandle(handle)` on the database and memory stores,
//   returning the row (current or former) or null for an unknown handle.
// - MemberView gains optional handle, displayName, formerMember, indexOptIn
//   and visibility (all optional: every existing seed keeps compiling).
//   Absent visibility reads as the spec defaults (public: display name,
//   avatar, rank, member-since; members-only: bio, games, timezone, Steam);
//   absent indexOptIn reads as opted out; absent displayName falls back to
//   the username; absent formerMember reads as current.
// - ROUTE_MANIFEST: an enabled GET entry under /u/ plus /profile and
//   /members/:user flipped to enabled. Bindings: the /u/[handle] load
//   resolves through the model and maps robots/canonical/OG; the
//   /profile and /members/[user] loads map ok to redirect(301, /u/<handle>).
//
// Viewer-class rules pinned here:
// - owner = session userId matches the profile id, even with a lapsed
//   membership (a former member still sees their own kept data with the
//   badge); member = signed-in current member (moderators viewing others
//   get the member view; moderator tooling belongs to the moderation slice);
//   everyone else (guests and signed-in non-members) gets the guest view.
// - The former-member badge is a member-view flag, never a guest leak:
//   guests cannot distinguish a former handle from an unknown one.
// - robots/canonical/OG are profile-level signals, identical for every
//   viewer class; OG description and title derive from the FILTERED view,
//   so members-only values can never reach guest meta tags.
// - Deliberately unspecified: the "Message on Discord" affordance for the
//   owner viewing their own page and for former-member views, and the edit
//   link target (the editor slice owns that route; presence is pinned).
//
// Forcing functions the Builder must resolve, not route around:
// - Discord CDN avatar URLs embed the user id
//   (cdn.discordapp.com/avatars/<id>/<hash>.png), and the avatar is public
//   by default. The guest outcome JSON must not contain the id anywhere, so
//   the Builder must proxy, rewrite or omit ID-bearing avatar URLs for
//   guests. Hiding the username field while serving the raw avatar URL fails
//   the leak tests, and rightly so: the id would still be harvestable.
// - The handle is public by construction (it is the URL). Handles that
//   equal a Discord username are the member's choice, not a leak; the leak
//   rule covers the username/id AS identity disclosures (username field,
//   message affordance, deep links, meta/JSON identity keys).
//
// Staging companion: e2e/staging/public-profiles.spec.ts covers the served
// bytes (guest HTML/JSON/meta without the fixture IDs, noindex tag,
// conditional canonical/OG correctness), the served 301s and 302s, and the
// seeded former-member journey. The former-owner session and the index
// opt-in flip cannot be staged (QA login always mints current-member
// sessions; no editor exists), so they are hermetic-only by necessity.
//
// Hermetic: memory stores, fixture secret, synthetic sessions. No database,
// no OAuth, no network, no route activation beyond the manifest pins.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { KitRequestSession } from "../src/kit-session";
import * as kit from "../src/profiles/kit";
import type { MemberStats } from "../src/profiles/stats";
import {
  createMemoryProfileStore,
  type MemberView,
  type ProfileStore,
} from "../src/profiles/store";
import { decideRoute, ROUTE_MANIFEST } from "../src/route-ownership";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => {
  try {
    return readFileSync(join(root, p), "utf8");
  } catch {
    return "";
  }
};

const APP = "https://next.example.test";

const ALICE_ID = "100000000000000001";
const ALICE_USERNAME = "alice_secretname";
const ALICE_HANDLE = "alice";
const ALICE_DISPLAY = "Alice A.";
const ALICE_AVATAR = `https://cdn.discordapp.com/avatars/${ALICE_ID}/9f8e7d6c5b4a.png`;
const ALICE_BIO = "Alice member-bio marker";
const ALICE_GAMES = ["Deep Rock Galactic", "Minecraft"];
const ALICE_TZ = "Europe/London";
const ALICE_JOINED = new Date("2024-03-02T10:00:00.000Z");
const ALICE_RANK = "gold-iii";

const BOB_ID = "100000000000000002";
const BOB_USERNAME = "bob_viewer";
const BOB_HANDLE = "bob";
const BOB_DISPLAY = "Bob B.";

const FAY_ID = "100000000000000009";
const FAY_USERNAME = "fay_oldname";
const FAY_HANDLE = "fay";
const FAY_DISPLAY = "Fay F.";
const FAY_BIO = "Fay former-bio marker";

const OUTSIDER_ID = "100000000000000004";
const MOD_ID = "100000000000000003";

// The visibility contract the model filters by. Every key is optional: an
// absent map, or an absent key in a sparse map, reads as the spec default.
type FieldVisibility = "public" | "members";
type VisibilityMap = {
  displayName?: FieldVisibility;
  avatar?: FieldVisibility;
  rank?: FieldVisibility;
  memberSince?: FieldVisibility;
  bio?: FieldVisibility;
  games?: FieldVisibility;
  timezone?: FieldVisibility;
  steam?: FieldVisibility;
};

// The store-row contract: MemberView plus the optional profile-slice keys.
// Optional on purpose — every existing seed keeps compiling, and the model
// supplies the spec defaults for absent keys (see the header).
type SeedRow = MemberView & {
  handle?: string | null;
  displayName?: string | null;
  formerMember?: boolean;
  indexOptIn?: boolean;
  visibility?: VisibilityMap;
};

type PublicProfileRequest = {
  session: KitRequestSession;
  handle: string;
  appUrl: string;
};

type PublicProfileView = {
  handle: string;
  displayName: string | null;
  avatar: string | null;
  rank: string | null;
  memberSince: string | null;
  bio: string | null;
  games: string[];
  timezone: string | null;
  discordUsername: string | null;
  messageOnDiscord: boolean;
  editLink: string | null;
  formerMember: boolean;
};

type PublicProfileOutcome =
  | { kind: "unavailable" }
  | { kind: "notFound" }
  | {
      kind: "ok";
      view: PublicProfileView;
      viewerClass: "guest" | "member" | "owner";
      robots: "index" | "noindex";
      canonical: string;
      openGraph: {
        title: string;
        url: string;
        image: string | null;
        description: string | null;
        type: "profile";
      };
    };

type PublicProfileDeps = {
  // Partial: the pre-Builder store has no findByHandle yet, and the runtime
  // seam assertion (not the type system) reports that.
  store: (ProfileStore & Partial<HandleStore>) | null;
  stats?: (memberId: string) => Promise<MemberStats | null>;
};

type ResolvePublicProfile = (
  req: PublicProfileRequest,
  deps: PublicProfileDeps,
) => Promise<PublicProfileOutcome>;

// The wished-for resolver, reached through the existing module so this file
// typechecks and collects before the Builder adds the export: every model
// test fails on the seam assertion until then, for exactly that reason.
const resolvePublicProfile = (): ResolvePublicProfile => {
  const fn = (kit as unknown as Record<string, unknown>).resolvePublicProfile;
  expect(
    typeof fn,
    "Builder seam missing: src/profiles/kit.ts must export resolvePublicProfile",
  ).toBe("function");
  return fn as ResolvePublicProfile;
};

type HandleStore = { findByHandle: (handle: string) => Promise<SeedRow | null> };

const handleSpy = (store: object) => {
  const candidate = (store as Partial<HandleStore>).findByHandle;
  expect(
    typeof candidate,
    "Builder seam missing: ProfileStore must support findByHandle(handle)",
  ).toBe("function");
  return vi.spyOn(store as HandleStore, "findByHandle");
};

type OkOutcome = Extract<PublicProfileOutcome, { kind: "ok" }>;

const okOutcome = (outcome: PublicProfileOutcome): OkOutcome => {
  expect(outcome.kind).toBe("ok");
  return outcome as OkOutcome;
};

const guestSession = (): KitRequestSession => ({ status: "guest", session: null });
const unknownSession = (): KitRequestSession => ({ status: "unknown", session: null });
const viewerSession = (
  userId: string,
  username: string,
  member: boolean,
  moderator: boolean,
): KitRequestSession => ({
  status: "authenticated",
  session: { userId, username, avatar: null, member, moderator },
});

const DEFAULT_VISIBILITY: VisibilityMap = {
  displayName: "public",
  avatar: "public",
  rank: "public",
  memberSince: "public",
  bio: "members",
  games: "members",
  timezone: "members",
  steam: "members",
};

const seedRow = (overrides: Partial<SeedRow> & { id: string }): SeedRow => ({
  username: "seed_user",
  avatar: null,
  bio: null,
  games: [],
  timezone: null,
  joinedAt: null,
  ...overrides,
});

const alice = (): SeedRow =>
  seedRow({
    id: ALICE_ID,
    username: ALICE_USERNAME,
    avatar: ALICE_AVATAR,
    bio: ALICE_BIO,
    games: [...ALICE_GAMES],
    timezone: ALICE_TZ,
    joinedAt: ALICE_JOINED,
    handle: ALICE_HANDLE,
    displayName: ALICE_DISPLAY,
    formerMember: false,
    indexOptIn: false,
    visibility: { ...DEFAULT_VISIBILITY },
  });

const bobOptedIn = (): SeedRow =>
  seedRow({
    id: BOB_ID,
    username: BOB_USERNAME,
    avatar: null,
    bio: "Bob bio",
    games: [],
    timezone: null,
    joinedAt: ALICE_JOINED,
    handle: BOB_HANDLE,
    displayName: BOB_DISPLAY,
    formerMember: false,
    indexOptIn: true,
    visibility: { ...DEFAULT_VISIBILITY },
  });

const fayFormer = (): SeedRow =>
  seedRow({
    id: FAY_ID,
    username: FAY_USERNAME,
    avatar: null,
    bio: FAY_BIO,
    games: ["Stardew Valley"],
    timezone: "UTC",
    joinedAt: ALICE_JOINED,
    handle: FAY_HANDLE,
    displayName: FAY_DISPLAY,
    formerMember: true,
    indexOptIn: false,
    visibility: { ...DEFAULT_VISIBILITY },
  });

const statsFor = (rankKey: string | null): MemberStats => ({
  joinedAt: null,
  tenureDays: 365,
  rankKey,
  isCurrentMember: true,
  milestones: [],
  milestonesTruncated: false,
});

const reqFor = (session: KitRequestSession, handle: string): PublicProfileRequest => ({
  session,
  handle,
  appUrl: APP,
});

const depsFor = (seed: SeedRow[], stats?: PublicProfileDeps["stats"]): PublicProfileDeps => ({
  store: createMemoryProfileStore(seed),
  stats,
});

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("route ownership: the profile routes move to Kit", () => {
  const get = (path: string) => decideRoute(new Request(`${APP}${path}`));

  it("GET /u/<handle> resolves to a Kit-owned entry", () => {
    expect(get("/u/alice"), "manifest must carry an enabled GET /u/* entry").toBeDefined();
  });

  it("GET /profile moves to Kit ownership", () => {
    expect(get("/profile"), "manifest must enable GET /profile for Kit").toBeDefined();
  });

  it("GET /members/:user moves to Kit ownership", () => {
    expect(
      get(`/members/${ALICE_ID}`),
      "manifest must enable GET /members/:user for Kit",
    ).toBeDefined();
  });

  it("HEAD /u/<handle> follows its GET entry", () => {
    const head = decideRoute(new Request(`${APP}/u/alice`, { method: "HEAD" }));
    expect(head, "HEAD must follow the GET /u/* entry").toBeDefined();
  });

  it("the manifest carries exactly one enabled single-segment GET entry under /u/", () => {
    // Single-segment only: deeper /u/* paths belong to later slices (the
    // editor owns its own route) and must not trip this pin when they land.
    const entries = ROUTE_MANIFEST.filter(
      (e) => e.method === "GET" && e.path.startsWith("/u/") && e.path.split("/").length === 3,
    );
    expect(entries.length).toBe(1);
    expect(entries[0]!.enabled).toBe(true);
  });
});

describe("guest view: public fields only, no Discord identity", () => {
  it("guest sees the default-public fields", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()]),
    );
    const { view, viewerClass } = okOutcome(outcome);
    expect(viewerClass).toBe("guest");
    expect(view.handle).toBe(ALICE_HANDLE);
    expect(view.displayName).toBe(ALICE_DISPLAY);
    expect(view.rank).toBeNull();
    expect(typeof view.memberSince).toBe("string");
    expect(view.memberSince!.length).toBeGreaterThan(0);
    expect(view.formerMember).toBe(false);
  });

  it("guest does not see members-only fields", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()]),
    );
    const { view } = okOutcome(outcome);
    expect(view.bio).toBeFalsy();
    expect(view.games).toEqual([]);
    expect(view.timezone).toBeFalsy();
  });

  it("guest outcome carries no Discord identity anywhere in its JSON", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()]),
    );
    const { view } = okOutcome(outcome);
    expect(view.discordUsername).toBeFalsy();
    expect(view.messageOnDiscord).toBe(false);
    expect(view.editLink).toBeNull();
    // The avatar URL embeds the id (see the header forcing function): the
    // guest view must proxy, rewrite or omit it, never serve it raw.
    expect(
      view.avatar === null || !view.avatar.includes(ALICE_ID),
      "guest avatar must be ID-free",
    ).toBe(true);
    const json = JSON.stringify(outcome);
    expect(json).not.toContain(ALICE_USERNAME);
    expect(json).not.toContain(ALICE_ID);
    // Anti-vacuous: the public identifiers ARE present.
    expect(json).toContain(ALICE_HANDLE);
    expect(json).toContain(ALICE_DISPLAY);
  });

  it("a field toggled to public becomes guest-visible without leaking the rest", async () => {
    const row = alice();
    row.visibility = { ...DEFAULT_VISIBILITY, bio: "public" };
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([row]),
    );
    const { view } = okOutcome(outcome);
    expect(view.bio).toBe(ALICE_BIO);
    expect(view.displayName).toBe(ALICE_DISPLAY);
    expect(view.games).toEqual([]);
    expect(view.timezone).toBeFalsy();
    expect(JSON.stringify(outcome)).not.toContain(ALICE_ID);
  });

  it("a field toggled to members-only leaves the guest view, with a leak-free OG title", async () => {
    const row = alice();
    row.visibility = { ...DEFAULT_VISIBILITY, displayName: "members" };
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([row]),
    );
    const ok = okOutcome(outcome);
    expect(ok.view.displayName).toBeFalsy();
    expect(JSON.stringify(ok)).not.toContain(ALICE_DISPLAY);
    expect(JSON.stringify(ok)).not.toContain(ALICE_ID);
    expect(ok.openGraph.title.length).toBeGreaterThan(0);
    expect(ok.openGraph.title).not.toContain(ALICE_DISPLAY);
  });

  it("a sparse visibility map defaults every absent key", async () => {
    const row = alice();
    row.visibility = { bio: "public" };
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([row]),
    );
    const { view } = okOutcome(outcome);
    expect(view.bio).toBe(ALICE_BIO);
    expect(view.displayName).toBe(ALICE_DISPLAY);
    expect(view.games).toEqual([]);
    expect(view.timezone).toBeFalsy();
  });

  it("a legacy row without the new keys reads as current, opted out, spec defaults", async () => {
    const row = seedRow({ id: ALICE_ID, username: ALICE_USERNAME, handle: ALICE_HANDLE });
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([row]),
    );
    const ok = okOutcome(outcome);
    expect(ok.view.formerMember).toBe(false);
    expect(ok.robots).toBe("noindex");
    expect(ok.view.displayName).toBe(ALICE_USERNAME);
    expect(ok.view.bio).toBeFalsy();
    expect(JSON.stringify(ok)).not.toContain(ALICE_ID);
  });

  it("signed-in non-members get the guest-equivalent public view", async () => {
    const outsider = viewerSession(OUTSIDER_ID, "outsider", false, false);
    const outcome = await resolvePublicProfile()(
      reqFor(outsider, ALICE_HANDLE),
      depsFor([alice()]),
    );
    const ok = okOutcome(outcome);
    expect(ok.viewerClass).toBe("guest");
    expect(ok.view.displayName).toBe(ALICE_DISPLAY);
    expect(ok.view.bio).toBeFalsy();
    expect(ok.view.discordUsername).toBeFalsy();
    expect(ok.view.messageOnDiscord).toBe(false);
    const json = JSON.stringify(ok);
    expect(json).not.toContain(ALICE_USERNAME);
    expect(json).not.toContain(ALICE_ID);
  });
});

describe("member view: members fields plus the Discord identity", () => {
  const bobMember = () => viewerSession(BOB_ID, BOB_USERNAME, true, false);

  it("member sees public plus members fields", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(bobMember(), ALICE_HANDLE),
      depsFor([alice()]),
    );
    const { view, viewerClass } = okOutcome(outcome);
    expect(viewerClass).toBe("member");
    expect(view.displayName).toBe(ALICE_DISPLAY);
    expect(view.bio).toBe(ALICE_BIO);
    expect(view.games).toEqual(ALICE_GAMES);
    expect(view.timezone).toBe(ALICE_TZ);
    expect(view.avatar).toBe(ALICE_AVATAR);
    expect(view.formerMember).toBe(false);
  });

  it("member sees the Discord username and the message affordance, but no edit link", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(bobMember(), ALICE_HANDLE),
      depsFor([alice()]),
    );
    const { view } = okOutcome(outcome);
    expect(view.discordUsername).toBe(ALICE_USERNAME);
    expect(view.messageOnDiscord).toBe(true);
    expect(view.editLink).toBeNull();
    // Anti-vacuous: the member JSON does carry the identity.
    expect(JSON.stringify(outcome)).toContain(ALICE_USERNAME);
  });

  it("a moderator viewing another member gets the member view", async () => {
    const mod = viewerSession(MOD_ID, "mod", true, true);
    const outcome = await resolvePublicProfile()(reqFor(mod, ALICE_HANDLE), depsFor([alice()]));
    const { view, viewerClass } = okOutcome(outcome);
    expect(viewerClass).toBe("member");
    expect(view.discordUsername).toBe(ALICE_USERNAME);
    expect(view.messageOnDiscord).toBe(true);
    expect(view.editLink).toBeNull();
  });

  it("an empty members-only field stays hidden by being empty", async () => {
    for (const bio of ["", null]) {
      const row = alice();
      row.bio = bio;
      const outcome = await resolvePublicProfile()(
        reqFor(bobMember(), ALICE_HANDLE),
        depsFor([row]),
      );
      expect(okOutcome(outcome).view.bio).toBeFalsy();
    }
  });
});

describe("owner view: everything plus an edit link", () => {
  it("owner sees every field plus an edit link", async () => {
    const owner = viewerSession(ALICE_ID, ALICE_USERNAME, true, false);
    const outcome = await resolvePublicProfile()(reqFor(owner, ALICE_HANDLE), depsFor([alice()]));
    const { view, viewerClass } = okOutcome(outcome);
    expect(viewerClass).toBe("owner");
    expect(view.displayName).toBe(ALICE_DISPLAY);
    expect(view.bio).toBe(ALICE_BIO);
    expect(view.games).toEqual(ALICE_GAMES);
    expect(view.timezone).toBe(ALICE_TZ);
    expect(view.discordUsername).toBe(ALICE_USERNAME);
    expect(view.editLink).toMatch(/^\//);
    // messageOnDiscord for the owner is deliberately unspecified (header).
  });
});

describe("former members: guests 404, members see the badge", () => {
  it("guest viewing a former member gets notFound after the store is consulted", async () => {
    const deps = depsFor([fayFormer()]);
    const spy = handleSpy(deps.store!);
    const outcome = await resolvePublicProfile()(reqFor(guestSession(), FAY_HANDLE), deps);
    expect(outcome).toEqual({ kind: "notFound" });
    expect(spy).toHaveBeenCalledWith(FAY_HANDLE);
  });

  it("signed-in non-member viewing a former member gets notFound", async () => {
    const outsider = viewerSession(OUTSIDER_ID, "outsider", false, false);
    const outcome = await resolvePublicProfile()(
      reqFor(outsider, FAY_HANDLE),
      depsFor([fayFormer()]),
    );
    expect(outcome).toEqual({ kind: "notFound" });
  });

  it("member viewing a former member gets the profile marked former", async () => {
    const bob = viewerSession(BOB_ID, BOB_USERNAME, true, false);
    const outcome = await resolvePublicProfile()(reqFor(bob, FAY_HANDLE), depsFor([fayFormer()]));
    const { view, viewerClass } = okOutcome(outcome);
    expect(viewerClass).toBe("member");
    expect(view.formerMember).toBe(true);
    expect(view.displayName).toBe(FAY_DISPLAY);
    expect(view.bio).toBe(FAY_BIO);
    expect(view.discordUsername).toBe(FAY_USERNAME);
    // The message affordance on former-member views is deliberately
    // unspecified (header): the badge plus the members data are the rule.
  });

  it("an owner with lapsed membership still sees their own kept profile with the badge", async () => {
    const lapsedOwner = viewerSession(FAY_ID, FAY_USERNAME, false, false);
    const outcome = await resolvePublicProfile()(
      reqFor(lapsedOwner, FAY_HANDLE),
      depsFor([fayFormer()]),
    );
    const { view, viewerClass } = okOutcome(outcome);
    expect(viewerClass).toBe("owner");
    expect(view.formerMember).toBe(true);
    expect(view.bio).toBe(FAY_BIO);
    expect(view.editLink).toMatch(/^\//);
  });
});

describe("unknown handles and outages fail closed", () => {
  it("unknown handle is notFound for guests and members alike", async () => {
    const bob = viewerSession(BOB_ID, BOB_USERNAME, true, false);
    for (const session of [guestSession(), bob]) {
      const outcome = await resolvePublicProfile()(
        reqFor(session, "no-such-handle"),
        depsFor([alice()]),
      );
      expect(outcome).toEqual({ kind: "notFound" });
    }
  });

  it("empty handle is notFound without crashing", async () => {
    const outcome = await resolvePublicProfile()(reqFor(guestSession(), ""), depsFor([alice()]));
    expect(outcome).toEqual({ kind: "notFound" });
  });

  it("unknown session is unavailable with no store read", async () => {
    const deps = depsFor([alice()]);
    const spy = handleSpy(deps.store!);
    const outcome = await resolvePublicProfile()(reqFor(unknownSession(), ALICE_HANDLE), deps);
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("null store is unavailable", async () => {
    const outcome = await resolvePublicProfile()(reqFor(guestSession(), ALICE_HANDLE), {
      store: null,
    });
    expect(outcome).toEqual({ kind: "unavailable" });
  });
});

describe("indexing: noindex by default, canonical plus OG when opted in", () => {
  it("opted-out profile is noindex for every viewer class", async () => {
    const sessions: Array<[string, KitRequestSession]> = [
      ["guest", guestSession()],
      ["member", viewerSession(BOB_ID, BOB_USERNAME, true, false)],
      ["owner", viewerSession(ALICE_ID, ALICE_USERNAME, true, false)],
    ];
    for (const [label, session] of sessions) {
      const outcome = await resolvePublicProfile()(
        reqFor(session, ALICE_HANDLE),
        depsFor([alice()]),
      );
      expect(okOutcome(outcome).robots, `robots for ${label}`).toBe("noindex");
    }
  });

  it("opted-in profile is index with an absolute canonical", async () => {
    const bob = viewerSession(BOB_ID, BOB_USERNAME, true, false);
    const outcome = await resolvePublicProfile()(reqFor(bob, BOB_HANDLE), depsFor([bobOptedIn()]));
    const ok = okOutcome(outcome);
    expect(ok.robots).toBe("index");
    expect(ok.canonical).toBe(`${APP}/u/${BOB_HANDLE}`);
    expect(ok.openGraph.url).toBe(`${APP}/u/${BOB_HANDLE}`);
  });

  it("open graph tags carry the visible identity for members", async () => {
    const bob = viewerSession(BOB_ID, BOB_USERNAME, true, false);
    const outcome = await resolvePublicProfile()(reqFor(bob, ALICE_HANDLE), depsFor([alice()]));
    const ok = okOutcome(outcome);
    expect(ok.canonical).toBe(`${APP}/u/${ALICE_HANDLE}`);
    expect(ok.openGraph).toEqual({
      title: ALICE_DISPLAY,
      url: `${APP}/u/${ALICE_HANDLE}`,
      image: ALICE_AVATAR,
      description: ALICE_BIO,
      type: "profile",
    });
  });

  it("guest open graph never carries members-only values", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()]),
    );
    const ok = okOutcome(outcome);
    expect(ok.openGraph.title).toBe(ALICE_DISPLAY);
    expect(ok.openGraph.url).toBe(`${APP}/u/${ALICE_HANDLE}`);
    expect(ok.openGraph.description).toBeFalsy();
    expect(ok.openGraph.image).toBe(ok.view.avatar);
    expect(JSON.stringify(ok.openGraph)).not.toContain(ALICE_ID);
  });
});

describe("ladder rank renders from bot stats, or hides without failing the page", () => {
  it("guest sees the rank passed through from stats", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()], async () => statsFor(ALICE_RANK)),
    );
    expect(okOutcome(outcome).view.rank).toBe(ALICE_RANK);
  });

  it("missing stats hide the rank without failing the page", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()], async () => null),
    );
    expect(okOutcome(outcome).view.rank).toBeNull();
  });

  it("unavailable membership stats hide the rank: no fact on them is valid", async () => {
    const outcome = await resolvePublicProfile()(
      reqFor(guestSession(), ALICE_HANDLE),
      depsFor([alice()], async () => ({ ...statsFor(ALICE_RANK), membershipUnavailable: true })),
    );
    expect(okOutcome(outcome).view.rank).toBeNull();
  });
});

describe("legacy reads keep resolving by id (the 301 inputs)", () => {
  // No unit pin on member.handle carriage: the memory store echoes seed
  // objects, so any such assertion would pass vacuously before the Builder
  // writes a line. The handle plumbing is pinned where it is not vacuous:
  // the store source pin below plus the served staging 301s.
  it("CONTROL: former rows keep resolving by id, so their legacy URL 301s instead of 404ing", async () => {
    const bob = viewerSession(BOB_ID, BOB_USERNAME, true, false);
    const outcome = await kit.resolveKitProfile(
      { session: bob, requestedId: FAY_ID, joinResult: null },
      { store: createMemoryProfileStore([fayFormer()]) },
    );
    expect(outcome.kind).toBe("ok");
  });

  it("CONTROL: legacy resolveKitProfile outcomes are otherwise unchanged", async () => {
    const store = createMemoryProfileStore([alice()]);
    const guest = await kit.resolveKitProfile(
      { session: guestSession(), requestedId: ALICE_ID, joinResult: null },
      { store },
    );
    expect(guest.kind).toBe("redirect");
    const member = await kit.resolveKitProfile(
      {
        session: viewerSession(BOB_ID, BOB_USERNAME, true, false),
        requestedId: ALICE_ID,
        joinResult: null,
      },
      { store },
    );
    expect(member.kind).toBe("ok");
    const outsider = await kit.resolveKitProfile(
      {
        session: viewerSession(OUTSIDER_ID, "outsider", false, false),
        requestedId: ALICE_ID,
        joinResult: null,
      },
      { store },
    );
    expect(outsider).toEqual({ kind: "forbidden" });
    const unknown = await kit.resolveKitProfile(
      { session: unknownSession(), requestedId: ALICE_ID, joinResult: null },
      { store },
    );
    expect(unknown).toEqual({ kind: "unavailable" });
  });
});

describe("bindings wire the page through the model (source pins)", () => {
  const bindings: ReadonlyArray<readonly [string, string]> = [
    ["/profile", "web/src/routes/profile/+page.server.ts"],
    ["/members/:user", "web/src/routes/members/[user]/+page.server.ts"],
  ];

  it("the Kit model exports the public resolver", () => {
    expect(read("src/profiles/kit.ts")).toContain("resolvePublicProfile");
  });

  it("the store supports handle lookup", () => {
    expect(read("src/profiles/store.ts")).toContain("findByHandle");
  });

  it("the member view carries the public display name", () => {
    expect(read("src/profiles/store.ts")).toContain("displayName");
  });

  it("the /u/[handle] load resolves through the model", () => {
    expect(read("web/src/routes/u/[handle]/+page.server.ts")).toContain("resolvePublicProfile");
  });

  it("the /u/[handle] load maps the robots signal", () => {
    expect(read("web/src/routes/u/[handle]/+page.server.ts")).toContain("robots");
  });

  it("the /u/[handle] load maps the canonical signal", () => {
    expect(read("web/src/routes/u/[handle]/+page.server.ts")).toContain("canonical");
  });

  it.each(bindings)("%s maps a resolved read to 301 at the handle URL", (_route, path) => {
    const src = read(path);
    expect(src).toContain("redirect(301");
    expect(src).toContain("/u/");
  });

  it("the public template carries the message button", () => {
    expect(read("web/src/routes/u/[handle]/+page.svelte")).toContain("Message on Discord");
  });

  it("the public template carries the former-member badge", () => {
    expect(read("web/src/routes/u/[handle]/+page.svelte")).toMatch(/former member/i);
  });

  it("the public template renders the robots, canonical and OG head", () => {
    const src = read("web/src/routes/u/[handle]/+page.svelte");
    expect(src).toContain("robots");
    expect(src).toContain("canonical");
    expect(src).toContain("og:");
  });

  it("the public template links the owner edit action", () => {
    expect(read("web/src/routes/u/[handle]/+page.svelte")).toContain("editLink");
  });
});
