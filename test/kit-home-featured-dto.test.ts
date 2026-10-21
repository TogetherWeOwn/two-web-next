// Kit home featured DTO pins: the cached load serves exactly the six
// VisibleFeatured display fields with the live window evaluated at the load
// instant — no scheduling bounds leak into the serialized load data.
//
// Builder-owned companion to the guest-cache acceptance suite (which this card
// must not edit): these pins answer the Paperclip Review findings on the
// cached move with a projection-aware fake. The fake distinguishes the direct
// six-column visible read from the eight-column published-base read by
// inspecting the SELECT list before `from "featured_contents"` (both queries
// mention starts_at — the visible one only in WHERE), returns the unfiltered
// published base for the base leg, and window-filters only the direct leg.
// A fake that prefilters the base or truncates it to six columns makes the
// window pin vacuous: the epoch mutant below would stay green.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listVisibleFeatured } from "../src/featured";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routePath = join(root, "web/src/routes/+page.server.ts");
const homeCachePath = join(root, "src/home-cache.ts");

const ENV_KEY = "__kitHomeFeaturedDtoEnv";

type KitHomeLoadArgs = {
  url: URL;
  request: Request;
  locals: { status?: string; session?: unknown; joinResult?: unknown };
  cookies: { delete: (name: string, options: Record<string, unknown>) => void };
  setHeaders: (headers: Record<string, string>) => void;
};

type KitHomeLoadData = {
  upcomingEvents: Array<{ title: string } & Record<string, unknown>>;
  eventsUnavailable: boolean;
  featured: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type KitHomeLoad = (args: KitHomeLoadArgs) => Promise<KitHomeLoadData>;

let load: KitHomeLoad;
let resetHomeGuestCache: () => void;
let scratch = "";

function setSharedEnv(next: Env): void {
  const current = (globalThis as Record<string, unknown>)[ENV_KEY] as Record<string, unknown>;
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, next);
}

beforeAll(async () => {
  // Same bundle harness as the guest-cache acceptance suite: the real route
  // load plus the real shared cache module, only the Worker env stubbed.
  (globalThis as Record<string, unknown>)[ENV_KEY] = {};
  scratch = mkdtempSync(join(tmpdir(), "kit-home-featured-dto-"));
  const outfile = join(scratch, "kit-home-load-bundle.mjs");
  await build({
    stdin: {
      contents: [
        `export { load } from ${JSON.stringify(routePath)};`,
        `export { __resetHomeGuestCacheForTests as resetHomeGuestCache } from ${JSON.stringify(homeCachePath)};`,
        ``,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    plugins: [
      {
        name: "kit-home-featured-dto-env",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "kit-home-featured-dto-env",
            namespace: "kit-home-featured-dto",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "kit-home-featured-dto" }, () => ({
            contents: `export const env = globalThis[${JSON.stringify(ENV_KEY)}];`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    load: KitHomeLoad;
    resetHomeGuestCache: () => void;
  };
  load = mod.load;
  resetHomeGuestCache = mod.resetHomeGuestCache;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[ENV_KEY];
});

afterEach(() => {
  resetHomeGuestCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const DISPLAY_KEYS = ["body", "id", "imageAlt", "imageUrl", "title", "url"];

// Positional projection: id, title, body, url, imageUrl, imageAlt, startsAt,
// endsAt. Bounds are ISO instants (or null); ISO strings compare
// lexicographically, like the acceptance fake.
function featuredRow(id: number, title: string, startsAt: string | null, endsAt: string | null) {
  return [id, title, `Featured body ${id}`, null, null, null, startsAt, endsAt];
}

function fixture(featuredRows: unknown[][]) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const eventStartsAt = new Date(Date.now() + 3600_000);
  const event = {
    id: 1,
    title: "Game night 1",
    startsAt: eventStartsAt,
    endsAt: new Date(eventStartsAt.getTime() + 7200_000),
  };
  const db = drizzle(async (sql: string) => {
    if (sql.includes('from "featured_contents"')) {
      // SELECT-list inspection: the published-base read selects starts_at /
      // ends_at, the direct visible read only filters on them in WHERE.
      const selectList = sql.slice(0, sql.indexOf('from "featured_contents"'));
      const isBaseRead = selectList.includes('"starts_at"');
      if (isBaseRead) return { rows: featuredRows };
      const nowIso = new Date().toISOString();
      return {
        rows: featuredRows
          .filter((row) => {
            const startsAt = row[6] as string | null;
            const endsAt = row[7] as string | null;
            return (
              (startsAt === null || startsAt <= nowIso) && (endsAt === null || endsAt > nowIso)
            );
          })
          .map((row) => row.slice(0, 6)),
      };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('from "events"')) {
      return {
        rows: [
          columns.map((key) => {
            const value =
              (event as Record<string, unknown>)[key] ?? (key === "status" ? "published" : null);
            return value instanceof Date ? value.toISOString() : value;
          }),
        ],
      };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const discord = {
    upcoming: async () => [],
    lastReadFailed: () => false,
  };
  const env = { ...baseEnv, ADMIN_DB: db, DISCORD_EVENTS: discord } as Env;
  return { db, env, use: () => setSharedEnv(env) };
}

function loadArgs(): KitHomeLoadArgs {
  const url = new URL("https://example.test/");
  return {
    url,
    request: new Request(url, { method: "GET" }),
    locals: { status: "guest" },
    cookies: { delete: () => {} },
    setHeaders: () => {},
  };
}

describe("Kit home featured DTO: cached shape matches the direct reader", () => {
  it("serves exactly the six VisibleFeatured fields, equal to listVisibleFeatured", async () => {
    const day = 86_400_000;
    const now = Date.now();
    // Non-null bounds on a live row: the projection must strip them, not just
    // pass nulls through.
    const bounded = featuredRow(
      1,
      "Bounded slot",
      new Date(now - day).toISOString(),
      new Date(now + day).toISOString(),
    );
    const always = featuredRow(2, "Always visible", null, null);
    const f = fixture([bounded, always]);
    f.use();

    const data = await load(loadArgs());
    expect(data.featured.map((row) => row.title)).toEqual(["Bounded slot", "Always visible"]);
    for (const row of data.featured) {
      expect(Object.keys(row).sort()).toEqual(DISPLAY_KEYS);
    }
    // The serialized load data is what SvelteKit serves at __data.json even
    // with csr=false: bounds must not survive serialization.
    expect(JSON.stringify(data.featured)).not.toContain("startsAt");
    expect(JSON.stringify(data.featured)).not.toContain("endsAt");
    // Exact equality with the direct reader on the same database.
    const direct = await listVisibleFeatured(f.db);
    expect(data.featured).toEqual(direct);
  });

  it("excludes scheduled and expired rows at the load instant", async () => {
    const day = 86_400_000;
    const now = Date.now();
    const visible = featuredRow(1, "Always visible", null, null);
    const scheduled = featuredRow(2, "Scheduled slot", new Date(now + day).toISOString(), null);
    const expired = featuredRow(3, "Expired slot", null, new Date(now - day).toISOString());
    const f = fixture([visible, scheduled, expired]);
    f.use();

    const data = await load(loadArgs());
    // Kills the new Date(0) mutant: at epoch the expired row (endsAt in 2026+)
    // would still be live and surface here.
    expect(data.featured.map((row) => row.title)).toEqual(["Always visible"]);
    const direct = await listVisibleFeatured(f.db);
    expect(data.featured.map((row) => row.title)).toEqual(
      direct.map((row) => (row as { title: string }).title),
    );
  });
});
