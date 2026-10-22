// Acceptance: Kit outage headers point at Discord and the generic 404 restores search.
//
// Today web/src/lib/ErrorShell.svelte renders <Shell> with no header override,
// so every Kit error status falls back to the guest header: "Sign in with
// Discord" pointing at the ordinary sign-in (/auth/discord, a 302 to Discord;
// explicit join/RSVP entries use /join/discord instead). On
// 403/429/500/503 that start is dead or a loop — Hono deliberately renders
// those headers with an invite "Open Discord" CTA instead
// (src/error-pages.tsx, src/page-shell.tsx cta branch) — and Kit's generic
// 404 branch offers links but no search form, while Hono's NotFoundPage and
// Kit's own EventMissing twin both carry one (GET /events?q=).
//
// Locked contract (the paired build satisfies without editing this file):
// - 403/429/500/503 headers render the invite "Open Discord" CTA with the
//   same href/label/testid contract as Hono's cta branch; no OAuth start
//   (/join/discord or /auth/discord) anywhere on those pages.
// - 400/404/410 headers keep the sign-in CTA exactly as today (parity pin).
// - Kit 400/404/410 gain the event search form, markup-matching the Hono
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
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KitErrorStatus } from "../src/kit-errors";

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
const SIGNIN: KitErrorStatus[] = [400, 404, 410];
const ALL: KitErrorStatus[] = [400, 404, 403, 410, 429, 500, 503];

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

// The shell offers recovery with no session, DB or network reads: every
// render runs with fetch refusing, and any call fails the rendering test.
function renderShell(code: KitErrorStatus): { head: string; body: string } {
  const fetchSpy = vi.fn(() => {
    throw new Error("kit error fixtures must remain offline");
  });
  vi.stubGlobal("fetch", fetchSpy);
  try {
    const rendered = requireRender()(code, INVITE);
    expect(fetchSpy, `${code} renders without a network read`).not.toHaveBeenCalled();
    return rendered;
  } finally {
    vi.unstubAllGlobals();
  }
}

function headerAccount(body: string, label: string): string {
  const matches = body.match(/<nav[^>]*class="header-account"[^>]*>[\s\S]*?<\/nav>/g);
  expect(matches, `${label} renders exactly one account nav`).toHaveLength(1);
  return matches![0]!;
}

function signinCta(header: string, label: string): { href: string; text: string } {
  const matches = header.match(/<a\b[^>]*data-testid="signin"[^>]*>[\s\S]*?<\/a>/g);
  expect(matches, `${label} header keeps exactly one signin CTA`).toHaveLength(1);
  const anchor = matches![0]!;
  expect(anchor, `${label} signin CTA keeps the button class`).toMatch(/class="[^"]*\bbtn\b/);
  const href = /href="([^"]*)"/.exec(anchor)?.[1];
  expect(href, `${label} signin CTA has an href`).toBeDefined();
  const text = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(anchor)?.[1]?.replace(/\s+/g, " ").trim();
  return { href: href!, text: text ?? "" };
}

function searchForms(body: string): string[] {
  return body.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
}

function mainHtml(body: string, label: string): string {
  const match = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(body);
  expect(match, `${label} renders a main landmark`).not.toBeNull();
  return match![1]!;
}

describe("acceptance: outage headers point at Discord, never the OAuth start", () => {
  it.each(OUTAGE)("%d header renders the invite Open Discord CTA", (code) => {
    const { body } = renderShell(code);
    const header = headerAccount(body, `${code}`);
    expect(header).toContain("Welcome, guest");
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
    expect(header).not.toContain("/join/discord");
    expect(header).not.toContain("/auth/discord");
  });

  it("no outage page sends the member to the OAuth start anywhere", () => {
    for (const code of OUTAGE) {
      const { body } = renderShell(code);
      expect(body, `${code} body links no join journey`).not.toContain("/join/discord");
      expect(body, `${code} body links no ordinary sign-in`).not.toContain("/auth/discord");
    }
  });
});

describe("acceptance: Kit 404 restores the event search form", () => {
  function searchForm(code: KitErrorStatus = 404): string {
    const { body } = renderShell(code);
    const forms = searchForms(body);
    expect(forms, `${code} renders exactly one form`).toHaveLength(1);
    expect(mainHtml(body, `${code}`), `the ${code} form lives in the main landmark`).toContain(
      forms[0],
    );
    return forms[0]!;
  }

  it("targets the event index with a GET search", () => {
    const tag = /<form\b[^>]*>/.exec(searchForm())![0];
    // Attribute order is the builder's choice; the contract is the twins'.
    expect(tag).toMatch(/action="\/events"/);
    expect(tag).toMatch(/method="get"/);
    expect(tag).toMatch(/role="search"/);
    expect(tag).toMatch(/class="error-events-search"/);
  });

  it("labels the query input and names it q", () => {
    const form = searchForm();
    expect(form).toMatch(/<label[^>]*for="error-events-search"[^>]*>\s*Search events\s*<\/label>/);
    expect(form).toContain('id="error-events-search"');
    expect(form).toContain('name="q"');
    expect(form).toContain('type="search"');
    expect(form).toContain('placeholder="Search events…"');
    expect(form).toContain('autocomplete="off"');
    expect(form).toContain('data-testid="error-events-search"');
  });

  it("submits with the twin submit button", () => {
    const form = searchForm();
    const button =
      /<button\b(?=[^>]*type="submit")(?=[^>]*data-testid="error-events-search-submit")[^>]*>([\s\S]*?)<\/button>/.exec(
        form,
      );
    expect(button, "404 form keeps the twin submit button").not.toBeNull();
    expect(button![1]!.replace(/\s+/g, " ").trim()).toBe("Search events");
  });

  it.each([400, 410] as const)("%d renders the same search form as 404", (code) => {
    // The three forms are verbatim copies; 404's action/method/role/class/
    // label/input/submit contract is pinned above, so byte equality extends
    // that contract to 400/410.
    expect(searchForm(code)).toBe(searchForm(404));
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
    expect(body).toContain('data-testid="error-join"');
    expect(body).toContain('href="/auth/discord"');
    expect(body).toContain('data-testid="error-home"');
    expect(body).toContain('data-testid="error-all-events"');
  });

  it.each([403, 429, 500, 503] as const)(
    "%d renders no search form: the form is 400/404/410-only",
    (code) => {
      const { body } = renderShell(code);
      expect(searchForms(body), `${code} renders no form`).toHaveLength(0);
    },
  );
});

describe("controls: sign-in statuses, selectors, indexes and read budget stay put", () => {
  it.each(SIGNIN)("%d header keeps the sign-in CTA", (code) => {
    const { body } = renderShell(code);
    const header = headerAccount(body, `${code}`);
    // OAuth is alive on these statuses, so the header is unchanged: the
    // guest caption plus the ordinary sign-in link (/auth/discord).
    expect(header).toContain("Welcome, guest");
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
    expect(head).toContain("noindex");
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
    expect(page).toContain(
      "<ErrorShell code={status} inviteUrl={FALLBACK_INVITE} adminBack={adminBack} />",
    );
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page).not.toMatch(/page\.error/);
  });

  it.each(OUTAGE)("%d body keeps its invite recovery links", (code) => {
    const { body } = renderShell(code);
    expect(body).toContain('data-testid="error-invite"');
    expect(body).toContain(`href="${INVITE}"`);
  });
});
