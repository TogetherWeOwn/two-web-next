import assert from "node:assert/strict";
import { URL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { registerHotzoneRoutes } from "../../src/hotzones/routes";
import { dispatchHotzonesRequest } from "../../src/kit-hotzones";
import type { Sql } from "../../src/sessions";
import type { PeriodKit, PeriodTwin } from "./hotzone-period-picker";
import { periodOrigin } from "./hotzone-period-picker";

// Independent row-major oracle, not derived from any production projection.
// Sunday and Saturday differ at every hour; every weekday has a real zero.
export const dayRows = [
  [
    100, 101, 102, 0, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
    119, 120, 121, 122, 123,
  ],
  [
    200, 201, 202, 203, 0, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218,
    219, 220, 221, 222, 223,
  ],
  [
    300, 301, 302, 303, 304, 0, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318,
    319, 320, 321, 322, 323,
  ],
  [
    400, 401, 402, 403, 404, 405, 0, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418,
    419, 420, 421, 422, 423,
  ],
  [
    500, 501, 502, 503, 504, 505, 506, 0, 508, 509, 510, 511, 512, 513, 514, 515, 516, 517, 518,
    519, 520, 521, 522, 523,
  ],
  [
    600, 601, 602, 603, 604, 605, 606, 607, 0, 609, 610, 611, 612, 613, 614, 615, 616, 617, 618,
    619, 620, 621, 622, 623,
  ],
  [
    700, 701, 702, 703, 704, 705, 706, 707, 708, 0, 710, 711, 712, 713, 714, 715, 716, 717, 718,
    719, 720, 721, 722, 723,
  ],
];
export const days = [
  { token: "sun", name: "Sunday" },
  { token: "mon", name: "Monday" },
  { token: "tue", name: "Tuesday" },
  { token: "wed", name: "Wednesday" },
  { token: "thu", name: "Thursday" },
  { token: "fri", name: "Friday" },
  { token: "sat", name: "Saturday" },
] as const;
export const dayNow = new Date("2026-04-01T00:30:00Z");
export type DayFixture = "populated" | "empty";
export type DayOptions = { fixture?: DayFixture; denied?: boolean; auditFails?: boolean };

// Only SQL transport is doubled: real routes, aggregate SQL, audit sink,
// admission transaction, Kit loaders, JSX and Svelte templates all execute.
export async function renderDayRequest(
  twin: PeriodTwin,
  path: string,
  kit: PeriodKit,
  options: DayOptions = {},
) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const hits: string[] = [];
  const inserts: unknown[][] = [];
  let dbTouches = 0;
  let fetches = 0;
  const buckets =
    options.fixture === "empty"
      ? []
      : dayRows.flatMap((row, dow) => row.flatMap((n, hr) => (n ? [[dow, hr, n]] : [])));
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('from "join_attempts"')) return { rows: buckets };
    if (sql.includes('from "events"')) return { rows: [[options.fixture === "empty" ? 0 : 17]] };
    if (sql.startsWith('insert into "board_view_logs"')) {
      inserts.push(params);
      if (options.auditFails) throw new Error("fixture audit unavailable");
      return { rows: [] };
    }
    if (sql.startsWith("SET LOCAL") || sql.startsWith("select set_config(")) return { rows: [] };
    throw new Error(`Unexpected day-reader fixture SQL: ${sql}`);
  });
  Object.assign(db, {
    transaction: async <T>(run: (tx: Db) => Promise<T>) => run(db as unknown as Db),
  });
  const throttle = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("SELECT count(*)")) return [{ n: options.denied ? 60 : 0, wait: 60 }];
      if (sql.includes("INSERT INTO web_throttle_hits")) {
        hits.push(String(values[0]));
        return [];
      }
      if (sql.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected day-reader throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(throttle as unknown as Sql),
      unsafe: async () => [],
    },
  );
  const env = {
    APP_URL: periodOrigin,
    THROTTLE_STORE: async () => throttle,
    get ADMIN_DB() {
      dbTouches += 1;
      return db;
    },
  } as unknown as Env;
  const NativeDate = globalThis.Date;
  const nativeFetch = globalThis.fetch;
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [dayNow.getTime()]);
    },
    get(target, key) {
      return key === "now" ? () => dayNow.getTime() : Reflect.get(target, key);
    },
  });
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Day-reader acceptance forbids network access");
  };
  try {
    let response: Response;
    if (twin === "Hono") {
      const app = new Hono<{ Bindings: Env }>();
      registerHotzoneRoutes(app);
      response = await app.request(
        path,
        { headers: { "cf-connecting-ip": "192.0.2.17", accept: "text/html" } },
        env,
      );
    } else {
      kit.setEnv(env);
      const url = new URL(path, periodOrigin);
      const headers: Record<string, string> = {};
      const render = async () => {
        try {
          const signal = url.pathname.split("/")[2] ?? "";
          const event = {
            url,
            params: { signal },
            setHeaders: (values: Record<string, string>) => Object.assign(headers, values),
          };
          const data = await (signal ? kit.loadSignal(event) : kit.loadIndex(event));
          const rendered = signal ? kit.signal(data) : kit.index(data);
          return new Response(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${rendered.head}</head><body>${rendered.body}</body></html>`,
            { headers },
          );
        } catch (error) {
          if (
            !(
              error &&
              typeof error === "object" &&
              "status" in error &&
              [400, 404, 503].includes(Number(error.status))
            )
          )
            throw error;
          return new Response("Hot zone refusal", { status: Number(error.status), headers });
        }
      };
      response = await dispatchHotzonesRequest(
        new Request(url, { headers: { "cf-connecting-ip": "192.0.2.17", accept: "text/html" } }),
        env,
        render,
      );
    }
    assert.equal(fetches, 0, "HZD_NETWORK: use only local fixtures");
    return {
      status: response.status,
      html: await response.text(),
      headers: response.headers,
      statements,
      hits,
      inserts,
      dbTouches,
    };
  } finally {
    globalThis.Date = NativeDate;
    globalThis.fetch = nativeFetch;
  }
}

type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];
export function attr(node: Element, name: string) {
  return node.attrs.find((a) => a.name === name)?.value ?? "";
}
export function elements(node: Node, tag?: string): Element[] {
  const children =
    "childNodes" in node ? node.childNodes.flatMap((child) => elements(child, tag)) : [];
  return "tagName" in node && (!tag || node.tagName === tag) ? [node, ...children] : children;
}
export function words(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return ("childNodes" in node ? node.childNodes.map(words).join(" ") : "")
    .replace(/\s+/g, " ")
    .trim();
}
export function main(html: string) {
  const node = elements(parse(html), "main")[0];
  assert.ok(node, "HZD_MAIN: render the real signal page");
  return node;
}
export function tables(node: Node) {
  return elements(node, "table").map((table) => ({
    node: table,
    caption: elements(table, "caption").map(words).join(" "),
    headings: elements(table, "thead").flatMap((head) => elements(head, "th").map(words)),
    rows: elements(table, "tbody").flatMap((body) =>
      elements(body, "tr").map((row) =>
        elements(row)
          .filter((cell) => cell.tagName === "th" || cell.tagName === "td")
          .map(words),
      ),
    ),
  }));
}
export function link(node: Node, label: RegExp) {
  const matches = elements(node, "a").filter((a) => label.test(words(a)));
  assert.equal(matches.length, 1, `HZD_LINK: expose one native ${label} link`);
  return new URL(attr(matches[0]!, "href"), periodOrigin);
}
export function getForm(node: Node, field: string) {
  const matches = elements(node, "form").filter((form) =>
    elements(form).some(
      (el) =>
        ["select", "input"].includes(el.tagName) &&
        attr(el, "type") !== "hidden" &&
        attr(el, "name") === field,
    ),
  );
  assert.equal(matches.length, 1, `HZD_FORM: expose one native ${field} GET form`);
  return matches[0]!;
}
export function formUrl(form: Element, chosen: Record<string, string>, requestPath: string) {
  const url = new URL(attr(form, "action") || requestPath, periodOrigin);
  url.search = "";
  for (const control of elements(form).filter((el) => ["input", "select"].includes(el.tagName))) {
    const name = attr(control, "name");
    if (!name || control.attrs.some((a) => a.name === "disabled")) continue;
    const value =
      chosen[name] ??
      (control.tagName === "select"
        ? attr(
            elements(control, "option").find((o) => o.attrs.some((a) => a.name === "selected")) ??
              elements(control, "option")[0]!,
            "value",
          )
        : attr(control, "value"));
    url.searchParams.append(name, value);
  }
  return url;
}
