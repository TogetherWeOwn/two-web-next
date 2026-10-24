// route-inventory: GET /join
// route-inventory: GET /join/discord
// Catches an unreachable Kit strip (including {#if false}) and a strip link
// that drops sanitized intent while the hero still preserves it. Compile the
// real page, Shell and server load; replace only the Cloudflare request binding
// and Discord health read, never application markup or query sanitizers.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL as NodeURL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordWidgetHealth, type DiscordWidgetSnapshot } from "../src/discord-widget";
import type { Env } from "../src/env";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const widgetUrl = "https://discord.com/widget?id=326474832151838730&theme=dark";
const snapshot: DiscordWidgetSnapshot = {
  guildId: env.DISCORD_GUILD_ID,
  name: "Together We Own",
  inviteUrl: null,
  presenceCount: 42,
  channels: [],
  members: [],
  fetchedAt: 0,
};

type State = {
  flash?: "added" | "already_member";
  widget?: "presence" | "facade" | "fallback";
};
type KitBundle = {
  renderJoin: (
    url: string,
    cookie: string,
    bindings: Env,
    widget: { url: string | null; snapshot: DiscordWidgetSnapshot | null },
  ) => Promise<string>;
};
let kit: KitBundle;

// Same locked-compiler harness as kit-about-parity.test.ts. A metafile pin
// below makes replacing Shell with a stub an observable test failure.
async function compileKit(): Promise<KitBundle> {
  const root = fileURLToPath(new NodeURL("../", import.meta.url));
  const webRequire = createRequire(new NodeURL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "join-expectations-ssr-"),
  );
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "render.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/join/+page.svelte"))};
import { load } from ${JSON.stringify(join(root, "web/src/routes/join/+page.server.ts"))};
import { discordWidgetHealth } from ${JSON.stringify(join(root, "src/discord-widget.ts"))};
import { setEnv } from "cloudflare:workers";
export async function renderJoin(url, cookie, bindings, widget) {
  setEnv(bindings);
  discordWidgetHealth.url = () => widget.url;
  discordWidgetHealth.snapshot = () => widget.snapshot;
  const data = await load({
    url: new URL(url),
    request: new Request(url, { headers: cookie ? { cookie } : {} }),
    cookies: { delete() {} },
    setHeaders() {},
  });
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}`,
    );
    const result = await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      metafile: true,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "real-join-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "cloudflare:workers",
              namespace: "request-binding",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "request-binding" }, () => ({
              contents:
                "export let env; export function setEnv(value) { env = value; } " +
                "export function waitUntil() { throw new Error('unexpected background probe'); }",
              loader: "js",
            }));
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
    const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
    for (const path of [
      "web/src/routes/join/+page.svelte",
      "web/src/routes/join/+page.server.ts",
      "web/src/lib/Shell.svelte",
      "web/src/lib/SiteHeader.svelte",
      "web/src/lib/SiteFooter.svelte",
    ]) {
      expect(
        inputs.some((input) => input.endsWith(path)),
        `SSR bundle omitted ${path}`,
      ).toBe(true);
    }
    return (await import(pathToFileURL(outfile).href)) as KitBundle;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function flashCookie(flash: State["flash"]): Promise<string> {
  if (!flash) return "";
  return (
    await serializeSigned(JOIN_RESULT_COOKIE, flash, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function renderJoin(twin: "Hono" | "Kit", path: string, state: State = {}): Promise<string> {
  const cookie = await flashCookie(state.flash);
  const widget = {
    url: state.widget === "fallback" ? null : widgetUrl,
    snapshot: state.widget === "presence" ? snapshot : null,
  };
  if (twin === "Kit")
    return kit.renderJoin(new NodeURL(path, env.APP_URL).href, cookie, env, widget);
  vi.spyOn(discordWidgetHealth, "url").mockReturnValue(widget.url);
  vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue(widget.snapshot);
  const response = await app.request(path, { headers: cookie ? { cookie } : {} }, env);
  expect(response.status).toBe(200);
  return response.text();
}

function stripOf(html: string): string {
  const strips = html.match(
    /<section\b[^>]*data-testid="join-expectations"[^>]*>[\s\S]*?<\/section>/g,
  );
  expect(strips, "exactly one reachable expectations strip in the rendered HTML").toHaveLength(1);
  return strips![0]!;
}

function linksOf(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) =>
    match[1]!.replaceAll("&amp;", "&"),
  );
}

function assertStrip(html: string, expectedHref: string): void {
  const strip = stripOf(html);
  const stepIds = ["connect", "recognized", "gamenight"];
  const steps = [
    ...strip.matchAll(/<li\b[^>]*data-testid="join-expectation-([^"]+)"[^>]*>([\s\S]*?)<\/li>/g),
  ];
  expect(steps.map((step) => step[1])).toEqual(stepIds);
  expect(steps[0]![2]).toMatch(/connect[^<]*discord/i);
  expect(steps[1]![2]).toMatch(/recogniz|signed in/i);
  expect(steps[1]![2]).toMatch(/welcome banner/i);
  expect(steps[1]![2]).not.toMatch(/(?:land|redirect|taken)[^<]*profile/i);
  expect(steps[2]![2]).toMatch(/game night/i);
  expect(linksOf(steps[0]![2]!)).toEqual([expectedHref]);
  expect(linksOf(steps[1]![2]!)).toEqual(["/faq"]);
  expect(linksOf(steps[2]![2]!)).toEqual(["/events"]);
  expect(strip).toMatch(/<h2\b[^>]*>What happens after you connect<\/h2>/);
  expect(strip).not.toMatch(/<script|aria-hidden|hidden(?:=|\s|>)|tabindex="-1"/);
  const hero = html.match(/<a\b[^>]*data-testid="join-oneclick"[^>]*>/)?.[0];
  expect(hero, "hero one-click anchor is rendered").toBeDefined();
  expect(linksOf(hero!)).toEqual([expectedHref]);
  expect(linksOf(strip)).toEqual([...linksOf(hero!), "/faq", "/events"]);
  const headingAt = html.indexOf('id="join-heading"');
  const heroAt = html.indexOf('data-testid="join-oneclick"');
  expect(headingAt).toBeGreaterThanOrEqual(0);
  expect(heroAt).toBeGreaterThan(headingAt);
  expect(html.indexOf('data-testid="join-expectations"')).toBeGreaterThan(heroAt);
}

beforeAll(async () => {
  kit = await compileKit();
});
beforeEach(() => {
  // Any unexpected external request is a test failure, not a live Discord probe.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected external fetch");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const contexts = [
  { name: "context-free default", query: "", href: "/join/discord" },
  {
    name: "next only",
    query: "next=%2Fevents%3Fgame%3DDeep%2520Rock",
    href: "/join/discord?next=%2Fevents%3Fgame%3DDeep%2520Rock",
  },
  { name: "source only", query: "source=web-homepage", href: "/join/discord?source=web-homepage" },
  {
    name: "combined next and source",
    query: "next=%2Fevents&source=web-homepage",
    href: "/join/discord?next=%2Fevents&source=web-homepage",
  },
  {
    name: "unsafe external next and source",
    query: "next=https%3A%2F%2Fevil.example%2F&source=bad%2Fsource",
    href: "/join/discord",
  },
  {
    name: "protocol-relative next",
    query: "next=%2F%2Fevil.example%2F&source=web-homepage",
    href: "/join/discord?source=web-homepage",
  },
  {
    name: "unsafe source preserves safe next",
    query: "next=%2Fevents&source=%3Cscript%3E",
    href: "/join/discord?next=%2Fevents",
  },
  { name: "backslash next", query: "next=%2F%5Cevil.example%2F", href: "/join/discord" },
] as const;

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} rendered expectations preserve sanitized join intent`, () => {
    for (const context of contexts) {
      it(context.name, async () => {
        const html = await renderJoin(twin, `/join${context.query ? `?${context.query}` : ""}`);
        assertStrip(html, context.href);
        expect(stripOf(html)).not.toContain("evil.example");
        expect(stripOf(html)).not.toContain("bad/source");
        expect(stripOf(html)).not.toContain("&lt;script&gt;");
      });
    }

    it("failed-start bounce preserves next and source on both rendered join actions", async () => {
      const store = createMemorySessionStore();
      vi.spyOn(store.journeys, "issue").mockResolvedValue(false);
      const response = await app.request(
        "/join/discord?next=%2Fevents%3Fgame%3DDeep%2520Rock&source=web-homepage",
        {},
        { ...env, SESSION_STORE: store } as Env,
      );
      expect(response.status).toBe(302);
      const retry = response.headers.get("location");
      expect(retry).toBe(
        "/join?notice=start-failed&next=%2Fevents%3Fgame%3DDeep%2520Rock&source=web-homepage",
      );
      const html = await renderJoin(twin, retry!);
      assertStrip(html, "/join/discord?next=%2Fevents%3Fgame%3DDeep%2520Rock&source=web-homepage");
    });
  });
}

// These cases pass on the pinned head, independently of the known context-link
// REDs. Hiding the section in Svelte must fail these real SSR assertions.
describe("Kit rendered expectations baseline states", () => {
  const states: { name: string; state: State }[] = [
    { name: "guest default", state: {} },
    { name: "added flash", state: { flash: "added" } },
    { name: "already-member flash", state: { flash: "already_member" } },
    { name: "presence preview", state: { widget: "presence" } },
    { name: "widget-only facade", state: { widget: "facade" } },
    { name: "widget unavailable fallback", state: { widget: "fallback" } },
  ];
  for (const { name, state } of states) {
    it(name, async () => {
      const html = await renderJoin("Kit", "/join", state);
      assertStrip(html, "/join/discord");
      expect(html).toContain('id="main"');
      expect(html).toContain('data-testid="join-invite"');
      expect(html).toContain('href="https://discord.gg/invite"');
      if (state.flash) {
        expect(html).toContain('data-testid="join-result"');
        if (state.flash === "already_member") {
          expect(html).toMatch(/<a href="\/discord" data-testid="reinvite-link">/);
        } else {
          expect(html).not.toContain('data-testid="reinvite-link"');
        }
      } else {
        expect(html).not.toContain('data-testid="join-result"');
      }
      if (state.widget === "presence") {
        expect(html).toContain('data-testid="join-widget-presence"');
        expect(html).toContain("42</strong>");
      } else {
        expect(html).not.toContain('data-testid="join-widget-presence"');
      }
      if (state.widget === "fallback") {
        expect(html).toContain('data-testid="join-widget-fallback"');
        expect(html).not.toContain('data-testid="join-widget-load"');
      } else {
        expect(html).toContain('data-testid="join-widget-load"');
        expect(html).not.toContain('data-testid="join-widget-fallback"');
      }
    });
  }
});
