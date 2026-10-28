// Acceptance-owned, literal vectors shared by SSR and real-DOM tests.
// Catch static titles, wrong state precedence, unbounded/unescaped query text,
// broken Unicode truncation, changed defaults, and Hono/Kit divergence.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const TITLE_ORIGIN = "https://titles.example.test";
export const TITLE_SUFFIX = " — Together We Own";
const root = fileURLToPath(new URL("../../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");

// Keep 40 query code points, then append U+2026 only when truncated.
// Season labels retain the existing public month/quarter token spelling.
const searches = [
  { name: "trimmed search", q: "  Chess night  ", text: "Chess night" },
  { name: "blank search", q: " \t ", text: null },
  {
    name: "40-character search",
    q: "1234567890".repeat(4),
    text: "1234567890123456789012345678901234567890",
  },
  {
    name: "41-character search",
    q: `${"1234567890".repeat(4)}Z`,
    text: "1234567890123456789012345678901234567890…",
  },
  {
    name: "255-character search",
    q: "x".repeat(255),
    text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…",
  },
  {
    name: "Unicode truncation",
    q: `${"1234567890".repeat(3)}123456789🎮Z`,
    text: "123456789012345678901234567890123456789🎮…",
  },
  {
    name: "title-closing injection",
    q: "</title><script>x()</script>&\"'",
    text: "</title><script>x()</script>&\"'",
  },
];

export const titleVectors = [
  { name: "default events list", kind: "calendar", title: "Events" },
  {
    name: "June calendar",
    kind: "calendar",
    view: "calendar",
    month: "2030-06",
    title: "Events — June 2030",
  },
  {
    name: "January calendar",
    kind: "calendar",
    view: "calendar",
    month: "2031-01",
    title: "Events — January 2031",
  },
  {
    name: "search takes precedence over month",
    kind: "calendar",
    view: "calendar",
    month: "2031-01",
    q: "Chess",
    title: "Events matching “Chess”",
  },
  ...searches.map(({ name, q, text }) => ({
    name: `events ${name}`,
    kind: "calendar",
    q,
    title: text === null ? "Events" : `Events matching “${text}”`,
  })),
  { name: "rejected events search", kind: "too-long", title: "Events — search too long" },
  { name: "default archive", kind: "archive", page: 1, title: "Past events" },
  { name: "second archive page", kind: "archive", page: 2, title: "Past events — page 2" },
  { name: "later archive page", kind: "archive", page: 12, title: "Past events — page 12" },
  {
    name: "archive search takes precedence over page",
    kind: "archive",
    page: 2,
    q: "Chess",
    title: "Past events matching “Chess”",
  },
  ...searches.map(({ name, q, text }) => ({
    name: `archive ${name}`,
    kind: "archive",
    page: 1,
    q,
    title: text === null ? "Past events" : `Past events matching “${text}”`,
  })),
  { name: "default hot zones", kind: "hotzones", season: "all", title: "Hot zones" },
  { name: "month hot zones", kind: "hotzones", season: "2030-06", title: "Hot zones — 2030-06" },
  { name: "quarter hot zones", kind: "hotzones", season: "2030-Q2", title: "Hot zones — 2030-Q2" },
];

export function titleFixture(vector) {
  if (vector.kind === "too-long") return { queryTooLong: true, appUrl: TITLE_ORIGIN };
  if (vector.kind === "archive")
    return {
      rows: [],
      page: vector.page,
      hasMore: false,
      totalPages: 12,
      appUrl: TITLE_ORIGIN,
      q: vector.q ?? "",
    };
  if (vector.kind === "hotzones") {
    const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
    return {
      appUrl: TITLE_ORIGIN,
      season: vector.season,
      joins: cells,
      voice: cells,
      games: cells,
      joinsTotal: 0,
      eventCount: 0,
      retentionNote: null,
      joinsHtml: "",
      voiceHtml: "",
      gamesHtml: "",
      periodPickerHtml: "",
    };
  }
  return {
    state: {
      view: vector.view ?? "list",
      month: vector.month ?? "2030-06",
      q: vector.q ?? "",
      past: false,
      page: 1,
    },
    upcoming: [],
    past: [],
    zone: "UTC",
    now: new Date("2030-06-15T12:00:00Z"),
    totalPages: 0,
    emptyState: "never",
    discordFailed: false,
    games: [],
    gameFilter: null,
    member: false,
    moderator: false,
    inviteUrl: "https://discord.gg/example",
    appUrl: TITLE_ORIGIN,
    canonical: `${TITLE_ORIGIN}/events`,
    loginReturnTo: "/events",
    joinResult: null,
    queryTooLong: false,
    robots: vector.q?.trim() ? "noindex, follow" : undefined,
  };
}

// This pins existing metadata independently of title expectations, including
// full (untruncated) query state. No production title/URL formatter is reused.
export function titleMetadata(vector) {
  let path = "/events";
  let robots = vector.kind === "too-long" || vector.q?.trim() ? "noindex, follow" : null;
  if (vector.kind === "archive") {
    const params = new URLSearchParams();
    if (vector.page > 1) params.set("page", String(vector.page));
    if (vector.q) params.set("q", vector.q);
    path = `/events/past${params.size ? `?${params}` : ""}`;
    robots = "noindex, follow";
  } else if (vector.kind === "hotzones") {
    path = `/hotzones${vector.season === "all" ? "" : `?season=${vector.season}`}`;
    robots = "noindex, follow";
  }
  return { canonical: `${TITLE_ORIGIN}${path}`, robots };
}

export async function compileTitleRenderers() {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { jsx } from "hono/jsx/jsx-runtime";
        import { EventsCalendarPage, EventsSearchTooLongPage } from "./src/events/pages-calendar-screen";
        import { PastEventsPage } from "./src/events/pages-past";
        import { HotzonesIndexPage } from "./src/hotzones/pages";
        import { renderEventsHtml } from "./src/kit-events-html";
        import { render } from "svelte/server";
        import Archive from "./web/src/routes/events/past/+page.svelte";
        import Hotzones from "./web/src/routes/hotzones/+page.svelte";
        export async function renderTitle(twin, kind, data) {
          if (twin === "Hono") {
            const page = kind === "archive" ? PastEventsPage
              : kind === "hotzones" ? HotzonesIndexPage
              : kind === "too-long" ? EventsSearchTooLongPage : EventsCalendarPage;
            return await jsx(page, data).toString();
          }
          if (kind === "calendar" || kind === "too-long") {
            return (await renderEventsHtml(data, {})).body;
          }
          const result = render(kind === "archive" ? Archive : Hotzones, { props: { data } });
          return '<!doctype html><html><head>' + result.head + '</head><body>' + result.body + '</body></html>';
        }
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "discovery-title-ssr",
        setup(plugin) {
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
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
    )
  ).renderTitle;
}
