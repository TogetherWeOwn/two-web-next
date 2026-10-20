import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { Env } from "../src/env";
import { loadMembersBoardData } from "../src/kit-members";
import { consumeLoginReturn, LOGIN_INTENDED_COOKIE } from "../src/return-journey";

const SESSION_SECRET = "binding-test-session-secret-at-least-32-bytes";
const APP = "https://next.example.test";
const DESTINATION = "/leaderboards/members?season=2026-Q3&scope=relative&activity=valheim";
const env: Env = {
  APP_URL: APP,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET,
};

let scratch: string;
let kitLoad: (event: unknown) => Promise<unknown>;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kit-members-binding-"));
  const entry = resolve("web/src/routes/leaderboards/members/+page.server.ts");
  const outfile = join(scratch, "members-load.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    treeShaking: true,
    tsconfigRaw: { compilerOptions: { target: "ES2022", module: "ESNext" } },
    plugins: [
      {
        name: "kit-binding-test-runtime",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "test",
          }));
          plugin.onLoad({ filter: /^workers$/, namespace: "test" }, () => ({
            contents: `export const env = ${JSON.stringify(env)};`,
            loader: "js",
          }));
          plugin.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "test",
          }));
          plugin.onLoad({ filter: /^sveltekit$/, namespace: "test" }, () => ({
            contents: `export function redirect(status, location) { throw Object.assign(new Error("redirect"), { status, location }); } export function error(status, message) { throw Object.assign(new Error(message), { status }); }`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const loaded = await import(pathToFileURL(outfile).href);
  kitLoad = loaded.load;
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function loadEvent(
  url: URL,
  cookies: {
    set: (name: string, value: string, options: Record<string, unknown>) => void;
    delete: (name: string, options: Record<string, unknown>) => void;
  },
) {
  return {
    url,
    locals: { status: "guest", session: null },
    cookies,
    setHeaders() {},
  };
}

const consume = async (cookie: string) => {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async (c) => c.text((await consumeLoginReturn(c)) ?? "default"));
  return app.request("/", { headers: { cookie } }, env);
};

describe("Kit member-board binding cookie emission", () => {
  it("executes the binding and emits a cookie the login-return consumer verifies", async () => {
    const emitted: Array<[string, string, Record<string, unknown>]> = [];
    const removed: Array<[string, Record<string, unknown>]> = [];
    const cookies = {
      set: (name: string, value: string, options: Record<string, unknown>) =>
        emitted.push([name, value, options]),
      delete: (name: string, options: Record<string, unknown>) => removed.push([name, options]),
    };

    await expect(
      kitLoad(loadEvent(new URL(`${APP}${DESTINATION}`), cookies)),
    ).rejects.toMatchObject({
      status: 302,
      location: "/auth/discord",
    });

    expect(removed).toEqual([]);
    expect(emitted).toHaveLength(1);
    const [name, value, options] = emitted[0]!;
    expect(name).toBe(LOGIN_INTENDED_COOKIE);
    expect(value).not.toContain("%2Fleaderboards");
    expect(options).toMatchObject({ path: "/", secure: true, httpOnly: true, sameSite: "lax" });

    const response = await consume(`${name}=${encodeURIComponent(value)}`);
    expect(await response.text()).toBe(DESTINATION);
  });

  it("executes the binding clearing path for a rejected destination", async () => {
    const emitted: Array<[string, string, Record<string, unknown>]> = [];
    const removed: Array<[string, Record<string, unknown>]> = [];
    const cookies = {
      set: (name: string, value: string, options: Record<string, unknown>) =>
        emitted.push([name, value, options]),
      delete: (name: string, options: Record<string, unknown>) => removed.push([name, options]),
    };

    await expect(
      kitLoad(loadEvent(new URL(`${APP}/leaderboards/members?x=${"a".repeat(600)}`), cookies)),
    ).rejects.toMatchObject({ status: 302, location: "/auth/discord" });

    expect(emitted).toEqual([]);
    expect(removed).toEqual([
      [LOGIN_INTENDED_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "lax" }],
    ]);
  });

  it("legacy and no-signer helper calls return no cookie instruction", async () => {
    const base = {
      session: { status: "guest", userId: null, member: false } as const,
      seasonParam: null,
      scopeParam: null,
      activityParam: null,
      setHeaders: () => {},
      dbForFn: async () => null,
    };

    for (const args of [
      { ...base, env },
      { ...base, env: { APP_URL: APP } as Env, url: `${APP}${DESTINATION}` },
    ]) {
      let caught: (Error & { status?: number; intendedCookie?: string }) | undefined;
      try {
        await loadMembersBoardData(args);
      } catch (error) {
        caught = error as Error & { status?: number; intendedCookie?: string };
      }
      expect(caught?.status).toBe(302);
      expect(caught?.intendedCookie).toBeUndefined();
    }
  });
});
