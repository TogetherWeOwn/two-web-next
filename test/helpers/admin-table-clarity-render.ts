import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

export type Renderer = "Hono" | "Kit";
export type Panel = "events" | "roster" | "join-attempts" | "activity-log" | "featured";
export type RenderPanel = (
  renderer: Renderer,
  panel: Panel,
  raw?: Record<string, string>,
  options?: {
    empty?: boolean;
    status?: string;
    rsvpOpen?: boolean;
    eventKey?: string;
    startsAt?: string;
  },
) => Promise<{ html: string; query: Record<string, unknown> }>;

// Real SSR pages, Kit route loaders and shared parsers/read models. Only the
// framework bindings and database reads use local fixtures; the loader-to-page
// query handoff is production code. No worker, HTTP listener or database is used.
export async function createAdminTableRenderers(): Promise<RenderPanel> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const { outputFiles } = await build({
    stdin: {
      resolveDir: root,
      loader: "js",
      contents: `
import { jsx } from "hono/jsx/jsx-runtime";
import { render } from "svelte/server";
import { EventsPage, EventFormPage, JoinAttemptsPage, ActivityLogPage, FeaturedPage } from "./src/admin/pages";
import { parseEventListQuery } from "./src/admin/event-list";
import { parseFeaturedListQuery } from "./src/admin/featured-list-query";
import { parseRosterQuery, parseJoinAttemptsQuery, parseActivityLogQuery } from "./src/admin/table-list";
import { setFixture } from "admin-table-fixture";
import { load as loadEvents } from "./web/src/routes/admin/events/+page.server.ts";
import { load as loadRoster } from "./web/src/routes/admin/events/[key]/+page.server.ts";
import { load as loadAttempts } from "./web/src/routes/admin/join-attempts/+page.server.ts";
import { load as loadActivity } from "./web/src/routes/admin/activity-log/+page.server.ts";
import { load as loadFeatured } from "./web/src/routes/admin/featured/+page.server.ts";
import KitEvents from "./web/src/routes/admin/events/+page.svelte";
import KitRoster from "./web/src/routes/admin/events/[key]/+page.svelte";
import KitAttempts from "./web/src/routes/admin/join-attempts/+page.svelte";
import KitActivity from "./web/src/routes/admin/activity-log/+page.svelte";
import KitFeatured from "./web/src/routes/admin/featured/+page.svelte";

const now = new Date("2026-10-21T12:00:00.000Z");
const at = new Date("2099-11-01T18:00:00.000Z");
const baseEvent = {
  id: 1, eventKey: "01K00000000000000000000001", title: 'Friday & friends "Chess"',
  game: "Chess", description: "Casual games", startsAt: at,
  endsAt: new Date("2099-11-01T21:00:00.000Z"), timezone: "UTC",
  location: "Community room", capacity: 8, status: "published", rsvpOpen: true,
  discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
  agentGrantId: null, proofMarker: null, agentVersion: 1, recurrenceFrequency: null,
  recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
  icsSequence: 0n, syncRevision: 0, syncedRevision: 0, createdBy: null,
  createdAt: now, updatedAt: now, goingCount: 2,
};
// Two same-title recurring occurrences per lifecycle state (draft,
// published/open, published/paused), each with a distinct key and start, so a
// title-only accessible name cannot tell the occurrences apart.
const eventRows = [
  { ...baseEvent, status: "draft" },
  { ...baseEvent, id: 5, eventKey: "01K00000000000000000000005", status: "draft", startsAt: new Date("2099-11-08T18:00:00.000Z"), endsAt: new Date("2099-11-08T21:00:00.000Z") },
  { ...baseEvent, id: 2, eventKey: "01K00000000000000000000002", title: "Sunday strategy", status: "draft", startsAt: new Date("2099-11-03T18:00:00.000Z"), endsAt: new Date("2099-11-03T21:00:00.000Z") },
  { ...baseEvent, id: 3, eventKey: "01K00000000000000000000003", title: "Open games", startsAt: new Date("2099-11-02T18:00:00.000Z"), endsAt: new Date("2099-11-02T21:00:00.000Z") },
  { ...baseEvent, id: 6, eventKey: "01K00000000000000000000006", title: "Open games", startsAt: new Date("2099-11-09T18:00:00.000Z"), endsAt: new Date("2099-11-09T21:00:00.000Z") },
  { ...baseEvent, id: 4, eventKey: "01K00000000000000000000004", title: "Paused games", rsvpOpen: false, startsAt: new Date("2099-11-04T18:00:00.000Z"), endsAt: new Date("2099-11-04T21:00:00.000Z") },
  { ...baseEvent, id: 7, eventKey: "01K00000000000000000000007", title: "Paused games", rsvpOpen: false, startsAt: new Date("2099-11-11T18:00:00.000Z"), endsAt: new Date("2099-11-11T21:00:00.000Z") },
];
const roster = [{ userId: "100000000000000101", username: "Alex", status: "going", answeredAt: now }];
const attempts = [{ id: 7, outcome: "added", source: "join", requestId: "fixture-request", discordId: "100000000000000101", createdAt: now }];
const activity = [{ id: 8, description: "updated fixture event", subjectType: "Event", subjectId: baseEvent.eventKey, causerId: "100000000000000101", event: "updated", createdAt: now }];
const featured = [{ id: 9, legacyId: null, title: "Community game night", body: "Bring a friend.", url: null, imageUrl: null, imageAlt: null, isPublished: true, position: 0, startsAt: null, endsAt: null, createdBy: null, createdAt: now, updatedAt: now }];
const parsers = { events: parseEventListQuery, roster: parseRosterQuery, "join-attempts": parseJoinAttemptsQuery, "activity-log": parseActivityLogQuery, featured: parseFeaturedListQuery };
const loaders = { events: loadEvents, roster: loadRoster, "join-attempts": loadAttempts, "activity-log": loadActivity, featured: loadFeatured };
const components = { events: KitEvents, roster: KitRoster, "join-attempts": KitAttempts, "activity-log": KitActivity, featured: KitFeatured };

export async function renderPanel(renderer, panel, raw = {}, options = {}) {
  const query = parsers[panel](raw);
  const startsAt = options.startsAt ? new Date(options.startsAt) : baseEvent.startsAt;
  const row = {
    ...baseEvent,
    status: options.status ?? "published",
    rsvpOpen: options.rsvpOpen ?? true,
    ...(options.eventKey ? { eventKey: options.eventKey } : {}),
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
  };
  const rows = options.empty ? [] : ({ events: eventRows, roster, "join-attempts": attempts, "activity-log": activity, featured })[panel];
  if (renderer === "Hono") {
    let page;
    if (panel === "events") page = jsx(EventsPage, { rows, query, hasNext: true });
    if (panel === "roster") page = jsx(EventFormPage, { mode: "edit", row, values: {}, errors: {}, roster: rows, rosterTotal: rows.length, rosterQuery: query });
    if (panel === "join-attempts") page = jsx(JoinAttemptsPage, { rows, query, hasNext: true, outcomes: ["added", "denied"] });
    if (panel === "activity-log") page = jsx(ActivityLogPage, { rows, query, hasNext: true });
    if (panel === "featured") page = jsx(FeaturedPage, { rows, query, now });
    return { html: String(page), query };
  }
  setFixture({ row, rows });
  const url = new URL("https://admin-fixture.invalid/admin/" + (panel === "roster" ? "events/" + row.eventKey : panel));
  url.search = new URLSearchParams(raw).toString();
  const data = await loaders[panel]({
    parent: async () => ({}), url, params: { key: row.eventKey },
    locals: { requestId: "admin-table-fixture" }, setHeaders: () => {},
  });
  const loadedQuery = panel === "roster" ? data.view.roster.query : data.query;
  return { html: render(components[panel], { props: { data } }).body, query: loadedQuery };
}
`,
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "admin-table-clarity-ssr",
        setup(plugin) {
          const fixtures: Record<string, string> = {
            "admin-table-fixture":
              "export let fixture; export function setFixture(value) { fixture = value; }",
            "@sveltejs/kit":
              "export function error(status, message) { throw Object.assign(new Error(message), { status }); }",
            "cloudflare:workers": "export const env = {};",
            db: "export async function dbFor() { return {}; }",
            "store-event-reads":
              'import { fixture } from "admin-table-fixture"; export async function listEvents() { return fixture.rows; } export async function getEvent() { return fixture.row; }',
            reads:
              'import { fixture } from "admin-table-fixture"; export const JOIN_RETENTION_DAYS = 90; export async function listJoinAttempts() { return fixture.rows; } export async function listActivityLog() { return fixture.rows; } export async function listRoster() { return { rows: fixture.rows, total: fixture.rows.length }; }',
            "store-featured":
              'import { fixture } from "admin-table-fixture"; export async function listFeatured() { return fixture.rows; }',
          };
          plugin.onResolve(
            { filter: /^(admin-table-fixture|@sveltejs\/kit|cloudflare:workers)$/ },
            ({ path }) => ({
              path,
              namespace: "admin-table-fixtures",
            }),
          );
          plugin.onResolve(
            { filter: /(?:^|\/)admin\/(?:db|reads|store-event-reads|store-featured)$/ },
            ({ path, importer }) => {
              if (
                !importer.endsWith("+page.server.ts") &&
                !importer.endsWith("/src/admin/kit-activity-log.ts")
              )
                return;
              return {
                path: path.slice(path.lastIndexOf("/") + 1),
                namespace: "admin-table-fixtures",
              };
            },
          );
          // The activity helper's relative bindings name the same read seams.
          plugin.onResolve({ filter: /^\.\/(db|reads)$/ }, ({ path, importer }) => {
            if (!importer.endsWith("/src/admin/kit-activity-log.ts")) return;
            return { path: path.slice(2), namespace: "admin-table-fixtures" };
          });
          plugin.onLoad({ filter: /.*/, namespace: "admin-table-fixtures" }, ({ path }) => ({
            contents: fixtures[path],
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
  const bundle = `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`;
  return (await import(bundle)).renderPanel as RenderPanel;
}
