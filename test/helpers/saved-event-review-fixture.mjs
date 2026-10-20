// Owned acceptance fixture shared by offline Vitest and native Playwright cases.
// No production/staging resources. Only framework environment/DB bindings are
// replaced; actual loads, queries, hook dispatch, SSR and write handlers run.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { adminApp } from "../../src/admin/routes";
import { events } from "../../src/db/admin-schema";
import { resolveKitEventDetail } from "../../src/events/kit-detail";
import { dispatchHookRequest, ROUTE_MANIFEST } from "../../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";
import { createMemberDataFixture } from "./member-data-db";

export const NOW = new Date("2030-01-10T20:00:00.000Z");
export const UPDATED = new Date("2030-01-09T11:12:13.000Z");
export const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const ORIGIN = "https://next.example.test";
export const FIELDS = {
  title: "Saved chess night",
  game: "Chess",
  description: "Synthetic local event",
  starts_at: "2030-01-10 19:00",
  ends_at: "2030-01-10 21:00",
  timezone: "UTC",
  location: "Fixture voice room",
  capacity: "8",
};
export const root = fileURLToPath(new URL("../../", import.meta.url));
const SECRET = "test-session-secret-at-least-32-bytes-long";

async function compilePages() {
  const { compile } = createRequire(join(root, "web/package.json"))("svelte/compiler");
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Page from "./web/src/routes/admin/events/[key]/+page.svelte";
        import Detail from "./web/src/lib/EventDetail.svelte";
        export { load } from "./web/src/routes/admin/events/[key]/+page.server.ts";
        export const renderPage = (data) => render(Page, { props: { data } }).body;
        export const renderDetail = (model) => render(Detail, { props: { model } }).body;
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "saved-event-review-ssr",
        setup(plugin) {
          const virtual = new Map([
            [
              "@sveltejs/kit",
              "export function error(status, message) { throw Object.assign(new Error(message), {status}); }",
            ],
            ["cloudflare:workers", "export const env = {};"],
            [
              "admin-db",
              "export async function dbFor() { return globalThis.__savedEventReviewDb; }",
            ],
          ]);
          plugin.onResolve({ filter: /^(@sveltejs\/kit|cloudflare:workers)$/ }, ({ path }) => ({
            path,
            namespace: "review-fixture",
          }));
          plugin.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "review-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "review-fixture" }, ({ path }) => ({
            contents: virtual.get(path),
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
}

function localsFor(role) {
  return {
    status: role === "guest" ? "guest" : "authenticated",
    session:
      role === "guest"
        ? null
        : {
            userId: role === "moderator" ? "100000000000000111" : "100000000000000222",
            username: "fixture-viewer",
            avatar: null,
            member: true,
            moderator: role === "moderator",
          },
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  };
}

export async function savedEventFixture() {
  const fixture = await createMemberDataFixture(process.env.DATABASE_URL, { max: 3 });
  let pages;
  try {
    pages = await compilePages();
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
  let store;
  let cookie;
  let env;
  const stored = async () =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, KEY)))[0];
  async function sessionCookie(moderator) {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: moderator ? "100000000000000111" : "100000000000000222",
      username: "fixture-viewer",
      avatar: null,
      member: true,
      moderator,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0];
  }
  async function reset() {
    await fixture.reset();
    store = createMemorySessionStore();
    cookie = await sessionCookie(true);
    env = { APP_URL: ORIGIN, SESSION_SECRET: SECRET, SESSION_STORE: store, ADMIN_DB: fixture.db };
  }
  async function seed(overrides = {}) {
    await fixture.db.insert(events).values({
      eventKey: KEY,
      title: FIELDS.title,
      game: FIELDS.game,
      description: FIELDS.description,
      startsAt: new Date("2030-01-10T19:00:00.000Z"),
      endsAt: new Date("2030-01-10T21:00:00.000Z"),
      timezone: "UTC",
      location: FIELDS.location,
      capacity: 8,
      status: "draft",
      rsvpOpen: true,
      updatedAt: UPDATED,
      ...overrides,
    });
  }
  const post = (path, fields = {}) =>
    adminApp({ sessionStore: store, db: fixture.db }).request(
      path,
      {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      },
      env,
    );
  const honoGet = (path) =>
    adminApp({ sessionStore: store, db: fixture.db }).request(path, { headers: { cookie } }, env);
  async function hook(path, declaration, role, resolve) {
    const request = new Request(`${ORIGIN}${path}`);
    return dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: declaration } },
      {
        appUrl: ORIGIN,
        featuredImageHosts: "",
        // Enable only the tested read in a local manifest. Never alter ownership.
        manifest: ROUTE_MANIFEST.map((entry) =>
          entry.method === "GET" && entry.path === declaration
            ? { ...entry, enabled: true }
            : entry,
        ),
        honoFetch: () => {
          throw new Error("Kit read unexpectedly fell back to Hono");
        },
        sessionFor: async () => localsFor(role),
        accessSink: async () => async () => true,
        resolve,
      },
    );
  }
  async function editorResponse(engine) {
    if (engine === "Hono") return honoGet(`/events/${KEY}`);
    globalThis.__savedEventReviewDb = fixture.db;
    return hook(`/admin/events/${KEY}`, "/admin/events/:key", "moderator", async () => {
      const data = await pages.load(
        {
          parent: async () => ({ actor: { id: "100000000000000111", username: "fixture-mod" } }),
          params: { key: KEY },
          url: new URL(`${ORIGIN}/admin/events/${KEY}`),
          setHeaders: () => {},
        },
        {},
      );
      return new Response(pages.renderPage(data), { headers: { "content-type": "text/html" } });
    });
  }
  async function detailResponse(engine, role, path = `/e/${KEY}`) {
    if (engine === "Hono") {
      const headers = {
        accept: "text/html",
        ...(role === "guest" ? {} : { cookie: await sessionCookie(role === "moderator") }),
      };
      return app.request(path, { headers }, env);
    }
    return hook(`/e/${KEY}`, "/e/:key", role, async () => {
      const outcome = await resolveKitEventDetail({
        key: KEY,
        search: "",
        path: `/e/${KEY}`,
        env,
        session: localsFor(role),
        joinResult: null,
        setHeaders: () => {},
        store: {
          dbForFn: async () => fixture.db,
          getEventFn: async () => ({ ...(await stored()), goingCount: 0 }),
          neighborsFn: async () => ({ previous: null, next: null }),
          relatedFn: async () => [],
          attendeesFn: async () => [],
          viewerRsvpFn: async () => null,
          waitlistFn: async () => null,
          suggestionsFn: async () => [],
        },
      });
      if (outcome.kind === "forbidden") return new Response("Forbidden", { status: 403 });
      if (outcome.kind !== "ok") throw new Error(`Unexpected detail outcome ${outcome.kind}`);
      return new Response(pages.renderDetail(outcome.model), {
        headers: { "content-type": "text/html" },
      });
    });
  }
  return {
    ...fixture,
    reset,
    seed,
    stored,
    post,
    honoGet,
    editorResponse,
    detailResponse,
    change: (fields) => fixture.db.update(events).set(fields).where(eq(events.eventKey, KEY)),
    newResponse: () => app.request("/admin/events/new", { headers: { cookie } }, env),
    dispose: async () => {
      delete globalThis.__savedEventReviewDb;
      await fixture.dispose();
    },
  };
}
