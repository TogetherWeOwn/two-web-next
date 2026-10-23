// Acceptance-owned fixture: real Hono route, Kit binding/page and read boundary.
// Only SQL transport, Workers bindings and browser-only page state are replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import app from "../app";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const ORIGIN = "https://period.example.test";
export type Twin = "Hono" | "Kit";
type Actor = "member" | "guest" | "outsider";
type State = "ranked" | "empty" | "unavailable";
type Statement = { sql: string; params: unknown[] };
type Reply = { status: number; html: string; headers: Headers; data?: unknown };
const VIEWER = "100000000000000201";
const OTHER = "100000000000000202";
const SECRET = "test-session-secret-at-least-32-bytes-long";

type KitRequest = {
  env: Env;
  path: string;
  actor: Actor;
  audit: (entry: unknown) => Promise<boolean>;
};
export type BoardPeriodKit = {
  request: (args: KitRequest) => Promise<Reply>;
  css: string;
};

export async function compileBoardPeriodKit(): Promise<BoardPeriodKit> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler");
  const styles: string[] = [];
  const { outputFiles } = await build({
    stdin: {
      contents: `
import { render } from "svelte/server";
import Page from "./web/src/routes/leaderboards/members/+page.svelte";
import { load } from "./web/src/routes/leaderboards/members/+page.server.ts";
import { memberReadResponse } from "./src/member-reads.ts";
import { recordQueuedMembersBoardView } from "./src/kit-members.ts";
import { setEnv } from "cloudflare:workers";
export async function request({ env, path, actor, audit }) {
  setEnv(env);
  const headers = new Headers({ "content-type": "text/html" });
  const locals = {
    status: actor === "guest" ? "guest" : "authenticated",
    session: actor === "guest" ? undefined : { userId: "${VIEWER}", username: "Fixture viewer", member: actor === "member" }
  };
  let data;
  const response = await memberReadResponse(
    { method: "GET", route: "/leaderboards/members" },
    { viewer: "${VIEWER}", resource: "leaderboard", action: "list", route: "leaderboards.members" },
    audit,
    async () => {
      try {
        data = await load({ url: new URL(path, ${JSON.stringify(ORIGIN)}), locals,
          cookies: { set() {}, delete() {} },
          setHeaders: (values) => { for (const [key, value] of Object.entries(values)) headers.set(key, value); }
        });
        const { head, body } = render(Page, { props: { data } });
        return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + head + '</head><body>' + body + '</body></html>', { headers });
      } catch (error) {
        // Only a branded application refusal is an answer. Fixture/import errors
        // must escape rather than masquerading as expected missing behavior.
        if (![302, 400, 403, 503].includes(error?.status)) throw error;
        if (error.location) headers.set("location", error.location);
        return new Response("", { status: error.status, headers });
      }
    },
    async (released) => recordQueuedMembersBoardView(locals, released.status)
  );
  return { status: response.status, html: await response.text(), headers: response.headers, data };
}
`,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    banner: {
      js: `import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(${JSON.stringify(join(root, "package.json"))});`,
    },
    plugins: [
      {
        name: "member-period-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "bindings",
            namespace: "member-period",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "member-period" }, () => ({
            contents:
              "let current; export const setEnv = (value) => { current = value; }; export const env = new Proxy({}, { get: (_, key) => Reflect.get(current, key) });",
            loader: "js",
          }));
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
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
  return { request: compiled.request, css: styles.join("\n") };
}

export function boardPeriodHarness(
  kit: BoardPeriodKit,
  options: { state?: State; failAudit?: boolean } = {},
) {
  const statements: Statement[] = [];
  const audits: unknown[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params: [...params] });
    if (options.failAudit && sql.includes('insert into "member_data_access_logs"'))
      throw new Error("Fixture audit refusal");
    if (!/from rsvps/i.test(sql) || options.state === "empty") return { rows: [] };
    // Raw execute() maps keyed aliases, not positional SELECT projections.
    if (/select ranked\.user_id as user_id, ranked\.rank as rank/.test(sql)) {
      return { rows: [{ user_id: VIEWER, rank: 7 }] as unknown as unknown[][] };
    }
    return {
      rows: [
        { user_id: VIEWER, username: "Fixture viewer", count: 3, rank: 7 },
        { user_id: OTHER, username: "Fixture other member", count: 1, rank: 8 },
      ] as unknown as unknown[][],
    };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: ORIGIN,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: SECRET,
    SESSION_STORE: sessions,
    ...(options.state === "unavailable" ? {} : { ADMIN_DB: db }),
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;
  async function cookie(actor: Actor) {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: VIEWER,
      username: "Fixture viewer",
      avatar: null,
      member: actor === "member",
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }
  return {
    statements,
    audits,
    async request(twin: Twin, path: string, actor: Actor = "member"): Promise<Reply> {
      const nativeFetch = globalThis.fetch;
      let fetches = 0;
      globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("Member period fixtures forbid remote fetches");
      };
      try {
        let result: Reply;
        if (twin === "Kit")
          result = await kit.request({
            env,
            path,
            actor,
            audit: async (entry) => {
              audits.push(entry);
              return !options.failAudit;
            },
          });
        else {
          const response = await app.request(
            path,
            {
              headers: {
                accept: "text/html,application/xhtml+xml",
                ...(actor === "guest" ? {} : { cookie: await cookie(actor) }),
              },
            },
            env,
          );
          result = {
            status: response.status,
            html: await response.text(),
            headers: response.headers,
          };
        }
        assert.equal(fetches, 0, "No remote fetch may escape fixture injection");
        return result;
      } finally {
        globalThis.fetch = nativeFetch;
      }
    },
  };
}

function decode(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&quot;/g, '"');
}
function attribute(attrs: string, name: string) {
  return decode(attrs.match(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`, "i"))?.[1] ?? "");
}
export function currentMark(attrs: string) {
  return ["page", "date", "true"].includes(attribute(attrs, "aria-current"));
}
export function namedLink(html: string, name: string) {
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter((match) => {
    // Svelte markers are comments, never part of the accessible name.
    const text = decode(match[2]!.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    return text === name;
  });
  assert.equal(links.length, 1, `Expected one native ${name} shortcut/link`);
  const attrs = links[0]![1]!;
  const href = attribute(attrs, "href");
  assert.ok(href && !/^(?:javascript:|#)/i.test(href), `${name} needs a navigable href`);
  assert.ok(!/\b(?:onclick|role=["']button)/i.test(attrs), `${name} must remain a native link`);
  return { name, href, attrs };
}
export function periodLinks(html: string) {
  return [
    namedLink(html, "This month"),
    namedLink(html, "This quarter"),
    namedLink(html, "All time"),
  ] as const;
}
export function seasonInput(html: string) {
  const inputs = [...html.matchAll(/<input\b([^>]*)>/gi)].filter(
    (match) => attribute(match[1]!, "name") === "season",
  );
  assert.equal(inputs.length, 1, "Historical season remains one native input");
  return { attrs: inputs[0]![1]!, value: attribute(inputs[0]![1]!, "value") };
}
