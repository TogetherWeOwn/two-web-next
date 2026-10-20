import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../../src/events/kit-detail";
import type { KitRequestSession } from "../../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";
import { scheduleNow, type ScheduleCase } from "../fixtures/event-scheduled-range";

export const scheduleOrigin = "https://schedule.example.test";
export const schedulePath = "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
export type Viewer = "guest" | "member" | "moderator";
export type Twin = "Hono" | "Kit";
type EventRow = typeof events.$inferSelect;
type Rendered = { head: string; body: string };
export type KitRenderer = {
  detail: (model: Record<string, unknown>) => Rendered;
  gone: (model: Record<string, unknown>) => Rendered;
  css: string;
};

export function scheduledEvent(fixture: ScheduleCase, over: Partial<EventRow> = {}): EventRow {
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: schedulePath.slice(3),
    title: "Community chess session",
    game: "Chess",
    description: "Bring a board and meet other players.",
    startsAt: new Date(fixture.startsAt),
    endsAt: new Date(fixture.endsAt),
    timezone: fixture.timezone,
    location: "Community room",
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
    createdAt: scheduleNow,
    updatedAt: scheduleNow,
    ...over,
  };
}

async function honoPage(row: EventRow, viewer: Viewer) {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  // Only database results are synthetic; route policy, sessions and HTML are real.
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"')) {
      return sql.includes("count(*)") ? { rows: [[row.id, 0]] } : { rows: [] };
    }
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
        ],
      };
    }
    return { rows: [] };
  });
  const sessions = createMemorySessionStore();
  const secret = "test-session-secret-at-least-32-bytes-long";
  const env = {
    APP_URL: scheduleOrigin,
    SESSION_SECRET: secret,
    SESSION_STORE: sessions,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  const headers: Record<string, string> = {};
  if (viewer !== "guest") {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000001",
      username: "member",
      avatar: null,
      member: true,
      moderator: viewer === "moderator",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    headers.cookie = (
      await serializeSigned("__Host-two_session", token, secret, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }
  const response = await app.request(schedulePath, { headers }, env);
  return { status: response.status, html: await response.text() };
}

async function kitPage(row: EventRow, viewer: Viewer, renderer: KitRenderer) {
  const session: KitRequestSession =
    viewer === "guest"
      ? { status: "guest", session: null }
      : {
          status: "authenticated",
          session: {
            userId: "100000000000000001",
            username: "member",
            avatar: null,
            member: true,
            moderator: viewer === "moderator",
          },
        };
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
    key: row.eventKey,
    search: "",
    path: schedulePath,
    env: { APP_URL: scheduleOrigin } as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind === "forbidden") return { status: outcome.status, html: "" };
  if (outcome.kind !== "ok" && outcome.kind !== "gone") {
    throw new Error(`Unexpected fixture outcome: ${outcome.kind}`);
  }
  const render = outcome.kind === "ok" ? renderer.detail : renderer.gone;
  const { head, body } = render(outcome.model as unknown as Record<string, unknown>);
  return {
    status: outcome.kind === "ok" ? 200 : outcome.status,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`,
  };
}

// Freeze only Date; compiler/process/browser timers must keep running. Every
// request owns its fixture clock and restores it, even on an assertion failure.
export async function renderScheduledPage(
  twin: Twin,
  row: EventRow,
  viewer: Viewer,
  renderer: KitRenderer,
  now = scheduleNow,
) {
  const originalDate = globalThis.Date;
  const originalFetch = globalThis.fetch;
  const timestamp = now.getTime();
  let fetches = 0;
  globalThis.Date = new Proxy(originalDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [timestamp]);
    },
    get(target, key) {
      return key === "now" ? () => timestamp : Reflect.get(target, key);
    },
  });
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Schedule acceptance fixtures forbid network access");
  };
  try {
    const result =
      twin === "Hono" ? await honoPage(row, viewer) : await kitPage(row, viewer, renderer);
    if (fetches) throw new Error(`Fixture attempted ${fetches} external fetches`);
    return result;
  } finally {
    globalThis.Date = originalDate;
    globalThis.fetch = originalFetch;
  }
}

export async function compileScheduleKit(): Promise<KitRenderer> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  const scratch = mkdtempSync(join(scratchRoot, "scheduled-range-"));
  const styles: string[] = [];
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(root, "web/src/lib/EventDetail.svelte"))};
import Gone from ${JSON.stringify(join(root, "web/src/lib/EventGone.svelte"))};
export const detail = (model) => render(Detail, { props: { model } });
export const gone = (model) => render(Gone, { props: { model } });`,
    );
    const outfile = join(scratch, "bundle.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "scheduled-range-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const { js, css } = compile(readFileSync(path, "utf8"), {
                generate: "server",
                dev: false,
                filename: path,
              });
              if (css?.code) styles.push(css.code);
              return { contents: js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    const renderer = await import(pathToFileURL(outfile).href);
    return { detail: renderer.detail, gone: renderer.gone, css: styles.join("\n") };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
