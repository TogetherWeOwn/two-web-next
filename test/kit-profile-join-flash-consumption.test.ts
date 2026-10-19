// Acceptance contract: Kit profile reads consume the one-shot join
// confirmation only after the audited member-read boundary releases a
// successful HTML GET — Hono parity with src/profiles/routes-gate.ts
// (`if (c.res.status === 200) await takeJoinResult(c)` after
// memberReadBoundary) and src/return-journey.ts (GET-only read, delete with
// the set attributes repeated).
//
// Today the Kit bridge only peeks (src/kit-session.ts readReturnJourney) and
// both Kit profile loads pass the peeked value to the view without consuming
// it, so a reload repeats the one-shot banner. These tests drive the real
// boundaries a fix must sit behind — the signed-cookie peek
// (readReturnJourney), the real profile model (resolveKitProfile, as both
// +page.server.ts loads call it) and the real hook core
// (dispatchHookRequest + memberReadResponse, as web/src/hooks.server.ts
// delegates to it) — with the shipped profile entries enabled only inside
// this test manifest. Shipped ownership stays disabled (pinned below).
//
// Builder note (the seam these tests pin): consumption belongs in the hook
// core after the member-read release (the same post-response position as the
// auth-status cookie append in dispatchHookRequest), driven by the bridged
// locals + the released response. It must not happen in the +page.server.ts
// loads (that would consume before the audit decision — pinned by source
// below), must not make session resolution non-read-only, and must not hide
// behind a new optional dispatch dependency: these tests call
// dispatchHookRequest with only the dependencies that exist today.
//
// Hermetic: synthetic signed cookies, a memory profile store, no DB/OAuth.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { readReturnJourney, type KitLocals, type KitRequestSession } from "../src/kit-session";
import { resolveKitProfile } from "../src/profiles/kit";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { JOIN_RESULT_COOKIE, type JoinResult } from "../src/return-journey";
import {
  decideRoute,
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const APP_URL = "https://next.example.test";
const SECRET = "acceptance-test-secret";
const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const OUTSIDER = "100000000000000004";
const MISSING = "999999999999999999";
const REFUSAL = "Member data is temporarily unavailable.";

// Exact ProfileView copy (web/src/lib/ProfileView.svelte), pinned against the
// real view below so this render stand-in cannot drift from the banner.
const COPY: Record<JoinResult, string> = {
  added: "You are in. Finish Discord's rules screening before you can post.",
  already_member: "You are already in the server.",
};

const seedMembers = (): MemberView[] => [
  { id: ALICE, username: "alice", avatar: null, bio: null, games: [], timezone: null },
  { id: BOB, username: "bob", avatar: null, bio: null, games: [], timezone: null },
];

// The shipped manifest with only the two profile reads enabled, for this
// test dispatch. Reads declarations (profile / profiles.show) come from the
// shipped entries untouched.
const TEST_MANIFEST = ROUTE_MANIFEST.map((entry) =>
  entry.path === "/profile" || entry.path === "/members/:user"
    ? { ...entry, enabled: true }
    : entry,
);

const pair = async (name: string, value: string, secret: string = SECRET) =>
  (await serializeSigned(name, value, secret, { path: "/", secure: true })).split(";")[0]!;

type ViewerKind = "alice" | "bob" | "outsider" | "guest" | "unknown";

const sessionFor = (viewer: ViewerKind) => {
  const decision: KitRequestSession =
    viewer === "guest"
      ? { status: "guest", session: null }
      : viewer === "unknown"
        ? { status: "unknown", session: null }
        : {
            status: "authenticated",
            session: {
              userId: viewer === "alice" ? ALICE : viewer === "bob" ? BOB : OUTSIDER,
              username: viewer,
              avatar: null,
              member: viewer !== "outsider",
              moderator: false,
            },
          };
  // The real read-only peek supplies the journey half of locals, exactly as
  // kitSessionBridge merges it: signature-verified, GET-only join flash.
  return async (event: HookEventLike): Promise<KitLocals> => ({
    ...decision,
    ...(await readReturnJourney(event.request, SECRET)),
  });
};

type HarnessOptions = {
  viewer: ViewerKind;
  sink?: (entry: AccessEntry) => Promise<boolean>;
  contentType?: string;
};

// One dispatch harness whose resolve is the Kit load+render both profile
// routes perform: locals -> resolveKitProfile -> redirect/error mapping ->
// the banner the shared view renders for a peeked flash.
function harness({ viewer, sink, contentType = "text/html" }: HarnessOptions) {
  const order: string[] = [];
  const entries: AccessEntry[] = [];
  const store = createMemoryProfileStore(seedMembers());
  const deps: HookDispatchDeps = {
    appUrl: APP_URL,
    honoFetch: vi.fn(async () => new Response("hono")),
    manifest: TEST_MANIFEST,
    sessionFor: sessionFor(viewer),
    accessSink: async () =>
      sink ??
      (async (entry: AccessEntry) => {
        order.push("audit");
        entries.push(entry);
        return true;
      }),
    resolve: async (event) => {
      order.push("render");
      const locals = event.locals as Partial<KitLocals>;
      const isProfile = event.url.pathname === "/profile";
      const outcome = await resolveKitProfile(
        {
          session: { status: locals.status ?? "unknown", session: locals.session ?? null },
          requestedId: isProfile
            ? (locals.session?.userId ?? null)
            : event.url.pathname.split("/")[2]!,
          joinResult: locals.joinResult ?? null,
        },
        { store },
      );
      if (outcome.kind === "redirect")
        return new Response(null, { status: 302, headers: { location: outcome.location } });
      // Kit error() renders an HTML error page, so refusals are text/html
      // too: only the status distinguishes them from a released page.
      const htmlError = { headers: { "content-type": "text/html" } };
      if (outcome.kind === "forbidden")
        return new Response("Forbidden", { status: 403, ...htmlError });
      if (outcome.kind === "notFound")
        return new Response("Not found", { status: 404, ...htmlError });
      if (outcome.kind === "unavailable")
        return new Response(REFUSAL, { status: 503, ...htmlError });
      if (contentType !== "text/html")
        return Response.json({ joinResult: outcome.joinResult, username: outcome.member.username });
      const banner = outcome.joinResult
        ? `<p class="notice" role="status" data-testid="join-result">${COPY[outcome.joinResult]}${
            outcome.joinResult === "already_member"
              ? ' <a href="/discord" data-testid="reinvite-link">Rejoin with the Discord invite</a>'
              : ""
          }</p>`
        : "";
      return new Response(
        event.request.method === "HEAD" ? null : `${banner}<h1>${outcome.member.username}</h1>`,
        {
          headers: { "content-type": "text/html", "cache-control": "private, no-store" },
        },
      );
    },
  };
  return { deps, entries, order };
}

const eventFor = (path: string, cookie: string | null, method = "GET"): HookEventLike => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: "next.example.test", ...(cookie ? { cookie } : {}) },
  });
  return {
    request,
    url: new URL(request.url),
    route: { id: path === "/profile" ? "/profile" : "/members/[user]" },
  };
};

const flashCookie = async (result: JoinResult) =>
  `${await pair(JOIN_RESULT_COOKIE, result)}; unrelated=keep-me`;

// A minimal browser jar: apply a response's Set-Cookie headers so a
// follow-up request carries exactly what a browser would resend.
function applyToJar(jar: Map<string, string>, res: Response): Map<string, string> {
  for (const header of res.headers.getSetCookie()) {
    const [head, ...attrs] = header.split(";").map((part) => part.trim());
    const eq = head!.indexOf("=");
    const name = head!.slice(0, eq);
    const value = head!.slice(eq + 1);
    const expired =
      value === "" ||
      attrs.some((a) => /^max-age=0$/i.test(a)) ||
      attrs.some((a) => /^expires=thu, 01 jan 1970/i.test(a));
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}
const jarHeader = (jar: Map<string, string>) =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") || null;
const jarFrom = async (result: JoinResult) =>
  new Map<string, string>([
    [JOIN_RESULT_COOKIE, (await pair(JOIN_RESULT_COOKIE, result)).split("=")[1]!],
    ["unrelated", "keep-me"],
  ]);

const joinSetCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${JOIN_RESULT_COOKIE}=`));

function expectConsumed(res: Response) {
  const deletions = joinSetCookies(res);
  expect(deletions).toHaveLength(1);
  const parts = deletions[0]!.split(";").map((p) => p.trim().toLowerCase());
  expect(parts[0]).toBe(`${JOIN_RESULT_COOKIE.toLowerCase()}=`);
  // Matching path/security attributes: the same attributes the flash was set
  // with (src/return-journey.ts cookieOpts/deleteOpts), plus an expiry.
  expect(parts).toContain("path=/");
  expect(parts).toContain("secure");
  expect(parts).toContain("httponly");
  expect(parts).toContain("samesite=lax");
  expect(parts.some((p) => p === "max-age=0" || p.startsWith("expires=thu, 01 jan 1970"))).toBe(
    true,
  );
  // Unrelated cookies are never written by this consumption.
  expect(res.headers.getSetCookie().some((c) => c.startsWith("unrelated="))).toBe(false);
}

function expectPreserved(res: Response) {
  expect(joinSetCookies(res)).toEqual([]);
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("successful HTML GET consumes the confirmation once, after release", () => {
  it("/profile (self read) shows 'added' once, expires it, and a reload has no banner", async () => {
    const { deps, entries } = harness({ viewer: "alice" });
    const jar = await jarFrom("added");
    const first = await dispatchHookRequest(eventFor("/profile", jarHeader(jar)), deps);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const html = await first.clone().text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain(COPY.added);
    expectConsumed(first);
    // Self read: the viewer is never their own audit subject.
    expect(entries).toEqual([]);

    applyToJar(jar, first);
    const second = await dispatchHookRequest(eventFor("/profile", jarHeader(jar)), deps);
    expect(second.status).toBe(200);
    expect(await second.text()).not.toContain('data-testid="join-result"');
    expectPreserved(second);
    expect(jar.get("unrelated")).toBe("keep-me");
  });

  it("/members/:user (other read) shows 'already_member' once, audits, expires it, then no banner", async () => {
    const { deps, entries, order } = harness({ viewer: "bob" });
    const jar = await jarFrom("already_member");
    const first = await dispatchHookRequest(eventFor(`/members/${ALICE}`, jarHeader(jar)), deps);
    expect(first.status).toBe(200);
    const html = await first.clone().text();
    expect(html).toContain(COPY.already_member);
    expect(html).toContain('data-testid="reinvite-link"');
    // Audit precedes release inside the boundary; consumption is pinned to
    // that release by the audit-failure case below (no release, no delete).
    expect(order).toEqual(["render", "audit"]);
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
    expectConsumed(first);

    applyToJar(jar, first);
    const second = await dispatchHookRequest(eventFor(`/members/${ALICE}`, jarHeader(jar)), deps);
    expect(second.status).toBe(200);
    expect(await second.text()).not.toContain('data-testid="join-result"');
    expectPreserved(second);
  });

  it("both profile paths consume either supported confirmation", async () => {
    for (const result of ["added", "already_member"] as const) {
      const self = harness({ viewer: "alice" });
      const own = await dispatchHookRequest(
        eventFor("/profile", await flashCookie(result)),
        self.deps,
      );
      expect(own.status, result).toBe(200);
      expectConsumed(own);

      const other = harness({ viewer: "bob" });
      const theirs = await dispatchHookRequest(
        eventFor(`/members/${ALICE}`, await flashCookie(result)),
        other.deps,
      );
      expect(theirs.status, result).toBe(200);
      expectConsumed(theirs);
    }
  });
});

describe("refused, failed and non-HTML responses preserve a pending confirmation", () => {
  it("HEAD leaves the flash pending for the next visible GET", async () => {
    const { deps } = harness({ viewer: "alice" });
    const cookie = await flashCookie("added");
    const head = await dispatchHookRequest(eventFor("/profile", cookie, "HEAD"), deps);
    expect(head.status).toBe(200);
    expectPreserved(head);
  });

  it("403 (signed-in non-member) renders no banner and preserves the flash", async () => {
    const { deps } = harness({ viewer: "outsider" });
    const res = await dispatchHookRequest(
      eventFor(`/members/${ALICE}`, await flashCookie("added")),
      deps,
    );
    expect(res.status).toBe(403);
    expect(await res.clone().text()).not.toContain('data-testid="join-result"');
    expectPreserved(res);
  });

  it("404 (unknown member) preserves the flash on the member path", async () => {
    const { deps } = harness({ viewer: "bob" });
    const res = await dispatchHookRequest(
      eventFor(`/members/${MISSING}`, await flashCookie("already_member")),
      deps,
    );
    expect(res.status).toBe(404);
    expectPreserved(res);
  });

  it("503 (session unknown/outage) preserves the flash", async () => {
    const { deps } = harness({ viewer: "unknown" });
    const res = await dispatchHookRequest(eventFor("/profile", await flashCookie("added")), deps);
    expect(res.status).toBe(503);
    expectPreserved(res);
  });

  it("a failed access audit refuses the read and preserves the flash (no consume-before-audit)", async () => {
    const { deps } = harness({
      viewer: "bob",
      sink: async () => {
        throw new Error("insert failed");
      },
    });
    const res = await dispatchHookRequest(
      eventFor(`/members/${ALICE}`, await flashCookie("added")),
      deps,
    );
    expect(res.status).toBe(503);
    const body = await res.clone().text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain("alice");
    expectPreserved(res);
  });

  it("guest keeps the existing sign-in redirect and does not consume", async () => {
    const { deps } = harness({ viewer: "guest" });
    const res = await dispatchHookRequest(eventFor("/profile", await flashCookie("added")), deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expectPreserved(res);
  });

  it("a non-HTML 200 does not display the banner, so it does not consume", async () => {
    const { deps } = harness({ viewer: "alice", contentType: "application/json" });
    const res = await dispatchHookRequest(eventFor("/profile", await flashCookie("added")), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expectPreserved(res);
  });
});

describe("tampered and unknown values never render or delete", () => {
  it("a flash signed with the wrong secret is ignored entirely", async () => {
    const { deps } = harness({ viewer: "alice" });
    const forged = await pair(JOIN_RESULT_COOKIE, "added", "wrong-secret");
    const res = await dispatchHookRequest(eventFor("/profile", forged), deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain('data-testid="join-result"');
    expectPreserved(res);
  });

  it("a signed but unsupported value is ignored entirely", async () => {
    const { deps } = harness({ viewer: "alice" });
    const res = await dispatchHookRequest(
      eventFor("/profile", await pair(JOIN_RESULT_COOKIE, "denied")),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain('data-testid="join-result"');
    expectPreserved(res);
  });

  it("no flash cookie at all yields no banner and no spurious deletion", async () => {
    const { deps } = harness({ viewer: "alice" });
    const res = await dispatchHookRequest(eventFor("/profile", "unrelated=keep-me"), deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain('data-testid="join-result"');
    expectPreserved(res);
  });
});

describe("peek stays read-only and the surrounding posture is unchanged", () => {
  it("readReturnJourney peeks twice without consuming (session resolution stays read-only)", async () => {
    const request = new Request(new URL("/profile", APP_URL).href, {
      headers: { cookie: await pair(JOIN_RESULT_COOKIE, "added") },
    });
    expect((await readReturnJourney(request, SECRET)).joinResult).toBe("added");
    expect((await readReturnJourney(request, SECRET)).joinResult).toBe("added");
  });

  it("shipped route ownership stays disabled for both profile reads", () => {
    expect(decideRoute(new Request(new URL("/profile", APP_URL).href))).toBeUndefined();
    expect(decideRoute(new Request(new URL(`/members/${ALICE}`, APP_URL).href))).toBeUndefined();
  });

  it("neither Kit profile load consumes in the loader (no cookie delete before the audit decision)", () => {
    for (const server of [
      read("web/src/routes/profile/+page.server.ts"),
      read("web/src/routes/members/[user]/+page.server.ts"),
    ]) {
      expect(server).not.toContain("cookies.delete");
      expect(server).not.toContain("JOIN_RESULT_COOKIE");
    }
  });

  it("the shared view still renders the unchanged banner copy this file mirrors", () => {
    const view = read("web/src/lib/ProfileView.svelte");
    expect(view).toContain('data-testid="join-result"');
    expect(view).toContain(COPY.added);
    expect(view).toContain(COPY.already_member);
    expect(view).toContain('data-testid="reinvite-link"');
    expect(view).toContain("Rejoin with the Discord invite");
  });
});
