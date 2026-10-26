import { URL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { registerHotzoneRoutes } from "../../src/hotzones/routes";
import { type PeriodKit, type PeriodTwin, periodOrigin } from "./hotzone-period-picker";

// Replace SQL transport only. The real aggregate, loaders, route handlers and
// compiled Svelte pages still run; even board-view writes stay in memory.
export async function requestHotzones(twin: PeriodTwin, path: string, kit: PeriodKit) {
  const db = drizzle(async (sql) => {
    if (sql.includes('from "join_attempts"') && sql.includes("group by")) {
      return {
        rows: [
          [0, 0, 2],
          [0, 23, 3],
          [3, 12, 11],
          [6, 0, 5],
          [6, 23, 7],
        ],
      };
    }
    if (sql.includes('from "events"') && sql.includes("count(*)")) return { rows: [[13]] };
    if (
      sql.startsWith("SET LOCAL statement_timeout") ||
      sql.startsWith("select set_config(") ||
      sql.startsWith('insert into "board_view_logs"')
    )
      return { rows: [] };
    throw new Error(`Unexpected hotzones fixture SQL: ${sql}`);
  });
  const adminDb = Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  }) as unknown as Db;
  const env = { APP_URL: periodOrigin, ADMIN_DB: adminDb } as unknown as Env;
  if (twin === "Hono") {
    const app = new Hono<{ Bindings: Env }>();
    registerHotzoneRoutes(app);
    return app.request(new URL(path, periodOrigin).href, {}, env);
  }
  kit.setEnv(env);
  const url = new URL(path, periodOrigin);
  const signal = url.pathname.split("/")[2] ?? "";
  const headers: Record<string, string> = {};
  const event = {
    url,
    params: { signal },
    setHeaders: (values: Record<string, string>) => Object.assign(headers, values),
  };
  const data = await (signal ? kit.loadSignal(event) : kit.loadIndex(event));
  const rendered = signal ? kit.signal(data) : kit.index(data);
  // Successful native Kit page load + actual SSR, as in the period-picker
  // fixture. Exceptions propagate; no error can masquerade as a 200 here.
  return new Response(
    `<!doctype html><html><head>${rendered.head}</head><body>${rendered.body}</body></html>`,
    { headers },
  );
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export function elements(node: Node, tag?: string): Element[] {
  const found: Element[] = [];
  if ("tagName" in node && (!tag || node.tagName === tag)) found.push(node);
  if ("childNodes" in node) {
    for (const child of node.childNodes) found.push(...elements(child, tag));
  }
  return found;
}

export const attr = (node: Element, name: string) =>
  node.attrs.find((attribute) => attribute.name === name)?.value;

function text(node: Node, visibleOnly = false): string {
  if ("tagName" in node) {
    if (attr(node, "aria-hidden") === "true" || attr(node, "hidden") !== undefined) return "";
    if (visibleOnly && attr(node, "class")?.split(/\s+/).includes("sr-only")) return "";
  }
  if ("value" in node) return node.value;
  return "childNodes" in node
    ? node.childNodes
        .map((child) => text(child, visibleOnly))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function name(node: Element, document: Node): string {
  const labelledBy = attr(node, "aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => elements(document).find((element) => attr(element, "id") === id))
      .map((label) => (label ? text(label) : ""))
      .join(" ");
  }
  return attr(node, "aria-label") ?? text(node);
}

export function scheduleHotzoneLinks(html: string) {
  const document = parse(html);
  const heads = elements(document).filter((node) => attr(node, "data-cal-zone") === "head");
  return {
    headCount: heads.length,
    links: heads.flatMap((head) =>
      elements(head, "a")
        .filter((anchor) => attr(anchor, "href") === "/hotzones")
        .map((anchor) => ({ href: attr(anchor, "href")!, name: name(anchor, document) })),
    ),
  };
}

export function gridEvidence(html: string) {
  const document = parse(html);
  return elements(document, "table").map((table) => {
    const captions = elements(table, "caption");
    const columns = elements(table, "th").filter((header) => attr(header, "scope") === "col");
    const tableName =
      attr(table, "aria-label") !== undefined || attr(table, "aria-labelledby") !== undefined
        ? name(table, document)
        : captions.map((caption) => name(caption, document)).join(" ");
    return {
      visibleAxis: [...captions, ...columns].map((node) => text(node, true)).join(" "),
      accessibleAxis: [tableName, ...columns.map((node) => name(node, document))].join(" "),
      hours: columns.flatMap((header) => text(header).match(/\b(?:[01]\d|2[0-3])\b/g) ?? []),
      days: elements(table, "th")
        .filter((header) => attr(header, "scope") === "row")
        .map((header) => text(header)),
      cells: elements(table, "tbody").flatMap((body) =>
        elements(body, "tr").map((row) => elements(row, "td").map((cell) => Number(text(cell)))),
      ),
    };
  });
}

// Distinct corners and an interior value expose weekday/hour shifts and transposition.
// These are counts at fixed UTC coordinates, not viewer-local times.
export function joinsFixture() {
  const cells = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  cells[0]![0] = 2;
  cells[0]![23] = 3;
  cells[3]![12] = 11;
  cells[6]![0] = 5;
  cells[6]![23] = 7;
  return { cells, total: 28, eventCount: 13 };
}
