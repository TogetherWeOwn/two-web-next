/// <reference types="vite/client" />
// route-inventory: GET /
// Acceptance: both home twins offer a retry for signin_denied.
//
// Failing-first contract for the sibling build: the denied copy promises "try
// again whenever you like" yet both retry conditions exclude it
// (src/screens/home.tsx, web/src/routes/+page.svelte). After the build,
// signin_denied renders the same `notice-retry` link as signin_failed and
// signin_unavailable; every other notice keeps its current answer (no retry).
// No new notice kinds, no copy rewrite, no session/cookie/redirect change.
//
// OWNERSHIP: this file is acceptance-owned. The builder builds on this branch
// and must never edit this file; implement in both renderers until it is
// green. The sibling suite test/home-failure-recovery-acceptance.test.ts
// currently pins denied as no-retry; it will flip RED once this behavior
// lands and needs a Test Author correction (denied moves to the retry set).
//
// Pinned testids (the builder implements exactly these):
// - `notice-retry`: the retry link under ?n=signin_denied (and the two
//   existing failure notices), href exactly `/auth/discord`, copy exactly
//   "Try signing in again", rendered under the notice.
//
// Hermetic: Hono renders via jsx(Home) and via the mounted app with no
// database; Kit renders via the real +page.svelte compiled and SSR-rendered
// with fake load data. No database, no network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import type { Session } from "../src/env";
import {
  FALLBACK_RANKS,
  HOME_JOIN_RESULT_COPY,
  HOME_NOTICES,
  applyHomeResponsePolicy,
} from "../src/home-copy";
import { Home, type Notice } from "../src/pages";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/invite";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: INVITE_URL,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

const honoMember: Session = {
  id: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};

const kitMember = {
  userId: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};

async function renderHono(session: Session | null, notice: Notice): Promise<string> {
  return await jsx(Home, {
    session,
    notice,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
  }).toString();
}

// Hono escapes text nodes; the notice sentences only need the apostrophe.
const honoText = (sentence: string): string => sentence.replaceAll("'", "&#39;");

const NOTICE_RETRY_ANCHOR = /<a\b[^>]*data-testid="notice-retry"[^>]*>([\s\S]*?)<\/a>/g;

function retryAnchors(html: string): string[] {
  return [...html.matchAll(NOTICE_RETRY_ANCHOR)].map((m) => m[0]);
}

function anchorHref(anchor: string): string | null {
  return anchor.match(/href="([^"]*)"/)?.[1] ?? null;
}

function anchorText(anchor: string): string {
  let stripped = "";
  for (let i = 0; i < anchor.length; ) {
    if (anchor[i] === "<") {
      const close = anchor.indexOf(">", i + 1);
      if (close === -1) {
        stripped += anchor.slice(i);
        break;
      }
      i = close + 1;
    } else {
      stripped += anchor[i];
      i += 1;
    }
  }
  return stripped.replaceAll("&amp;", "&").trim();
}

// Kit twin: the real +page.svelte, compiled and SSR-rendered with fake load
// data (the same harness as test/kit-home-render.test.ts).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderPage = (data: Record<string, unknown>) => string;

let renderKit: RenderPage;
let scratch = "";

function baseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS },
    ...overrides,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-denied-retry-acceptance-"));
  const entry = join(scratch, "kit-denied-retry-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-denied-retry-bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-denied-retry-acceptance-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    renderPage: RenderPage;
  };
  renderKit = mod.renderPage;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("acceptance: signin_denied offers a retry (Hono, RED)", () => {
  it.each([
    { viewer: "guest", session: null },
    { viewer: "member", session: honoMember },
  ])(
    "?n=signin_denied shows one /auth/discord retry under the notice ($viewer)",
    async ({ session }) => {
      const html = await renderHono(session, "signin_denied");
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(honoText(HOME_NOTICES.signin_denied));
      const retries = retryAnchors(html);
      expect(retries).toHaveLength(1);
      expect(anchorHref(retries[0]!)).toBe("/auth/discord");
      expect(anchorText(retries[0]!)).toBe("Try signing in again");
      expect(html.indexOf('data-testid="notice"')).toBeLessThan(
        html.indexOf('data-testid="notice-retry"'),
      );
    },
  );
});

describe("acceptance: signin_denied offers a retry (Kit, RED)", () => {
  it.each([
    { viewer: "guest", session: null },
    { viewer: "member", session: kitMember },
  ])("?n=signin_denied shows one /auth/discord retry under the notice ($viewer)", ({ session }) => {
    const html = renderKit(baseData({ notice: "signin_denied", session }));
    expect(html).toContain('data-testid="notice"');
    expect(html).toContain(HOME_NOTICES.signin_denied);
    const retries = retryAnchors(html);
    expect(retries).toHaveLength(1);
    expect(anchorHref(retries[0]!)).toBe("/auth/discord");
    expect(anchorText(retries[0]!)).toBe("Try signing in again");
    expect(html.indexOf('data-testid="notice"')).toBeLessThan(
      html.indexOf('data-testid="notice-retry"'),
    );
  });
});

describe("acceptance: signin failure notices still offer a retry (GREEN preserved)", () => {
  it.each([
    { notice: "signin_failed" as const, viewer: "guest", session: null },
    { notice: "signin_failed" as const, viewer: "member", session: honoMember },
    { notice: "signin_unavailable" as const, viewer: "guest", session: null },
    { notice: "signin_unavailable" as const, viewer: "member", session: honoMember },
  ])("Hono ?n=$notice keeps its retry ($viewer)", async ({ notice, session }) => {
    const html = await renderHono(session, notice);
    const retries = retryAnchors(html);
    expect(retries).toHaveLength(1);
    expect(anchorHref(retries[0]!)).toBe("/auth/discord");
    expect(anchorText(retries[0]!)).toBe("Try signing in again");
  });

  it.each([
    { notice: "signin_failed" as const, viewer: "guest", session: null },
    { notice: "signin_failed" as const, viewer: "member", session: kitMember },
    { notice: "signin_unavailable" as const, viewer: "guest", session: null },
    { notice: "signin_unavailable" as const, viewer: "member", session: kitMember },
  ])("Kit ?n=$notice keeps its retry ($viewer)", ({ notice, session }) => {
    const html = renderKit(baseData({ notice, session }));
    const retries = retryAnchors(html);
    expect(retries).toHaveLength(1);
    expect(anchorHref(retries[0]!)).toBe("/auth/discord");
    expect(anchorText(retries[0]!)).toBe("Try signing in again");
  });
});

describe("acceptance: other notices gain no retry (GREEN preserved)", () => {
  it.each(["joined", "already_member"] as const)(
    "Hono ?n=%s renders its sentence with no retry",
    async (notice) => {
      const html = await renderHono(null, notice);
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(honoText(HOME_NOTICES[notice]));
      expect(html).not.toContain('data-testid="notice-retry"');
    },
  );

  it.each(["joined", "already_member"] as const)(
    "Kit ?n=%s renders its sentence with no retry",
    (notice) => {
      const html = renderKit(baseData({ notice }));
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(HOME_NOTICES[notice]);
      expect(html).not.toContain('data-testid="notice-retry"');
    },
  );

  it.each([
    { viewer: "guest", session: null },
    { viewer: "member", session: honoMember },
  ])(
    "Hono ?n=join_failed keeps its invite link and gains no retry ($viewer)",
    async ({ session }) => {
      const html = await renderHono(session, "join_failed");
      expect(html).toContain(honoText(HOME_NOTICES.join_failed));
      expect(html).toContain("Join with an invite link instead");
      expect(html).toContain(`href="${INVITE_URL}"`);
      expect(html).not.toContain('data-testid="notice-retry"');
    },
  );

  it.each([
    { viewer: "guest", session: null },
    { viewer: "member", session: kitMember },
  ])("Kit ?n=join_failed keeps its invite link and gains no retry ($viewer)", ({ session }) => {
    const html = renderKit(baseData({ notice: "join_failed", session }));
    expect(html).toContain(HOME_NOTICES.join_failed);
    expect(html).toContain("Join with an invite link instead");
    expect(html).toContain(`href="${INVITE_URL}"`);
    expect(html).not.toContain('data-testid="notice-retry"');
  });

  it("Hono plain home (no notice) gains no retry", async () => {
    const html = await renderHono(null, null);
    expect(html).not.toContain('data-testid="notice-retry"');
  });

  it("Kit plain home (no notice) gains no retry", () => {
    const html = renderKit(baseData({ notice: null }));
    expect(html).not.toContain('data-testid="notice-retry"');
  });
});

describe("acceptance: notice copy is byte-identical, no new kinds (GREEN)", () => {
  it("pins all six sentences at the shared source (no copy rewrite)", () => {
    expect({ ...HOME_NOTICES }).toEqual({
      joined: "You're in. Welcome to the TWO Discord.",
      already_member: "Signed in. You're already in the TWO Discord.",
      join_failed:
        "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below.",
      signin_failed: "Discord sign-in didn't complete. Please try again.",
      signin_denied:
        "You cancelled the Discord sign-in, so we didn't sign you in. Nothing changed — try again whenever you like.",
      signin_unavailable:
        "Discord did not answer just now, so we could not sign you in. This is on Discord, not you — please try again in a minute.",
    });
    expect(Object.keys(HOME_NOTICES).sort()).toEqual(
      [
        "already_member",
        "join_failed",
        "joined",
        "signin_denied",
        "signin_failed",
        "signin_unavailable",
      ].sort(),
    );
  });

  it("pins the retry bytes both renderers must emit", async () => {
    const hono = retryAnchors(await renderHono(null, "signin_failed"))[0]!;
    const kit = retryAnchors(renderKit(baseData({ notice: "signin_failed" })))[0]!;
    expect(hono).toBe(
      '<a href="/auth/discord" data-testid="notice-retry">Try signing in again</a>',
    );
    expect(kit).toBe(hono);
  });
});

describe("acceptance: / cache parity across renderers (GREEN)", () => {
  it.each(["signin_denied", "signin_failed", "signin_unavailable", "joined"] as const)(
    "Hono GET /?n=%s stays private, no-store",
    async (n) => {
      const res = await app.request(`/?n=${n}`, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  it("Hono GET / (plain) stays private, no-store", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["signin_denied", "signin_failed", "signin_unavailable", "joined", null] as const)(
    "Kit response policy for ?n=%s stays private, no-store",
    (noticeRaw) => {
      const headers: Record<string, string> = {};
      const out = applyHomeResponsePolicy({
        locals: {},
        noticeRaw,
        method: "GET",
        cookieName: "test-flash",
        cookies: { delete: () => {} },
        setHeaders: (values) => Object.assign(headers, values),
      });
      expect(headers["cache-control"]).toBe("private, no-store");
      expect(out.notice).toBe(noticeRaw);
    },
  );
});

describe("acceptance: / no-JS contract (RED for denied via HTTP, GREEN pins)", () => {
  it("Kit home stays server-rendered (GREEN)", () => {
    const load = readFileSync(
      new NodeURL("../web/src/routes/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(load).toContain("export const csr = false");
  });

  it("RED: Hono GET /?n=signin_denied carries the retry in the raw body", async () => {
    const html = await (await app.request("/?n=signin_denied", {}, env)).text();
    const retries = retryAnchors(html);
    expect(retries).toHaveLength(1);
    expect(anchorHref(retries[0]!)).toBe("/auth/discord");
  });

  it("Hono GET /?n=signin_failed carries the retry in the raw body (GREEN)", async () => {
    const html = await (await app.request("/?n=signin_failed", {}, env)).text();
    expect(retryAnchors(html)).toHaveLength(1);
  });

  it("Hono home ships no executable scripts (GREEN)", async () => {
    const html = await (await app.request("/?n=signin_denied", {}, env)).text();
    // Only the JSON-LD data block (type application/ld+json, not executable);
    // the retry is a plain anchor that works with scripts disabled.
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of scripts) {
      expect(tag).toContain("application/ld+json");
    }
  });

  it("Kit SSR ships no executable scripts (GREEN)", () => {
    const html = renderKit(baseData({ notice: "signin_denied" }));
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of scripts) {
      expect(tag).toContain("application/ld+json");
    }
  });
});
