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
  options?: { empty?: boolean; status?: string; rsvpOpen?: boolean },
) => Promise<{ html: string; query: Record<string, unknown> }>;

// Real SSR pages and shared parsers/read models; only the read results are local
// fixtures. No worker, HTTP listener, database connection or remote fetch is used.
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
import { parseRosterQuery, parseJoinAttemptsQuery, parseActivityLogQuery, joinAttemptsUrl } from "./src/admin/table-list";
import { buildEventListView } from "./src/admin/kit-events";
import { resolveKitEventEdit } from "./src/admin/kit-event-edit";
import { resolveKitFeaturedList } from "./src/admin/kit-featured";
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
const eventRows = [
  { ...baseEvent, status: "draft" },
  { ...baseEvent, id: 2, eventKey: "01K00000000000000000000002", title: "Sunday strategy", status: "draft" },
  { ...baseEvent, id: 3, eventKey: "01K00000000000000000000003", title: "Open games" },
  { ...baseEvent, id: 4, eventKey: "01K00000000000000000000004", title: "Paused games", rsvpOpen: false },
];
const roster = [{ userId: "100000000000000101", username: "Alex", status: "going", answeredAt: now }];
const attempts = [{ id: 7, outcome: "added", source: "join", requestId: "fixture-request", discordId: "100000000000000101", createdAt: now }];
const activity = [{ id: 8, description: "updated fixture event", subjectType: "Event", subjectId: baseEvent.eventKey, causerId: "100000000000000101", event: "updated", createdAt: now }];
const featured = [{ id: 9, legacyId: null, title: "Community game night", body: "Bring a friend.", url: null, imageUrl: null, imageAlt: null, isPublished: true, position: 0, startsAt: null, endsAt: null, createdBy: null, createdAt: now, updatedAt: now }];
const parsers = { events: parseEventListQuery, roster: parseRosterQuery, "join-attempts": parseJoinAttemptsQuery, "activity-log": parseActivityLogQuery, featured: parseFeaturedListQuery };
const components = { events: KitEvents, roster: KitRoster, "join-attempts": KitAttempts, "activity-log": KitActivity, featured: KitFeatured };

export async function renderPanel(renderer, panel, raw = {}, options = {}) {
  const query = parsers[panel](raw);
  const row = { ...baseEvent, status: options.status ?? "published", rsvpOpen: options.rsvpOpen ?? true };
  const rows = options.empty ? [] : ({ events: eventRows, roster, "join-attempts": attempts, "activity-log": activity, featured })[panel];
  let data;
  if (renderer === "Hono") {
    let page;
    if (panel === "events") page = jsx(EventsPage, { rows, query, hasNext: true });
    if (panel === "roster") page = jsx(EventFormPage, { mode: "edit", row, values: {}, errors: {}, roster: rows, rosterTotal: rows.length, rosterQuery: query });
    if (panel === "join-attempts") page = jsx(JoinAttemptsPage, { rows, query, hasNext: true, outcomes: ["added", "denied"] });
    if (panel === "activity-log") page = jsx(ActivityLogPage, { rows, query, hasNext: true });
    if (panel === "featured") page = jsx(FeaturedPage, { rows, query, now });
    return { html: String(page), query };
  }
  if (panel === "events") data = buildEventListView(query, rows);
  if (panel === "roster") {
    const result = await resolveKitEventEdit(row.eventKey, raw, {
      db: {}, get: async () => row, list: async () => ({ rows, total: rows.length }), now,
    });
    if (result.kind !== "ok") throw new Error("fixture edit read refused: " + result.kind);
    data = { view: result.view };
  }
  if (panel === "join-attempts") data = {
    rows: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })), query, hasNext: true,
    prevUrl: query.page > 1 ? joinAttemptsUrl(query, query.page - 1) : null,
    nextUrl: joinAttemptsUrl(query, query.page + 1), outcomes: ["added", "denied"], retentionDays: 90,
  };
  if (panel === "activity-log") data = {
    rows: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })), query, hasNext: true,
  };
  if (panel === "featured") {
    const result = await resolveKitFeaturedList(raw, { db: {}, list: async () => rows, now });
    if (result.kind !== "ok") throw new Error("fixture featured read refused: " + result.kind);
    data = { ...result,
      positionHeader: { href: "#", ariaSort: "none", ariaLabel: "Sort position", text: "Position" },
      updatedHeader: { href: "#", ariaSort: "none", ariaLabel: "Sort update", text: "Last changed" },
      previousHref: null, nextHref: null,
    };
  }
  return { html: render(components[panel], { props: { data } }).body, query };
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
