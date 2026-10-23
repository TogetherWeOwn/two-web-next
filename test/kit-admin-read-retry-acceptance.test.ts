// Failing-first acceptance: retry a failed admin GET in the current view.
// The Builder consumes this suite unchanged. Existing status/header/auth suites
// remain the HTTP-policy oracle; this suite renders the two real Kit boundaries.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ADMIN_RETRY_CANARY,
  ADMIN_RETRY_ORIGIN,
  ADMIN_RETRY_VIEWS,
  type AdminBoundary,
  type AdminRetryKit,
  anchors,
  compileAdminRetryKit,
  retryAnchors,
  retryPage,
} from "./helpers/admin-read-retry-acceptance";

const boundaries: AdminBoundary[] = ["admin", "join-attempts"];
const safeFallbacks = new Set([
  "/admin",
  "/admin/events",
  "/admin/featured",
  "/admin/activity-log",
  "/admin/join-attempts",
]);
let kit: AdminRetryKit;
beforeAll(async () => {
  kit = await compileAdminRetryKit();
});
afterEach(() => vi.unstubAllGlobals());

function expectSafeRetry(href: string) {
  expect(href, "a native retry uses a relative same-origin admin GET").toMatch(
    /^\/admin(?:[/?]|$)/,
  );
  expect(href).not.toMatch(/[\\\r\n\0]/);
  const target = new URL(href, ADMIN_RETRY_ORIGIN);
  expect(target.origin).toBe(ADMIN_RETRY_ORIGIN);
  expect(target.hash).toBe("");
  expect(target.pathname).not.toMatch(/\/(?:redispatch|delete|logout|destroy)(?:\/|$)/i);
}

describe("RED: transient admin failures offer Retry loading for the same GET", () => {
  for (const status of [503, 500]) {
    it.each(ADMIN_RETRY_VIEWS)(
      `${status} $path keeps the current filtered/paged read`,
      async (view) => {
        const { body } = kit.render(view.boundary, retryPage(status, view.path, view.routeId));
        const retry = await retryAnchors(body);
        expect(retry, "missing native Retry loading link for the failed read").toHaveLength(1);
        expect(retry[0]!.href).toBe(view.path);
        expectSafeRetry(retry[0]!.href);
        expect(retry[0]!.attributes).not.toMatch(
          /\b(?:onclick|download|target|aria-disabled)\s*=/i,
        );
      },
    );
  }

  it.each(boundaries)(
    "%s preserves an escaped hostile query as data, not executable markup",
    async (boundary) => {
      const pathname = boundary === "admin" ? "/admin/activity-log" : "/admin/join-attempts";
      const path = `${pathname}?page=2&q=%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E&next=https%3A%2F%2Foutside.example%2F&tag=one&tag=two`;
      const { body } = kit.render(boundary, retryPage(503, path, pathname));
      const retry = await retryAnchors(body);
      expect(retry, "hostile text must not remove the usable same-view GET retry").toHaveLength(1);
      expect(retry[0]!.href).toBe(path);
      expectSafeRetry(retry[0]!.href);
      expect(body).not.toContain("<img src=x onerror=alert(1)>");
      expect(body).not.toContain(ADMIN_RETRY_CANARY);
    },
  );

  it.each(boundaries)(
    "%s drops the fragment, rather than replacing the read with an in-page jump",
    async (boundary) => {
      const path = boundary === "admin" ? "/admin/events?page=2" : "/admin/join-attempts?page=2";
      const { body } = kit.render(boundary, retryPage(500, `${path}#old-row`, path.split("?")[0]!));
      const retry = await retryAnchors(body);
      expect(retry).toHaveLength(1);
      expect(retry[0]!.href).toBe(path);
    },
  );
});

describe("CONTROL: missing rows and safe fallback remain recoverable without replay", () => {
  it.each([
    {
      boundary: "admin",
      path: "/admin/events/no-such-key",
      routeId: "/admin/events/[key]",
      exit: "/admin/events",
      title: "Event not found",
    },
    {
      boundary: "admin",
      path: "/admin/featured/999999",
      routeId: "/admin/featured/[id]",
      exit: "/admin/featured",
      title: "Featured content not found",
    },
    {
      boundary: "join-attempts",
      path: "/admin/join-attempts/7",
      routeId: "/admin/join-attempts/[id]",
      exit: "/admin/join-attempts",
      title: "Join attempt not found",
    },
  ] as const)("$path 404 has a list exit but no misleading retry", async (view) => {
    const { head, body } = kit.render(view.boundary, retryPage(404, view.path, view.routeId));
    expect(await retryAnchors(body)).toHaveLength(0);
    expect((await anchors(body)).map((anchor) => anchor.href)).toContain(view.exit);
    expect(head).toContain(view.title);
    expect(head).toContain("noindex");
    expect(body).not.toContain(ADMIN_RETRY_CANARY);
  });

  const malformedUrls = [
    { label: "absent", value: undefined },
    { label: "null", value: null },
    { label: "string", value: "/admin/events?page=2" },
    { label: "number", value: 42 },
    { label: "empty object", value: {} },
    { label: "non-string pathname", value: { pathname: 42, search: "?page=2" } },
    {
      label: "non-string query",
      value: { pathname: "/admin/events", search: { redirect: "//outside.example" } },
    },
    {
      label: "throwing pathname",
      value: {
        get pathname() {
          throw new Error(ADMIN_RETRY_CANARY);
        },
        search: "",
      },
    },
  ];
  for (const boundary of boundaries) {
    it.each(malformedUrls)(
      `${boundary}: $label page.url is total and has only safe fallback navigation`,
      async ({ value }) => {
        const { head, body } = kit.render(boundary, {
          status: 503,
          url: value,
          route: { id: boundary === "admin" ? "/admin/events" : "/admin/join-attempts" },
          params: {},
          error: { message: ADMIN_RETRY_CANARY },
        });
        expect(head).toContain("noindex");
        expect(body).toContain("TWO admin");
        expect(body).not.toContain(ADMIN_RETRY_CANARY);
        const links = await anchors(body);
        expect(links.some((anchor) => safeFallbacks.has(anchor.href))).toBe(true);
        for (const retry of await retryAnchors(body)) {
          expect(
            safeFallbacks.has(retry.href),
            "unusable page.url may only use a fixed safe GET fallback",
          ).toBe(true);
        }
      },
    );
  }

  const unsafePaths = [
    "/profile?next=/admin/events",
    "/administrator/events?page=2",
    "//outside.example/admin/events?page=2",
    "/admin/../auth/logout",
    "/admin/%2e%2e/auth/logout",
    "/admin/%2f%2foutside.example",
    "/admin\\..\\auth\\logout",
    "/admin/queue/failed/01J00000000000000000000001/redispatch",
  ];
  for (const boundary of boundaries) {
    for (const representation of ["URL", "malformed object"] as const) {
      const paths =
        representation === "URL"
          ? unsafePaths.filter((path) => !path.startsWith("//"))
          : unsafePaths;
      it.each(paths)(
        `${boundary}: ${representation} refuses unsafe or mutation pathname %s`,
        async (pathname) => {
          const { body } = kit.render(boundary, {
            status: 503,
            url:
              representation === "URL"
                ? new URL(pathname, ADMIN_RETRY_ORIGIN)
                : { pathname, search: "?page=2" },
            route: { id: "/admin/events" },
          });
          for (const retry of await retryAnchors(body)) {
            expect(
              safeFallbacks.has(retry.href),
              "invalid targets may only offer a fixed safe fallback",
            ).toBe(true);
            expectSafeRetry(retry.href);
          }
          expect((await anchors(body)).some((anchor) => safeFallbacks.has(anchor.href))).toBe(true);
        },
      );
    }
  }

  it.each(boundaries)(
    "%s cannot turn an absolute page URL into an external retry destination",
    async (boundary) => {
      const path = boundary === "admin" ? "/admin/events?page=2" : "/admin/join-attempts?page=2";
      const { body } = kit.render(boundary, {
        ...retryPage(503, path, path.split("?")[0]!),
        url: new URL(path, "https://outside.example"),
      });
      for (const retry of await retryAnchors(body)) expectSafeRetry(retry.href);
    },
  );

  it("the join-attempt boundary never retries a different admin cohort", async () => {
    const { body } = kit.render(
      "join-attempts",
      retryPage(503, "/admin/events?page=2", "/admin/events"),
    );
    for (const retry of await retryAnchors(body))
      expect(["/admin", "/admin/join-attempts"]).toContain(retry.href);
  });
});

describe("CONTROL: pure rendering preserves status copy, chrome, noindex and exits", () => {
  it.each(ADMIN_RETRY_VIEWS)(
    "$path keeps 500/503 distinct and the existing exits",
    async (view) => {
      const unavailable = kit.render(view.boundary, retryPage(503, view.path, view.routeId));
      const unexpected = kit.render(view.boundary, retryPage(500, view.path, view.routeId));
      expect(unavailable.head).toContain("Admin temporarily unavailable");
      expect(unexpected.head).toContain("Something went wrong");
      expect(unavailable.body).not.toBe(unexpected.body);
      for (const rendered of [unavailable, unexpected]) {
        expect(rendered.head).toContain("noindex");
        expect(rendered.body).toContain('aria-label="Administration"');
        expect(rendered.body).not.toContain(ADMIN_RETRY_CANARY);
        const hrefs = (await anchors(rendered.body)).map((anchor) => anchor.href);
        expect(hrefs).toContain("/admin");
        if (view.boundary === "join-attempts") expect(hrefs).toContain("/admin/join-attempts");
        if (view.routeId === "/admin/events/[key]") expect(hrefs).toContain("/admin/events");
        if (view.routeId === "/admin/featured/[id]") expect(hrefs).toContain("/admin/featured");
      }
    },
  );

  it.each(boundaries)(
    "%s derives recovery without a fetch or a server/session dependency",
    (boundary) => {
      const fetchSpy = vi.fn(() => {
        throw new Error("boundary rendering must not fetch");
      });
      vi.stubGlobal("fetch", fetchSpy);
      const path = boundary === "admin" ? "/admin/events?page=2" : "/admin/join-attempts?page=2";
      const { body } = kit.render(boundary, retryPage(503, path, path.split("?")[0]!));
      expect(body).toContain("TWO admin");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        kit.inputs.filter((path) =>
          /(?:^|\/)(?:postgres|cloudflare:workers)|src\/(?:db\/|sessions\.|kit-session\.)/.test(
            path,
          ),
        ),
      ).toEqual([]);
      expect(body).not.toMatch(/<meta\b[^>]*http-equiv=["']refresh|<script\b/i);
    },
  );
});
