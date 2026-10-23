// route-inventory: GET /e/:key
// route-inventory: GET /about
// route-inventory: GET /faq
// route-inventory: GET /rules
// route-inventory: GET /privacy
// route-inventory: GET /join
//
// Rich unfurl acceptance: every public leaf (event detail, the four content
// leaves, join) emits og:image + og:image:alt on BOTH renderers, pointing at
// ONE static brand asset via an absolute URL on the canonical host. The
// referenced file must live under public/ with image bytes and an image MIME
// mapping, and no Hono route may shadow its path (the platform serves
// public/ before the Worker runs, so file-on-disk plus no-shadow is the
// served proof). Event share copy stays pinned identical Hono vs Kit,
// gone/draft states keep emitting zero share tags, and anonymous vs member
// heads stay byte-identical with no member data.
//
// Shape: the og:image presence assertions are the RED half (they fail on
// unmodified main, where no shell emits og:image); the parity, absence and
// anonymity assertions are green pins proving the build changes nothing else.
// Local fixtures only: pg-proxy DB, memory sessions, SSR-compiled Kit pages,
// real public/ bytes. A throwing global fetch proves nothing reaches the
// network.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app, { FALLBACK_INVITE } from "./app";
import { aboutPageData } from "../src/about-content";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { PublicEvent } from "../src/events/reads";
import { faqPageData } from "../src/faq-content";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy";
import type { KitRequestSession } from "../src/kit-session";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { POLICY_VERSION, renderPolicyMarkdown } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { rulesPageData } from "../src/rules-content";
import { canonicalUrl } from "../src/seo";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
// Allowlisted synthetic fixture ULID only (see .gitleaks.toml).
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_PATH = `/e/${EVENT_KEY}`;
const MEMBER_ID = "100000000000000001";
// Distinctive session username: any leak of it into a <head> is member data
// in the share surface, and "headcanary" collides with no template literal.
const HEAD_CANARY = "headcanary";
const SITE_NAME = "Together We Own";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const leafEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
};

type EventRow = typeof events.$inferSelect;

function eventRow(over: Partial<EventRow> = {}): EventRow {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: EVENT_KEY,
    title: "Chess night",
    game: "Chess",
    // Plain ASCII on purpose: both serializers must agree byte-for-byte on
    // the extracted share values, so the parity pins use no escapable chars.
    description: "Bring a friend and a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

// Real Drizzle queries and Hono rendering; all data is local, no DB
// connection. One event row; the roster/count aggregates answer empty.
function eventHarness(over: Partial<EventRow> = {}, appUrl = APP_URL) {
  const row = eventRow(over);
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return sql.includes("count(*)") ? { rows: [] } : { rows: [] };
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) =>
            row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
          ),
        ],
      };
    }
    return { rows: [] };
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL: appUrl,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    env,
    async cookie(username = HEAD_CANARY, moderator = false): Promise<string> {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: MEMBER_ID,
        username,
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
      ).split(";")[0]!;
    },
    request(cookie?: string, path = EVENT_PATH) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

// ---------------------------------------------------------------------------
// Head extraction + share-contract assertions (both renderers, one grammar)
// ---------------------------------------------------------------------------

function headOf(html: string): string {
  const match = html.match(/<head>([\s\S]*?)<\/head>/);
  if (!match) throw new Error("no <head> block in render");
  return match[1]!;
}

function titleOf(html: string): string {
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]!);
  expect(titles, "exactly one <title>").toHaveLength(1);
  return titles[0]!;
}

// Attribute-order tolerant: Hono JSX and Svelte SSR serialize void elements
// differently, so match the tag by its property/name, then read content=.
function metaContents(html: string, attr: "property" | "name", key: string): string[] {
  const tags = html.match(new RegExp(`<meta\\s+[^>]*?${attr}="${key}"[^>]*?>`, "g")) ?? [];
  return tags.map((tag) => {
    const content = tag.match(/content="([^"]*)"/);
    if (!content) throw new Error(`share tag ${key} carries no content: ${tag}`);
    return content[1]!;
  });
}

function canonicals(html: string): string[] {
  const tags = html.match(/<link\s+[^>]*?rel="canonical"[^>]*?>/g) ?? [];
  return tags.map((tag) => {
    const href = tag.match(/href="([^"]*)"/);
    if (!href) throw new Error(`canonical link carries no href: ${tag}`);
    return href[1]!;
  });
}

type ShareCopy = {
  canonical: string | null;
  title: string;
  description: string | null;
  robots: string | null;
  image: string | null;
  imageAlt: string | null;
};

function shareCopyOf(html: string): ShareCopy {
  const canonical = canonicals(html);
  const titles = metaContents(html, "property", "og:title");
  const descriptions = metaContents(html, "property", "og:description");
  const robots = metaContents(html, "name", "robots");
  const images = metaContents(html, "property", "og:image");
  const alts = metaContents(html, "property", "og:image:alt");
  expect(canonical.length, "at most one canonical").toBeLessThanOrEqual(1);
  expect(titles.length, "at most one og:title").toBeLessThanOrEqual(1);
  expect(descriptions.length, "at most one og:description").toBeLessThanOrEqual(1);
  expect(robots.length, "at most one robots meta").toBeLessThanOrEqual(1);
  expect(images.length, "at most one og:image").toBeLessThanOrEqual(1);
  expect(alts.length, "at most one og:image:alt").toBeLessThanOrEqual(1);
  return {
    canonical: canonical[0] ?? null,
    title: titles[0] ?? "",
    description: descriptions[0] ?? null,
    robots: robots[0] ?? null,
    image: images[0] ?? null,
    imageAlt: alts[0] ?? null,
  };
}

// The full rich-unfurl contract for one shareable page: the pre-existing tag
// set stays intact and exactly one og:image + og:image:alt joins it.
// description=null pins the content leaves, whose shell passes no share
// description (og:description and twitter:description stay absent there).
// Returns the og:image URL for the single-asset + served proofs.
function expectRichUnfurl(
  html: string,
  expected: { canonical: string; description: string | null; page: string },
): string {
  const { canonical, description, page } = expected;
  const title = titleOf(html);
  expect(canonicals(html), `${page}: one self canonical`).toEqual([canonical]);
  expect(metaContents(html, "property", "og:url"), `${page}: og:url`).toEqual([canonical]);
  expect(metaContents(html, "property", "og:title"), `${page}: og:title`).toEqual([title]);
  expect(metaContents(html, "property", "og:type"), `${page}: og:type`).toEqual(["website"]);
  expect(metaContents(html, "property", "og:site_name"), `${page}: og:site_name`).toEqual([
    SITE_NAME,
  ]);
  expect(metaContents(html, "property", "og:description"), `${page}: og:description`).toEqual(
    description === null ? [] : [description],
  );
  expect(metaContents(html, "name", "twitter:card"), `${page}: twitter:card`).toHaveLength(1);
  expect(metaContents(html, "name", "twitter:title"), `${page}: twitter:title`).toEqual([title]);
  expect(metaContents(html, "name", "twitter:description"), `${page}: twitter:description`).toEqual(
    description === null ? [] : [description],
  );
  const images = metaContents(html, "property", "og:image");
  expect(images, `${page}: exactly one og:image`).toHaveLength(1);
  const alts = metaContents(html, "property", "og:image:alt");
  expect(alts, `${page}: exactly one og:image:alt`).toHaveLength(1);
  expect(alts[0], `${page}: brand alt names the community`).toContain(SITE_NAME);
  expect(alts[0], `${page}: alt is text, not a URL`).not.toContain("http");
  return images[0]!;
}

function expectNoShareTags(html: string, where: string) {
  expect(canonicals(html), `${where}: no canonical`).toEqual([]);
  expect(metaContents(html, "property", "og:title"), `${where}: no og:title`).toEqual([]);
  expect(html, `${where}: no og: tags`).not.toContain("og:");
  expect(html, `${where}: no twitter: tags`).not.toContain("twitter:");
  expect(html, `${where}: no og:image`).not.toContain("og:image");
}

// The served proof for the one brand asset: absolute https URL on the
// canonical host, clean path (no query/fragment/double slash, so every
// crawler unfurls the same bytes), an approved brand file that exists under
// public/ with matching image magic, an image MIME mapping, no Hono route
// shadowing the path, and byte-identical passthrough through the Worker
// ASSETS branch.
async function expectBrandAssetServed(imageUrl: string, canonical: string) {
  const image = new URL(imageUrl);
  const canon = new URL(canonical);
  expect(image.protocol, "og:image is absolute https").toBe("https:");
  expect(image.host, "og:image lives on the canonical host").toBe(canon.host);
  expect(image.search, "og:image carries no query").toBe("");
  expect(image.hash, "og:image carries no fragment").toBe("");
  expect(image.pathname.startsWith("//"), "og:image has no double slash").toBe(false);
  const approved =
    image.pathname === "/logo.svg" ||
    (image.pathname.startsWith("/icons/") && image.pathname.endsWith(".png"));
  expect(approved, `og:image reuses an approved brand file, got ${image.pathname}`).toBe(true);
  const diskPath = join(root, "public", image.pathname);
  expect(existsSync(diskPath), `og:image exists under public/: ${image.pathname}`).toBe(true);
  const bytes = readFileSync(diskPath);
  const mime =
    image.pathname.endsWith(".png") && isPng(bytes)
      ? "image/png"
      : image.pathname.endsWith(".svg") && bytes.includes("<svg")
        ? "image/svg+xml"
        : null;
  expect(mime, `${image.pathname} has image magic bytes`).not.toBeNull();
  // No Hono route claims the path: without an ASSETS binding the Worker
  // answers its branded 404, so in production the platform static file wins.
  const shadowed = await app.request(image.pathname, {}, leafEnv);
  expect(shadowed.status, `${image.pathname} is static-served, not routed`).toBe(404);
  // Through the ASSETS branch the Worker passes the bytes + image type along.
  const env = {
    ...leafEnv,
    ASSETS: {
      fetch: async () =>
        new Response(bytes, {
          headers: { "content-type": mime! },
        }),
    },
  };
  const res = await app.request(`${APP_URL}${image.pathname}`, {}, env as unknown as Env);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(mime);
  expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

// ---------------------------------------------------------------------------
// Kit harness: the real Svelte pages, SSR-compiled with the web workspace's
// own svelte/compiler and bundled by esbuild (same shape as the per-route
// parity suites, one bundle for all six leaves plus the gone/403 surfaces).
// ---------------------------------------------------------------------------

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type KitBundle = {
  renderAbout: (data: Record<string, unknown>) => string;
  renderFaq: (data: Record<string, unknown>) => string;
  renderRules: (data: Record<string, unknown>) => string;
  renderPrivacy: (data: Record<string, unknown>) => string;
  renderJoin: (data: Record<string, unknown>) => string;
  renderDetail: (model: Record<string, unknown>) => string;
  renderGone: (model: Record<string, unknown>) => string;
  renderForbidden: (code: number, inviteUrl: string) => string;
};

async function buildKitUnfurlBundle(): Promise<KitBundle> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-unfurl-"));
  try {
    const entry = join(scratch, "kit-unfurl-entry.mjs");
    const page = (route: string) =>
      JSON.stringify(join(worktree, `web/src/routes/${route}/+page.svelte`));
    const lib = (name: string) => JSON.stringify(join(worktree, `web/src/lib/${name}.svelte`));
    const doc = (render: string, component: string, props: string) =>
      `export function ${render}(input) {\n` +
      `  const { head, body } = render(${component}, { props: ${props} });\n` +
      `  return "<head>" + head + "</head><body>" + body + "</body>";\n}\n`;
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import About from ${page("about")};
import Faq from ${page("faq")};
import Rules from ${page("rules")};
import Privacy from ${page("privacy")};
import Join from ${page("join")};
import Detail from ${lib("EventDetail")};
import Gone from ${lib("EventGone")};
import Forbidden from ${lib("ErrorShell")};
${doc("renderAbout", "About", "{ data: input }")}
${doc("renderFaq", "Faq", "{ data: input }")}
${doc("renderRules", "Rules", "{ data: input }")}
${doc("renderPrivacy", "Privacy", "{ data: input }")}
${doc("renderJoin", "Join", "{ data: input }")}
${doc("renderDetail", "Detail", "{ model: input }")}
${doc("renderGone", "Gone", "{ model: input }")}
export function renderForbidden(code, inviteUrl) {
  const { head, body } = render(Forbidden, { props: { code, inviteUrl } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-unfurl.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-unfurl-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    return (await import(pathToFileURL(outfile).href)) as KitBundle;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// One bundle build per file: every Kit suite shares this lazy build, so the
// eight Svelte components compile once no matter how many describes use them.
let sharedKitBuild: Promise<KitBundle> | null = null;
function sharedKitBundle(): Promise<KitBundle> {
  sharedKitBuild ??= buildKitUnfurlBundle();
  return sharedKitBuild;
}

function kitLeafData(): Record<string, Record<string, unknown>> {
  return {
    about: { ...aboutPageData(APP_URL), leafCss: LEAF_CRITICAL_CSS },
    faq: { ...faqPageData(APP_URL), leafCss: LEAF_CRITICAL_CSS },
    rules: { ...rulesPageData(APP_URL, undefined), leafCss: LEAF_CRITICAL_CSS },
    privacy: {
      html: renderPolicyMarkdown(POLICY_MARKDOWN),
      version: POLICY_VERSION,
      appUrl: APP_URL,
      leafCss: LEAF_CRITICAL_CSS,
    },
    // Static join view: no presence snapshot, no widget URL (the page renders
    // its fallback copy), no flash. Mirrors the Kit load's return shape.
    join: {
      inviteUrl: "https://discord.gg/configured",
      joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
      widgetUrl: null,
      widgetSnapshot: null,
      oneClickHref: "/join/discord",
      appUrl: APP_URL,
      joinResult: null,
    },
  };
}

// Hermetic Kit event store: the same seams the Kit load binds, backed by the
// one fixture row. Published by default; override per case.
function kitStore(over: Partial<{ event: PublicEvent | null }> = {}): KitEventDetailStore {
  const event = { ...eventRow(), goingCount: 3 } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => (over.event === undefined ? event : over.event),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [
      { id: "100000000000000003", name: "ann" },
      { id: "100000000000000004", name: "bob" },
    ],
    viewerRsvpFn: async () => ({ status: "going", syncedToDiscordAt: null }),
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

const GUEST: KitRequestSession = { status: "guest", session: null };
const kitMember = (): KitRequestSession => ({
  status: "authenticated",
  session: {
    userId: MEMBER_ID,
    username: HEAD_CANARY,
    avatar: null,
    member: true,
    moderator: false,
  },
});
const kitMod = (): KitRequestSession => ({
  status: "authenticated",
  session: {
    userId: "100000000000000002",
    username: "modcanary",
    avatar: null,
    member: true,
    moderator: true,
  },
});

async function kitEventModel(
  store: KitEventDetailStore,
  session: KitRequestSession = GUEST,
): Promise<Record<string, unknown>> {
  const outcome = await resolveKitEventDetail({
    key: EVENT_KEY,
    search: "",
    path: EVENT_PATH,
    env: { APP_URL } as unknown as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.model as unknown as Record<string, unknown>;
}

async function kitGoneModel(): Promise<Record<string, unknown>> {
  const outcome = await resolveKitEventDetail({
    key: EVENT_KEY,
    search: "",
    path: EVENT_PATH,
    env: { APP_URL } as unknown as Env,
    session: GUEST,
    joinResult: null,
    setHeaders: () => {},
    store: kitStore({
      event: { ...eventRow({ status: "cancelled" }), goingCount: 3 } as PublicEvent,
    }),
  });
  if (outcome.kind !== "gone") throw new Error(`expected gone, got ${outcome.kind}`);
  return outcome.model as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unfurl tests must remain local");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Hono: every public leaf emits the brand unfurl image
// ---------------------------------------------------------------------------

describe("Hono leaves emit the brand unfurl image", () => {
  const EVENT_CANONICAL = canonicalUrl(APP_URL, EVENT_PATH);

  it("tags the published event detail", async () => {
    const res = await eventHarness().request();
    expect(res.status).toBe(200);
    expectRichUnfurl(await res.text(), {
      canonical: EVENT_CANONICAL,
      description: "Bring a friend and a board.",
      page: "Hono event detail",
    });
  });

  it.each([
    ["/about", null],
    ["/faq", null],
    ["/rules", null],
    ["/privacy", null],
    ["/join", JOIN_INTRO],
  ] as const)("%s carries the brand image", async (path, description) => {
    const res = await app.request(path, {}, leafEnv);
    expect(res.status).toBe(200);
    expectRichUnfurl(await res.text(), {
      canonical: canonicalUrl(APP_URL, path),
      description,
      page: `Hono ${path}`,
    });
  });
});

describe("Hono unfurl URLs stay absolute on the canonical host", () => {
  it("emits no double-slash image URL when APP_URL carries a trailing slash", async () => {
    const slashed = `${APP_URL}/`;
    const leaf = await (await app.request("/about", {}, { ...leafEnv, APP_URL: slashed })).text();
    const leafImage = expectRichUnfurl(leaf, {
      canonical: `${APP_URL}/about`,
      description: null,
      page: "Hono /about (slashed APP_URL)",
    });
    expect(leafImage.startsWith(`${APP_URL}/`), "leaf image is absolute on the host").toBe(true);
    expect(leafImage, "leaf image has no double slash").not.toContain("//icons/");
    expect(leafImage, "leaf image has no double slash").not.toContain("//logo");
    const event = await (await eventHarness({}, slashed).request()).text();
    const eventImage = expectRichUnfurl(event, {
      canonical: `${APP_URL}${EVENT_PATH}`,
      description: "Bring a friend and a board.",
      page: "Hono event detail (slashed APP_URL)",
    });
    expect(eventImage.startsWith(`${APP_URL}/`), "event image is absolute on the host").toBe(true);
    expect(eventImage, "event image has no double slash").not.toContain("//icons/");
  });
});

// ---------------------------------------------------------------------------
// Kit: the same leaves, the same one brand asset
// ---------------------------------------------------------------------------

describe("Kit leaves emit the same brand unfurl image", () => {
  let kit: KitBundle;
  let data: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    kit = await sharedKitBundle();
    data = kitLeafData();
  }, 60_000);

  it.each([
    ["about", "/about", null],
    ["faq", "/faq", null],
    ["rules", "/rules", null],
    ["privacy", "/privacy", null],
  ] as const)("%s carries the brand image", async (leaf, path, description) => {
    const render = {
      about: kit.renderAbout,
      faq: kit.renderFaq,
      rules: kit.renderRules,
      privacy: kit.renderPrivacy,
    }[leaf]!;
    expectRichUnfurl(render(data[leaf]!), {
      canonical: canonicalUrl(APP_URL, path),
      description,
      page: `Kit ${path}`,
    });
  });

  it("join carries the brand image with the funnel intro", async () => {
    expectRichUnfurl(kit.renderJoin(data.join!), {
      canonical: canonicalUrl(APP_URL, "/join"),
      description: JOIN_INTRO,
      page: "Kit /join",
    });
  });

  it("event detail carries the brand image", async () => {
    const html = kit.renderDetail(await kitEventModel(kitStore()));
    expectRichUnfurl(html, {
      canonical: canonicalUrl(APP_URL, EVENT_PATH),
      description: "Bring a friend and a board.",
      page: "Kit event detail",
    });
  });
});

describe("one static brand asset across every leaf and renderer", () => {
  let kit: KitBundle;
  let data: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    kit = await sharedKitBundle();
    data = kitLeafData();
  }, 60_000);

  it("all twelve renders point at a single served image URL", async () => {
    const honoPages: Array<[string, string, string | null]> = [
      [EVENT_PATH, canonicalUrl(APP_URL, EVENT_PATH), "Bring a friend and a board."],
      ["/about", canonicalUrl(APP_URL, "/about"), null],
      ["/faq", canonicalUrl(APP_URL, "/faq"), null],
      ["/rules", canonicalUrl(APP_URL, "/rules"), null],
      ["/privacy", canonicalUrl(APP_URL, "/privacy"), null],
      ["/join", canonicalUrl(APP_URL, "/join"), JOIN_INTRO],
    ];
    const images = new Set<string>();
    for (const [path, canonical, description] of honoPages) {
      const html =
        path === EVENT_PATH
          ? await (await eventHarness().request()).text()
          : await (await app.request(path, {}, leafEnv)).text();
      images.add(expectRichUnfurl(html, { canonical, description, page: `Hono ${path}` }));
    }
    const kitPages: Array<[string, string, string | null]> = [
      [
        kit.renderDetail(await kitEventModel(kitStore())),
        canonicalUrl(APP_URL, EVENT_PATH),
        "Bring a friend and a board.",
      ],
      [kit.renderAbout(data.about!), canonicalUrl(APP_URL, "/about"), null],
      [kit.renderFaq(data.faq!), canonicalUrl(APP_URL, "/faq"), null],
      [kit.renderRules(data.rules!), canonicalUrl(APP_URL, "/rules"), null],
      [kit.renderPrivacy(data.privacy!), canonicalUrl(APP_URL, "/privacy"), null],
      [kit.renderJoin(data.join!), canonicalUrl(APP_URL, "/join"), JOIN_INTRO],
    ];
    for (const [html, canonical, description] of kitPages) {
      images.add(expectRichUnfurl(html, { canonical, description, page: "Kit leaf" }));
    }
    expect([...images], "one static brand asset, not per-page art").toHaveLength(1);
    await expectBrandAssetServed([...images][0]!, canonicalUrl(APP_URL, "/about"));
  });
});

// ---------------------------------------------------------------------------
// Parity + absence + anonymity guards (green before and after the build)
// ---------------------------------------------------------------------------

describe("event share copy is identical Hono vs Kit", () => {
  let kit: KitBundle;

  beforeAll(async () => {
    kit = await sharedKitBundle();
  }, 60_000);

  it("published event: canonical, title, description, robots and image match", async () => {
    const honoHtml = await (await eventHarness().request()).text();
    const kitHtml = kit.renderDetail(await kitEventModel(kitStore()));
    expect(shareCopyOf(kitHtml)).toEqual(shareCopyOf(honoHtml));
    expect(shareCopyOf(honoHtml)).toMatchObject({
      canonical: canonicalUrl(APP_URL, EVENT_PATH),
      title: "Chess night — Together We Own",
      description: "Bring a friend and a board.",
      robots: null,
    });
  });

  it("moderator draft: noindex on both, share values identical", async () => {
    const source = eventHarness({ status: "draft" });
    const honoRes = await source.request(await source.cookie(HEAD_CANARY, true));
    expect(honoRes.status).toBe(200);
    const honoCopy = shareCopyOf(await honoRes.text());
    expect(honoCopy.robots).toBe("noindex, nofollow");
    const kitHtml = kit.renderDetail(
      await kitEventModel(
        kitStore({ event: { ...eventRow({ status: "draft" }), goingCount: 0 } as PublicEvent }),
        kitMod(),
      ),
    );
    expect(kitHtml).toContain('data-testid="event-draft"');
    expect(shareCopyOf(kitHtml)).toEqual(honoCopy);
  });
});

describe("gone and draft states emit no share tags", () => {
  let kit: KitBundle;

  beforeAll(async () => {
    kit = await sharedKitBundle();
  }, 60_000);

  it("Hono answers cancelled 410 with no share tags", async () => {
    const res = await eventHarness({ status: "cancelled" }).request();
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('data-testid="event-cancelled"');
    expectNoShareTags(html, "Hono 410");
    expect(metaContents(html, "name", "robots")).toEqual(["noindex, nofollow"]);
  });

  it("Kit EventGone renders no share tags", async () => {
    const html = kit.renderGone(await kitGoneModel());
    expect(html).toContain('data-testid="event-cancelled"');
    expectNoShareTags(html, "Kit gone");
    expect(metaContents(html, "name", "robots")).toEqual(["noindex, nofollow"]);
  });

  it("Hono refuses drafts 403 to guests and members with no share tags", async () => {
    const source = eventHarness({ status: "draft" });
    for (const cookie of [undefined, await source.cookie()]) {
      const res = await source.request(cookie);
      expect(res.status).toBe(403);
      expectNoShareTags(await res.text(), "Hono draft 403");
    }
  });

  it("Kit gates drafts forbidden and its 403 shell emits no share tags", async () => {
    const draft = kitStore({
      event: { ...eventRow({ status: "draft" }), goingCount: 0 } as PublicEvent,
    });
    for (const session of [GUEST, kitMember()]) {
      const outcome = await resolveKitEventDetail({
        key: EVENT_KEY,
        search: "",
        path: EVENT_PATH,
        env: { APP_URL } as unknown as Env,
        session,
        joinResult: null,
        setHeaders: () => {},
        store: draft,
      });
      expect(outcome.kind).toBe("forbidden");
    }
    // The route error wrapper only adds a robots meta for non-branded states
    // (pinned at source: no canonical/og/twitter may join it), so rendering
    // the shared 403 shell directly covers the served 403 surface.
    const wrapper = readFileSync(
      new URL("../web/src/routes/e/[key]/+error.svelte", import.meta.url),
      "utf8",
    );
    const wrapperHead = wrapper.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? "";
    expect(wrapperHead).toContain('name="robots"');
    expect(wrapperHead).not.toContain("canonical");
    expect(wrapperHead).not.toContain("og:");
    expect(wrapperHead).not.toContain("twitter:");
    const html = kit.renderForbidden(403, FALLBACK_INVITE);
    expectNoShareTags(html, "Kit 403");
    expect(metaContents(html, "name", "robots")).toEqual(["noindex, nofollow"]);
  });
});

describe("anonymous and member heads are identical", () => {
  let kit: KitBundle;

  beforeAll(async () => {
    kit = await sharedKitBundle();
  }, 60_000);

  it("Hono event detail: same head for guest and member, no member data", async () => {
    const source = eventHarness();
    const guestHtml = await (await source.request()).text();
    const memberHtml = await (await source.request(await source.cookie())).text();
    // The sessions really differ (proves the head comparison is not vacuous).
    expect(guestHtml).toContain('data-testid="event-join-pitch"');
    expect(memberHtml).not.toContain('data-testid="event-join-pitch"');
    expect(memberHtml).toContain(HEAD_CANARY);
    const guestHead = headOf(guestHtml);
    expect(headOf(memberHtml), "member head is byte-identical to the guest head").toBe(guestHead);
    expect(guestHead, "guest head carries no member data").not.toContain(HEAD_CANARY);
  });

  it("Kit event detail: same head for guest and member, no attendee data", async () => {
    const guestHtml = kit.renderDetail(await kitEventModel(kitStore(), GUEST));
    const memberHtml = kit.renderDetail(await kitEventModel(kitStore(), kitMember()));
    expect(guestHtml).toContain('data-testid="event-join-pitch"');
    expect(memberHtml).not.toContain('data-testid="event-join-pitch"');
    expect(memberHtml).toContain(">ann<");
    const guestHead = headOf(guestHtml);
    expect(headOf(memberHtml), "member head is byte-identical to the guest head").toBe(guestHead);
    for (const leak of [HEAD_CANARY, ">ann<", ">bob<", "100000000000000003"]) {
      expect(guestHead, `guest head leaks no member data (${leak})`).not.toContain(leak);
    }
  });
});
