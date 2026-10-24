// Kit admin events-list load wiring: the no-db/outage-to-503 decisions in
// web/src/routes/admin/events/+page.server.ts are behavioural, not source
// text. buildEventListView is unit-tested; this drives the real load with a
// fake Db so an inverted outage check or a dropped normalization fails here
// instead of shipping a 500/503 swap or an unfiltered query silently.
//
// The root Vitest config does not run SvelteKit's sync hook, so Vite/OXC cannot
// resolve the route's generated `$app/tsconfig`. Bundle the real route with
// esbuild instead, stubbing only its framework and database-binding imports.
import { build } from "esbuild";
import { PgDialect } from "drizzle-orm/pg-core";
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
  ["admin-db", "export async function dbFor() { return globalThis.__kitAdminEventsDb; }"],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/admin/events/+page.server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-admin-events-load-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-admin-events-load-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-admin-events-load-test",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-admin-events-load-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "kit-admin-events-load-test" }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
          }));
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
const parent = async () => ({ actor });

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

// Inventory reads install transaction-local timeouts before their SELECTs.
function inventoryDb(db) {
  const tx = { ...db, select: vi.fn(db.select), execute: vi.fn(async () => []) };
  return { ...db, tx, transaction: vi.fn(async (fn) => fn(tx)) };
}

/** Drizzle builders are lazy thenables: one chain per select, queued results. */
function rowsDb(eventRows, countRows = []) {
  let outstanding = [eventRows, countRows];
  const queries = [];
  return inventoryDb({
    queries,
    select: () => {
      const query = {};
      queries.push(query);
      const chain = {};
      for (const method of ["from", "where", "orderBy", "limit", "offset", "groupBy"]) {
        chain[method] = (...args) => {
          (query[method] ??= []).push(args);
          return chain;
        };
      }
      chain.then = (resolve, reject) =>
        Promise.resolve(outstanding.length > 1 ? outstanding.shift() : outstanding[0]).then(
          resolve,
          reject,
        );
      return chain;
    },
  });
}

function throwingDb(err) {
  return inventoryDb({
    select: () => {
      throw err;
    },
  });
}

function rejectingDb(err) {
  const chain = {};
  for (const m of ["from", "where", "orderBy", "limit", "offset", "groupBy"]) {
    chain[m] = () => chain;
  }
  chain.then = (_resolve, reject) => Promise.resolve().then(() => reject(err));
  return inventoryDb({ select: () => chain });
}

const eventRow = (i) => ({
  id: i,
  eventKey: `EVT${i}`,
  title: `Game night ${i}`,
  status: "published",
  startsAt: new Date("2026-11-01T18:00:00.000Z"),
  endsAt: new Date("2026-11-01T21:00:00.000Z"),
  capacity: 8,
  rsvpOpen: true,
});

describe("Kit admin events-list load: guard and failure wiring", () => {
  it("no database answers 503 and sets no cache headers", async () => {
    const setHeaders = vi.fn();
    const err = await load(
      { parent, url: new URL("https://next.example.test/admin/events"), setHeaders },
      {},
    ).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("a refused database makes the load throw 503, never page data", async () => {
    vi.stubGlobal("__kitAdminEventsDb", throwingDb(refused()));
    const setHeaders = vi.fn();
    const err = await load(
      { parent, url: new URL("https://next.example.test/admin/events"), setHeaders },
      {},
    ).catch((e) => e);
    expect(err?.status).toBe(503);
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("an ordinary database failure rethrows, never a 503", async () => {
    const failure = new Error("syntax error at end of input");
    vi.stubGlobal("__kitAdminEventsDb", rejectingDb(failure));
    const err = await load(
      { parent, url: new URL("https://next.example.test/admin/events"), setHeaders: vi.fn() },
      {},
    ).catch((e) => e);
    expect(err).toBe(failure);
  });

  it("invalid query values normalize before the store and the view", async () => {
    vi.stubGlobal("__kitAdminEventsDb", rowsDb([]));
    const setHeaders = vi.fn();
    const data = await load(
      {
        parent,
        url: new URL(
          "https://next.example.test/admin/events?q=%00++Games++&status=bogus&sort=title%3B+DROP+TABLE+events--&page=Infinity",
        ),
        setHeaders,
      },
      {},
    );
    expect(data.query).toMatchObject({ q: "Games", status: "", sort: "starts_at", page: 1 });
    expect(data.rows).toEqual([]);
    expect(data.hasNext).toBe(false);
    expect(data.emptyText).toBe("No events match these filters.");
    expect(data).not.toHaveProperty("sectionTitle");
    expect(setHeaders).toHaveBeenCalledOnce();
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("duplicate query params resolve first-wins, like the Hono handler", async () => {
    vi.stubGlobal("__kitAdminEventsDb", rowsDb([]));
    const data = await load(
      {
        parent,
        url: new URL(
          "https://next.example.test/admin/events?status=draft&status=past&page=2&page=3",
        ),
        setHeaders: vi.fn(),
      },
      {},
    );
    expect(data.query).toMatchObject({ status: "draft", page: 2 });
    expect(data.rows).toEqual([]);
  });

  it("passes filters to a bounded, stably ordered reader and slices its lookahead", async () => {
    const events = Array.from({ length: 26 }, (_, i) => eventRow(i + 1));
    const db = rowsDb(events, [{ eventId: 1, n: "4" }]);
    vi.stubGlobal("__kitAdminEventsDb", db);
    const data = await load(
      {
        parent,
        url: new URL(
          "https://next.example.test/admin/events?q=Games&status=published&sort=title&order=asc&page=2",
        ),
        setHeaders: vi.fn(),
      },
      {},
    );

    expect(data.query).toMatchObject({
      q: "Games",
      status: "published",
      sort: "title",
      order: "asc",
      page: 2,
    });
    expect(data.rows).toHaveLength(25);
    expect(data.rows[0]).toMatchObject({
      eventKey: "EVT1",
      startsAt: "2026-11-01T18:00:00.000Z",
      endsAt: "2026-11-01T21:00:00.000Z",
    });
    expect(data.rows[0].goingCount).toBe(4);
    expect(data.hasNext).toBe(true);

    const [eventsRead, goingRead] = db.queries;
    const dialect = new PgDialect();
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.tx.execute).toHaveBeenCalledOnce();
    expect(dialect.sqlToQuery(db.tx.execute.mock.calls[0][0])).toMatchObject({
      sql: "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
      params: ["2000ms", "2000ms"],
    });
    expect(db.tx.select).toHaveBeenCalledTimes(2);
    expect(db.tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      db.tx.select.mock.invocationCallOrder[0],
    );
    const predicate = dialect.sqlToQuery(eventsRead.where[0][0]);
    expect(predicate.sql).toContain('"events"."title" ilike');
    expect(predicate.sql).toContain('"events"."game" ilike');
    expect(predicate.sql).toContain('"events"."status" =');
    // Title and game arms bind the same escaped literal, then the status arm.
    expect(predicate.params).toEqual(["%Games%", "%Games%", "published"]);
    const goingPredicate = dialect.sqlToQuery(goingRead.where[0][0]);
    expect(goingPredicate.sql).toContain('"rsvps"."event_id" in');
    expect(goingPredicate.sql).toContain('"rsvps"."status" =');
    expect(goingPredicate.params).toEqual([
      ...Array.from({ length: 26 }, (_, i) => i + 1),
      "going",
    ]);
    const ordering = eventsRead.orderBy[0].map(
      (expression) => dialect.sqlToQuery(expression.getSQL?.() ?? expression).sql,
    );
    expect(ordering[0]).toContain('"events"."title" asc');
    expect(ordering[1]).toBe('"events"."id" asc');
    expect(eventsRead.limit).toEqual([[26]]);
    expect(eventsRead.offset).toEqual([[25]]);
  });
});
