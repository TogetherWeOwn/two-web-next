// Kit admin event-edit load wiring: the guard-first/no-store/404/503
// decisions in web/src/routes/admin/events/[key]/+page.server.ts are
// behavioural, not source text. resolveKitEventEdit is unit-tested; this
// drives the real load with a fake Db so a dropped parent() await, a missing
// cache header, a 404/503 swap or an unfiltered roster query fails here
// instead of shipping a guard bypass or a shared-cacheable moderator form.
//
// The root Vitest config does not run SvelteKit's sync hook, so Vite/OXC
// cannot resolve the route's generated `$app/tsconfig`. Bundle the real route
// with esbuild instead, stubbing only its framework and database-binding
// imports.
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw Object.assign(new Error(message), { status });
    }`,
  ],
  ["cloudflare-workers", "export const env = {};"],
  ["admin-db", "export async function dbFor() { return globalThis.__kitAdminEventEditDb; }"],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../web/src/routes/admin/events/[key]/+page.server.ts", import.meta.url),
      ),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-admin-event-edit-load-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-admin-event-edit-load-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-admin-event-edit-load-test",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-admin-event-edit-load-test",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "kit-admin-event-edit-load-test" },
            ({ path }) => ({
              contents: virtualModules.get(path),
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ load } = await import(bundled));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const actor = { id: "100000000000000111", username: "mod" };

const eventRow = () => ({
  eventKey: "EVT1",
  title: "Game night",
  game: "Chess",
  description: "Casual play",
  startsAt: new Date("2026-07-01T19:00:00.000Z"),
  endsAt: new Date("2026-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
});

const rosterRow = () => ({
  userId: "100000000000000333",
  memberId: "100000000000000333",
  username: "mod",
  status: "going",
  answeredAt: new Date("2026-06-01T12:00:00.000Z"),
});

/** Drizzle builders are lazy thenables: one chain per select, queued results
 * (event read, roster count, roster page). */
function rowsDb(eventRows, countRows, rosterRows) {
  const outstanding = [eventRows, countRows, rosterRows];
  const chain = {};
  for (const m of [
    "from",
    "where",
    "orderBy",
    "limit",
    "offset",
    "innerJoin",
    "leftJoin",
    "groupBy",
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve, reject) =>
    Promise.resolve(outstanding.length > 1 ? outstanding.shift() : outstanding[0]).then(
      resolve,
      reject,
    );
  return { select: () => chain };
}

function throwingDb(err) {
  return {
    select: () => {
      throw err;
    },
  };
}

function rejectingDb(err) {
  const chain = {};
  for (const m of [
    "from",
    "where",
    "orderBy",
    "limit",
    "offset",
    "innerJoin",
    "leftJoin",
    "groupBy",
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (_resolve, reject) => Promise.resolve().then(() => reject(err));
  return { select: () => chain };
}

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

const editUrl = (search = "") => new URL(`https://next.example.test/admin/events/EVT1${search}`);

describe("Kit admin event-edit load: guard and failure wiring", () => {
  it("awaits the layout guard before any database work", async () => {
    let settled = false;
    vi.stubGlobal("__kitAdminEventEditDb", rowsDb([eventRow()], [{ n: 0 }], []));
    const parent = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = true;
      return { actor };
    };
    const setHeaders = vi.fn();
    const data = await load({ parent, params: { key: "EVT1" }, url: editUrl(), setHeaders }, {});
    expect(settled).toBe(true);
    expect(data.view.key).toBe("EVT1");
    expect(setHeaders).toHaveBeenCalledOnce();
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("propagates a guest redirect and sets no cache headers", async () => {
    const redirect = Object.assign(new Error("redirect"), {
      status: 302,
      location: "/auth/discord",
    });
    const parent = async () => {
      throw redirect;
    };
    const setHeaders = vi.fn();
    const err = await load(
      { parent, params: { key: "EVT1" }, url: editUrl(), setHeaders },
      {},
    ).catch((e) => e);
    expect(err).toBe(redirect);
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("no database answers 503 and sets no cache headers", async () => {
    const setHeaders = vi.fn();
    const err = await load(
      { parent: async () => ({ actor }), params: { key: "EVT1" }, url: editUrl(), setHeaders },
      {},
    ).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("a refused database makes the load throw 503, never page data", async () => {
    vi.stubGlobal("__kitAdminEventEditDb", throwingDb(refused()));
    const setHeaders = vi.fn();
    const err = await load(
      { parent: async () => ({ actor }), params: { key: "EVT1" }, url: editUrl(), setHeaders },
      {},
    ).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("an ordinary database failure rethrows, never a 503", async () => {
    const failure = new Error("syntax error at end of input");
    vi.stubGlobal("__kitAdminEventEditDb", rejectingDb(failure));
    const err = await load(
      {
        parent: async () => ({ actor }),
        params: { key: "EVT1" },
        url: editUrl(),
        setHeaders: vi.fn(),
      },
      {},
    ).catch((e) => e);
    expect(err).toBe(failure);
  });

  it("a missing event answers 404 and sets no cache headers", async () => {
    vi.stubGlobal("__kitAdminEventEditDb", rowsDb([], [{ n: 0 }], []));
    const setHeaders = vi.fn();
    const err = await load(
      { parent: async () => ({ actor }), params: { key: "NOPE" }, url: editUrl(), setHeaders },
      {},
    ).catch((e) => e);
    expect(err?.status).toBe(404);
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("normalizes hostile roster query values before the store and the view", async () => {
    vi.stubGlobal("__kitAdminEventEditDb", rowsDb([eventRow()], [{ n: 0 }], []));
    const setHeaders = vi.fn();
    const data = await load(
      {
        parent: async () => ({ actor }),
        params: { key: "EVT1" },
        url: editUrl("?roster_q=%00++mod++&roster_sort=bogus&roster_page=Infinity"),
        setHeaders,
      },
      {},
    );
    expect(data.view.roster.query).toMatchObject({ q: "mod", sort: "answered", page: 1 });
    expect(data.view.roster.entries).toEqual([]);
    expect(data.view.roster.emptyText).toBe("No RSVPs match this member search.");
    expect(setHeaders).toHaveBeenCalledOnce();
  });

  it("duplicate roster params resolve first-wins, like the Hono handler", async () => {
    vi.stubGlobal("__kitAdminEventEditDb", rowsDb([eventRow()], [{ n: 0 }], []));
    const data = await load(
      {
        parent: async () => ({ actor }),
        params: { key: "EVT1" },
        url: editUrl("?roster_sort=status&roster_sort=answered&roster_page=2&roster_page=3"),
        setHeaders: vi.fn(),
      },
      {},
    );
    expect(data.view.roster.query).toMatchObject({ sort: "status", page: 2 });
  });

  it("shapes the stored row and roster page for the Svelte contract", async () => {
    vi.stubGlobal("__kitAdminEventEditDb", rowsDb([eventRow()], [{ n: 1 }], [rosterRow()]));
    const data = await load(
      {
        parent: async () => ({ actor }),
        params: { key: "EVT1" },
        url: editUrl(),
        setHeaders: vi.fn(),
      },
      {},
    );
    expect(data.view.values).toMatchObject({
      title: "Game night",
      starts_at: "2026-07-01 20:00",
      timezone: "Europe/London",
      capacity: "8",
    });
    expect(data.view.showPublish).toBe(true);
    expect(data.view.roster.total).toBe(1);
    expect(data.view.roster.entries).toEqual([
      { member: "mod", status: "going", answeredAt: "2026-06-01T12:00:00.000Z" },
    ]);
    for (const entry of data.view.roster.entries) {
      expect(entry).not.toHaveProperty("userId");
    }
  });
});
