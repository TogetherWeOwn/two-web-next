import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { Hono } from "hono";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/index";
import { events } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import { __resetAnonEventCacheForTests } from "../../src/events/anon-cache";
import { registerEventRoutes } from "../../src/events/routes";
import { dispatchEventsRequest, loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";
import { dispatchHookRequest } from "../../src/route-ownership";
import { gathering } from "./calendar-multiday-acceptance";

export const WEEK_ORIGIN = "https://calendar.example.test";
export const WEEK_NOW = new Date("2026-11-01T12:00:00Z");
export const WEEK_TWINS = ["Hono", "Kit"] as const;
export type WeekTwin = (typeof WEEK_TWINS)[number];
export type WeekStart = "monday" | "sunday";
export type HtmlNode = DefaultTreeAdapterMap["node"];
export type HtmlElement = DefaultTreeAdapterMap["element"];

export function elements(node: HtmlNode, tag?: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  if ("tagName" in node && (!tag || node.tagName === tag)) found.push(node);
  if ("childNodes" in node)
    for (const child of node.childNodes) found.push(...elements(child, tag));
  return found;
}
export const attr = (node: HtmlElement, name: string) =>
  node.attrs.find((item) => item.name === name)?.value;
export function text(node: HtmlNode): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}
export function ancestor(node: HtmlNode, tag: string): HtmlElement | undefined {
  let parent = "parentNode" in node ? node.parentNode : null;
  while (parent) {
    if ("tagName" in parent && parent.tagName === tag) return parent;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return undefined;
}
export function testElement(html: string, id: string): HtmlElement {
  const node = elements(parse(html)).find((item) => attr(item, "data-testid") === id);
  if (!node) throw new Error(`WEEK_FIXTURE_ELEMENT_MISSING: ${id}; inspect the rendered response`);
  return node;
}

export interface WeekChoice {
  name: string;
  monday: string;
  sunday: string;
  kind: "select" | "radio";
  labelled: boolean;
  form?: HtmlElement;
  selected?: string;
}

// Discover the public GET vocabulary, not a new private TypeScript API. The
// spec allows either a select or a native radio group, and does not name a key.
export function weekChoice(html: string): WeekChoice | null {
  const doc = parse(html);
  const all = elements(doc);
  const labelFor = (node: HtmlElement) => {
    const id = attr(node, "id");
    const explicit = id
      ? all.find((item) => item.tagName === "label" && attr(item, "for") === id)
      : undefined;
    const labelledBy = (attr(node, "aria-labelledby") ?? "")
      .split(/\s+/)
      .map((key) => all.find((item) => attr(item, "id") === key))
      .filter((item): item is HtmlElement => !!item)
      .map(text)
      .join(" ");
    const label = explicit ?? ancestor(node, "label");
    return (label ? text(label) : "") + (attr(node, "aria-label") ?? "") + labelledBy;
  };
  for (const select of elements(doc, "select")) {
    const options = elements(select, "option");
    const monday = options.find((item) => /\bmonday\b/i.test(text(item)));
    const sunday = options.find((item) => /\bsunday\b/i.test(text(item)));
    const name = attr(select, "name");
    if (monday && sunday && name) {
      const selected = options.find((item) => attr(item, "selected") !== undefined) ?? options[0];
      return {
        name,
        monday: attr(monday, "value") ?? text(monday),
        sunday: attr(sunday, "value") ?? text(sunday),
        kind: "select",
        labelled: labelFor(select).trim().length > 0,
        form: ancestor(select, "form"),
        selected: selected ? (attr(selected, "value") ?? text(selected)) : undefined,
      };
    }
  }
  const radios = elements(doc, "input").filter((item) => attr(item, "type") === "radio");
  const monday = radios.find((item) => /\bmonday\b/i.test(labelFor(item)));
  const sunday = radios.find((item) => /\bsunday\b/i.test(labelFor(item)));
  if (monday && sunday && attr(monday, "name") && attr(monday, "name") === attr(sunday, "name")) {
    const fieldset = ancestor(monday, "fieldset");
    const selected = [monday, sunday].find((item) => attr(item, "checked") !== undefined);
    return {
      name: attr(monday, "name")!,
      monday: attr(monday, "value") ?? "on",
      sunday: attr(sunday, "value") ?? "on",
      kind: "radio",
      labelled: !!fieldset && elements(fieldset, "legend").some((item) => text(item).trim() !== ""),
      form: ancestor(monday, "form"),
      selected: selected ? attr(selected, "value") : undefined,
    };
  }
  return null;
}

// Before the feature exists, a provisional probe still reaches the route and
// exposes Monday geometry. Once a control exists, every test uses its real
// name/values; no spelling of the presentation parameter is an acceptance gate.
export function probeChoice(html: string): WeekChoice {
  return (
    weekChoice(html) ?? {
      name: "weekStart",
      monday: "monday",
      sunday: "sunday",
      kind: "select",
      labelled: false,
    }
  );
}
export function weekPath(path: string, choice: WeekChoice, start: WeekStart): string {
  const url = new URL(path, WEEK_ORIGIN);
  url.searchParams.set(choice.name, choice[start]);
  return url.pathname + url.search + url.hash;
}
export function effectiveWeek(path: string, choice: WeekChoice): string {
  return new URL(path, WEEK_ORIGIN).searchParams.get(choice.name) ?? choice.monday;
}
export function nativeFields(form: HtmlElement): URLSearchParams {
  const params = new URLSearchParams();
  for (const node of elements(form)) {
    const name = attr(node, "name");
    if (!name || attr(node, "disabled") !== undefined) continue;
    if (node.tagName === "input") {
      const type = attr(node, "type") ?? "text";
      if (["button", "submit", "reset", "file"].includes(type)) continue;
      if (["checkbox", "radio"].includes(type) && attr(node, "checked") === undefined) continue;
      params.append(name, attr(node, "value") ?? "");
    } else if (node.tagName === "select") {
      const options = elements(node, "option");
      const selected = options.find((item) => attr(item, "selected") !== undefined) ?? options[0];
      if (selected) params.append(name, attr(selected, "value") ?? text(selected));
    }
  }
  return params;
}
export function calendarCells(html: string) {
  return elements(parse(html), "td")
    .filter((node) => attr(node, "data-testid") === "calendar-day")
    .map((node) => ({
      date: attr(node, "data-date"),
      outside: attr(node, "data-outside") === "true",
      today: attr(node, "aria-current") === "date",
      node,
    }));
}
export function calendarHeadings(html: string) {
  return elements(testElement(html, "events-calendar-grid"), "th").map((node) => text(node).trim());
}

export function weekEvent(id: number, start: string, end: string, game = "Chess") {
  return gathering({
    id,
    eventKey: `01ARZ3NDEKTSV4RRFFQ69G5F${String(id).padStart(2, "0")}`,
    title: `Calendar fixture gathering ${id} with a full accessible title`,
    game,
    startsAt: new Date(start),
    endsAt: new Date(end),
    timezone: "UTC",
  });
}
export const weekRows = [
  weekEvent(1, "2027-01-30T23:00:00Z", "2027-02-02T01:00:00Z"),
  weekEvent(2, "2027-01-31T12:00:00Z", "2027-01-31T14:00:00Z"),
  weekEvent(3, "2027-02-14T23:30:00Z", "2027-02-15T01:00:00Z"),
  weekEvent(4, "2027-03-06T20:00:00Z", "2027-03-06T22:00:00Z"),
  weekEvent(5, "2027-03-07T20:00:00Z", "2027-03-07T22:00:00Z"),
  weekEvent(6, "2027-02-10T20:00:00Z", "2027-02-10T22:00:00Z", "Go"),
];

type Endpoint = (event: {
  request: Request;
  url: URL;
  cookies: { delete: () => void };
  setHeaders: (headers: Record<string, string>) => void;
}) => Promise<Response>;
let endpoint: Promise<Endpoint> | undefined;
const GLOBAL = "__calendarWeekStartAcceptance";

// Execute the actual Kit endpoint file. Only framework/env/session/SQL/Discord
// boundaries are synthetic. The real load and renderer are forwarded unchanged
// through the fixture global to share Drizzle's runtime with the SQL proxy.
async function kitEndpoint(): Promise<Endpoint> {
  endpoint ??= (async () => {
    const modules: Record<string, string> = {
      framework:
        "export function error(status,message){throw Object.assign(new Error(message),{status});}",
      workers: `export const env = new Proxy({}, {get: (_,key) => globalThis.${GLOBAL}.env[key]});`,
      db: `export const dbFor = async () => globalThis.${GLOBAL}.db;`,
      session:
        "export const kitEventsSessionFor=()=>async()=>null; export const kitEventsJourneyFor=()=>async()=>null;",
      discord: `export const discordEventsSource=()=>globalThis.${GLOBAL}.source;`,
      load: `export const loadEventsPage=(...args)=>globalThis.${GLOBAL}.load(...args);`,
      renderer: `export const renderEventsHtml=(...args)=>globalThis.${GLOBAL}.render(...args);`,
    };
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../../web/src/routes/events/+server.ts", import.meta.url).href),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
      plugins: [
        {
          name: "week-start-endpoint-fixture",
          setup(builder) {
            const replacements: [RegExp, string][] = [
              [/^@sveltejs\/kit$/, "framework"],
              [/^cloudflare:workers$/, "workers"],
              [/src\/admin\/db$/, "db"],
              [/src\/kit-session$/, "session"],
              [/\/events\/discord-transients$/, "discord"],
              [/src\/kit-events$/, "load"],
              [/src\/kit-events-html$/, "renderer"],
            ];
            for (const [filter, path] of replacements)
              builder.onResolve({ filter }, () => ({ path, namespace: "week-start-fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "week-start-fixture" }, ({ path }) => ({
              contents: modules[path],
              loader: "js",
            }));
          },
        },
      ],
    });
    const loaded = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.text).toString("base64")}`
    );
    return loaded.GET as Endpoint;
  })();
  return endpoint;
}

export function weekFixture(rows = weekRows) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: (typeof rows)[number]) =>
    columns.map((column) => {
      const value = row[column];
      return value instanceof Date ? value.toISOString() : value;
    });
  let discordCalls = 0;
  const source = {
    upcoming: async () => {
      discordCalls++;
      return [];
    },
    lastReadFailed: () => false,
  };
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (/^(insert|update|delete)\b/i.test(sql) || sql.includes("set_config(")) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (/^select\s+distinct/i.test(sql)) return { rows: [["Chess"], ["Go"]] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (!sql.includes('from "events"'))
      throw new Error("WEEK_UNEXPECTED_SQL: inspect fixture boundary");
    let selected = /"ends_at" </.test(sql) ? [] : [...rows];
    if (sql.slice(sql.indexOf('from "events"')).includes('"game"')) {
      const game = params.find((value) => value === "chess" || value === "go");
      if (game) selected = selected.filter((row) => row.game?.toLowerCase() === game);
    }
    const search = params.find(
      (value): value is string => typeof value === "string" && value.startsWith("%"),
    );
    if (search)
      selected = selected.filter((row) =>
        row.title.toLowerCase().includes(search.slice(1, -1).toLowerCase()),
      );
    if (/^select count/i.test(sql)) return { rows: [[selected.length]] };
    if (Number(params.at(-1)) === 200) {
      const to = new Date(String(params.at(-3)));
      const from = new Date(String(params.at(-2)));
      selected = selected.filter((row) => row.startsAt < to && row.endsAt > from);
    }
    if (/order by .*"starts_at" asc/.test(sql))
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    if (sql.includes("limit")) {
      const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
      const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
      selected = selected.slice(offset, offset + limit);
    }
    return { rows: selected.map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  const adminDb = db as unknown as Db;
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    app,
    async () => null,
    async () => null,
  );
  return {
    queries,
    get discordCalls() {
      return discordCalls;
    },
    async render(
      twin: WeekTwin,
      path: string,
      island = false,
      cache = false,
      requestHeaders: Record<string, string> = {},
    ) {
      if (!cache) __resetAnonEventCacheForTests();
      const env = {
        APP_URL: WEEK_ORIGIN,
        SESSION_SECRET: "w".repeat(64),
        DISCORD_INVITE_URL: "https://discord.gg/example",
        ADMIN_DB: adminDb,
        DISCORD_EVENTS: source,
      } as unknown as Env;
      const headers: Record<string, string> = {
        ...requestHeaders,
        ...(island ? { "x-two-island": "events-calendar" } : {}),
      };
      const request = new Request(new URL(path, WEEK_ORIGIN), { headers });
      if (twin === "Hono") return app.fetch(request, env);
      const GET = await kitEndpoint();
      Object.assign(globalThis, {
        [GLOBAL]: { env, db: adminDb, source, load: loadEventsPage, render: renderEventsHtml },
      });
      return dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: "/events" }, locals: {} },
        {
          appUrl: WEEK_ORIGIN,
          honoFetch: async () => {
            throw new Error("WEEK_KIT_FELL_BACK: schedule must execute its shipped endpoint");
          },
          resolve: async () =>
            GET({
              request,
              url: new URL(request.url),
              locals: {},
              cookies: {
                delete: () => {
                  throw new Error("WEEK_UNEXPECTED_COOKIE_WRITE: presentation must not persist");
                },
              },
              setHeaders: () => {},
            }),
          eventsPage: (req, render) => dispatchEventsRequest(req, env, render),
        },
      );
    },
  };
}
