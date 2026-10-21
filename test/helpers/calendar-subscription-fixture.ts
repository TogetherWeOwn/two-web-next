import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/pg-proxy";
import app from "../app";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { __resetAnonEventCacheForTests } from "../../src/events/anon-cache";
import { listPast } from "../../src/events/reads";
import { faqPageData } from "../../src/faq-content";
import { loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";
import { loadPastArchivePage } from "../../src/kit-past-events";
import { dispatchHookRequest } from "../../src/route-ownership";

export const FEED_URL = "https://calendar.example.test/events.ics";
export const ORIGIN = "https://calendar.example.test";
export const SURFACES = ["hono-calendar", "hono-archive", "kit-calendar", "kit-archive"] as const;
export type Surface = (typeof SURFACES)[number];
const root = fileURLToPath(new URL("../../", import.meta.url).href);
const webRequire = createRequire(new URL("../../web/package.json", import.meta.url).href);
const { compile } = webRequire("svelte/compiler");

// Actual Kit archive SSR (csr=false), with its real external island scripts.
// Calendar is shared Hono HTML. No test-written controls or clipboard handlers.
export async function subscriptionFixture() {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "calendar-subscription-"),
  );
  const page = join(root, "web/src/routes/events/past/+page.svelte");
  const faq = join(root, "web/src/routes/faq/+page.svelte");
  const options = (generate: "server") => ({
    bundle: true,
    format: "esm" as const,
    logLevel: "warning" as const,
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: `subscription-${generate}`,
        setup(plugin: import("esbuild").PluginBuild) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), { generate, dev: false, filename: path })
              .js.code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  try {
    const serverFile = join(scratch, "server.mjs");
    await build({
      ...options("server"),
      platform: "node",
      outfile: serverFile,
      stdin: {
        resolveDir: root,
        contents: `
        import { render } from 'svelte/server';
        import Past from ${JSON.stringify(page)};
        import Faq from ${JSON.stringify(faq)};
        export const renderPast = data => render(Past, {props:{data}});
        export const renderFaq = data => render(Faq, {props:{data}});
      `,
      },
    });
    const server = (await import(pathToFileURL(serverFile).href)) as {
      renderPast(data: unknown): { head: string; body: string };
      renderFaq(data: unknown): { head: string; body: string };
    };
    return {
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
      async render(surface: Surface, appUrl = ORIGIN, query = "") {
        __resetAnonEventCacheForTests();
        // Strict, empty read fixture. Unexpected I/O is a harness error, never
        // a silent successful empty result. No SQL connection or live Discord.
        const db = drizzle(async (sql) => {
          if (/^select count\(\*\) from "events"/.test(sql)) return { rows: [[0]] };
          if (sql.startsWith("select ") && /from "(?:events|rsvps)"/.test(sql)) return { rows: [] };
          throw new Error(`Unexpected subscription fixture SQL: ${sql}`);
        }) as unknown as Db;
        const discord = { upcoming: async () => [], lastReadFailed: () => false };
        const env = {
          APP_URL: appUrl,
          ADMIN_DB: db,
          DISCORD_EVENTS: discord,
          DISCORD_INVITE_URL: "https://discord.gg/example",
        } as unknown as Env;
        const path = surface.endsWith("archive") ? "/events/past" : "/events";
        const url = new URL(path + query, appUrl);
        const request = new Request(url);
        if (surface.startsWith("hono")) return app.request(request, {}, env);
        const headers: Record<string, string> = {};
        const setHeaders = (next: Record<string, string>) => Object.assign(headers, next);
        const resolve = async () => {
          if (surface === "kit-calendar") {
            const data = await loadEventsPage({
              env,
              url,
              method: "GET",
              island: false,
              request,
              setHeaders,
              deleteJoinCookie: () => {},
              dbForFn: async () => db,
              sessionForFn: async () => null,
              journeyForFn: async () => null,
              discordForFn: () => discord as never,
            });
            const rendered = await renderEventsHtml(data as never, headers);
            return new Response(rendered.body, {
              status: rendered.status,
              headers: rendered.headers,
            });
          }
          const data = await loadPastArchivePage({
            env,
            pageParam: url.searchParams.get("page"),
            setHeaders,
            dbForFn: async () => db,
            listPastFn: listPast,
          });
          const rendered = server.renderPast(data);
          return new Response(
            `<!doctype html><html lang="en"><head>${rendered.head}</head><body>` +
              `${rendered.body}</body></html>`,
            { headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
          );
        };
        return dispatchHookRequest(
          { request, url, route: { id: path } },
          { appUrl, honoFetch: async (req) => app.request(req, {}, env), resolve },
        );
      },
      async faq(renderer: "hono" | "kit") {
        if (renderer === "hono")
          return (await app.request("/faq", {}, { APP_URL: ORIGIN } as Env)).text();
        const rendered = server.renderFaq(faqPageData(ORIGIN));
        return `<head>${rendered.head}</head><body>${rendered.body}</body>`;
      },
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
