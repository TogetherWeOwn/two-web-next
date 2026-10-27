// route-inventory: GET /e/:key
// Builder-owned review follow-up: closed event detail must omit the contextual
// RSVP help link in both twins, and the open-state help link must carry the
// marker the shipped island uses to release outcome-focus ownership. Hermetic
// pg-proxy + fake-store fixtures: no DATABASE_URL, no network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { PublicEvent } from "../src/events/reads";
import {
  RSVP_CLOSED_TESTID,
  RSVP_HELP_COPY,
  RSVP_HELP_HREF,
  rsvpClosedCopy,
} from "../src/islands/contracts";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";
import { EVENT_KEY, scanEvent } from "./calendar-card-scan.fixtures";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
function elements(node: Node): Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}
function text(node: Node): string {
  return "value" in node
    ? node.value
    : "childNodes" in node
      ? node.childNodes.map(text).join("")
      : "";
}
const helpLinks = (html: string) =>
  elements(parse(html)).filter(
    (node) =>
      node.tagName === "a" &&
      text(node).trim() === RSVP_HELP_COPY &&
      attr(node, "href") === RSVP_HELP_HREF,
  );

const ORIGIN = "https://closed-help.example.test";
const DETAIL_PATH = `/e/${EVENT_KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";

const MODERATOR: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: "100000000000000002",
    username: "moderator",
    avatar: null,
    member: true,
    moderator: true,
  },
};

// Served Hono answers through a disposable pg-proxy fixture (same dispatch as
// the participation-guidance query CONTROL: single-row lookup by key plus the
// going-count aggregates; everything else finds nothing).
async function honoDetail(event: PublicEvent, moderator: boolean) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"'))
      return { rows: sql.includes("count(*)") ? [[event.id, 3]] : [] };
    if (sql.includes('"event_key" =') && !sql.includes('"status" =') && params.includes(EVENT_KEY))
      return {
        rows: [
          columns.map((key) => {
            const value = event[key];
            return value instanceof Date ? value.toISOString() : value;
          }),
        ],
      };
    return { rows: [] };
  });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: ORIGIN,
    ADMIN_DB: db as unknown as Db,
    SESSION_STORE: sessions,
    SESSION_SECRET: SECRET,
  } as unknown as Env;
  let cookie: string | undefined;
  if (moderator) {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000002",
      username: "moderator",
      avatar: null,
      member: true,
      moderator: true,
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
  const response = await app.request(DETAIL_PATH, cookie ? { headers: { cookie } } : {}, env);
  return { response, html: await response.text() };
}

let bundle: Promise<(model: Record<string, unknown>) => string> | undefined;
function kitRenderer() {
  bundle ??= (async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const webRequire = createRequire(join(root, "web/package.json"));
    const { compile } = webRequire("svelte/compiler") as {
      compile(source: string, options: Record<string, unknown>): { js: { code: string } };
    };
    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "closed-help-ssr-"),
    );
    try {
      const outfile = join(scratch, "detail.mjs");
      await build({
        stdin: {
          contents: `import {render} from "svelte/server";
import Detail from ${JSON.stringify(join(root, "web/src/lib/EventDetail.svelte"))};
export const renderDetail = model => { const {head,body}=render(Detail,{props:{model}}); return "<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\">"+head+"</head><body>"+body+"</body></html>"; };`,
          loader: "ts",
          resolveDir: root,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "silent",
        nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
        alias: { "#lib": join(root, "web/src/lib") },
        plugins: [
          {
            name: "closed-help-real-svelte",
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
      return (await import(pathToFileURL(outfile).href)).renderDetail as (
        model: Record<string, unknown>,
      ) => string;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return bundle;
}

async function kitDetail(event: PublicEvent, session: KitRequestSession) {
  const store: KitEventDetailStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    seriesFn: async () => null,
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
  const outcome = await resolveKitEventDetail({
    key: EVENT_KEY,
    search: "",
    path: DETAIL_PATH,
    env: { APP_URL: ORIGIN } as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`Fixture expected detail, received ${outcome.kind}`);
  return {
    closed: outcome.model.rsvpClosed,
    html: (await kitRenderer())(outcome.model as unknown as Record<string, unknown>),
  };
}

const GUEST: KitRequestSession = { status: "guest", session: null };

function closedEvents(): { name: string; event: PublicEvent; reason: "past" | "draft" }[] {
  const now = Date.now();
  return [
    {
      name: "past",
      event: scanEvent({
        startsAt: new Date("2020-01-10T20:00:00Z"),
        endsAt: new Date("2020-01-10T22:00:00Z"),
      }),
      reason: "past",
    },
    {
      name: "clock-ended published",
      event: scanEvent({
        startsAt: new Date(now - 2 * 3600_000),
        endsAt: new Date(now - 1000),
      }),
      reason: "past",
    },
    {
      name: "authorized draft",
      event: scanEvent({ status: "draft" }),
      reason: "draft",
    },
  ];
}

describe("Hono closed detail omits contextual RSVP help", () => {
  for (const { name, event, reason } of closedEvents()) {
    it(`${name} renders its closure with zero help links`, async () => {
      const { response, html } = await honoDetail(event, reason === "draft");
      expect(response.status).toBe(200);
      expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
      expect(text(parse(html))).toContain(rsvpClosedCopy(reason));
      expect(html).not.toContain("data-rsvp-form");
      expect(helpLinks(html)).toHaveLength(0);
    });
  }

  it("open published detail keeps one ownership-releasing help link", async () => {
    const { response, html } = await honoDetail(scanEvent(), false);
    expect(response.status).toBe(200);
    const help = helpLinks(html);
    expect(help).toHaveLength(1);
    expect(attr(help[0]!, "data-rsvp-help")).toBeDefined();
  });
});

describe("Kit closed detail omits contextual RSVP help", () => {
  for (const { name, event, reason } of closedEvents()) {
    it(`${name} renders its closure with zero help links`, async () => {
      const { closed, html } = await kitDetail(event, reason === "draft" ? MODERATOR : GUEST);
      expect(closed).toBe(reason);
      expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
      expect(text(parse(html))).toContain(rsvpClosedCopy(reason));
      expect(html).not.toContain("data-rsvp-form");
      expect(helpLinks(html)).toHaveLength(0);
    });
  }

  it("open published detail keeps one ownership-releasing help link", async () => {
    const { html } = await kitDetail(scanEvent(), GUEST);
    const help = helpLinks(html);
    expect(help).toHaveLength(1);
    expect(attr(help[0]!, "data-rsvp-help")).toBeDefined();
  });
});
