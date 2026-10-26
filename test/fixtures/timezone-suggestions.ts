// Independent acceptance fixtures; no timezone assistance is implemented here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build, type PluginBuild } from "esbuild";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../../src/events/kit-detail";
import { createMemorySessionStore } from "../../src/sessions";
import app from "../app";
import { participationFixture, type Renderer } from "../helpers/profile-participation";

export const ZONE_ORIGIN = "https://next.example.test";
export const ZONE_EVENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const ZONE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ZONE_VIEWS = ["Hono", "Kit"] as const;
export const ZONE_CONTROLS = ["profile", "event"] as const;
export const ZONE_INPUT = {
  profile: '[name="timezone"]',
  event: '[data-testid="event-chosen-timezone-input"]',
};
export type ZoneControl = (typeof ZONE_CONTROLS)[number];

let bundle: Promise<{
  render(model: unknown): { head: string; body: string };
  client: string;
}>;
function kitEventBundle() {
  bundle ??= (async () => {
    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zone-suggestions-"),
    );
    try {
      const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
      const { compile } = webRequire("svelte/compiler");
      const component = JSON.stringify(join(ZONE_ROOT, "web/src/lib/EventDetail.svelte"));
      const server = join(scratch, "server.mjs");
      const client = join(scratch, "client.mjs");
      const output = join(scratch, "render.mjs");
      writeFileSync(
        server,
        `import {render} from 'svelte/server'; import Detail from ${component}; export const renderDetail = model => render(Detail,{props:{model}});`,
      );
      writeFileSync(
        client,
        `import {hydrate,mount,unmount} from 'svelte'; import Detail from ${component};
const target=document.getElementById('zone-detail-root');
let instance=hydrate(Detail,{target,props:{model:window.__zoneModel}});
window.__zoneRerender=async()=>{await unmount(instance);instance=mount(Detail,{target,props:{model:window.__zoneModel}})};`,
      );
      const options = (generate: "server" | "client") => ({
        bundle: true,
        logLevel: "warning" as const,
        absWorkingDir: ZONE_ROOT,
        tsconfigRaw: {},
        nodePaths: [join(ZONE_ROOT, "web/node_modules"), join(ZONE_ROOT, "node_modules")],
        alias: { "#lib": join(ZONE_ROOT, "web/src/lib") },
        plugins: [
          {
            name: `suggestions-fixture-${generate}`,
            setup(plugin: PluginBuild) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
                contents: compile(readFileSync(args.path, "utf8"), {
                  generate,
                  dev: false,
                  filename: args.path,
                }).js.code,
                loader: "js",
                resolveDir: dirname(args.path),
              }));
            },
          },
        ],
      });
      await build({
        ...options("server"),
        entryPoints: [server],
        platform: "node",
        format: "esm",
        outfile: output,
      });
      const compiled = await import(pathToFileURL(output).href);
      const browser = await build({
        ...options("client"),
        entryPoints: [client],
        platform: "browser",
        conditions: ["browser"],
        format: "iife",
        write: false,
      });
      return { render: compiled.renderDetail, client: browser.outputFiles[0]!.text };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return bundle;
}

export async function timezoneProfileFixture(view: Renderer) {
  const fixture = await participationFixture("completed owner");
  return {
    ...fixture,
    async response(path = fixture.path, init: RequestInit = {}) {
      const response = await fixture.request(view, path, init);
      assert.equal(response.status, 200, "profile fixture must reach the real page");
      return response.text();
    },
  };
}

export async function timezoneEventFixture(view: Renderer) {
  const start = new Date("2035-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1,
    eventKey: ZONE_EVENT,
    icsSequence: 1n,
    title: "Chess night",
    game: "Chess",
    description: "Bring a board.",
    startsAt: start,
    endsAt: new Date("2035-01-10T22:00:00Z"),
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
  };
  const env = {
    APP_URL: ZONE_ORIGIN,
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as Env;
  const path = `/e/${ZONE_EVENT}`;
  if (view === "Hono") {
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
    const db = drizzle(async (sql) => {
      if (sql.includes('from "rsvps"')) return { rows: [] };
      if (sql.includes('"event_key" ='))
        return {
          rows: [
            columns.map((key) =>
              row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
            ),
          ],
        };
      return { rows: [] };
    });
    const response = await app.request(path, {}, { ...env, ADMIN_DB: db });
    assert.equal(response.status, 200, "event fixture must reach the real detail");
    return { html: await response.text(), client: "", path };
  }
  const store: KitEventDetailStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => ({ ...row, goingCount: 0, goingOccupancy: 0 }),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
  const outcome = await resolveKitEventDetail({
    key: ZONE_EVENT,
    search: "",
    path,
    env,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  assert.equal(outcome.kind, "ok", "Kit fixture must resolve the real detail");
  if (outcome.kind !== "ok") throw new Error("Fixture detail unavailable");
  const compiled = await kitEventBundle();
  const { head, body } = compiled.render(outcome.model);
  const model = JSON.stringify(outcome.model).replace(/</g, "\\u003c");
  return {
    html: `<!doctype html><html lang="en"><head>${head}</head><body><div id="zone-detail-root">${body}</div><script>window.__zoneModel=${model}</script></body></html>`,
    client: compiled.client,
    path,
  };
}
