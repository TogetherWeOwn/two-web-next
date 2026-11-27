// Acceptance: Kit outage headers point at Discord and the generic 404 keeps search.
//
// Without a header override, web/src/lib/ErrorShell.svelte falls back to the
// guest header on every Kit error status: "Sign in with Discord" pointing at
// the ordinary sign-in (/auth/discord, a 302 to Discord; explicit join/RSVP
// entries use /join/discord instead). On 403/429/500/503 that start is dead
// or a loop — Hono deliberately renders those headers with an invite "Open
// Discord" CTA instead (src/error-pages.tsx, src/page-shell.tsx cta branch).
// The 404 search form (GET /events?q=) shipped in #1483; this suite pins it
// together with the header so the two recovery paths stay consistent.
//
// Locked contract (the paired build satisfies without editing this file):
// - 403/429/500/503 headers render the invite "Open Discord" CTA with the
//   same href/label/testid contract as Hono's cta branch; no OAuth start
//   (/join/discord or /auth/discord) anywhere on those pages.
// - 400/404/410/422 headers keep the sign-in CTA exactly as today (parity pin).
// - Kit 400/404/410 keep the event search form, markup-matching the Hono
//   NotFoundPage and EventMissing twins; other statuses gain no form.
// - The boundary still reads no session/DB/network; noindex intact;
//   data-testid="signin" stays on the header CTA for every status.
//
// Hermetic: SSR renders of the real ErrorShell.svelte (the kit-error-shell
// esbuild harness shape, no browser) with a fixture invite, plus source pins
// on the shell and the root boundary. Local fixtures only, no live services.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { type DefaultTreeAdapterMap, Parser, type ParserOptions, type Token } from "parse5";
import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import type { KitErrorStatus } from "../src/kit-errors";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type Template = DefaultTreeAdapterMap["template"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

const INVITE = "https://discord.gg/fixture-invite";
// Hono sends these members to the invite because the OAuth start cannot help
// them; Kit must match. Every other Kit status keeps the sign-in header.
const OUTAGE: KitErrorStatus[] = [403, 429, 500, 503];
const SIGNIN: KitErrorStatus[] = [400, 404, 410, 422];
const ALL: KitErrorStatus[] = [400, 404, 403, 410, 422, 429, 500, 503];
const OAUTH_START = /\/(?:join|auth)\/discord/;

type RenderErrorShell = (
  code: KitErrorStatus,
  inviteUrl: string,
) => {
  head: string;
  body: string;
};

let renderErrorShell: RenderErrorShell | null = null;
let harnessError: unknown = null;

beforeAll(async () => {
  try {
    const worktree = `${root}/`;
    const scratch = mkdtempSync(join(tmpdir(), "kit-outage-header-404-search-"));
    const entry = join(scratch, "kit-outage-header-404-search-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import ErrorShell from ${JSON.stringify(join(worktree, "web/src/lib/ErrorShell.svelte"))};
export function renderErrorShell(code, inviteUrl) {
  const { head, body } = render(ErrorShell, { props: { code, inviteUrl } });
  return { head, body };
}
`,
    );
    const outfile = join(scratch, "kit-outage-header-404-search.mjs");
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
          name: "kit-outage-header-404-search-svelte-ssr",
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
    ({ renderErrorShell } = (await import(pathToFileURL(outfile).href)) as {
      renderErrorShell: RenderErrorShell;
    });
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    // Stored, not thrown: each render test rethrows it so a broken harness
    // reads as explicit failures, never silent skips.
    harnessError = error;
  }
});

function requireRender(): RenderErrorShell {
  if (harnessError) throw harnessError;
  if (!renderErrorShell) throw new Error("error-shell render harness did not initialize");
  return renderErrorShell;
}

class OutageParser extends Parser<DefaultTreeAdapterMap> {
  override onStartTag(token: Token.TagToken): void {
    // Tree construction can discard a start tag and all its attributes.
    const oauth = token.attrs.find(({ value }) => OAUTH_START.test(value));
    expect(oauth?.value, `OAuth reference on ${token.tagName}`).toBeUndefined();
    super.onStartTag(token);
  }
}

// The shell offers recovery with no session, DB or network reads: every
// render runs with fetch refusing, and any call fails the rendering test.
function renderShell(code: KitErrorStatus, scriptingEnabled = false) {
  const fetchSpy = vi.fn(() => {
    throw new Error("kit error fixtures must remain offline");
  });
  vi.stubGlobal("fetch", fetchSpy);
  try {
    const rendered = requireRender()(code, INVITE);
    expect(fetchSpy, `${code} renders without a network read`).not.toHaveBeenCalled();
    const options: ParserOptions<DefaultTreeAdapterMap> = {
      scriptingEnabled,
      onParseError: (error) => {
        throw new Error(`${code} shell HTML parse error ${error.code}`);
      },
    };
    const parser = OUTAGE.includes(code) ? OutageParser : Parser;
    const document = parser.parse(
      `<!doctype html><html><head>${rendered.head}</head><body>${rendered.body}</body></html>`,
      options,
    );
    const nodes = elements(document);
    const head = nodes.find((node) => node.tagName === "head");
    const body = nodes.find((node) => node.tagName === "body");
    assert(head && body, `${code} shell has a head and body`);
    return { document, head, body };
  } finally {
    vi.unstubAllGlobals();
  }
}

function headerAccount(body: Node, label: string): Element {
  const nodes = parsedRoots(body).flatMap((root) => elements(root));
  const matches = nodes.filter(
    (node) => node.tagName === "nav" && attr(node, "class") === "header-account",
  );
  const nav = elements(body).find((node) => matches.includes(node));
  assert(nav && matches.length === 1, `${label} renders exactly one account nav`);
  return nav;
}

const directText = (node: Element) =>
  node.childNodes.some((child) => "tagName" in child) ? "" : textOf(node);

function signinCta(header: Element, label: string) {
  const caption = elements(header).find((node) => attr(node, "class") === "account-caption");
  assert(caption, `${label} has an account caption`);
  expect(directText(caption)).toBe("Welcome, guest");
  const matches = parsedRoots(header).flatMap((root) =>
    elements(root).filter((node) => node.tagName === "a" && attr(node, "data-testid") === "signin"),
  );
  const anchor = elements(header).find((node) => matches.includes(node));
  assert(anchor && matches.length === 1, `${label} header keeps exactly one signin CTA`);
  expect(attr(anchor, "class")?.split(/\s+/), `${label} signin CTA class`).toContain("btn");
  const href = attr(anchor, "href");
  expect(href, `${label} signin CTA has an href`).toBeDefined();
  return { href, text: directText(anchor).replace(/\s+/g, " ").trim() };
}

function parsedRoots(root: Node): Node[] {
  const roots = [root];
  for (const subtree of roots)
    for (const node of elements(subtree))
      if ("content" in node) roots.push((node as Template).content);
  return roots;
}

function searchForms(body: Node): Element[] {
  const nodes = parsedRoots(body).flatMap((root) => elements(root));
  return nodes.filter((node) => node.tagName === "form");
}

function expectNoOAuthStart(root: Node, label: string): void {
  const roots = parsedRoots(root);
  const nodes = roots.flatMap((subtree) => elements(subtree));
  const values = nodes.flatMap((node) => node.attrs.map(({ value }) => value));
  values.push(...roots.map(textOf));
  for (const node of [...roots, ...nodes])
    if ("childNodes" in node)
      for (const child of node.childNodes) if ("data" in child) values.push(child.data);
  const oauth = values.find((value) => OAUTH_START.test(value));
  expect(oauth, label).toBeUndefined();
}

describe("acceptance: outage headers point at Discord, never the OAuth start", () => {
  it.each(OUTAGE)("%d header renders the invite Open Discord CTA", (code) => {
    const { body } = renderShell(code);
    const header = headerAccount(body, `${code}`);
    const cta = signinCta(header, `${code}`);
    // Same href/label/testid contract as Hono's cta branch
    // (src/page-shell.tsx): the invite that works during an outage.
    expect(cta.href).toBe(INVITE);
    expect(cta.text).toBe("Open Discord");
  });

  it.each(OUTAGE)("%d header never links the OAuth start", (code) => {
    const { body } = renderShell(code);
    const header = headerAccount(body, `${code}`);
    // Ordinary sign-in is /auth/discord (a 302 to Discord); explicit
    // join/RSVP entries use /join/discord instead. During an outage
    // neither can help, so neither may appear in the header.
    expectNoOAuthStart(header, `${code} account nav`);
  });

  it("no outage page sends the member to the OAuth start anywhere", () => {
    for (const code of OUTAGE) {
      for (const mode of [false, true]) {
        const { document } = renderShell(code, mode);
        expectNoOAuthStart(document, `${code} scripting=${mode}`);
      }
    }
  });
});

describe("acceptance: Kit 404 restores the event search form", () => {
  function searchForm(code: KitErrorStatus = 404): Element {
    const { body } = renderShell(code);
    const forms = searchForms(body);
    const [form] = forms;
    assert(form && forms.length === 1, `${code} renders exactly one form`);
    const main = elements(body).find((node) => node.tagName === "main");
    assert(main, `${code} renders a main landmark`);
    expect(searchForms(main), `the ${code} form lives in the main landmark`).toContain(form);
    return form;
  }

  it("targets the event index with a GET search", () => {
    const form = searchForm();
    // Attribute order is the builder's choice; the contract is the twins'.
    expect(attr(form, "action")).toBe("/events");
    expect(attr(form, "method")).toBe("get");
    expect(attr(form, "role")).toBe("search");
    expect(attr(form, "class")).toBe("error-events-search");
  });

  it("labels the query input and names it q", () => {
    const nodes = elements(searchForm());
    const label = nodes.find((node) => node.tagName === "label");
    const input = nodes.find((node) => node.tagName === "input");
    assert(label && input);
    expect(attr(label, "for")).toBe("error-events-search");
    expect(directText(label).trim()).toBe("Search events");
    expect(attr(input, "id")).toBe("error-events-search");
    expect(attr(input, "name")).toBe("q");
    expect(attr(input, "type")).toBe("search");
    expect(attr(input, "placeholder")).toBe("Search events…");
    expect(attr(input, "autocomplete")).toBe("off");
    expect(attr(input, "data-testid")).toBe("error-events-search");
  });

  it("submits with the twin submit button", () => {
    const button = elements(searchForm()).find((node) => node.tagName === "button");
    assert(button, "404 form keeps the twin submit button");
    expect(attr(button, "type")).toBe("submit");
    expect(attr(button, "data-testid")).toBe("error-events-search-submit");
    expect(directText(button).replace(/\s+/g, " ").trim()).toBe("Search events");
  });

  it.each([400, 410] as const)("%d renders the same search form as 404", (code) => {
    function formTree(node: Node): unknown {
      if ("value" in node) return node.value;
      if ("data" in node && !/^(?:\[[\d-]*|\])?$/.test(node.data)) return { comment: node.data };
      if (!("tagName" in node)) return;
      const tree = "content" in node ? (node as Template).content : node;
      const attributes = [...node.attrs].sort((a, b) => a.name.localeCompare(b.name));
      const children = tree.childNodes.map(formTree).filter(Boolean);
      return { namespace: node.namespaceURI, tag: node.tagName, attributes, children };
    }
    expect(formTree(searchForm(code))).toEqual(formTree(searchForm(404)));
  });

  it("markup-matches the Hono NotFoundPage and EventMissing twins", () => {
    // The twins agree verbatim today; if either drifts, this test — owned
    // with this file — flags the contract for re-examination instead of
    // silently pinning a stale copy.
    const hono = readFileSync(join(root, "src/error-pages.tsx"), "utf8");
    const twin = readFileSync(join(root, "web/src/lib/EventMissing.svelte"), "utf8");
    const honoForm = /<form\b[^>]*>[\s\S]*?<\/form>/.exec(hono)?.[0];
    const twinForm = /<form\b[^>]*>[\s\S]*?<\/form>/.exec(twin)?.[0];
    expect(honoForm, "Hono NotFoundPage still carries the search form").toBeDefined();
    expect(twinForm, "EventMissing still carries the search form").toBeDefined();
    for (const token of [
      '<form action="/events" method="get" role="search" class="error-events-search">',
      '<label for="error-events-search">Search events</label>',
      'id="error-events-search"',
      'name="q"',
      'type="search"',
      'placeholder="Search events…"',
      'autocomplete="off"',
      'data-testid="error-events-search"',
      'data-testid="error-events-search-submit"',
      'type="submit"',
    ]) {
      expect(honoForm, `Hono twin keeps ${token}`).toContain(token);
      expect(twinForm, `EventMissing twin keeps ${token}`).toContain(token);
    }
  });

  it("keeps the 404 recovery links alongside the form", () => {
    const { body } = renderShell(404);
    const links = elements(body).filter((node) => node.tagName === "a");
    const join = links.find((node) => attr(node, "data-testid") === "error-join");
    expect(join && attr(join, "href")).toBe("/auth/discord");
    const testIds = links.map((node) => attr(node, "data-testid"));
    expect(testIds).toContain("error-home");
    expect(testIds).toContain("error-all-events");
  });

  it.each([403, 422, 429, 500, 503] as const)(
    "%d renders no search form: the form is 400/404/410-only",
    (code) => {
      const { body } = renderShell(code);
      expect(searchForms(body), `${code} renders no form`).toHaveLength(0);
      expect(searchForms(renderShell(code, true).body)).toHaveLength(0);
    },
  );
});

describe("controls: sign-in statuses, selectors, indexes and read budget stay put", () => {
  it.each(SIGNIN)("%d header keeps the sign-in CTA", (code) => {
    const { body } = renderShell(code);
    const header = headerAccount(body, `${code}`);
    // OAuth is alive on these statuses, so the header is unchanged: the
    // guest caption plus the ordinary sign-in link (/auth/discord).
    const cta = signinCta(header, `${code}`);
    expect(cta.href).toBe("/auth/discord");
    expect(cta.text).toBe("Sign in with Discord");
  });

  it.each(ALL)("%d header CTA keeps data-testid signin", (code) => {
    const { body } = renderShell(code);
    signinCta(headerAccount(body, `${code}`), `${code}`);
  });

  it.each(ALL)("%d stays out of search indexes", (code) => {
    const { head } = renderShell(code);
    const robots = elements(head).find(
      (node) => node.tagName === "meta" && attr(node, "name") === "robots",
    );
    expect(robots && attr(robots, "content")).toBe("noindex, nofollow");
  });

  it("rendering every status performs no network read", () => {
    for (const code of ALL) renderShell(code);
  });

  it("ErrorShell source performs no session or DB reads", () => {
    const shell = readFileSync(join(root, "web/src/lib/ErrorShell.svelte"), "utf8");
    expect(shell).not.toMatch(/dbFor|getSignedCookie|readSession|SESSION_STORE|cookies\.|fetch\(/);
    expect(shell).not.toContain("{@html");
    expect(shell).not.toContain("<script src");
  });

  it("the root boundary contract is unchanged: fallback, invite, noindex, no echo", () => {
    const page = readFileSync(join(root, "web/src/routes/+error.svelte"), "utf8");
    expect(page).toContain(
      "const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);",
    );
    // The request-id correlation prop is the only extra attribute allowed on
    // the boundary line; anything else (a message, an error echo) fails here.
    expect(page).toMatch(
      /<ErrorShell code=\{status\} inviteUrl=\{FALLBACK_INVITE\}(?: supportReference=\{page\.data\.requestId\})? adminBack=\{adminBack\} \/>/,
    );
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page).not.toMatch(/page\.error/);
  });

  it.each(OUTAGE)("%d body keeps its invite recovery links", (code) => {
    const { body } = renderShell(code);
    const invite = elements(body).find(
      (node) => node.tagName === "a" && attr(node, "data-testid") === "error-invite",
    );
    assert(invite, `${code} has an invite recovery link`);
    expect(attr(invite, "href")).toBe(INVITE);
  });
});
