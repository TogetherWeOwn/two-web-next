import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone probe tooling has no declaration file.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { ADMIN_POST_PATHS, QA_HEADER, STAGING_URL, runProbe, sessionCookieValue } from "../bin/admin-authwall-probe.mjs";

function headers(init: Record<string, string>, cookies: string[] = []): Headers {
  const h = new Headers(init);
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

function response(status: number, init: Record<string, string> = {}, cookies: string[] = []) {
  return new Response(null, { status, headers: headers(init, cookies) });
}

const cookieFor = (session: string) =>
  `__Host-two_session=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const MEMBER_SESSION = cookieFor("fixture-member-session");
const MODERATOR_SESSION = cookieFor("fixture-moderator-session");

/** Fixture transport: all three legs at their expected statuses. */
function greenFetch() {
  return vi.fn(
    async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const origin = init?.headers?.origin ?? init?.headers?.Origin;
      const cookie = init?.headers?.Cookie ?? init?.headers?.cookie ?? "";
      const presented = init?.headers?.[QA_HEADER] ?? "";
      if (path.startsWith("/auth/qa/")) {
        if (presented !== "fixture-qa-token") return response(404);
        // Identity-distinct sessions, like the real seam's per-identity rows.
        return response(204, {}, [
          path.endsWith("qa-moderator") ? MODERATOR_SESSION : MEMBER_SESSION,
        ]);
      }
      if (method === "POST" && path.startsWith("/admin/")) {
        if (origin !== STAGING_URL) return response(403);
        if (!cookie)
          return response(303, { location: `/auth/recover?next=${encodeURIComponent(path)}` });
        return response(403);
      }
      if (path === "/admin") {
        if (cookie.includes("moderator")) return response(200);
        if (cookie) return response(403);
        return response(302, { location: "/auth/discord" });
      }
      return response(404);
    },
  );
}

describe("admin auth-wall probe tool (local fixtures)", () => {
  it("covers all nine admin mutation routes", () => {
    expect(ADMIN_POST_PATHS).toHaveLength(9);
    expect(ADMIN_POST_PATHS).toContain("/admin/events");
    expect(ADMIN_POST_PATHS).toContain("/admin/events/ZZZ/publish");
    expect(ADMIN_POST_PATHS).toContain("/admin/featured/1/delete");
  });

  it("reads the session cookie value and ignores other cookies", () => {
    const res = response(204, {}, ["other=1; Path=/", MEMBER_SESSION]);
    expect(sessionCookieValue(res)).toBe("__Host-two_session=fixture-member-session");
    expect(sessionCookieValue(response(204))).toBeNull();
  });

  it("passes all three legs against the expected wall", async () => {
    const send = greenFetch();
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBe(0);
    expect(result).toMatchObject({
      target: STAGING_URL,
      legs: { guest: "303 recovery", member: "403 forbidden", moderator: "200 dashboard" },
    });
    // Two QA logins presented the token in a header, never in a URL or body.
    const logins = send.mock.calls.filter(([url, init]) =>
      new URL(url as string).pathname.startsWith("/auth/qa/"),
    );
    expect(logins).toHaveLength(2);
    for (const [, init] of logins) {
      const h = (init as { headers: Record<string, string> }).headers;
      expect(h[QA_HEADER]).toBe("fixture-qa-token");
    }
    expect(JSON.stringify(result)).not.toContain("fixture-qa-token");
    // The probe sends sessions as Cookie headers but never logs them back.
    expect(JSON.stringify(result)).not.toContain("fixture-member-session");
    expect(JSON.stringify(result)).not.toContain("fixture-moderator-session");
    // No login request carried a Cookie header: the seam authenticates by header.
    for (const [, init] of logins) {
      expect((init as { headers: Record<string, string> }).headers.Cookie).toBeUndefined();
    }
  });

  it("posts every mutation write with an empty body and same-origin Origin", async () => {
    const send = greenFetch();
    await runProbe({ token: "fixture-qa-token", fetch: send });
    const posts = send.mock.calls.filter(
      ([, init]) => (init as { method?: string }).method === "POST",
    );
    expect(posts.length).toBeGreaterThanOrEqual(ADMIN_POST_PATHS.length * 2);
    // The single cross-origin control forges evil.example deliberately.
    const writes = posts.filter(([url]) => new URL(url as string).pathname.startsWith("/admin/"));
    expect(writes.length).toBeGreaterThanOrEqual(ADMIN_POST_PATHS.length * 2 + 1);
    expect(
      writes.filter(
        ([, init]) => (init as { headers: Record<string, string> }).headers.origin === STAGING_URL,
      ),
    ).toHaveLength(writes.length - 1);
    for (const [, init] of writes) {
      expect((init as { body?: unknown }).body).toBe("");
    }
  });

  it("fails when the member leg writes instead of 403ing", async () => {
    const send = greenFetch();
    const inner = send.getMockImplementation()!;
    // A member POST that redirects as if it wrote: the wall must hold 403.
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        const h = init?.headers ?? {};
        if (
          new URL(url).pathname === "/admin/events" &&
          init?.method === "POST" &&
          (h.Cookie ?? h.cookie ?? "").includes("member")
        )
          return response(303, { location: "/admin/events/ZZZ" });
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "member POST /admin/events status",
    );
  });

  it("fails when the moderator control cannot read the dashboard", async () => {
    const send = greenFetch();
    const inner = send.getMockImplementation()!;
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        if (new URL(url).pathname === "/admin" && (init?.method ?? "GET") === "GET")
          return response(403);
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "moderator GET /admin status",
    );
  });

  it.each([
    { baseUrl: "https://togetherweown.com" },
    { baseUrl: `${STAGING_URL}/` },
    { baseUrl: `${STAGING_URL}.evil.test` },
    { token: "" },
  ])("fails before network for unsafe target/missing input %#", async (change) => {
    const send = vi.fn();
    await expect(runProbe({ token: "fixture-qa-token", fetch: send, ...change })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when a QA login is refused", async () => {
    const send = vi.fn(async () => response(404));
    await expect(runProbe({ token: "fixture-qa-token", fetch: send })).rejects.toThrow(
      "QA login as qa-member refused (HTTP 404)",
    );
  });
});
