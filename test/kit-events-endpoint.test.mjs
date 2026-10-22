// Exercise the real GET and loadEventsPage, not a copy of the endpoint.
// Like the admin-load tests, bundle the route without Kit's generated tsconfig.
// Only framework/data boundaries and the deliberately failing renderer are seams.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderEventsHtml } from "../src/kit-events-html";

const modelModule = fileURLToPath(new URL("../src/events/page-models.server.ts", import.meta.url));
const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw new globalThis.__kitEventsEndpoint.HttpError(status, message);
    }`,
  ],
  [
    "workers",
    `export const env = {
      APP_URL: "https://example.test", DISCORD_INVITE_URL: "https://discord.gg/example"
    };`,
  ],
  ["db", "export async function dbFor() { return {}; }"],
  [
    "session",
    `export const kitEventsSessionFor = () => async () => null;
     export const kitEventsJourneyFor = () => async (request) =>
       request.headers.get("cookie")?.includes("__Host-two_join_result=pending") ? "added" : null;
     export const isRestoredBannerEligible = (request) =>
       !new URL(request.url).pathname.startsWith("/auth/") &&
       !request.headers.get("x-two-island");
     export const readReturnJourney = async (request) => ({
       returnTo: null,
       joinResult: null,
       expiredWrite: null,
       restoredWrite: request.headers.get("cookie")?.includes("restored|")
         ? "/profile?restored-probe=1"
         : null,
     });`,
  ],
  [
    "discord",
    `export const discordEventsSource = () => ({
      upcoming: async () => [], lastReadFailed: () => false
    });`,
  ],
  [
    "model",
    `export { resolveCalendarInput } from ${JSON.stringify(modelModule)};
     export const loadCalendarPageModel = (...args) => globalThis.__kitEventsEndpoint.model(...args);`,
  ],
  [
    "renderer",
    "export const renderEventsHtml = (...args) => globalThis.__kitEventsEndpoint.render(...args);",
  ],
]);

let GET;
let seams;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.body = { message };
  }
}

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../web/src/routes/events/+server.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    write: false,
    plugins: [
      {
        name: "kit-events-endpoint-test",
        setup(build) {
          const replacements = [
            [/^@sveltejs\/kit$/, "sveltekit"],
            [/^cloudflare:workers$/, "workers"],
            [/src\/admin\/db$/, "db"],
            [/src\/kit-session$/, "session"],
            [/\/events\/discord-transients$/, "discord"],
            [/\/events\/page-models\.server$/, "model"],
            [/src\/kit-events-html$/, "renderer"],
          ];
          for (const [filter, path] of replacements) {
            build.onResolve({ filter }, () => ({ path, namespace: "kit-events-endpoint-test" }));
          }
          build.onLoad({ filter: /.*/, namespace: "kit-events-endpoint-test" }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
            resolveDir: fileURLToPath(new URL("..", import.meta.url)),
          }));
        },
      },
    ],
  });
  ({ GET } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  ));
});

beforeEach(() => {
  seams = {
    HttpError,
    model: vi.fn(async () => ({
      state: { view: "list", month: "2026-10", q: "", past: false, page: 1 },
      upcoming: [],
      past: [],
      zone: "Europe/London",
      now: new Date("2026-10-13T12:00:00Z"),
      totalPages: 1,
      emptyState: null,
      robots: undefined,
      discordFailed: false,
    })),
    render: vi.fn(renderEventsHtml),
  };
  vi.stubGlobal("__kitEventsEndpoint", seams);
  vi.stubGlobal("fetch", () => {
    throw new Error("Endpoint acceptance tests must not use the network");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function requestEvent({
  flash = false,
  restored = false,
  method = "GET",
  island = false,
  query = "",
} = {}) {
  const jar = [
    ...(flash ? ["__Host-two_join_result=pending"] : []),
    ...(restored ? ["__Host-two_expired_write=restored|/profile"] : []),
  ];
  const request = new Request(`https://example.test/events${query}`, {
    method,
    headers: {
      ...(jar.length ? { cookie: jar.join("; ") } : {}),
      ...(island ? { "x-two-island": "events-calendar" } : {}),
    },
  });
  const headers = new Headers();
  const deleteCookie = vi.fn();
  const event = {
    request,
    url: new URL(request.url),
    cookies: { delete: deleteCookie },
    setHeaders(values) {
      for (const [name, value] of Object.entries(values)) headers.set(name, value);
    },
  };
  return { event, headers, deleteCookie };
}

async function expectUnavailable(event) {
  const failure = await GET(event).then(
    () => null,
    (error) => error,
  );
  // A helper's ordinary Error with status:503 is not a Kit HttpError: Kit
  // would turn that into a 500. Require the framework error boundary too.
  expect(failure).toBeInstanceOf(HttpError);
  expect(failure).toMatchObject({
    status: 503,
    body: { message: "Events temporarily unavailable" },
  });
  // Prove this was a late failure, after the real load read its model.
  expect(seams.model).toHaveBeenCalledOnce();
  expect(seams.render).toHaveBeenCalledOnce();
}

function expectPrivate(headers) {
  expect(headers.get("cache-control")).toBe("private, no-store");
  expect(headers.get("vary")).toBe("Cookie, X-Two-Island");
}

function failRendering() {
  seams.render.mockRejectedValueOnce(new Error("render failed after the model loaded"));
}

describe("Kit events endpoint late-failure contract", () => {
  it("replaces anonymous success-cache headers with private no-store on render failure", async () => {
    const { event, headers, deleteCookie } = requestEvent();
    failRendering();

    await expectUnavailable(event);

    expectPrivate(headers);
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("does not queue a join-flash deletion when rendering fails", async () => {
    const { event, headers, deleteCookie } = requestEvent({ flash: true });
    failRendering();

    await expectUnavailable(event);

    expect(seams.render.mock.calls[0][0]).toMatchObject({ joinResult: "added" });
    expectPrivate(headers);
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("does not queue a join-flash deletion when Response construction fails", async () => {
    const { event, headers, deleteCookie } = requestEvent({ flash: true });
    const construct = vi.fn(() => {
      throw new Error("response construction failed after rendering");
    });
    vi.stubGlobal("Response", new Proxy(Response, { construct }));

    await expectUnavailable(event);

    expect(construct).toHaveBeenCalledOnce();
    const rendered = await seams.render.mock.results[0].value;
    expect(rendered.body).toContain('data-testid="join-result"');
    expectPrivate(headers);
    expect(deleteCookie).not.toHaveBeenCalled();
  });
});

describe("Kit events endpoint flash-consumption controls", () => {
  it("keeps an anonymous successful full GET public and never deletes a flash", async () => {
    const { event, deleteCookie } = requestEvent();

    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("vary")).toBe("Cookie, X-Two-Island");
    expect(await response.text()).toContain('data-testid="events-calendar"');
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("consumes the pending flash exactly once on a successful full GET with Host-safe options", async () => {
    const { event, deleteCookie } = requestEvent({ flash: true });

    const response = await GET(event);

    expect(response.status).toBe(200);
    expectPrivate(response.headers);
    const body = await response.text();
    expect(body).toContain('data-testid="events-calendar"');
    expect(body).toContain('data-testid="join-result"');
    expect(deleteCookie.mock.calls).toEqual([
      ["__Host-two_join_result", { path: "/", secure: true, httpOnly: true, sameSite: "lax" }],
    ]);
  });

  it.each([
    { method: "HEAD", island: false },
    { method: "GET", island: true },
    { method: "HEAD", island: true },
  ])("leaves the flash pending on $method with island=$island", async ({ method, island }) => {
    const { event, deleteCookie } = requestEvent({ flash: true, method, island });

    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(seams.render.mock.calls[0][0]).toMatchObject({ joinResult: null });
    expect(deleteCookie).not.toHaveBeenCalled();
  });
});

describe("Kit events endpoint restored-write banner", () => {
  const banner =
    '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';

  it("renders the banner first in main on a full GET without echoing the destination", async () => {
    const { event, deleteCookie } = requestEvent({ restored: true });

    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(seams.render.mock.calls[0][2]).toEqual({
      restoredWrite: "/profile?restored-probe=1",
    });
    const body = await response.text();
    expect(body).toContain(banner);
    expect(body.indexOf('data-testid="auth-error"')).toBeGreaterThan(body.indexOf("<main"));
    expect(body).not.toContain("restored-probe=1");
    // The endpoint renders only: the hook core owns the one-shot deletion.
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("renders no banner for island fragments", async () => {
    const { event } = requestEvent({ restored: true, island: true });

    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(seams.render.mock.calls[0][2]).toEqual({ restoredWrite: null });
    expect(await response.text()).not.toContain('data-testid="auth-error"');
  });

  it("renders no banner on the overlong-query notice", async () => {
    const { event } = requestEvent({ restored: true, query: `?q=${"z".repeat(300)}` });

    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(seams.render.mock.calls[0][0]).toMatchObject({ queryTooLong: true });
    expect(seams.render.mock.calls[0][2]).toEqual({ restoredWrite: null });
    expect(seams.model).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('data-testid="auth-error"');
  });
});
