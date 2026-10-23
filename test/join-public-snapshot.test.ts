// Kit GET /join anonymous payload: the load projects the Discord presence
// snapshot to aggregates before returning, so __data.json carries no member
// usernames or statuses (privacy policy v2). Hono /join HTML parity ("never
// member names") is pinned by test/discord-widget-snapshot.test.ts; this file
// pins the Kit serialization boundary the Hono suite cannot see.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DISCORD_WIDGET_VERDICT_TTL_MS,
  parseDiscordWidgetJson,
  toPublicWidgetSnapshot,
  type DiscordWidgetSnapshot,
} from "../src/discord-widget";
import type { Env } from "../src/env";

const GUILD = "326474832151838730";
const AGGREGATE_KEYS = ["channels", "inviteUrl", "name", "presenceCount"];

function fullSnapshot(): DiscordWidgetSnapshot {
  const parsed = parseDiscordWidgetJson(GUILD, {
    id: GUILD,
    name: "Together We Own",
    instant_invite: "https://discord.gg/widget-invite",
    presence_count: 42,
    channels: [{ id: "1", name: "stage-night", position: 1 }],
    members: [
      { username: "leak-probe-username-zz9", status: "dnd" },
      { username: "leak-probe-idle-qq4", status: "idle" },
    ],
  });
  if (!parsed) throw new Error("join projection fixture must parse");
  return parsed;
}

describe("toPublicWidgetSnapshot", () => {
  it("keeps exactly the four aggregate fields the view reads", () => {
    const full = fullSnapshot();
    // The fixture actually carries members, so the absence pins below are
    // not vacuous: an identity projection would fail them.
    expect(full.members).toHaveLength(2);

    const projected = toPublicWidgetSnapshot(full);
    expect(projected).not.toBeNull();
    expect(Object.keys(projected!).sort()).toEqual(AGGREGATE_KEYS);
    expect(projected).toEqual({
      name: "Together We Own",
      presenceCount: 42,
      inviteUrl: "https://discord.gg/widget-invite",
      channels: [{ id: "1", name: "stage-night", position: 1 }],
    });
  });

  it("drops member, guild and fetch-stamp bytes", () => {
    const bytes = JSON.stringify(toPublicWidgetSnapshot(fullSnapshot()));
    for (const needle of ["members", "leak-probe", "guildId", "fetchedAt", GUILD]) {
      expect(bytes, `projection leaked ${needle}`).not.toContain(needle);
    }
  });

  it("passes null and undefined through as null", () => {
    expect(toPublicWidgetSnapshot(null)).toBeNull();
    expect(toPublicWidgetSnapshot(undefined)).toBeNull();
  });
});

const ENV_KEY = "__kitJoinPublicSnapshotEnv";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routePath = join(root, "web/src/routes/join/+page.server.ts");

type KitJoinLoadArgs = {
  url: URL;
  request: Request;
  cookies: { delete: (name: string, options: Record<string, unknown>) => void };
  setHeaders: (headers: Record<string, string>) => void;
};

type KitJoinLoadData = {
  inviteUrl: string;
  widgetUrl: string | null;
  widgetSnapshot: Record<string, unknown> | null;
  oneClickHref: string;
  appUrl: string;
  joinResult: unknown;
  [key: string]: unknown;
};

type KitJoinLoad = (args: KitJoinLoadArgs) => Promise<KitJoinLoadData>;

let load: KitJoinLoad;
let scratch = "";

type SharedStub = {
  env: Env;
  pending: Promise<unknown>[];
  waitUntil: (work: Promise<unknown>) => void;
};

function shared(): SharedStub {
  return (globalThis as Record<string, unknown>)[ENV_KEY] as SharedStub;
}

beforeAll(async () => {
  // The bundled singleton captures Date.now at import. Install the controlled
  // clock first; leave timers real so Discord probe deadlines still settle.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  // Same bundle harness as the home featured-DTO suite: the real route load
  // with only the Worker env stubbed. The bundled discord-widget singleton
  // starts cold, so the first load schedules its probe through waitUntil.
  // The waitUntil implementation lives here in plain TS, not in the
  // generated stub: the stub only re-exports the shared members, so no
  // function syntax is ever built out of template strings.
  const pending: Promise<unknown>[] = [];
  (globalThis as Record<string, unknown>)[ENV_KEY] = {
    env: {
      APP_URL: "https://next.example.test",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: GUILD,
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    } satisfies Env,
    pending,
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  } satisfies SharedStub;
  scratch = mkdtempSync(join(tmpdir(), "kit-join-public-snapshot-"));
  const outfile = join(scratch, "kit-join-load-bundle.mjs");
  await build({
    stdin: {
      contents: `export { load } from ${JSON.stringify(routePath)};\n`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    plugins: [
      {
        name: "kit-join-public-snapshot-env",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "kit-join-public-snapshot-env",
            namespace: "kit-join-public-snapshot",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "kit-join-public-snapshot" }, () => ({
            contents: [
              `export const env = globalThis[${JSON.stringify(ENV_KEY)}].env;`,
              `export const waitUntil = globalThis[${JSON.stringify(ENV_KEY)}].waitUntil;`,
              ``,
            ].join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    load: KitJoinLoad;
  };
  load = mod.load;
}, 60000);

afterAll(() => {
  vi.useRealTimers();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[ENV_KEY];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Kit GET /join anonymous payload (SvelteKit __data.json)", () => {
  it("serves aggregates only: no members, usernames or statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: GUILD,
          name: "Together We Own",
          instant_invite: "https://discord.gg/widget-invite",
          presence_count: 42,
          channels: [
            { id: "2", name: "lobby-voice", position: 2 },
            { id: "1", name: "stage-night", position: 1 },
          ],
          members: [
            { username: "leak-probe-username-zz9", status: "dnd" },
            { username: "leak-probe-idle-qq4", status: "idle" },
          ],
        }),
      ),
    );

    const args = (): KitJoinLoadArgs => ({
      url: new URL("https://example.test/join"),
      request: new Request("https://example.test/join", { method: "GET" }),
      cookies: { delete: () => {} },
      setHeaders: () => {},
    });

    // Cold isolate: the probe is scheduled, never awaited — no presence yet.
    const cold = await load(args());
    expect(cold.widgetSnapshot).toBeNull();
    expect(cold.widgetStale).toBe(false);
    expect(shared().pending).toHaveLength(1);
    await Promise.all(shared().pending);

    // Anonymous follow-up: presence renders from the warmed verdict with the
    // same four fields and values the view read before (no view change).
    const data = await load(args());
    expect(data.widgetSnapshot).not.toBeNull();
    expect(data.widgetStale).toBe(false);
    expect(Object.keys(data.widgetSnapshot!).sort()).toEqual(AGGREGATE_KEYS);
    expect(data.widgetSnapshot).toEqual({
      name: "Together We Own",
      presenceCount: 42,
      inviteUrl: "https://discord.gg/widget-invite",
      channels: [
        { id: "1", name: "stage-night", position: 1 },
        { id: "2", name: "lobby-voice", position: 2 },
      ],
    });
    // The serialized load data is what SvelteKit serves at __data.json even
    // with csr=false: no member bytes may survive serialization.
    const bytes = JSON.stringify(data);
    for (const needle of [
      "leak-probe-username-zz9",
      "leak-probe-idle-qq4",
      '"members"',
      '"status"',
      '"fetchedAt"',
      '"guildId"',
    ]) {
      expect(bytes, `anonymous payload leaked ${needle}`).not.toContain(needle);
    }

    // Past one verdict TTL but within the three-TTL servable bound, the real
    // load must carry freshness separately from the four-field projection.
    vi.setSystemTime(Date.now() + DISCORD_WIDGET_VERDICT_TTL_MS + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 })),
    );
    const aged = await load(args());
    expect(aged.widgetSnapshot).toEqual(data.widgetSnapshot);
    expect(aged.widgetStale).toBe(true);
    expect(shared().pending).toHaveLength(2);
    await Promise.all(shared().pending);

    // A completed 429 probe refreshes the verdict, not the presence data:
    // the same aggregates remain available and still need qualified copy.
    const preserved = await load(args());
    expect(preserved.widgetSnapshot).toEqual(data.widgetSnapshot);
    expect(preserved.widgetStale).toBe(true);
  });
});

describe("Kit GET /join load projection pin", () => {
  it("returns the projected snapshot, never the raw widget snapshot", () => {
    const source = readFileSync(
      new NodeURL("../web/src/routes/join/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("toPublicWidgetSnapshot(widgetSnapshot)");
  });
});
