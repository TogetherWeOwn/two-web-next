// Independent local fixture for the native-share acceptance contract. No behavior implementation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build, type PluginBuild } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../../src/events/kit-detail";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";

export const SHARE_ORIGIN = "https://events.example.test";
export const SHARE_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const SHARE_PATH = `/e/${SHARE_KEY}`;
export const SHARE_TITLE = 'Chess "night" & friends ♟';
export const SHARE_CANONICAL = "https://events.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PRIVATE_NAME = "private-member-fixture";
export const PRIVATE_ID = "100000000000000003";
export const SHARE_QUERY = "?attendees=2&next=%2Fprofile&source=private-context#account-context";
export const SHARE_VIEWS = ["Hono", "Kit"] as const;
export type ShareView = (typeof SHARE_VIEWS)[number];
type Viewer = "guest" | "member" | "moderator";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SECRET = "test-session-secret-at-least-32-bytes-long";

function eventRow(status: string, title: string): typeof events.$inferSelect {
  const start = new Date("2035-01-10T20:00:00Z");
  return {
    id: 1,
    eventKey: SHARE_KEY,
    icsSequence: 1n,
    title,
    game: "Chess",
    description: "Public description; not part of the native payload.",
    startsAt: start,
    endsAt: new Date("2035-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status,
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
}

// Compile only the existing CSR-disabled presentations. Do not inject a new
// controller, hydrate the component, or synthesize a Share control in the fixture.
let renderers: Promise<Record<string, (model: unknown) => string>> | undefined;
function kitRenderers() {
  renderers ??= (async () => {
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "native-share-",
      ),
    );
    try {
      const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
      const { compile } = webRequire("svelte/compiler") as {
        compile(
          source: string,
          options: { generate: string; dev: boolean; filename: string },
        ): {
          js: { code: string };
        };
      };
      const entry = join(scratch, "entry.mjs");
      const outfile = join(scratch, "render.mjs");
      writeFileSync(
        entry,
        `import {render} from 'svelte/server';
${["Detail", "Gone", "Missing"]
  .map(
    (name) => `import ${name} from ${JSON.stringify(join(ROOT, `web/src/lib/Event${name}.svelte`))};
export function render${name}(model) { const {head,body}=render(${name},{props:{model}}); return ${JSON.stringify(readFileSync(join(ROOT, "web/src/app.html"), "utf8"))}.replace('%sveltekit.head%',head).replace('%sveltekit.body%',body); }`,
  )
  .join("\n")}`,
      );
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        absWorkingDir: ROOT,
        tsconfigRaw: { compilerOptions: {} },
        nodePaths: [join(ROOT, "web/node_modules"), join(ROOT, "node_modules")],
        alias: { "#lib": join(ROOT, "web/src/lib") },
        plugins: [
          {
            name: "native-share-existing-ssr",
            setup(plugin: PluginBuild) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
                contents: compile(readFileSync(args.path, "utf8"), {
                  generate: "server",
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
      return await import(pathToFileURL(outfile).href);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return renderers;
}

export async function nativeShareFixture(
  view: ShareView,
  options: {
    viewer?: Viewer;
    status?: string;
    title?: string;
    missing?: boolean;
    search?: string;
  } = {},
): Promise<{ html: string; status: number }> {
  const {
    viewer = "guest",
    status = "published",
    title = SHARE_TITLE,
    missing = false,
    search = SHARE_QUERY,
  } = options;
  const row = eventRow(status, title);
  const member = viewer !== "guest";
  const moderator = viewer === "moderator";
  const store = createMemorySessionStore();
  const env = {
    APP_URL: `${SHARE_ORIGIN}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
  } as unknown as Env;
  if (view === "Hono") {
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
    const db = drizzle(async (sql) => {
      if (sql.includes("row_number()")) return { rows: [] };
      if (sql.includes('from "rsvps"') && sql.includes("count(")) return { rows: [[1, 1]] };
      if (sql.includes('from "rsvps"') && sql.includes('inner join "users"'))
        return {
          rows: [Object.assign([PRIVATE_ID, PRIVATE_NAME], { id: PRIVATE_ID, name: PRIVATE_NAME })],
        };
      if (sql.includes('from "rsvps"'))
        return {
          rows: [
            Object.assign([PRIVATE_ID, "going", null], {
              userId: PRIVATE_ID,
              status: "going",
              syncedToDiscordAt: null,
            }),
          ],
        };
      if (sql.includes('"event_key" ='))
        return {
          rows: missing
            ? []
            : [
                columns.map((key) =>
                  row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
                ),
              ],
        };
      return { rows: [] };
    });
    // Preserve the real audit recorder; pg-proxy needs a local transaction seam.
    Object.assign(db, {
      transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
    });
    Object.assign(env, { ADMIN_DB: db });
    let cookie = "";
    if (member) {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: PRIVATE_ID,
        username: PRIVATE_NAME,
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    }
    const response = await app.request(
      SHARE_PATH + search.split("#")[0],
      { headers: { cookie } },
      env,
    );
    return { html: await response.text(), status: response.status };
  }
  const data: KitEventDetailStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => (missing ? null : { ...row, goingCount: 1, goingOccupancy: 1 }),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [{ id: PRIVATE_ID, name: PRIVATE_NAME }],
    viewerRsvpFn: async () => ({ status: "going", syncedToDiscordAt: null }),
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
  const outcome = await resolveKitEventDetail({
    key: SHARE_KEY,
    search: search.split("#")[0]!,
    path: SHARE_PATH,
    env,
    session: member
      ? {
          status: "authenticated",
          session: {
            userId: PRIVATE_ID,
            username: PRIVATE_NAME,
            avatar: null,
            member: true,
            moderator,
          },
        }
      : { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store: data,
  });
  const kit = await kitRenderers();
  if (outcome.kind === "ok") return { html: kit.renderDetail!(outcome.model), status: 200 };
  if (outcome.kind === "gone") return { html: kit.renderGone!(outcome.model), status: 410 };
  if (outcome.kind === "missing") return { html: kit.renderMissing!(outcome.model), status: 404 };
  throw new Error(`Unexpected fixture outcome: ${outcome.kind}`);
}

export function nativeShareButtonMarkup(html: string) {
  return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).filter((button) =>
    /^share(?: this)?(?: event)?$/i.test(button.replace(/<!--[\s\S]*?-->|<[^>]+>/g, "").trim()),
  );
}
