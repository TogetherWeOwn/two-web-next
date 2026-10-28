import assert from "node:assert/strict";
import { URL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { parse } from "parse5";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { registerHotzoneRoutes } from "../../src/hotzones/routes";
import { periodOrigin, type PeriodKit, type PeriodTwin } from "./hotzone-period-picker";

type HtmlNode = {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  value?: string;
};
export function elements(html: string, tag: string) {
  const result: HtmlNode[] = [];
  function visit(node: HtmlNode) {
    if (node.tagName === tag) result.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html) as HtmlNode);
  return result;
}
export const attr = (node: HtmlNode, name: string) =>
  node.attrs?.find((entry) => entry.name === name)?.value;
export function text(node: HtmlNode): string {
  return (node.value ?? (node.childNodes ?? []).map(text).join(" ")).replace(/\s+/g, " ").trim();
}
export function nativeNeighbors(html: string) {
  return elements(html, "a")
    .map((node) => ({
      node,
      name: attr(node, "aria-label") ?? text(node),
      href: attr(node, "href"),
    }))
    .filter((link) => link.href !== undefined && /\b(?:previous|next)\b/i.test(link.name));
}
export function namesPeriod(name: string, destination: string) {
  if (name.includes(destination)) return true;
  const [year, part] = destination.split("-");
  if (!name.includes(year!)) return false;
  if (part?.startsWith("Q"))
    return new RegExp(`(?:Q${part[1]}|quarter\\s*${part[1]})`, "i").test(name);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return part !== undefined && new RegExp(`\\b${months[Number(part) - 1]}\\b`, "i").test(name);
}
export function neighbor(html: string, direction: "Previous" | "Next", destination: string) {
  const matches = nativeNeighbors(html).filter((link) =>
    new RegExp(`\\b${direction}\\b`, "i").test(link.name),
  );
  assert.equal(matches.length, 1, `PB_NAV_MISSING: render one native ${direction} period link`);
  const link = matches[0]!;
  assert.ok(
    namesPeriod(link.name, destination),
    `PB_DESTINATION_UNNAMED: name ${destination} on ${direction}`,
  );
  assert.ok(link.href && !/^(?:javascript:|#)/i.test(link.href), "PB_NATIVE_HREF: use a real URL");
  assert.equal(attr(link.node, "onclick"), undefined, "PB_JS_DEPENDENCY: use native navigation");
  assert.notEqual(attr(link.node, "role"), "button");
  return { ...link, href: link.href! };
}

// Real route/load, real aggregate/query builder and log writer; only the SQL
// transport is replaced. This supplements the null-DB picker fixture with
// observed statements, including comparison/member reads that must not appear.
export function hotzoneBrowsingHarness(kit: PeriodKit) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params: [...params] });
    if (/^select set_config\(/i.test(sql)) return { rows: [] };
    if (/^select\b/i.test(sql)) {
      if (sql.includes('from "join_attempts"')) return { rows: [[1, 20, 3]] };
      if (sql.includes('from "events"')) return { rows: [[2]] };
      throw new Error("PB_EXTRA_READ: period navigation must not query another dataset");
    }
    return { rows: [] };
  });
  Object.assign(db, {
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  });
  const env = { APP_URL: periodOrigin, ADMIN_DB: db } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  registerHotzoneRoutes(app);
  return {
    statements,
    async request(twin: PeriodTwin, path: string) {
      const nativeFetch = globalThis.fetch;
      let fetches = 0;
      globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("PB_REMOTE_FETCH: fixture-only acceptance");
      };
      try {
        if (twin === "Hono") {
          const response = await app.request(path, {}, env);
          const html = await response.text();
          assert.equal(fetches, 0);
          return { status: response.status, html, headers: response.headers };
        }
        kit.setEnv(env);
        const headers = new Headers();
        const url = new URL(path, periodOrigin);
        const signal = url.pathname.split("/")[2] ?? "";
        const event = {
          url,
          params: { signal },
          locals: {},
          setHeaders: (values: Record<string, string>) => {
            for (const [key, value] of Object.entries(values)) headers.set(key, value);
          },
        };
        try {
          const data = await (signal ? kit.loadSignal(event) : kit.loadIndex(event));
          const rendered = signal ? kit.signal(data) : kit.index(data);
          assert.equal(fetches, 0);
          return {
            status: 200,
            html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${rendered.head}</head><body>${rendered.body}</body></html>`,
            headers,
          };
        } catch (error) {
          if (!(error && typeof error === "object" && "status" in error && error.status === 400))
            throw error;
          assert.equal(fetches, 0);
          return { status: 400, html: "", headers };
        }
      } finally {
        globalThis.fetch = nativeFetch;
      }
    },
  };
}
