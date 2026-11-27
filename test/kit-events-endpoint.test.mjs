// Exercise the real GET and loadEventsPage, not a copy of the endpoint.
// Like the admin-load tests, bundle the route without Kit's generated tsconfig.
// Only framework/data boundaries and the deliberately failing renderer are seams.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { defaultTreeAdapter, Parser } from "parse5";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRenderedPage, renderedElements, renderedText } from "../ci/rendered-page.mjs";
import { renderKitEvents as realRender } from "./helpers/calendar-game-recovery";
import { gathering } from "./helpers/calendar-multiday-acceptance";
import { attribute, elements, tag, testId } from "./helpers/schedule-search-context-acceptance";

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
       request.headers.get("cookie")?.includes("__Host-two_join_result=pending") ? "added" : null;`,
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
            [/lib\/server\/render-events-html$/, "renderer"],
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
    model: vi.fn(async ({ input: { q, page } }) => ({
      state: { view: "list", month: "2026-10", q, past: false, page },
      upcoming: page === 2 ? [] : [gathering({ title: "<drill>", proofMarker: "not-public" })],
      past: [],
      zone: "Europe/London",
      now: new Date("2026-10-13T12:00:00Z"),
      totalPages: page === 2 ? 2 : 1,
      emptyState: null,
      robots: undefined,
      discordFailed: false,
      games: [],
      gameFilter: null,
    })),
    render: vi.fn(realRender),
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

function requestEvent(options = {}) {
  const { flash, method = "GET", island, restoredWrite, search = "" } = options;
  const request = new Request(`https://example.test/events${search}`, {
    method,
    headers: {
      ...(flash ? { cookie: "__Host-two_join_result=pending" } : {}),
      ...(island ? { "x-two-island": "events-calendar" } : {}),
    },
  });
  const headers = new Headers();
  const deleteCookie = vi.fn();
  const event = {
    request,
    url: new URL(request.url),
    // The binding threads locals.requestId into the load (the dispatch sets
    // it on the Kit branch); this harness drives the endpoint without the
    // dispatch, so locals carries no id, exactly like a headerless request.
    locals: { restoredWrite },
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

// Fragment parsing can discard document tags. Record them before tree construction.
class IslandFragmentParser extends Parser {
  documentTags = [];

  onDoctype(token) {
    this.documentTags.push("doctype");
    super.onDoctype(token);
  }

  onStartTag(token) {
    if (["html", "body", "main", "script"].includes(token.tagName)) {
      this.documentTags.push(token.tagName);
    }
    super.onStartTag(token);
  }
}

function sourceElements(root, predicate) {
  return [
    ...elements(root, predicate),
    ...tag(root, "template").flatMap((template) =>
      template.content ? sourceElements(template.content, predicate) : [],
    ),
  ];
}

function sourceTestIds(page) {
  return sourceElements(page, (node) => attribute(node, "data-testid") !== undefined).map((node) =>
    attribute(node, "data-testid"),
  );
}

function stylesheets(page) {
  return tag(page, "link")
    .filter((link) => attribute(link, "rel") === "stylesheet")
    .map((link) => attribute(link, "href"));
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
    expect(testId(parseRenderedPage(rendered.body), "join-result")).toHaveLength(1);
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
    const body = await response.text();
    const page = parseRenderedPage(body);
    const [calendar] = testId(page, "events-calendar");
    expect(calendar).toBeDefined();
    expect(tag(page, "nav").map((nav) => attribute(nav, "class"))).toContain("segments");
    expect(calendar && renderedText(calendar)).toContain("<drill>");
    expect(sourceElements(page, (node) => node.tagName === "drill")).toHaveLength(0);
    // Wire bytes also cover nested markup in attributes and markers in comments.
    expect(body).not.toContain("<drill>");
    expect(body).not.toContain("not-public");
    expect(stylesheets(page)).toContain("/schedule-theme.css");
    expect(stylesheets(page)).toContain("/kit-events-controls.css");
    const scripts = tag(page, "script");
    expect(scripts.map((script) => attribute(script, "src"))).toContain(
      "/islands/events-calendar.js",
    );
    const documents = [page, parseRenderedPage(body, { scriptingEnabled: false })];
    expect(
      documents.flatMap((document) =>
        sourceElements(
          document,
          (node) =>
            node.tagName === "script" && attribute(node, "type")?.toLowerCase() === "module",
        ),
      ),
    ).toHaveLength(0);
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("consumes the pending flash exactly once on a successful full GET with Host-safe options", async () => {
    const { event, deleteCookie } = requestEvent({ flash: true, restoredWrite: true });

    const response = await GET(event);

    expect(response.status).toBe(200);
    expectPrivate(response.headers);
    const page = parseRenderedPage(await response.text());
    expect(testId(page, "events-calendar")).toHaveLength(1);
    expect(testId(page, "join-result")).toHaveLength(1);
    const [main] = tag(page, "main");
    expect(main?.childNodes[0]).toMatchObject({
      tagName: "div",
      attrs: expect.arrayContaining([
        { name: "role", value: "status" },
        { name: "tabindex", value: "-1" },
        { name: "data-testid", value: "auth-error" },
      ]),
    });
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
    const body = await response.text();
    const page = parseRenderedPage(body, { scriptingEnabled: false });
    expect(sourceTestIds(page)).not.toContain("join-result");
    // Also reject the private marker in comments and other unparsed wire bytes.
    expect(body).not.toContain('data-testid="join-result"');
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("renders an unreadable list fragment with the same swap zones", async () => {
    const { event, deleteCookie } = requestEvent({
      flash: true,
      island: true,
      restoredWrite: true,
      search: "?q=Paged&page=2",
    });
    const body = await (await GET(event)).text();
    // The client feeds the fragment to DOMParser before locating the island.
    const parser = new IslandFragmentParser({ scriptingEnabled: false });
    parser.tokenizer.write(body, true);
    const fragment = parser.document;
    const islands = elements(
      fragment,
      (node) => attribute(node, "data-island") === "events-calendar",
    );
    expect(islands).toHaveLength(1);
    const [island] = islands;
    const rendered = new Set(renderedElements(fragment, {}));
    const unreadable = testId(island, "events-page-unreadable").find((node) => rendered.has(node));
    const status = testId(island, "events-search-status").find((node) => rendered.has(node));
    expect(unreadable && renderedText(unreadable).trim()).toMatch(/^Events on page 2 can/);
    expect(status && renderedText(status).trim()).toMatch(/^Events on page 2 can/);
    expect(status && attribute(status, "role")).toBe("status");
    const [firstPage] = testId(island, "events-pager-first");
    expect(firstPage?.tagName).toBe("a");
    expect(firstPage && attribute(firstPage, "href")).toBe("/events?q=Paged");
    const emittedTestIds = sourceTestIds(fragment);
    expect(emittedTestIds).not.toContain("events-empty-search");
    expect(parser.documentTags).toEqual([]);
    const isZone = (node) => attribute(node, "data-cal-zone") !== undefined;
    const zones = elements(island, (node) => node !== island && isZone(node));
    expect(zones.map((zone) => attribute(zone, "data-cal-zone"))).toEqual([
      "head",
      "subscribe",
      "actions",
      "miss",
      "content",
    ]);
    expect(sourceElements(fragment, isZone)).toHaveLength(zones.length);
    const firstHeadChild = zones[0]?.childNodes.find(
      (node) => !defaultTreeAdapter.isTextNode(node) || node.value.trim() !== "",
    );
    expect(firstHeadChild).toMatchObject({
      tagName: "link",
      attrs: expect.arrayContaining([
        { name: "rel", value: "stylesheet" },
        { name: "href", value: "/kit-events-controls.css" },
      ]),
    });
    expect(emittedTestIds).not.toContain("auth-error");
    expect(emittedTestIds).not.toContain("join-result");
    expect(body).not.toContain('data-testid="auth-error"');
    expect(body).not.toContain('data-testid="join-result"');
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("keeps the query refusal out of the calendar renderer and leaves the flash pending", async () => {
    const query = `must-not-echo-${"x".repeat(256)}`;
    const { event, deleteCookie } = requestEvent({
      flash: true,
      restoredWrite: true,
      search: `?q=${query}`,
    });
    const response = await GET(event);
    const body = await response.text();
    const page = parseRenderedPage(body, { scriptingEnabled: false });
    expect(response.headers.get("x-two-events-too-long")).toBe("true");
    expect(elements(page, (node) => attribute(node, "role") === "alert")).toHaveLength(1);
    // Check the wire bytes for disclosure even outside rendered text and attributes.
    expect(body).not.toContain(query);
    const emittedTestIds = sourceTestIds(page);
    expect(emittedTestIds).not.toContain("events-calendar");
    expect(emittedTestIds).not.toContain("auth-error");
    expect(body).not.toContain('data-testid="auth-error"');
    expect(seams.model).not.toHaveBeenCalled();
    expect(seams.render.mock.calls[0][0]).toMatchObject({ queryTooLong: true });
    expect(deleteCookie).not.toHaveBeenCalled();
  });
});
