// Kit admin dispatch: GET /admin through dispatchHookRequest
// with the shipped dashboard declaration proves the privileged boundary
// releases exactly what it should — moderator HTML with private/no-store,
// SvelteKit-converted guest bounce and non-moderator 403 — and refuses the
// rest (audit failure, undeclared reads, missing sink) with the sanitized
// 503 that names no member.
//
// The manifest override mirrors the shipped /admin entry with enabled:true:
// the shipped entry stays Hono-owned until the enablement review, and the
// first test derives the override from it so the pins track the real
// declaration instead of a copy.
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
import {
  declareMemberResult,
  keyedMemberRead,
  memberQueryPermit,
  nonSensitiveRead,
} from "../src/member-reads";
import {
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
  type OwnedRoute,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const MOD_ID = "100000000000000111";
const MEMBER_ID = "100000000000000222";
const SUBJECT = "100000000000000333";
const REFUSAL = "Member data is temporarily unavailable.";

afterEach(() => vi.restoreAllMocks());

/** The override tracks the shipped declaration; only enablement differs. */
function adminManifest(): OwnedRoute[] {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin");
  if (!shipped) throw new Error("shipped GET /admin manifest entry missing");
  expect(shipped.enabled).toBe(false);
  return [{ ...shipped, enabled: true }];
}

const localsFor = (status: KitLocals["status"], userId?: string): KitLocals => ({
  status,
  session:
    status === "authenticated"
      ? {
          userId: userId!,
          username: "mod",
          avatar: null,
          member: true,
          moderator: userId === MOD_ID,
        }
      : null,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
  restoredWrite: null,
});

const eventFor = (): HookEventLike => {
  const request = new Request(`${APP_URL}/admin`, {
    method: "GET",
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: "/admin" } };
};

const recordingSink = () => {
  const entries: AccessEntry[] = [];
  const sink = vi.fn(async (entry: AccessEntry) => {
    entries.push(entry);
    return true;
  });
  return { entries, sink };
};

/** What SvelteKit's resolve() returns after converting load outcomes. */
const dashboardResolve = () => async () => {
  // The bounded optional widgets: classified, subject-free, like the Hono
  // dashboard's funnel and zero-search reads.
  await nonSensitiveRead("join-funnel", async () => {
    memberQueryPermit();
    return { started: 1 };
  });
  await nonSensitiveRead("search-widget", async () => {
    memberQueryPermit();
    return [];
  });
  return new Response('<main id="main"><strong data-testid="admin-actor">mod</strong></main>', {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
};

const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: dashboardResolve(),
  manifest: adminManifest(),
  sessionFor: vi.fn(async () => localsFor("authenticated", MOD_ID)),
  accessSink: async () => null,
  ...overrides,
});

describe("Kit admin dispatch: privileged boundary releases and refusals", () => {
  it("moderator dashboard releases with private/no-store and the signed probe cookie", async () => {
    const { entries, sink } = recordingSink();
    const probe = "__Host-two_session_status=signed.value; Path=/; Secure; HttpOnly; SameSite=Lax";
    const res = await dispatchHookRequest(
      eventFor(),
      depsFor({
        accessSink: async () => sink,
        authStatusCookieFor: async () => probe,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(res.headers.get("set-cookie")).toBe(probe);
    expect(await res.text()).toContain('data-testid="admin-actor"');
    // Subject-free dashboard: classified reads, zero audit rows, one sink
    // decision path — no duplicate audits.
    expect(entries).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("appends no probe cookie to failed or non-moderator admin documents", async () => {
    const probe = "__Host-two_session_status=signed.value; Path=/; Secure; HttpOnly; SameSite=Lax";
    for (const { status, actorStatus, moderator, contentType } of [
      { status: 503, actorStatus: "authenticated", moderator: true, contentType: undefined },
      { status: 403, actorStatus: "authenticated", moderator: false, contentType: undefined },
      { status: 302, actorStatus: "guest", moderator: false, contentType: undefined },
      { status: 200, actorStatus: "guest", moderator: false, contentType: "text/html" },
      { status: 200, actorStatus: "authenticated", moderator: false, contentType: "text/html" },
      {
        status: 200,
        actorStatus: "authenticated",
        moderator: true,
        contentType: "application/json",
      },
    ] as const) {
      const res = await dispatchHookRequest(
        eventFor(),
        depsFor({
          authStatusCookieFor: async () => probe,
          sessionFor: vi.fn(async () => localsFor(actorStatus, moderator ? MOD_ID : MEMBER_ID)),
          resolve: vi.fn(
            async () =>
              new Response(status === 200 ? "<main>ok</main>" : null, {
                status,
                headers: contentType ? { "content-type": contentType } : undefined,
              }),
          ),
        }),
      );
      expect(res.status).toBe(status);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("SvelteKit-converted guest bounce and non-moderator 403 pass through", async () => {
    const bounce = await dispatchHookRequest(
      eventFor(),
      depsFor({
        resolve: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "/auth/discord?next=%2Fadmin" },
            }),
        ),
        sessionFor: vi.fn(async () => localsFor("guest")),
      }),
    );
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord?next=%2Fadmin");

    const forbidden = await dispatchHookRequest(
      eventFor(),
      depsFor({
        resolve: vi.fn(async () => new Response("Forbidden", { status: 403 })),
        sessionFor: vi.fn(async () => localsFor("authenticated", MEMBER_ID)),
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("failed audit write refuses with the sanitized 503", async () => {
    const res = await dispatchHookRequest(
      eventFor(),
      depsFor({
        resolve: vi.fn(async () => {
          await keyedMemberRead(async () => {
            memberQueryPermit();
            declareMemberResult([SUBJECT]);
            return "member-naming";
          });
          return new Response("member-naming");
        }),
        accessSink: async () => async () => {
          throw new Error("audit store down");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain(SUBJECT);
  });

  it("missing access sink refuses a subject-bearing read, never renders it", async () => {
    const res = await dispatchHookRequest(
      eventFor(),
      depsFor({
        resolve: vi.fn(async () => {
          await keyedMemberRead(async () => {
            memberQueryPermit();
            declareMemberResult([SUBJECT]);
            return "member-naming";
          });
          return new Response("member-naming");
        }),
        accessSink: async () => null,
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(REFUSAL);
  });
});
