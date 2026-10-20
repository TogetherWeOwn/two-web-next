// Failing-first acceptance: static events-search form in the Kit error shell.
//
// T6 from the roadmap (M193): Hono's generic 404 ships an events-search form
// but Kit's ErrorShell 404 and 400/410 blocks offer links only. The exact form
// already exists on Kit (web/src/lib/EventMissing.svelte) and the shell
// contract allows static recovery (no loader/session/db reads).
//
// Test files only: the sibling build card builds on this branch and never
// edits this file. The form-presence tests below fail on current code (the
// shell has no form) and pass once the build adds the static form to the 404
// and 400/410 blocks. Controls pin what must not change: status-specific
// copy/titles byte-stable from src/kit-errors.ts, suggestions stay Hono-only,
// no reads, catastrophic shell and Kit 400 recovery UX unchanged.
//
// Hermetic: SSR renders via the web workspace's own svelte/compiler + esbuild
// (same shape as test/kit-event-states.test.ts), local fixtures only. No
// browser, no network, no session, no database.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { kitErrorCopy, type KitErrorStatus } from "../src/kit-errors";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { normalizeSection } from "../ci/kit-section-contract.mjs";
import app from "./app";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

const INVITE = "https://discord.gg/fixture-invite";
const APP_URL = "https://next.example.test";

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "test-guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

type RenderErrorShell = (code: KitErrorStatus) => string;
type RenderMissing = (model: { suggestions: never[] }) => string;

let renderErrorShell: RenderErrorShell;
let renderMissing: RenderMissing;

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-error-search-"));
  try {
    const entry = join(scratch, "kit-error-search-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import ErrorShell from ${JSON.stringify(join(worktree, "web/src/lib/ErrorShell.svelte"))};
import Missing from ${JSON.stringify(join(worktree, "web/src/lib/EventMissing.svelte"))};
export function renderErrorShell(code) {
  const { head, body } = render(ErrorShell, { props: { code, inviteUrl: ${JSON.stringify(INVITE)} } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderMissing(model) {
  const { head, body } = render(Missing, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-error-search.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-error-search-svelte-ssr",
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
    ({ renderErrorShell, renderMissing } = (await import(pathToFileURL(outfile).href)) as {
      renderErrorShell: RenderErrorShell;
      renderMissing: RenderMissing;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The shell offers recovery with no session, DB or network reads: rendering
// must succeed with fetch refusing every call, and never invoke it.
function renderOffline(code: KitErrorStatus): string {
  const fetchSpy = vi.fn(() => {
    throw new Error("kit error search fixtures must remain offline");
  });
  vi.stubGlobal("fetch", fetchSpy);
  try {
    return renderErrorShell(code);
  } finally {
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }
}

function formOf(html: string): string {
  const match = html.match(/<form[\s\S]*?<\/form>/);
  if (!match) throw new Error("events-search form is missing from the rendered shell");
  return normalizeSection(match[0].replace(/<!---->/g, ""));
}

// Same markup/testids as EventMissing.svelte:61-76 — the contract the build
// copies into the shell. Each assert names the member-visible behavior it pins.
function expectSearchForm(html: string, code: KitErrorStatus): void {
  // No-JS submit reaches GET /events with the query as `q`.
  expect(html, `${code} form action`).toContain('action="/events"');
  expect(html, `${code} form method`).toContain('method="get"');
  expect(html, `${code} form role`).toContain('role="search"');
  expect(html, `${code} form class`).toContain('class="error-events-search"');
  // Labelled search input, same accessible name as the Hono twin.
  expect(html, `${code} label`).toContain('<label for="error-events-search">Search events</label>');
  expect(html, `${code} input id`).toContain('id="error-events-search"');
  expect(html, `${code} input name`).toContain('name="q"');
  expect(html, `${code} input type`).toContain('type="search"');
  expect(html, `${code} input placeholder`).toContain('placeholder="Search events…"');
  expect(html, `${code} input autocomplete`).toContain('autocomplete="off"');
  expect(html, `${code} input testid`).toContain('data-testid="error-events-search"');
  // Submit button with the same name.
  expect(html, `${code} submit testid`).toContain('data-testid="error-events-search-submit"');
  expect(html, `${code} submit label`).toContain(">Search events</button>");
}

describe("Kit error shell search form (failing-first)", () => {
  it.each([404, 400, 410] as const)("renders the static search form in the %s block", (code) => {
    expectSearchForm(renderOffline(code), code);
  });

  it("matches the EventMissing form markup through the framework-tolerant treatment", () => {
    const shellForm = formOf(renderOffline(404));
    const missingForm = formOf(renderMissing({ suggestions: [] }).replace(/<!---->/g, ""));
    expect(shellForm).toBe(missingForm);
  });

  it("no-JS submit from the Kit 404 form reaches /events?q=…", async () => {
    const html = renderOffline(404);
    // Extract the form contract a no-JS browser would follow: action, method,
    // and the query input name. Fails while the shell has no form.
    const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1];
    const method = html.match(/<form[^>]*method="([^"]+)"/i)?.[1]?.toLowerCase();
    const inputName =
      html.match(/<input[^>]*name="([^"]+)"[^>]*type="search"/)?.[1] ??
      html.match(/<input[^>]*type="search"[^>]*name="([^"]+)"/)?.[1];
    expect(action).toBe("/events");
    expect(method).toBe("get");
    expect(inputName).toBe("q");
    // The target honors the submit: GET /events?q=… answers the listing
    // against an empty-calendar fixture (no live database, no Discord).
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const db = drizzle(async () => ({ rows: [] }));
    Object.assign(db, {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    });
    const res = await app.request("/events?q=search+probe", {}, {
      ...baseEnv,
      ADMIN_DB: db,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("Kit error shell copy stays byte-stable", () => {
  it.each([404, 400, 410] as const)(
    "keeps its status-specific title, lead and code (%s)",
    (code) => {
      const html = renderOffline(code);
      const copy = kitErrorCopy(code);
      expect(html).toContain(`<h1 id="error-heading">${copy.title}</h1>`);
      expect(html).toContain(copy.lead);
      expect(html).toContain(`class="recovery-code" aria-hidden="true">${copy.code}</p>`);
      expect(html).toContain(`${copy.title} — Together We Own`);
      expect(html).toContain('name="robots" content="noindex, nofollow"');
    },
  );

  it("keeps src/kit-errors.ts as the copy source of truth", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const shell = readFileSync(join(root, "web/src/lib/ErrorShell.svelte"), "utf8");
    expect(shell).toContain("kitErrorCopy");
    expect(shell).toContain("../../../src/kit-errors");
    // Never duplicates the strings: every title lives in the module, not the shell.
    for (const code of [400, 404, 410] as const) {
      expect(shell).not.toContain(kitErrorCopy(code).title);
      expect(shell).not.toContain(kitErrorCopy(code).lead);
    }
  });
});

describe("Kit error shell reads nothing and suggests nothing", () => {
  it("shell and boundary read no loader, session or database", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const shell = readFileSync(join(root, "web/src/lib/ErrorShell.svelte"), "utf8");
    const boundary = readFileSync(join(root, "web/src/routes/+error.svelte"), "utf8");
    for (const [label, source] of [
      ["shell", shell],
      ["boundary", boundary],
    ] as const) {
      expect(source, label).not.toMatch(/dbFor|getSignedCookie|readSession|fetch\(/);
      expect(source, label).not.toContain("<script src");
      expect(source, label).not.toContain("{@html");
    }
    expect(boundary).not.toMatch(/page\.error/);
  });

  it.each([404, 400, 410] as const)(
    "offers the form only on %s: suggestions stay Hono-only",
    (code) => {
      const html = renderOffline(code);
      expect(html).not.toContain('data-testid="error-event-suggestion"');
      expect(html).not.toContain('data-testid="error-events-empty"');
      expect(html).not.toContain('data-testid="error-event-suggestions"');
      expect(html).not.toContain("Happening soon");
    },
  );

  it.each([403, 429, 500, 503] as const)("adds no search form to the %s shell", (code) => {
    const html = renderOffline(code);
    expect(html).not.toContain('data-testid="error-events-search"');
    expect(html).not.toContain('data-testid="error-events-search-submit"');
  });
});

describe("Kit recovery UX the build must not change", () => {
  it("keeps the 404 recovery links alongside the form", () => {
    const html = renderOffline(404);
    expect(html).toContain('href="/auth/discord" data-testid="error-join">Join with Discord</a>');
    expect(html).toContain('href="/" data-testid="error-home">Back to the homepage</a>');
    expect(html).toContain('href="/events" data-testid="error-all-events">Browse all events</a>');
  });

  it.each([400, 410] as const)("keeps the %s recovery links alongside the form", (code) => {
    const html = renderOffline(code);
    expect(html).toContain('href="/events" data-testid="error-events">Browse all events</a>');
    expect(html).toContain('href="/" data-testid="error-home">Back to the homepage</a>');
  });

  it("leaves the catastrophic fallback minimal, with both placeholders and no form", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fallback = readFileSync(join(root, "web/src/error.html"), "utf8");
    expect(fallback).toContain("%sveltekit.status%");
    expect(fallback).toContain("%sveltekit.error.message%");
    expect(fallback).toContain("<!doctype html>");
    expect(fallback).toContain('<html lang="en">');
    expect(fallback).toContain('<meta charset="utf-8" />');
    expect(fallback).not.toContain('data-testid="error-events-search"');
    expect(fallback).not.toContain('action="/events"');
  });
});
