// Kit public-read 503 bindings thread the dispatch's served request id.
//
// The /events, /events/past and /e/:key bindings must pass locals.requestId
// (the id the dispatch validated or minted before resolve) into their load
// helpers, never the raw cf-ray header: with no valid cf-ray the dispatch
// mints a ULID for the 503 page Support reference and x-request-id, and an
// alert naming only the header would log a null request_id the operator
// holding the page value cannot join. The 503-alerts acceptance suite pins
// that the helpers forward a passed id to error.alert; this file pins that
// the production bindings supply the served one.
//
// Same bundling pattern as test/kit-events-endpoint.test.mjs: bundle each
// real route with esbuild (the root Vitest config does not run SvelteKit's
// sync hook), keep the load helper real, stub only the framework, env, db,
// alert, session, render and const imports. Hermetic: no live database (the
// db seam throws), no network.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { safeRequestId } from "../src/request-log";

// Minted-ULID shape (Crockford base32, timestamp head): what the dispatch
// stores in locals when no valid cf-ray arrived. Guarded below so a typoed
// fixture fails loudly instead of testing the absent-id path.
const MINTED = "01J9X7Q2M4W0B3D6F8H1K3N5P7";

const modelModule = fileURLToPath(new URL("../src/events/page-models.server.ts", import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.body = { message };
  }
}

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw new globalThis.__kit503Bindings.HttpError(status, message);
    }
    export function redirect(status, location) {
      throw new globalThis.__kit503Bindings.HttpError(status, location);
    }`,
  ],
  [
    "workers",
    `export const env = {
      APP_URL: "https://example.test", DISCORD_INVITE_URL: "https://discord.gg/example"
    };`,
  ],
  // The code-bug leg: a plain TypeError from the database handle, never a
  // branded status, so the helper must alert before mapping to the 503.
  [
    "db",
    `export async function dbFor() {
      throw new TypeError("probe: cannot read properties of undefined (db)");
    }`,
  ],
  [
    "alerts",
    `export function alertRequestError(err, fields) {
      globalThis.__kit503Bindings.alerts.push({ err, fields });
    }
    export function exceptionClass(err) {
      if (err instanceof Error) return err.constructor?.name || err.name || "Error";
      return typeof err;
    }`,
  ],
  [
    "session",
    `export const kitEventsSessionFor = () => async () => null;
     export const kitEventsJourneyFor = () => async () => null;`,
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
     export const loadCalendarPageModel = () => {
       throw new Error("page model must not run when the db handle throws");
     };`,
  ],
  [
    "renderer",
    `export const renderEventsHtml = () => {
      throw new Error("renderer must not run when the load throws");
    };`,
  ],
  [
    "reads",
    `export async function listPast() {
      throw new Error("listPast must not run when the db handle throws");
    }`,
  ],
  ["searchlog", `export const MAX_QUERY_LENGTH = 255;`],
  ["contracts", `export const EVENTS_SEARCH_TOO_LONG_COPY = "search too long (stub)";`],
  ["journey", `export const JOIN_RESULT_COOKIE = "__Host-two_join_result";`],
  [
    "detail",
    `export function kitEventDetailStore() { return {}; }
     export async function resolveKitEventDetail(args) {
       globalThis.__kit503Bindings.detailCalls.push(args);
       return { kind: "ok", model: { sentinel: "detail-ok" } };
     }
     export function eventDetailConsumesFlash() { return false; }
     export function eventDetailErrorPayload() {
       throw new Error("error payload must not run on the ok path");
     }`,
  ],
]);

async function bundleRoute(entryRelPath, replacements) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../web/src/routes/${entryRelPath}`, import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    write: false,
    plugins: [
      {
        name: "kit-503-bindings-request-id",
        setup(plugin) {
          for (const [filter, path] of replacements) {
            plugin.onResolve({ filter }, () => ({ path, namespace: "kit-503-bindings" }));
          }
          plugin.onLoad({ filter: /.*/, namespace: "kit-503-bindings" }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
            resolveDir: fileURLToPath(new URL("..", import.meta.url)),
          }));
        },
      },
    ],
  });
  return await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
}

const frameworkReplacements = [
  [/^@sveltejs\/kit$/, "sveltekit"],
  [/^cloudflare:workers$/, "workers"],
  [/src\/admin\/db$/, "db"],
  // The real helpers import the alerts module relatively ("./alerts"), so
  // match the basename: anchored to a path boundary so runbook-alerts and
  // tail-alerts never resolve here.
  [/(^|\/)alerts$/, "alerts"],
];

let eventsGET;
let pastLoad;
let detailLoad;

beforeAll(async () => {
  globalThis.__kit503Bindings = { HttpError, alerts: [], detailCalls: [] };
  ({ GET: eventsGET } = await bundleRoute("events/+server.ts", [
    ...frameworkReplacements,
    [/src\/kit-session$/, "session"],
    [/\/events\/discord-transients$/, "discord"],
    [/\/events\/page-models\.server$/, "model"],
    [/src\/kit-events-html$/, "renderer"],
    [/src\/return-journey$/, "journey"],
  ]));
  ({ load: pastLoad } = await bundleRoute("events/past/+page.server.ts", [
    ...frameworkReplacements,
    [/src\/events\/reads$/, "reads"],
    [/src\/events\/search-log$/, "searchlog"],
    [/src\/islands\/contracts$/, "contracts"],
  ]));
  ({ load: detailLoad } = await bundleRoute("e/[key]/+page.server.ts", [
    [/^@sveltejs\/kit$/, "sveltekit"],
    [/^cloudflare:workers$/, "workers"],
    [/src\/events\/kit-detail$/, "detail"],
    [/src\/return-journey$/, "journey"],
  ]));
});

beforeEach(() => {
  globalThis.__kit503Bindings.alerts = [];
  globalThis.__kit503Bindings.detailCalls = [];
});

const noHeaders = (url) => {
  const request = new Request(url);
  expect(request.headers.get("cf-ray"), "premise: no cf-ray arrived").toBeNull();
  return request;
};

describe("the /events binding alerts the served id", () => {
  const url = "https://example.test/events";

  it("names the minted ULID when no cf-ray arrived", async () => {
    expect(safeRequestId(MINTED), "fixture must be a valid ULID").toBe(MINTED);
    const failure = await eventsGET({
      request: noHeaders(url),
      url: new URL(url),
      locals: { requestId: MINTED },
      cookies: {},
      setHeaders: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure?.status).toBe(503);
    expect(globalThis.__kit503Bindings.alerts).toHaveLength(1);
    expect(globalThis.__kit503Bindings.alerts[0].fields).toMatchObject({
      method: "GET",
      route: "/events",
      requestId: MINTED,
    });
  });

  it("alerts without an id when locals carries none", async () => {
    const failure = await eventsGET({
      request: noHeaders(url),
      url: new URL(url),
      locals: {},
      cookies: {},
      setHeaders: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    expect(failure?.status).toBe(503);
    expect(globalThis.__kit503Bindings.alerts).toHaveLength(1);
    expect(globalThis.__kit503Bindings.alerts[0].fields.requestId).toBeUndefined();
  });
});

describe("the /events/past binding alerts the served id", () => {
  const url = "https://example.test/events/past";

  it("names the minted ULID when no cf-ray arrived", async () => {
    const failure = await pastLoad({
      url: new URL(url),
      // SvelteKit always supplies the request; the binding must not read
      // the id from it.
      request: noHeaders(url),
      locals: { requestId: MINTED },
      setHeaders: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure?.status).toBe(503);
    expect(globalThis.__kit503Bindings.alerts).toHaveLength(1);
    expect(globalThis.__kit503Bindings.alerts[0].fields).toMatchObject({
      method: "GET",
      route: "/events/past",
      requestId: MINTED,
    });
  });

  it("alerts without an id when locals carries none", async () => {
    const failure = await pastLoad({
      url: new URL(url),
      request: noHeaders(url),
      locals: {},
      setHeaders: () => {},
    }).then(
      () => null,
      (error) => error,
    );
    expect(failure?.status).toBe(503);
    expect(globalThis.__kit503Bindings.alerts).toHaveLength(1);
    expect(globalThis.__kit503Bindings.alerts[0].fields.requestId).toBeUndefined();
  });
});

describe("the /e/:key binding forwards the served id", () => {
  const url = "https://example.test/e/01JAAAAAAAAAAAAAAAAAAAAAAA";

  it("passes the minted ULID to the detail resolver", async () => {
    expect(safeRequestId(MINTED), "fixture must be a valid ULID").toBe(MINTED);
    const out = await detailLoad({
      params: { key: "01JAAAAAAAAAAAAAAAAAAAAAAA" },
      url: new URL(url),
      request: noHeaders(url),
      locals: { status: "unknown", session: null, joinResult: null, requestId: MINTED },
      cookies: {},
      setHeaders: () => {},
    });
    expect(out).toEqual({ model: { sentinel: "detail-ok" } });
    expect(globalThis.__kit503Bindings.detailCalls).toHaveLength(1);
    expect(globalThis.__kit503Bindings.detailCalls[0].requestId).toBe(MINTED);
  });

  it("forwards undefined when locals carries no id", async () => {
    await detailLoad({
      params: { key: "01JAAAAAAAAAAAAAAAAAAAAAAA" },
      url: new URL(url),
      request: noHeaders(url),
      locals: { status: "unknown", session: null, joinResult: null },
      cookies: {},
      setHeaders: () => {},
    });
    expect(globalThis.__kit503Bindings.detailCalls).toHaveLength(1);
    expect(globalThis.__kit503Bindings.detailCalls[0].requestId).toBeUndefined();
  });
});
