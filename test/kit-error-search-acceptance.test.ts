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
import { type DefaultTreeAdapterMap, Parser, type Token } from "parse5";
import { afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { kitErrorCopy, type KitErrorStatus } from "../src/kit-errors";
import app from "./app";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

type Document = DefaultTreeAdapterMap["document"];
type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type Template = DefaultTreeAdapterMap["template"];

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

class ErrorPageParser extends Parser<DefaultTreeAdapterMap> {
  readonly attributeValues: string[] = [];

  override onStartTag(token: Token.TagToken): void {
    // Capture attributes before the tree builder can drop or merge a tag.
    this.attributeValues.push(...token.attrs.map(({ value }) => value));
    super.onStartTag(token);
  }
}

function parseRenderedHtml(html: string, scriptingEnabled = false) {
  const parser = new ErrorPageParser({
    scriptingEnabled,
    onParseError: ({ code }) => expect(code).toBe("missing-doctype"),
  });
  parser.tokenizer.write(html, true);
  return parser;
}

// The shell offers recovery with no session, DB or network reads: rendering
// must succeed with fetch refusing every call, and never invoke it.
function renderOffline(code: KitErrorStatus, scriptingEnabled = false) {
  const fetchSpy = vi.fn(() => {
    throw new Error("kit error search fixtures must remain offline");
  });
  vi.stubGlobal("fetch", fetchSpy);
  try {
    return parseRenderedHtml(renderErrorShell(code), scriptingEnabled);
  } finally {
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }
}

function formOf(document: Document): Element {
  const form = elements(document).find((node) => node.tagName === "form");
  assert(form, "events-search form is missing from the rendered shell");
  return form;
}

function formTree(node: Node): unknown {
  if ("value" in node) return /[^ \t\n\f\r]/.test(node.value) ? node.value : undefined;
  if ("data" in node && !/^(?:\[[\d-]*|\])?$/.test(node.data)) return { comment: node.data };
  if (!("tagName" in node)) return;
  const tree = "content" in node ? (node as Template).content : node;
  const attributes = [...node.attrs].sort((a, b) => a.name.localeCompare(b.name));
  const children = tree.childNodes.map(formTree).filter(Boolean);
  return { namespace: node.namespaceURI, tag: node.tagName, attributes, children };
}

const directText = (node: Element) =>
  node.childNodes.some((child) => "tagName" in child) ? "" : textOf(node);

// Same markup/testids as EventMissing.svelte:61-76 — the contract the build
// copies into the shell. Each assert names the member-visible behavior it pins.
function expectSearchForm(document: Document, code: KitErrorStatus): void {
  const form = formOf(document);
  const nodes = elements(form);
  const label = nodes.find((node) => node.tagName === "label");
  const input = nodes.find((node) => node.tagName === "input");
  const button = nodes.find((node) => node.tagName === "button");
  // No-JS submit reaches GET /events with the query as `q`.
  expect(attr(form, "action"), `${code} form action`).toBe("/events");
  expect(attr(form, "method"), `${code} form method`).toBe("get");
  expect(attr(form, "role"), `${code} form role`).toBe("search");
  expect(attr(form, "class"), `${code} form class`).toBe("error-events-search");
  // Labelled search input, same accessible name as the Hono twin.
  expect(label && attr(label, "for"), `${code} label target`).toBe("error-events-search");
  expect(label && directText(label), `${code} label text`).toBe("Search events");
  expect(input && attr(input, "id"), `${code} input id`).toBe("error-events-search");
  expect(input && attr(input, "name"), `${code} input name`).toBe("q");
  expect(input && attr(input, "type"), `${code} input type`).toBe("search");
  expect(input && attr(input, "placeholder"), `${code} input placeholder`).toBe("Search events…");
  expect(input && attr(input, "autocomplete"), `${code} input autocomplete`).toBe("off");
  expect(input && attr(input, "data-testid"), `${code} input testid`).toBe("error-events-search");
  // Submit button with the same name.
  expect(button && attr(button, "data-testid")).toBe("error-events-search-submit");
  expect(button && directText(button), `${code} submit label`).toBe("Search events");
}

describe("Kit error shell search form (failing-first)", () => {
  it.each([404, 400, 410] as const)("renders the static search form in the %s block", (code) => {
    expectSearchForm(renderOffline(code).document, code);
  });

  it("matches the parsed EventMissing form", () => {
    const shellForm = formOf(renderOffline(404).document);
    const missingForm = formOf(parseRenderedHtml(renderMissing({ suggestions: [] })).document);
    expect(formTree(shellForm)).toEqual(formTree(missingForm));
  });

  it("no-JS submit from the Kit 404 form reaches /events?q=…", async () => {
    const form = formOf(renderOffline(404).document);
    // Extract the form contract a no-JS browser would follow: action, method,
    // and the query input name. Fails while the shell has no form.
    const action = attr(form, "action");
    const method = attr(form, "method");
    const input = elements(form).find((node) => node.tagName === "input");
    const inputName = input && attr(input, "type") === "search" && attr(input, "name");
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

describe("Kit error shell keeps its status-specific copy", () => {
  it.each([404, 400, 410] as const)(
    "keeps its status-specific title, lead and code (%s)",
    (code) => {
      const copy = kitErrorCopy(code);
      const nodes = elements(renderOffline(code).document);
      const find = (tag: string, name: string, value: string) =>
        nodes.find((node) => node.tagName === tag && attr(node, name) === value);
      const heading = find("h1", "id", "error-heading");
      const lead = find("p", "class", "lead");
      const status = find("p", "class", "recovery-code");
      const title = nodes.find((node) => node.tagName === "title");
      const robots = find("meta", "name", "robots");
      expect(heading && directText(heading)).toBe(copy.title);
      expect(lead && directText(lead)).toBe(copy.lead);
      expect(status && directText(status)).toBe(copy.code);
      expect(status && attr(status, "aria-hidden")).toBe("true");
      expect(title && directText(title)).toBe(`${copy.title} — Together We Own`);
      expect(robots && attr(robots, "content")).toBe("noindex, nofollow");
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
  function documentText(node: Node): string {
    if ("value" in node) return node.value;
    if ("data" in node) return node.data;
    const tree = "content" in node ? (node as Template).content : node;
    return "childNodes" in tree ? tree.childNodes.map(documentText).join("") : "";
  }

  function renderedValues(code: KitErrorStatus): string {
    return [false, true]
      .flatMap((scriptingEnabled) => {
        const { document, attributeValues } = renderOffline(code, scriptingEnabled);
        return [documentText(document), ...attributeValues];
      })
      .join("\n");
  }

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
      const output = renderedValues(code);
      expect(output).not.toContain("error-event-suggestion");
      expect(output).not.toContain("error-events-empty");
      expect(output).not.toContain("error-event-suggestions");
      expect(output).not.toContain("Happening soon");
    },
  );

  it.each([403, 429, 500, 503] as const)("adds no search form to the %s shell", (code) => {
    const output = renderedValues(code);
    expect(output).not.toContain("error-events-search");
    expect(output).not.toContain("error-events-search-submit");
  });
});

describe("Kit recovery UX the build must not change", () => {
  function recoveryLinks(document: Document) {
    return elements(document)
      .filter((node) => node.tagName === "a")
      .map((link) => [attr(link, "data-testid"), attr(link, "href"), directText(link)]);
  }

  it("keeps the 404 recovery links alongside the form", () => {
    const links = recoveryLinks(renderOffline(404).document);
    expect(links).toContainEqual(["error-join", "/auth/discord", "Join with Discord"]);
    expect(links).toContainEqual(["error-home", "/", "Back to the homepage"]);
    expect(links).toContainEqual(["error-all-events", "/events", "Browse all events"]);
  });

  it.each([400, 410] as const)("keeps the %s recovery links alongside the form", (code) => {
    const links = recoveryLinks(renderOffline(code).document);
    expect(links).toContainEqual(["error-events", "/events", "Browse all events"]);
    expect(links).toContainEqual(["error-home", "/", "Back to the homepage"]);
  });

  it("leaves the catastrophic fallback minimal, with the status placeholder, no message disclosure and no form", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fallback = readFileSync(join(root, "web/src/error.html"), "utf8");
    expect(fallback).toContain("%sveltekit.status%");
    expect(fallback).not.toContain("%sveltekit.error.message%");
    expect(fallback).toContain("<!doctype html>");
    expect(fallback).toContain('<html lang="en">');
    expect(fallback).toContain('<meta charset="utf-8">');
    expect(fallback).not.toContain('data-testid="error-events-search"');
    expect(fallback).not.toContain('action="/events"');
  });
});
