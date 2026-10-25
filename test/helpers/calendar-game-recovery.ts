import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import type { Db } from "../../src/db/index";
import { events } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import { registerEventRoutes } from "../../src/events/routes";
import { loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";
import { partialEvent } from "./calendar-discord-partial";

export const GAME_ORIGIN = "https://calendar.example.test";
export const GAME_ENTRY = "/events?view=list&month=2099-05&game=Chess";
export type GameTwin = "Hono" | "Kit";
export const GAME_TWINS: GameTwin[] = ["Hono", "Kit"];
export const GAME_BUNDLES = ["source", "shipped"] as const;

export function gameRow(id: number, game: string, past = false, month?: string) {
  const baseMonth = month ?? (past ? "2020-05" : "2099-05");
  const day = `${baseMonth}-12`;
  return {
    ...partialEvent(id),
    eventKey: id === 1 ? "01ARZ3NDEKTSV4RRFFQ69G5FAA" : "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    title: `${game} fixture night`,
    game,
    startsAt: new Date(`${day}T20:00:00Z`),
    endsAt: new Date(`${day}T22:00:00Z`),
  };
}

// SQL is the only data boundary replaced. Resolver, predicates, paging, model,
// both route adapters and the shared renderer are real. No external connection.
export function gameRecoveryFixture(
  options: {
    empty?: boolean;
    failed?: boolean;
    upcomingRows?: ReturnType<typeof gameRow>[];
    pastRows?: ReturnType<typeof gameRow>[];
  } = {},
) {
  let failed = options.failed ?? false;
  let upcoming =
    options.upcomingRows ?? (options.empty ? [] : [gameRow(1, "Chess"), gameRow(2, "Go")]);
  const past = options.pastRows ?? [gameRow(1, "Chess", true), gameRow(2, "Go", true)];
  const queries: { sql: string; params: unknown[] }[] = [];
  const discordCalls: number[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: ReturnType<typeof gameRow>) =>
    columns.map((column) => {
      const value = row[column];
      return value instanceof Date ? value.toISOString() : value;
    });
  const source = {
    upcoming: async () => {
      discordCalls.push(1);
      return [];
    },
    lastReadFailed: () => failed,
  };
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (/^select\s+distinct/i.test(sql)) {
      const limit = Number(params.at(-1));
      return {
        rows: ["Chess", "Go"].slice(0, Number.isSafeInteger(limit) ? limit : 2).map((g) => [g]),
      };
    }
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (!sql.includes('from "events"')) throw new Error("Unexpected fixture SQL boundary");
    let rows = /"ends_at" </.test(sql) ? past : upcoming;
    const where = sql.slice(sql.indexOf('from "events"'));
    if (/"game"/.test(where)) {
      const game = params.find(
        (p): p is string =>
          typeof p === "string" && ["chess", "go"].includes(p.trim().toLowerCase()),
      );
      if (game) rows = rows.filter((r) => r.game.toLowerCase() === game.trim().toLowerCase());
    }
    const query = params.find(
      (p): p is string => typeof p === "string" && p.startsWith("%") && p.endsWith("%"),
    );
    if (query) {
      const text = query.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      rows = rows.filter((r) => `${r.title} ${r.description}`.toLowerCase().includes(text));
    }
    // Month-grid reads (limit 200) carry [now, to, from, 200]: only rows
    // overlapping the grid survive, like the real `startsAt < to AND
    // endsAt > from` predicate. Global list/count reads keep all upcoming.
    if (!/^select count/i.test(sql) && Number(params.at(-1)) === 200) {
      const toRaw = params.at(-3);
      const fromRaw = params.at(-2);
      const to = toRaw instanceof Date ? toRaw : new Date(String(toRaw));
      const from = fromRaw instanceof Date ? fromRaw : new Date(String(fromRaw));
      if (!Number.isNaN(to.getTime()) && !Number.isNaN(from.getTime())) {
        rows = rows.filter((r) => r.startsAt < to && r.endsAt > from);
      }
    }
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    if (sql.includes("limit")) {
      const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
      const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
      rows = rows.slice(offset, offset + limit);
    }
    return { rows: rows.map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({ execute: async () => [] } as unknown as Db),
  });
  const adminDb = db as unknown as Db;
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    app,
    async () => null,
    async () => null,
  );
  const baseEnv = {
    APP_URL: GAME_ORIGIN,
    DISCORD_INVITE_URL: "https://discord.gg/example",
    ADMIN_DB: adminDb,
    DISCORD_EVENTS: source,
  } as unknown as Env;

  return {
    queries,
    discordCalls,
    db: adminDb,
    setFailed(value: boolean) {
      failed = value;
    },
    setEmpty() {
      upcoming = [];
    },
    async render(twin: GameTwin, path: string, island = false, origin = GAME_ORIGIN) {
      const url = new URL(path, origin);
      const headers: Record<string, string> = island ? { "x-two-island": "events-calendar" } : {};
      const env = { ...baseEnv, APP_URL: origin };
      if (twin === "Hono") return app.request(url.href, { headers }, env);
      const collected: Record<string, string> = {};
      const data = await loadEventsPage({
        env,
        url,
        method: "GET",
        island,
        request: new Request(url, { headers }),
        setHeaders: (values) => Object.assign(collected, values),
        deleteJoinCookie: () => {},
        dbForFn: async () => adminDb,
        sessionForFn: async () => null,
        journeyForFn: async () => null,
        discordForFn: () => source,
      });
      const rendered = await renderEventsHtml(data as never, collected);
      return new Response(rendered.body, { status: rendered.status, headers: rendered.headers });
    },
  };
}

export function decodedText(html: string) {
  // Text comparison for synthetic rendered fixtures, never an HTML sanitizer.
  // Walk markup tokens and raw-text elements before decoding text exactly once.
  let cursor = 0;
  let rawTag: string | undefined;
  let text = "";
  while (cursor < html.length) {
    if (rawTag) {
      const close = html.indexOf("</", cursor);
      if (close === -1) break;
      cursor = close + 2;
      const nameEnd = cursor + rawTag.length;
      if (
        html.slice(cursor, nameEnd).toLowerCase() !== rawTag ||
        !/[\t\n\f\r />]/.test(html[nameEnd] ?? "")
      )
        continue;
      cursor = close;
      rawTag = undefined;
    }
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      text += html.slice(cursor);
      break;
    }
    text += `${html.slice(cursor, open)} `;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break;
      cursor = close + 3;
      continue;
    }
    let quote = "";
    let end = open + 1;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === html.length) break;
    const tag = /^([a-z][a-z0-9:-]*)(?=[\t\n\f\r />]|$)/i
      .exec(html.slice(open + 1, end))?.[1]
      ?.toLowerCase();
    if (tag === "script" || tag === "style") rawTag = tag;
    cursor = end + 1;
  }
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&#39;": "'",
    "&#x27;": "'",
    "&quot;": '"',
  };
  return text
    .replace(/&(?:amp|#39|#x27|quot);/g, (entity) => entities[entity]!)
    .replace(/\s+/g, " ")
    .trim();
}

export function emptyRegion(html: string) {
  // Rendered HTML boundary only. Scope away from static navigation/icons.
  return (
    /<([a-z]+)\b[^>]*data-testid="events-empty-[^"]+"[^>]*>([\s\S]*?)<\/\1>/.exec(html)?.[0] ?? ""
  );
}

export function broadeningLinks(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .map((m) => ({
      href: /\bhref="([^"]+)"/.exec(m[1]!)?.[1]?.replace(/&amp;/g, "&") ?? "",
      name: decodedText(m[2]!),
    }))
    .filter(
      (link) =>
        /clear|all games|all events|broaden|remove.*filter/i.test(link.name) &&
        link.href.startsWith("/events"),
    );
}
