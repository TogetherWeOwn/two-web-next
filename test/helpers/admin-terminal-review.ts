// Acceptance-owned local fixtures. Render real pages; never contact a database or a live route.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { parseEventListQuery } from "../../src/admin/event-list";
import { resolveKitEventEdit } from "../../src/admin/kit-event-edit";
import { resolveKitFeaturedEdit } from "../../src/admin/kit-featured-edit";
import { buildEventListView } from "../../src/admin/kit-events";
import type { Db } from "../../src/db/index";
import { EventFormPage, EventsPage, FeaturedFormPage } from "../../src/admin/pages";
import type { EventListRow, FeaturedRow } from "../../src/admin/store";

export const REVIEW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SAVED_TARGET = 'Saved <img src=x onerror="alert(1)"> & "Friday"';
export const DIRTY_TARGET = "Unsaved editor headline";
export const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const OTHER_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const now = new Date("2030-01-01T12:00:00Z");
export const savedEvent: EventListRow = {
  id: 1,
  eventKey: EVENT_KEY,
  title: SAVED_TARGET,
  game: "Chess",
  description: "Bring a friend.",
  startsAt: new Date("2030-01-10T20:00:00Z"),
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "Lobby",
  capacity: 8,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: now,
  updatedAt: now,
  icsSequence: 0n,
  goingCount: 2,
  syncRevision: 1,
  syncedRevision: 0,
};
export const savedFeatured: FeaturedRow = {
  id: 7,
  legacyId: null,
  title: SAVED_TARGET,
  body: "Bring a friend.",
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: true,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: null,
  createdAt: now,
  updatedAt: now,
};
export const SURFACES = ["event-list", "event-edit", "featured-edit"] as const;
export type Surface = (typeof SURFACES)[number];
export type Presentation = "hono" | "kit";
export const pathFor = (surface: Surface) =>
  surface === "event-list"
    ? "/admin/events"
    : surface === "event-edit"
      ? `/admin/events/${EVENT_KEY}`
      : "/admin/featured/7";
export const actionFor = (surface: Surface) =>
  surface === "featured-edit" ? "/admin/featured/7/delete" : `/admin/events/${EVENT_KEY}/cancel`;
export const resultFor = (surface: Surface) =>
  surface === "featured-edit" ? "/admin/featured" : "/admin/events";

export function renderHonoReview(surface: Surface, status = "published", rejectedSave = false) {
  const row = { ...savedEvent, status };
  const values = {
    title: rejectedSave ? DIRTY_TARGET : SAVED_TARGET,
    game: "Chess",
    description: "Bring a friend.",
    starts_at: surface === "featured-edit" ? "" : "2030-01-10 20:00",
    ends_at: surface === "featured-edit" ? "" : "2030-01-10 22:00",
    timezone: "UTC",
    location: "Lobby",
    capacity: "8",
    body: "Bring a friend.",
    url: "",
    image_url: "",
    image_alt: "",
    is_published: "on",
    position: "0",
  };
  const errors = rejectedSave ? { title: "Fixture rejected Save" } : {};
  if (surface === "event-list") {
    return String(
      jsx(EventsPage, {
        rows: [row, { ...row, id: 2, eventKey: OTHER_KEY, title: "Other saved event" }],
        query: parseEventListQuery({}),
        hasNext: false,
      }),
    );
  }
  if (surface === "event-edit") {
    return String(jsx(EventFormPage, { mode: "edit", row, values, errors }));
  }
  return String(
    jsx(FeaturedFormPage, {
      mode: "edit",
      row: savedFeatured,
      values,
      errors,
      now,
      appUrl: "https://review.example.test",
    }),
  );
}

export async function kitReviewData(surface: Surface, status = "published", rejectedSave = false) {
  const row = { ...savedEvent, status };
  if (surface === "event-list") {
    return buildEventListView(parseEventListQuery({}), [
      row,
      { ...row, id: 2, eventKey: OTHER_KEY, title: "Other saved event" },
    ]);
  }
  // Only the read adapters are replaced. The real view builders derive saved
  // titles, eligibility, fields and roster; no SQL or endpoint is simulated here.
  const db = {} as Db;
  const outcome =
    surface === "event-edit"
      ? await resolveKitEventEdit(
          EVENT_KEY,
          {},
          {
            db,
            get: async () => row,
            list: async () => ({ rows: [], total: 0 }),
            now,
          },
        )
      : await resolveKitFeaturedEdit("7", {
          db,
          get: async () => ({ ...savedFeatured, startsAtText: null, endsAtText: null }),
          now,
          appUrl: "https://review.example.test",
        });
  if (outcome.kind !== "ok") throw new Error(`Fixture read failed: ${outcome.kind}`);
  const view = outcome.view;
  return {
    view: rejectedSave
      ? {
          ...view,
          values: { ...view.values, title: DIRTY_TARGET },
          errors: { title: "Fixture rejected Save" },
          hasErrors: true,
          isDraft: true,
        }
      : view,
  };
}

export async function compileKitReview() {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "admin-terminal-review-"),
  );
  const webRequire = createRequire(join(REVIEW_ROOT, "web/package.json"));
  const { compile } = webRequire("svelte/compiler") as {
    compile(source: string, options: Record<string, unknown>): { js: { code: string } };
  };
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `import { render } from "svelte/server";
import List from ${JSON.stringify(join(REVIEW_ROOT, "web/src/routes/admin/events/+page.svelte"))};
import Event from ${JSON.stringify(join(REVIEW_ROOT, "web/src/routes/admin/events/[key]/+page.svelte"))};
import Featured from ${JSON.stringify(join(REVIEW_ROOT, "web/src/routes/admin/featured/[id]/+page.svelte"))};
export function renderPage(surface, data) {
  const page = surface === "event-list" ? List : surface === "event-edit" ? Event : Featured;
  const { head, body } = render(page, { props: { data } });
  return '<!doctype html><html><head>' + head + '</head><body>' + body + '</body></html>';
}
`,
  );
  const outfile = join(scratch, "render.mjs");
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      absWorkingDir: REVIEW_ROOT,
      tsconfig: join(REVIEW_ROOT, "tsconfig.json"),
      logLevel: "warning",
      nodePaths: [join(REVIEW_ROOT, "web/node_modules"), join(REVIEW_ROOT, "node_modules")],
      alias: { "#lib": join(REVIEW_ROOT, "web/src/lib") },
      plugins: [
        {
          name: "terminal-review-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
              contents: compile(readFileSync(path, "utf8"), {
                generate: "server",
                dev: false,
                filename: path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(path),
            }));
          },
        },
      ],
    });
    const mod = (await import(pathToFileURL(outfile).href)) as {
      renderPage(surface: Surface, data: Record<string, unknown>): string;
    };
    return {
      render: mod.renderPage,
      close: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
