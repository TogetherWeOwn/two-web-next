// Acceptance contract: the restored-write banner on Kit pages.
//
// Hono injects the "you signed in again" banner via middleware
// (src/write-recovery.tsx expiredWriteBanner) on Hono-handled requests, but
// Kit-owned routes resolve through SvelteKit and the Kit journey bridge
// deliberately drops restored| notices (src/kit-session.ts expiredWriteOf)
// with zero Kit consumers — members landing on Kit pages after re-login
// never see the banner and the cookie lingers.
//
// These tests drive the real boundaries a fix must sit behind: the
// signature-verified bridge peek (readReturnJourney), the real hook core
// (dispatchHookRequest, as web/src/hooks.server.ts delegates to it), the
// real profile model (resolveKitProfile) and the real OAuth callback (the
// sign-in-again flow below). Hermetic: synthetic signed cookies, memory
// stores, no DB/OAuth.
//
// Builder note (the seam these tests pin): the bridge gains a restored|
// companion to expiredWriteOf with the same safeNext discipline, exposed as
// `restoredWrite` on KitReturnJourney (pending| keeps flowing through
// expiredWrite unchanged). Consumption belongs in the hook core after the
// released response — GET-only, 200-only, HTML-only, for every Kit route
// (member and public alike, the uniform twin of Hono's middleware) — at
// the same post-response position as the join-flash consumption. It must
// not happen in any +page.server.ts load (that would consume before the
// audit can refuse on member routes), must not make session resolution
// non-read-only, and must not hide behind a new optional dispatch
// dependency: these tests call dispatchHookRequest with only the
// dependencies that exist today. Rendering belongs in the Kit views/layout
// reading the bridged notice, with byte-identical copy (a shared copy
// source or a pinned twin — the source pin below accepts either).
// Banner responses must never be shared-cached (Hono sets no-store on the
// render); keep that discipline on the Kit side.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import {
  readReturnJourney,
  type KitLocals,
  type KitRequestSession,
  type KitReturnJourney,
} from "../src/kit-session";
import { resolveKitProfile } from "../src/profiles/kit";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  decideRoute,
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import { EXPIRED_WRITE_COOKIE, expiredWriteBanner } from "../src/write-recovery";
import {
  fixtureDiscord,
  MEMBER,
  mergeCookies,
  recoveryFixture,
  SECRET as FIXTURE_SECRET,
} from "./fixtures/session-recovery";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// Byte-identical Hono banner (src/write-recovery.tsx), pinned against the
// real middleware source below so this stand-in cannot drift from the copy.
const BANNER =
  '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';
const COPY_SENTENCE =
  "You signed in again. Your earlier changes were not saved. Review and submit them again.";

const APP_URL = "https://next.example.test";
const SECRET = "restored-banner-acceptance-secret-32b";
const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const OUTSIDER = "100000000000000004";
const REFUSAL = "Member data is temporarily unavailable.";

// The bridge companion this suite contracts: restoredWriteOf beside
// expiredWriteOf, exposed on the journey. Normalized so hostile pins read
// as null both before (field absent) and after (field resolves null) the fix.
const restoredOf = (journey: KitReturnJourney): string | null =>
  (journey as unknown as { restoredWrite?: string | null }).restoredWrite ?? null;

const pair = async (name: string, value: string, secret: string = SECRET) =>
  (await serializeSigned(name, value, secret, { path: "/", secure: true })).split(";")[0]!;

const requestWith = (pairs: string[], method = "GET") =>
  new Request(new URL("/about", APP_URL).href, {
    method,
    headers: { ...(pairs.length ? { cookie: pairs.join("; ") } : {}) },
  });

type ViewerKind = "alice" | "bob" | "outsider" | "guest" | "unknown";

const decisionFor = (viewer: ViewerKind): KitRequestSession =>
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
// kitSessionBridge merges it: signature-verified, safeNext-guarded.
const sessionFor = (viewer: ViewerKind, secret: string = SECRET) => {
  const decision = decisionFor(viewer);
  return async (event: HookEventLike): Promise<KitLocals> => ({
    ...decision,
    ...(await readReturnJourney(event.request, secret)),
  });
};

const seedMembers = (): MemberView[] => [
  { id: ALICE, username: "alice", avatar: null, bio: null, games: [], timezone: null },
  { id: BOB, username: "bob", avatar: null, bio: null, games: [], timezone: null },
];

// The shipped manifest with only the two profile reads enabled, for the
// member dispatch below. Reads declarations come from the shipped entries
// untouched; shipped ownership stays disabled (pinned below).
const TEST_MANIFEST = ROUTE_MANIFEST.map((entry) =>
  entry.path === "/profile" || entry.path === "/members/:user"
    ? { ...entry, enabled: true }
    : entry,
);

// POST /about exists only to pin the GET-only consumption gate: production
// carries GET entries only, so a real POST falls through to Hono.
const POST_MANIFEST = [
  ...ROUTE_MANIFEST,
  { method: "POST", path: "/about", enabled: true, reads: "public" as const },
];

const eventFor = (
  path: string,
  cookie: string | null,
  method = "GET",
  routeId?: string,
  extraHeaders: Record<string, string> = {},
): HookEventLike => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: "next.example.test", ...(cookie ? { cookie } : {}), ...extraHeaders },
  });
  return {
    request,
    url: new URL(request.url),
    route: {
      id:
        routeId ??
        (path === "/profile"
          ? "/profile"
          : path.startsWith("/members/")
            ? "/members/[user]"
            : "/about"),
    },
  };
};

type PublicHarnessOptions = {
  secret?: string;
  status?: number;
  contentType?: string;
  manifest?: typeof ROUTE_MANIFEST;
};

// Public Kit dispatch (/about, shipped enabled): the resolve stand-in is the
// Kit load+render, reading the real bridge peek directly off the request —
// the hook merges locals only on member reads, so a public load helper must
// peek exactly this way — and rendering the banner with Hono's placement
// (immediately inside <main>) and Hono's guards (GET, 200, HTML only).
function publicHarness({
  secret = SECRET,
  status = 200,
  contentType = "text/html",
  manifest,
}: PublicHarnessOptions = {}) {
  const calls = { resolve: 0, hono: 0 };
  const deps: HookDispatchDeps = {
    appUrl: APP_URL,
    honoFetch: vi.fn(async () => {
      calls.hono++;
      return new Response("hono");
    }),
    ...(manifest ? { manifest } : {}),
    sessionFor: sessionFor("alice", secret),
    resolve: async (event) => {
      calls.resolve++;
      if (contentType !== "text/html") return Response.json({ ok: true, status });
      if (status !== 200)
        return new Response("Not found", { status, headers: { "content-type": "text/html" } });
      if (event.request.method === "HEAD")
        return new Response(null, { headers: { "content-type": "text/html" } });
      const journey = await readReturnJourney(event.request, secret);
      const banner = event.request.method === "GET" && restoredOf(journey) ? BANNER : "";
      return new Response(`<main>${banner}<h1>About</h1></main>`, {
        headers: { "content-type": "text/html", "cache-control": "private, no-store" },
      });
    },
  };
  return { deps, calls };
}

type MemberHarnessOptions = {
  viewer: ViewerKind;
  sink?: (entry: AccessEntry) => Promise<boolean>;
};

// Member Kit dispatch through the real profile model, as both profile
// +page.server.ts loads call it: locals -> resolveKitProfile ->
// redirect/error mapping -> the banner the fixed view renders for a
// restored notice. The banner wrap mirrors Hono's placement.
function memberHarness({ viewer, sink }: MemberHarnessOptions) {
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
      const htmlError = { headers: { "content-type": "text/html" } };
      if (outcome.kind === "forbidden")
        return new Response("Forbidden", { status: 403, ...htmlError });
      if (outcome.kind === "notFound")
        return new Response("Not found", { status: 404, ...htmlError });
      if (outcome.kind === "unavailable")
        return new Response(REFUSAL, { status: 503, ...htmlError });
      if (event.request.method === "HEAD")
        return new Response(null, { headers: { "content-type": "text/html" } });
      const banner =
        event.request.method === "GET" && restoredOf(locals as KitReturnJourney) ? BANNER : "";
      return new Response(`<main>${banner}<h1>${outcome.member.username}</h1></main>`, {
        headers: { "content-type": "text/html", "cache-control": "private, no-store" },
      });
    },
  };
  return { deps, entries, order };
}

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
const jarFrom = async (value: string) =>
  new Map<string, string>([
    [EXPIRED_WRITE_COOKIE, (await pair(EXPIRED_WRITE_COOKIE, value)).split("=")[1]!],
    ["unrelated", "keep-me"],
  ]);

const noticeSetCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${EXPIRED_WRITE_COOKIE}=`));

function expectConsumed(res: Response) {
  const deletions = noticeSetCookies(res);
  expect(deletions).toHaveLength(1);
  const parts = deletions[0]!.split(";").map((p) => p.trim().toLowerCase());
  expect(parts[0]).toBe(`${EXPIRED_WRITE_COOKIE.toLowerCase()}=`);
  // Matching path/security attributes: the same attributes the notice was
  // set with (src/write-recovery.tsx OPTIONS / deleteCookie call sites).
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
  expect(noticeSetCookies(res)).toEqual([]);
}

function expectBannerInsideMain(html: string) {
  expect(html).toContain(BANNER);
  const main = html.indexOf("<main");
  expect(main).toBeGreaterThanOrEqual(0);
  expect(html.indexOf('data-testid="auth-error"')).toBeGreaterThan(main);
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bridge: restored| resolves with safeNext discipline (companion to expiredWriteOf)", () => {
  it("a restored notice resolves to its safe destination", async () => {
    const journey = await readReturnJourney(
      requestWith([await pair(EXPIRED_WRITE_COOKIE, "restored|/profile?edit=1")]),
      SECRET,
    );
    expect(restoredOf(journey)).toBe("/profile?edit=1");
  });

  it.each([
    "restored|https://evil.example/",
    "restored|//evil.example/profile",
    "restored|/profile with space",
    "restored|/\\evil.example",
    "restored|javascript:alert(1)",
    "restored|/\u0000evil",
    `restored|/${"a".repeat(600)}`,
    "restored|",
    "restored",
  ])("hostile or empty restored value %s resolves to nothing", async (value) => {
    const journey = await readReturnJourney(
      requestWith([await pair(EXPIRED_WRITE_COOKIE, value)]),
      SECRET,
    );
    expect(restoredOf(journey)).toBeNull();
  });

  it("a pending notice still resolves through expiredWrite, never as restored", async () => {
    const journey = await readReturnJourney(
      requestWith([await pair(EXPIRED_WRITE_COOKIE, "pending|/profile")]),
      SECRET,
    );
    expect(journey.expiredWrite).toBe("/profile");
    expect(restoredOf(journey)).toBeNull();
  });

  it("a hostile pending notice resolves to neither field", async () => {
    const journey = await readReturnJourney(
      requestWith([await pair(EXPIRED_WRITE_COOKIE, "pending|https://evil.example/")]),
      SECRET,
    );
    expect(journey.expiredWrite).toBeNull();
    expect(restoredOf(journey)).toBeNull();
  });

  it("a forged or missing notice resolves to nothing in both fields", async () => {
    const forged = await pair(
      EXPIRED_WRITE_COOKIE,
      "restored|/profile",
      "wrong-secret-32-bytes-long-ok",
    );
    for (const request of [requestWith([forged]), requestWith([])]) {
      const journey = await readReturnJourney(request, SECRET);
      expect(journey.expiredWrite).toBeNull();
      expect(restoredOf(journey)).toBeNull();
    }
  });

  it("the peek stays read-only: repeated reads resolve identically", async () => {
    const cookie = await pair(EXPIRED_WRITE_COOKIE, "restored|/profile");
    const first = await readReturnJourney(requestWith([cookie]), SECRET);
    const second = await readReturnJourney(requestWith([cookie]), SECRET);
    expect(restoredOf(first)).toBe("/profile");
    expect(restoredOf(second)).toBe("/profile");
  });
});

describe("public Kit page renders the banner once and consumes it", () => {
  it("GET /about shows the banner inside <main>, expires it, and a reload has no banner", async () => {
    const { deps, calls } = publicHarness();
    const jar = await jarFrom("restored|/profile");
    const first = await dispatchHookRequest(eventFor("/about", jarHeader(jar)), deps);
    expect(first.status).toBe(200);
    expect(calls.hono).toBe(0);
    expect(first.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expectBannerInsideMain(await first.clone().text());
    expectConsumed(first);

    applyToJar(jar, first);
    expect(jar.has(EXPIRED_WRITE_COOKIE)).toBe(false);
    const second = await dispatchHookRequest(eventFor("/about", jarHeader(jar)), deps);
    expect(second.status).toBe(200);
    expect(await second.text()).not.toContain('data-testid="auth-error"');
    expectPreserved(second);
    expect(jar.get("unrelated")).toBe("keep-me");
  });

  it("HEAD leaves the notice pending for the next visible GET", async () => {
    const { deps } = publicHarness();
    const head = await dispatchHookRequest(
      eventFor("/about", await pair(EXPIRED_WRITE_COOKIE, "restored|/profile"), "HEAD"),
      deps,
    );
    expect(head.status).toBe(200);
    expectPreserved(head);
  });

  it("POST leaves the notice pending (GET-only consumption gate)", async () => {
    const { deps, calls } = publicHarness({ manifest: POST_MANIFEST });
    const post = await dispatchHookRequest(
      eventFor("/about", await pair(EXPIRED_WRITE_COOKIE, "restored|/profile"), "POST", undefined, {
        origin: APP_URL,
      }),
      deps,
    );
    // The POST test entry owns the request: Kit answered, Hono never ran.
    expect(calls.resolve).toBe(1);
    expect(calls.hono).toBe(0);
    expect(post.status).toBe(200);
    expect(await post.clone().text()).not.toContain('data-testid="auth-error"');
    expectPreserved(post);
  });

  it.each([404, 503])(
    "error status %s renders no banner and preserves the notice",
    async (status) => {
      const { deps } = publicHarness({ status });
      const res = await dispatchHookRequest(
        eventFor("/about", await pair(EXPIRED_WRITE_COOKIE, "restored|/profile")),
        deps,
      );
      expect(res.status).toBe(status);
      expect(await res.clone().text()).not.toContain('data-testid="auth-error"');
      expectPreserved(res);
    },
  );

  it("a non-HTML 200 does not display the banner, so it does not consume", async () => {
    const { deps } = publicHarness({ contentType: "application/json" });
    const res = await dispatchHookRequest(
      eventFor("/about", await pair(EXPIRED_WRITE_COOKIE, "restored|/profile")),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expectPreserved(res);
  });

  it("no notice cookie at all yields no banner and no spurious deletion", async () => {
    const { deps } = publicHarness();
    const res = await dispatchHookRequest(eventFor("/about", "unrelated=keep-me"), deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain('data-testid="auth-error"');
    expectPreserved(res);
  });

  it("a notice signed with the wrong secret is ignored entirely", async () => {
    const { deps } = publicHarness();
    const forged = await pair(
      EXPIRED_WRITE_COOKIE,
      "restored|/profile",
      "wrong-secret-32-bytes-long-ok",
    );
    const res = await dispatchHookRequest(eventFor("/about", forged), deps);
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain('data-testid="auth-error"');
    expectPreserved(res);
  });

  it("a pending notice never renders and is never deleted by a Kit page", async () => {
    const { deps } = publicHarness();
    const res = await dispatchHookRequest(
      eventFor("/about", await pair(EXPIRED_WRITE_COOKIE, "pending|/profile")),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain('data-testid="auth-error"');
    expectPreserved(res);
  });

  it("a hostile restored destination renders nothing and deletes nothing", async () => {
    const { deps } = publicHarness();
    const res = await dispatchHookRequest(
      eventFor("/about", await pair(EXPIRED_WRITE_COOKIE, "restored|https://evil.example/")),
      deps,
    );
    expect(res.status).toBe(200);
    const html = await res.clone().text();
    expect(html).not.toContain('data-testid="auth-error"');
    expect(html).not.toContain("evil.example");
    expectPreserved(res);
  });
});

describe("member Kit reads consume only after release (no consume-before-audit)", () => {
  it("/profile (self read) shows the banner once, expires it, and a reload has no banner", async () => {
    const { deps, entries } = memberHarness({ viewer: "alice" });
    const jar = await jarFrom("restored|/profile");
    const first = await dispatchHookRequest(eventFor("/profile", jarHeader(jar)), deps);
    expect(first.status).toBe(200);
    expectBannerInsideMain(await first.clone().text());
    expectConsumed(first);
    // Self read: the viewer is never their own audit subject.
    expect(entries).toEqual([]);

    applyToJar(jar, first);
    const second = await dispatchHookRequest(eventFor("/profile", jarHeader(jar)), deps);
    expect(second.status).toBe(200);
    expect(await second.text()).not.toContain('data-testid="auth-error"');
    expectPreserved(second);
  });

  it("/members/:user (other read) shows the banner once, audits, expires it, then no banner", async () => {
    const { deps, entries, order } = memberHarness({ viewer: "bob" });
    const jar = await jarFrom("restored|/profile");
    const first = await dispatchHookRequest(eventFor(`/members/${ALICE}`, jarHeader(jar)), deps);
    expect(first.status).toBe(200);
    expectBannerInsideMain(await first.clone().text());
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
    expect(await second.text()).not.toContain('data-testid="auth-error"');
    expectPreserved(second);
  });

  it("a failed access audit refuses the read and preserves the notice (no consume-before-audit)", async () => {
    const { deps } = memberHarness({
      viewer: "bob",
      sink: async () => {
        throw new Error("insert failed");
      },
    });
    const res = await dispatchHookRequest(
      eventFor(`/members/${ALICE}`, await pair(EXPIRED_WRITE_COOKIE, "restored|/profile")),
      deps,
    );
    expect(res.status).toBe(503);
    const body = await res.clone().text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain("alice");
    expectPreserved(res);
  });

  it("guest keeps the existing sign-in redirect and does not consume", async () => {
    const { deps } = memberHarness({ viewer: "guest" });
    const res = await dispatchHookRequest(
      eventFor("/profile", await pair(EXPIRED_WRITE_COOKIE, "restored|/profile")),
      deps,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expectPreserved(res);
  });

  it("403 (signed-in non-member) renders no banner and preserves the notice", async () => {
    const { deps } = memberHarness({ viewer: "outsider" });
    const res = await dispatchHookRequest(
      eventFor(`/members/${ALICE}`, await pair(EXPIRED_WRITE_COOKIE, "restored|/profile")),
      deps,
    );
    expect(res.status).toBe(403);
    expect(await res.clone().text()).not.toContain('data-testid="auth-error"');
    expectPreserved(res);
  });

  it("HEAD on a member read leaves the notice pending", async () => {
    const { deps } = memberHarness({ viewer: "alice" });
    const head = await dispatchHookRequest(
      eventFor("/profile", await pair(EXPIRED_WRITE_COOKIE, "restored|/profile"), "HEAD"),
      deps,
    );
    expect(head.status).toBe(200);
    expectPreserved(head);
  });
});

describe("sign-in-again flow lands the banner on a Kit route", () => {
  it("the real callback's restored| cookie renders once on GET /about, then is gone", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    const bounce = await f.request(`/members/${MEMBER}`, {
      method: "POST",
      headers: {
        cookie: dead.cookie,
        origin: f.env.APP_URL,
        referer: `${f.env.APP_URL}/about`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "_method=PATCH&bio=Unsaved+secret+draft",
    });
    expect(bounce.status).toBe(303);
    let jar = mergeCookies("", bounce);
    const landing = await f.request(bounce.headers.get("location")!, {
      headers: { cookie: jar },
    });
    expect(landing.status).toBe(200);
    jar = mergeCookies(jar, landing);
    const start = await f.request("/auth/discord?next=%2Fabout", {
      headers: { cookie: jar },
    });
    jar = mergeCookies(jar, start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, {
      headers: { cookie: jar },
    });
    expect(callback.headers.get("location")).toBe("/about");
    jar = mergeCookies(jar, callback);
    expect(jar).toContain(EXPIRED_WRITE_COOKIE);
    expect(jar.split("; ").find((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="))!).toContain(
      "restored",
    );

    // The member lands on a Kit page: the shipped /about entry answers from Kit.
    const { deps } = publicHarness({ secret: FIXTURE_SECRET });
    const first = await dispatchHookRequest(eventFor("/about", jar), deps);
    expect(first.status).toBe(200);
    expect(first.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expectBannerInsideMain(await first.clone().text());
    expectConsumed(first);

    const browser = new Map(
      jar
        .split("; ")
        .filter(Boolean)
        .map((entry) => {
          const eq = entry.indexOf("=");
          return [entry.slice(0, eq), entry.slice(eq + 1)] as const;
        }),
    );
    applyToJar(browser, first);
    const second = await dispatchHookRequest(eventFor("/about", jarHeader(browser)), deps);
    expect(second.status).toBe(200);
    expect(await second.text()).not.toContain('data-testid="auth-error"');
    expectPreserved(second);
    expect(f.state.writes).toBe(0);
  });
});

describe("regression pins: pending journey and Hono banner path unchanged", () => {
  it("the Hono middleware source carries exactly the bytes this suite mirrors", () => {
    const source = read("src/write-recovery.tsx");
    expect(source).toContain(BANNER);
    expect(source).toContain(COPY_SENTENCE);
  });

  it("Hono still renders restored| one-shot and ignores pending| (acceptance oracle)", async () => {
    const app = new Hono();
    app.use("*", expiredWriteBanner);
    app.get("/about", (c) => c.html("<html><body><main><h1>About</h1></main></body></html>"));
    const page = (cookie: string) =>
      app.request(
        "https://next.example.test/about",
        { headers: { cookie } },
        { SESSION_SECRET: SECRET },
      );

    const restored = await page(await pair(EXPIRED_WRITE_COOKIE, "restored|/profile"));
    expect(await restored.clone().text()).toContain(BANNER);
    expect(
      restored.headers
        .getSetCookie()
        .some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=") && /Max-Age=0/i.test(c)),
    ).toBe(true);

    const pending = await page(await pair(EXPIRED_WRITE_COOKIE, "pending|/profile"));
    expect(await pending.text()).not.toContain('data-testid="auth-error"');
    expect(noticeSetCookies(pending)).toEqual([]);
  });

  it("shipped route ownership is unchanged by this slice", () => {
    expect(decideRoute(new Request(new URL("/about", APP_URL).href))).toMatchObject({
      path: "/about",
    });
    expect(decideRoute(new Request(new URL("/profile", APP_URL).href))).toBeUndefined();
    expect(decideRoute(new Request(new URL(`/members/${ALICE}`, APP_URL).href))).toBeUndefined();
  });

  it("no Kit page load consumes the notice in the loader (consumption stays post-release)", () => {
    for (const load of [
      read("web/src/routes/about/+page.server.ts"),
      read("web/src/routes/faq/+page.server.ts"),
      read("web/src/routes/profile/+page.server.ts"),
      read("web/src/routes/members/[user]/+page.server.ts"),
    ]) {
      expect(load).not.toContain("EXPIRED_WRITE_COOKIE");
      expect(load).not.toContain("expired_write");
    }
  });
});

describe("production seams the builder wires (RED until implemented)", () => {
  it("KitLocals exposes the restored companion beside expiredWrite", () => {
    expect(read("src/kit-session.ts")).toContain("restoredWrite");
  });

  it("a shipped Kit view renders the byte-identical banner (twin bytes or shared source)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile() && /\.(svelte|ts)$/.test(entry.name)) {
          const text = read(rel);
          if (text.includes('data-testid="auth-error"')) hits.push(rel);
        }
      }
    };
    walk("web/src");
    expect(hits).not.toEqual([]);
    // Either the twin bytes inline, or a shared copy source imported from the
    // Hono banner module (single source, byte-identity by construction).
    expect(
      hits.some((rel) => read(rel).includes(BANNER)) ||
        hits.some((rel) => read(rel).includes("write-recovery")),
    ).toBe(true);
  });
});
