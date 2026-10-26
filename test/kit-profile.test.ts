// Kit profile-read port contract: GET /profile and GET /members/:user
// through one Svelte view/model, Hono-owned until the edit-parity
// enablement review.
//
// Hermetic: memory session/store doubles, no database, no network. The
// member-gate order mirrors src/profiles/routes-gate.ts (member bit before
// any store read) and the audit order mirrors src/profiles/routes-reads.tsx
// (the retrieved subject — never the requested id — is declared before any
// output is released).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { decideRoute } from "../src/route-ownership";
import { keyedMemberRead, memberQueryPermit, memberReadResponse } from "../src/member-reads";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  resolveKitProfile,
  type KitProfileDeps,
  type KitProfileRequest,
} from "../src/profiles/kit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(p, "utf8");
const manifestSource = (): string => read(join(root, "src/route-ownership.ts"));
const profileServer = (): string => read(join(root, "web/src/routes/profile/+page.server.ts"));
const memberServer = (): string =>
  read(join(root, "web/src/routes/members/[user]/+page.server.ts"));
const profilePage = (): string => read(join(root, "web/src/routes/profile/+page.svelte"));
const memberPage = (): string => read(join(root, "web/src/routes/members/[user]/+page.svelte"));
const view = (): string => read(join(root, "web/src/lib/ProfileView.svelte"));

const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const MOD = "100000000000000003";

const seedMembers = (): MemberView[] => [
  {
    id: ALICE,
    username: "alice",
    avatar: null,
    bio: "Alice bio",
    games: ["Chess"],
    timezone: "Europe/London",
  },
  { id: BOB, username: "bob", avatar: "abc123", bio: null, games: [], timezone: null },
  { id: MOD, username: "mod", avatar: null, bio: null, games: [], timezone: null },
];

const memberSession = (userId: string, moderator = false) =>
  ({
    status: "authenticated",
    session: { userId, username: "viewer", avatar: null, member: true, moderator },
  }) as KitProfileRequest["session"];
const outsiderSession = () =>
  ({
    status: "authenticated",
    session: {
      userId: "100000000000000004",
      username: "outsider",
      avatar: null,
      member: false,
      moderator: false,
    },
  }) as KitProfileRequest["session"];
const guestSession = () => ({ status: "guest", session: null }) as KitProfileRequest["session"];
const unknownSession = () => ({ status: "unknown", session: null }) as KitProfileRequest["session"];

const depsFor = (overrides: Partial<KitProfileDeps> = {}): KitProfileDeps => ({
  store: createMemoryProfileStore(seedMembers()),
  ...overrides,
});
const reqFor = (
  session: KitProfileRequest["session"],
  requestedId: string | null,
): KitProfileRequest => ({ session, requestedId, joinResult: null });

const meta = { method: "GET", route: "/members/:user" };
const declared = (viewer: string) => ({
  resource: "profile",
  action: "view" as const,
  route: "profiles.show",
  viewer,
});

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Kit profile model: member gate before any store read", () => {
  it("guest redirects to the Discord sign-in without touching the store", async () => {
    const deps = depsFor();
    const find = vi.spyOn(deps.store!, "find");
    const outcome = await resolveKitProfile(reqFor(guestSession(), ALICE), deps);
    expect(outcome).toEqual({ kind: "redirect", location: "/auth/discord" });
    expect(find).not.toHaveBeenCalled();
  });

  it("unknown session (store outage, never a logout) is unavailable without a read", async () => {
    const deps = depsFor();
    const find = vi.spyOn(deps.store!, "find");
    const outcome = await resolveKitProfile(reqFor(unknownSession(), ALICE), deps);
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(find).not.toHaveBeenCalled();
  });

  it("signed-in non-member is forbidden on both reads with nothing rendered or logged", async () => {
    for (const requestedId of [ALICE, "100000000000000004"]) {
      const deps = depsFor();
      const find = vi.spyOn(deps.store!, "find");
      const outcome = await resolveKitProfile(reqFor(outsiderSession(), requestedId), deps);
      expect(outcome, requestedId).toEqual({ kind: "forbidden" });
      expect(find).not.toHaveBeenCalled();
    }
  });

  it("missing store (database outage) is unavailable without leaking the id", async () => {
    const outcome = await resolveKitProfile(reqFor(memberSession(BOB), ALICE), { store: null });
    expect(outcome).toEqual({ kind: "unavailable" });
  });
});

describe("Kit profile model: reads declare the retrieved subject", () => {
  it("member reading another member resolves with owner/moderator bits split", async () => {
    const outcome = await resolveKitProfile(reqFor(memberSession(BOB), ALICE), depsFor());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.member.username).toBe("alice");
    expect(outcome.isOwner).toBe(false);
    expect(outcome.isModerator).toBe(false);
    expect(outcome.stats).toBeNull();
  });

  it("self read (/profile) is the owner and stays distinct from other reads", async () => {
    const outcome = await resolveKitProfile(reqFor(memberSession(ALICE), ALICE), depsFor());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.isOwner).toBe(true);
  });

  it("moderator bit travels with the outcome but adds no member fields", async () => {
    const asMember = await resolveKitProfile(reqFor(memberSession(BOB), ALICE), depsFor());
    const asMod = await resolveKitProfile(reqFor(memberSession(MOD, true), ALICE), depsFor());
    expect(asMod.kind).toBe("ok");
    if (asMod.kind !== "ok" || asMember.kind !== "ok") return;
    expect(asMod.isModerator).toBe(true);
    expect({ ...asMod, isModerator: false }).toEqual({ ...asMember, isModerator: false });
  });

  it("malformed ids are not-found with no store subject declared", async () => {
    for (const bad of ["not-a-snowflake", "1", ""]) {
      const deps = depsFor();
      const find = vi.spyOn(deps.store!, "find");
      const outcome = await resolveKitProfile(reqFor(memberSession(BOB), bad), deps);
      expect(outcome, bad).toEqual({ kind: "notFound" });
      expect(find).not.toHaveBeenCalled();
    }
  });

  it("unknown snowflake ids are not-found and declare no subject", async () => {
    const deps = depsFor();
    const outcome = await resolveKitProfile(reqFor(memberSession(BOB), "999999999999999999"), deps);
    expect(outcome).toEqual({ kind: "notFound" });
  });

  it("missing public-member lookup resolves to a generic not-found outcome", async () => {
    const outcome = await resolveKitProfile(reqFor(memberSession(BOB), "999999999999999998"), {
      store: createMemoryProfileStore([]),
    });
    expect(outcome).toEqual({ kind: "notFound" });
  });

  it("stats absence resolves with a null block instead of failing the read", async () => {
    const outcome = await resolveKitProfile(reqFor(memberSession(BOB), ALICE), depsFor());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.stats).toBeNull();
  });

  it("a provided stats source resolves into the outcome", async () => {
    const stats = {
      joinedAt: new Date("2024-01-02T00:00:00Z"),
      tenureDays: 10,
      rankKey: "regular",
      isCurrentMember: true,
      milestonesTruncated: false,
      milestones: [],
    };
    const outcome = await resolveKitProfile(reqFor(memberSession(BOB), ALICE), {
      store: createMemoryProfileStore(seedMembers()),
      stats: async () => stats,
    });
    expect(outcome).toEqual({
      kind: "ok",
      member: expect.objectContaining({ id: ALICE }),
      stats,
      isOwner: false,
      isModerator: false,
      joinResult: null,
      // Bob stores no games, so nothing of Alice's list is shared with him.
      sharedGames: [],
      scheduledGames: {},
    });
  });
});

describe("Kit profile model: audit precedes output inside the boundary", () => {
  const release = (
    viewer: string,
    requestedId: string,
    sink: (entry: AccessEntry) => Promise<boolean>,
  ) =>
    memberReadResponse(meta, declared(viewer), sink, async () => {
      const outcome = await resolveKitProfile(
        { session: memberSession(viewer), requestedId, joinResult: null },
        depsFor(),
      );
      if (outcome.kind !== "ok") return new Response("refused-test", { status: 500 });
      return new Response(`<h1>${outcome.member.username}</h1>`, {
        headers: { "content-type": "text/html" },
      });
    });

  it("other-read writes exactly one row naming viewer, subject and route before bytes leave", async () => {
    const entries: AccessEntry[] = [];
    const res = await release(BOB, ALICE, async (entry) => {
      entries.push(entry);
      return true;
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("alice");
    expect(entries).toEqual([
      {
        viewerDiscordId: BOB,
        viewerUserId: BOB,
        resource: "profile",
        action: "view",
        route: "profiles.show",
        subjectUserIds: [ALICE],
      },
    ]);
  });

  it("self-read writes no row: the viewer is never their own subject", async () => {
    const sink = vi.fn(async () => true);
    const res = await release(ALICE, ALICE, sink);
    expect(res.status).toBe(200);
    expect(sink).not.toHaveBeenCalled();
  });

  it("audit failure refuses with a sanitized 503 carrying no member data", async () => {
    const res = await release(BOB, ALICE, async () => {
      throw new Error("insert failed");
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toBe("Member data is temporarily unavailable.");
    expect(body).not.toContain("alice");
    expect(body).not.toContain(ALICE);
    expect(body).not.toContain(BOB);
  });

  it("a read refusal inside the store propagates instead of rendering", async () => {
    const store = createMemoryProfileStore(seedMembers());
    vi.spyOn(store, "find").mockImplementation(async () => {
      await keyedMemberRead(async () => {
        memberQueryPermit();
        memberQueryPermit();
        return null;
      }).catch(() => undefined);
      const { refuseMemberRead } = await import("../src/member-reads");
      refuseMemberRead();
      return null;
    });
    await expect(resolveKitProfile(reqFor(memberSession(BOB), ALICE), { store })).rejects.toThrow(
      "Member read contract refused.",
    );
  });
});

describe("Kit profile routes: ownership stays Hono until edit parity", () => {
  it("registers both reads as member-read, Hono-owned entries", () => {
    const manifest = manifestSource();
    expect(manifest).toMatch(/path:\s*"\/profile"[^}]*reads:\s*\{[^}]*resource:\s*"profile"/);
    expect(manifest).toMatch(/path:\s*"\/profile"[^}]*enabled:\s*false/);
    expect(manifest).toMatch(/path:\s*"\/members\/:user"[^}]*route:\s*"profiles\.show"/);
    expect(manifest).toMatch(/path:\s*"\/members\/:user"[^}]*enabled:\s*false/);
  });

  it("keeps every read on Hono: profile, member, retired directory and sibling writes", () => {
    const app = "https://next.example.test";
    const get = (path: string, method = "GET") =>
      decideRoute(new Request(new URL(path, app).href, { method }));
    expect(get("/profile")).toBeUndefined();
    expect(get(`/members/${ALICE}`)).toBeUndefined();
    expect(get("/members")).toBeUndefined();
    expect(get("/members/")).toBeUndefined();
    expect(get(`/members/${ALICE}`, "POST")).toBeUndefined();
    expect(get(`/members/${ALICE}`, "PATCH")).toBeUndefined();
  });

  it("introduces no member directory route or public profile metadata", () => {
    expect(() => read(join(root, "web/src/routes/members/+page.svelte"))).toThrow();
    expect(() => read(join(root, "web/src/routes/members/+page.server.ts"))).toThrow();
    const servers = [profileServer(), memberServer()];
    for (const server of servers) {
      expect(server).not.toMatch(/list|directory|search/i);
    }
    const page = view();
    expect(page).not.toContain('name="robots" content="index');
    expect(page).toContain("noindex");
  });
});

describe("Kit profile routes: server posture", () => {
  it("both servers share the Kit model with zero duplicated gate logic", () => {
    for (const server of [profileServer(), memberServer()]) {
      expect(server).toContain("resolveKitProfile");
      expect(server).toContain("kitProfileDeps");
      expect(server).not.toContain("createMemoryProfileStore");
    }
    // /profile resolves the viewer's own id; the member route resolves the param.
    expect(profileServer()).toContain("locals.session?.userId");
    expect(memberServer()).toContain("params.user");
  });

  it("both servers stay server-rendered with the member cache policy", () => {
    for (const server of [profileServer(), memberServer()]) {
      expect(server).toContain("csr = false");
      expect(server).toContain("private, no-store");
    }
  });

  it("both pages render through the one shared profile view", () => {
    for (const page of [profilePage(), memberPage()]) {
      expect(page).toContain("ProfileView");
    }
    expect(profilePage()).not.toContain("data-testid");
    expect(memberPage()).not.toContain("data-testid");
  });
});

describe("Kit profile view: single-source Hono parity", () => {
  it("imports every contract from shared sources, never a copy", () => {
    const page = view();
    for (const name of [
      "PROFILE_VIEW_TESTID",
      "PROFILE_AVATAR_TESTID",
      "PROFILE_NAME_TESTID",
      "PROFILE_JOINED_TESTID",
      "PROFILE_RANK_TESTID",
      "PROFILE_EDIT_TESTID",
      "PROFILE_FORM_TESTID",
      "PROFILE_SAVE_TESTID",
      "PROFILE_CANCEL_TESTID",
      "PROFILE_NEW_MEMBER_TESTID",
      "PROFILE_NEW_MEMBER_CTA_TESTID",
      "PROFILE_EMPTY_COPY",
      "PROFILE_NEW_MEMBER_COPY",
      "PROFILE_COPY",
      "PROFILE_HONEY_FIELD",
      "PROFILE_OPENED_AT_FIELD",
      "MEMBER_PROFILE_ISLAND",
      "profileAvatarSrcset",
      "profileIsNewMember",
      "profileJoinedMonth",
    ]) {
      expect(page, name).toContain(name);
    }
    expect(page).toContain('from "../../../src/islands/contracts"');
    expect(page).toMatch(
      /import\s*\{[^}]*\bMEMBER_PROFILE_ISLAND\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/src\/islands\/contracts["']/,
    );
    // The owner editor needs the shared island value, not a computed-key spelling.
    // kit-profile-form.test.ts separately pins the emitted data-island mount.
    const editor =
      page.match(/<section\b[^>]*data-testid=\{PROFILE_EDIT_TESTID\}[^>]*>/)?.[0] ?? "";
    expect(editor).toMatch(
      /\sdata-island\s*=\s*\{\s*MEMBER_PROFILE_ISLAND\s*\}|\{\s*\.\.\.\s*\{\s*\[\s*MOUNT_ATTR\s*\]\s*:\s*MEMBER_PROFILE_ISLAND\s*\}\s*\}/,
    );
    // Hono-owned profile helpers stay imported from their source module.
    for (const name of ["PROFILE_FIELD_IDS", "profileInitials", "PROFILE_SHARE_DESCRIPTION"]) {
      expect(page, name).toContain(name);
    }
    expect(page).toContain('from "../../../src/profiles/pages"');
  });

  it("keeps member data out of markup helpers: interpolation only, no raw HTML of member fields", () => {
    const page = view();
    expect(page).toContain("{member.username}");
    expect(page).not.toMatch(/\{@html\s+member/);
    expect(page).not.toMatch(/\{@html\s+form/);
  });

  it("preserves the Hono chrome: canonical member URL, owner edit form, moderator link, sign-out and islands", () => {
    const page = view();
    expect(page).toContain("/members/${member.id}");
    expect(page).toContain('data-testid="profile-signout"');
    expect(page).toContain('data-testid="profile-admin-link"');
    expect(page).toContain('data-testid="profile-stats"');
    expect(page).toContain('data-testid="join-result"');
    expect(page).toContain('data-testid="reinvite-link"');
    expect(page).toContain("action={`/members/${member.id}`}");
    expect(page).toContain('name="_method"');
    expect(page).toContain("/islands/avatar.js");
    expect(page).toContain("/islands/member-profile.js");
  });

  it("emits the Hono head tag for tag: raw title with no site suffix", () => {
    const page = view();
    expect(page).toContain("<svelte:head>");
    expect(page).toContain("<title>{title}</title>");
    expect(page).toContain('property="og:title" content={title}');
    expect(page).toContain("title = $derived(`${member.username} — Member profile`)");
    expect(page).not.toContain("<SiteMetadata");
    expect(page).not.toContain("#lib/SiteMetadata.svelte");
    expect(page).toContain('title="Together We Own Events"');
  });
});
