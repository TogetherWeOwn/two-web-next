#!/usr/bin/env node
// Kit preview parity (TOG-12247): the SvelteKit /events/past page renders the
// same archive contract as the Hono PastEventsPage (src/events/pages.tsx).
//
// Two modes, one assertion set:
// - Unit mode (default, CI): serves the real Hono route with a pg-proxy
//   fixture, renders the real Svelte page (SSR-compiled with the web
//   workspace's own svelte/compiler, bundled by esbuild like ci/a11y-build)
//   with the same rows, then compares the archive <section> byte-for-byte,
//   modulo the boolean-attribute serialization each framework emits itself.
// - Preview mode (KIT_PREVIEW_URL + HONO_PREVIEW_URL): fetches /events/past
//   from both deployed Workers and applies the same section assertions.
//
// The shared section contract (testids, copy, pager, island script) is what
// the existing E2E and island binders already pin; this script proves the Kit
// page carries it, not that the two HTML documents are identical files.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const webDir = new URL("../web/", import.meta.url);
// svelte lives in the web workspace only; the root workspace never sees it.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler");

const APP_URL = "https://kit-parity.invalid";

// Bundle the Hono surface (real route + reads + pg-proxy fixture driver)
// to one ESM file. The generated entry lives in scratch and imports the
// worktree by absolute path; absWorkingDir + nodePaths keep bare imports
// (drizzle-orm, hono, …) resolving to the worktree's node_modules.
const worktree = fileURLToPath(root);
async function buildHonoBundle(scratch, outfile) {
  const entry = join(scratch, "kit-e2e-hono-entry.mjs");
  writeFileSync(
    entry,
    `
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import app from ${JSON.stringify(join(worktree, "test/app.ts"))};
import { events } from ${JSON.stringify(join(worktree, "src/db/admin-schema.ts"))};
export function eventRow(n) {
  const date = new Date(Date.UTC(2020, 0, n + 1, 19, 0, 0));
  return {
    id: n, icsSequence: 1n, eventKey: "kit-parity-" + n, title: "Parity night <&> " + n,
    game: n % 2 ? "Valheim" : null, description: null,
    startsAt: date, endsAt: date, timezone: "Europe/London", location: null,
    capacity: n % 3 === 0 ? 12 : null, status: "past",
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: null, rsvpOpen: true, recurrenceFrequency: null,
    recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: date, updatedAt: date,
  };
}
export function archive(total, appUrl) {
  const rows = Array.from({ length: total }, (_, i) => eventRow(total - i));
  const db = drizzle(async (sql, params) => {
    if (sql.startsWith('select count(*) from "events"')) return { rows: [[total]] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    const hasOffset = sql.includes(" offset ");
    const offset = hasOffset ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(hasOffset ? -2 : -1));
    const columns = Object.keys(getTableColumns(events));
    return { rows: rows.slice(offset, offset + limit).map((row) => columns.map((k) => {
      const value = row[k];
      return value instanceof Date ? value.toISOString() : value;
    })) };
  });
  const env = { APP_URL: appUrl, ADMIN_DB: db };
  return { rows, request: (path) => app.request(path, {}, env) };
}
`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    jsx: "automatic",
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "node_modules"), join(worktree, "web/node_modules")],
  });
}

// Bundle the real Svelte page to an SSR render function. .svelte sources are
// compiled with the web workspace's svelte/compiler; #lib/* resolves through
// the web tsconfig imports map, relative src/* through the worktree.
async function buildKitBundle(scratch, outfile) {
  const accountFixture = join(scratch, "account-chrome-fixture.svelte");
  writeFileSync(
    accountFixture,
    `
<script lang="ts">
import Shell from ${JSON.stringify(join(worktree, "web/src/lib/Shell.svelte"))};
</script>
{#snippet accountChrome()}
  <strong data-testid="explicit-account-chrome">Signed in as a member</strong>
{/snippet}
<Shell title="Account fixture" theme="schedule" accountChrome={accountChrome}>
  <h1>Account fixture</h1>
</Shell>
`,
  );
  const entry = join(scratch, "kit-e2e-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/events/past/+page.svelte"))};
import AccountFixture from ${JSON.stringify(accountFixture)};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderAccountFixture() {
  const { head, body } = render(AccountFixture);
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const result = await build({
    metafile: true,
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
        name: "kit-e2e-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, { generate: "server", dev: false, filename: args.path });
            // Compiled output keeps the component's relative imports (../../..),
            // so resolve them from the component's own directory, not web/src.
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  return Object.keys(result.metafile.inputs);
}

const sectionOf = (html) => {
  const match = html.match(/<section[^>]*data-testid="past-events"[\s\S]*?<\/section>/);
  if (!match) throw new Error("Archive section is missing");
  return match[0];
};

// Svelte SSR hydration markers have no Hono counterpart. Stripped to a fixed
// point so no single removal can splice a new marker together.
function stripHydrationMarkers(html) {
  let previous;
  do {
    previous = html;
    html = html.replace(/\x3c!--\[[\d-]*-->|\x3c!--\]-->/g, "");
  } while (html !== previous);
  return html;
}

// Page-owned serialization the two frameworks legitimately emit differently;
// the archive section contract itself must be identical.
function normalize(html) {
  return (
    stripHydrationMarkers(html)
      // Boolean-attribute serialization differs per framework (bare, ="",
      // ="true"); the contract is presence, pinned separately by expectArchive.
      .replace(/=(?:""|"true")(?=[\s>])/g, "")
      // `>` escaping is serializer-owned (Hono emits &gt;, Svelte a bare >);
      // the security-relevant escapes (&amp;, &lt;, quotes) are pinned exactly.
      .replace(/&gt;/g, ">")
      // Inter-tag whitespace is a serializer choice, not a contract.
      .replace(/>\s+</g, "><")
      .trim()
  );
}

const failures = [];
let browserFixturesRun = false;
function check(label, condition, detail = "") {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function expectShell(document) {
  const count = (pattern) => [...document.matchAll(pattern)].length;
  const scripts = [...document.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  check("one document head is assembled", count(/<head(?:\s|>)/gi) === 1);
  check("one semantic main is rendered", count(/<main(?:\s|>)/gi) === 1);
  // No hydration bundle or inline bootstrap (csr=false, CSP script-src
  // 'self'): exactly the two deferred first-party island binders, in Hono's
  // order. The copy-link binder arrived with the calendar subscription help.
  check(
    "only the copy-link and archive island binders load",
    scripts.length === 2 &&
      scripts[0] === '<script src="/islands/copy-link.js" defer>' &&
      scripts[1] === '<script src="/islands/past-events.js" defer>',
  );
  check("one canonical URL is rendered", count(/<link rel="canonical"/g) === 1);
  check("archive shell carries the schedule theme", document.includes('data-theme="schedule"'));
  check(
    "archive navigation marks Events current",
    document.includes('href="/events" aria-current="page"'),
  );
  check("skip link targets the main landmark", document.includes('class="skip-link" href="#main"'));
  check("primary navigation has an accessible name", document.includes('aria-label="Primary"'));
  check(
    "static account chrome stays guest-only",
    document.includes("Welcome, guest") && !document.includes("Sign out"),
  );
  check(
    "app template leaves theme choice to the shared layout",
    !/<body[^>]*class=/i.test(document),
  );
}

// The Kit page serves its tokens and Tailwind output from web/src/app.css
// (compiled by the web vite build into .svelte-kit/output), never from
// public/theme-tokens.css, which stays Hono-only. Build it here so the
// fixture injects exactly what Kit serves: a static read of app.css would
// miss the Tailwind pipeline (Preflight, @theme emission, utilities), which
// is how the Preflight underline regression went undetected.
function kitCompiledCss() {
  execFileSync("npm", ["run", "build", "--prefix", "web"], { stdio: "inherit" });
  const assets = new URL(
    "../web/.svelte-kit/output/client/_app/immutable/assets/",
    import.meta.url,
  );
  const names = readdirSync(assets).filter((name) => name.endsWith(".css"));
  if (names.length === 0) throw new Error("Kit build emitted no CSS assets");
  return names.map((name) => readFileSync(new URL(name, assets), "utf8")).join("\n");
}

async function browserShellFixtures(document) {
  const css = [
    ...["styles.css", "theme.css", "schedule-theme.css"].map((name) =>
      readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"),
    ),
    kitCompiledCss(),
  ]
    .join("\n")
    .replace(/@font-face\s*\{[^}]*\}/g, "");
  const fixture = document
    .replace(/<link rel="(?:stylesheet|preload)"[^>]*\/?\s*>/g, "")
    .replace(/<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*\/?\s*>/g, "")
    .replace(/<script src="\/islands\/past-events\.js"[^>]*><\/script>/g, "")
    .replace(
      'src="/logo.svg"',
      'src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22/%3E"',
    )
    .replace("</head>", `<style>${css}</style></head>`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({
      content: '.base-theme[data-theme="schedule"] { --theme-schedule-accent: #ff00aa; }',
    });
    const accent = await page.evaluate(() =>
      getComputedStyle(document.querySelector(".base-theme"))
        .getPropertyValue("--color-accent")
        .trim(),
    );
    check("schedule theme accepts pluggable semantic token values", accent === "#ff00aa");
    // Preflight guard: the public sheets never set text-decoration, so content
    // links rely on the UA underline. A Tailwind Preflight in the Kit cascade
    // strips it (colour alone distinguishes the link: WCAG 1.4.1).
    const underline = await page.evaluate(() => {
      const link = document.querySelector(
        'main.events-page section[data-testid="past-events"] p a',
      );
      return link ? getComputedStyle(link).textDecorationLine : null;
    });
    check(
      "content links keep their underline without Preflight",
      underline === "underline",
      `got ${underline}`,
    );
    // Canvas guard: the Kit canvas must stay dark. public/styles.css sets an
    // unlayered body{background:var(--paper)} cream rule (#f4efe6), so a
    // layered Kit body rule loses to it in both stylesheet orders and the
    // canvas shows cream on overscroll bounce, pinch zoom-out and mobile bar
    // tinting. The unlayered `html` rule paints the canvas regardless, and
    // `html body` outranks the bare `body` selector whichever sheet loads
    // first.
    const canvas = await page.evaluate(() => ({
      root: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    }));
    check(
      "lobby canvas paints the dark surface, not cream",
      canvas.root !== "rgba(0, 0, 0, 0)" && canvas.body !== "rgb(244, 239, 230)",
      `got html ${canvas.root}, body ${canvas.body}`,
    );
    const desktop = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      wrapperWidth: document.querySelector(".base-theme")?.getBoundingClientRect().width,
    }));
    check("desktop shell fits the viewport", desktop.width <= desktop.viewport);
    check("desktop shell has a themed layout root", desktop.wrapperWidth > 0);

    await page.keyboard.press("Tab");
    const skipFocused = await page.evaluate(
      () => document.activeElement?.matches("a.skip-link") === true,
    );
    check("keyboard focus reaches the skip link first", skipFocused);
    await page.keyboard.press("Enter");
    const skipTargetFocused = await page.evaluate(
      () => location.hash === "#main" && document.activeElement?.id === "main",
    );
    check("skip link moves keyboard focus to main", skipTargetFocused);

    await page.setViewportSize({ width: 375, height: 812 });
    const mobile = await page.evaluate(() => {
      const nav = document.querySelector(".main-nav").getBoundingClientRect();
      const links = [...document.querySelectorAll(".main-nav a")].map((link) => {
        const rect = link.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      });
      return {
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        navVisible: nav.width > 0 && nav.height > 0,
        linksVisible: links.every(Boolean),
      };
    });
    check("mobile shell has no horizontal overflow", mobile.width <= mobile.viewport);
    check(
      "mobile primary navigation and links remain visible",
      mobile.navVisible && mobile.linksVisible,
    );
    check("browser fixture has no uncaught errors", pageErrors.length === 0, pageErrors.join("; "));
    await page.close();
  } finally {
    await browser.close();
  }
}

function expectArchive(html, { keys, pager }) {
  check(
    "section renders with the archive testids",
    html.includes('data-testid="past-events"') && html.includes('data-testid="past-events-list"'),
  );
  const found = [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
  check(
    "event keys render newest-first",
    JSON.stringify(found) === JSON.stringify(keys),
    `got ${JSON.stringify(found)}`,
  );
  check("never indexes", html.includes('<meta name="robots" content="noindex, follow"'));
  check(
    "island script is the shared binder",
    html.includes('<script src="/islands/past-events.js"'),
  );
  for (const href of pager) check(`pager links ${href}`, html.includes(`href="${href}"`));
  check(
    "no RSVP surface",
    !html.includes("/rsvp") && !html.match(/data-testid="(?:rsvp-|waitlist-|event-going-count)/),
  );
}

async function unitParity() {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-e2e-"));
  try {
    // Scratch entries resolve worktree modules the way ci/a11y-test-worker.mjs
    // does: the worktree's own node_modules plus the web workspace's (svelte).
    symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
    symlinkSync(resolve("web/node_modules"), join(scratch, "web_node_modules"), "dir");
    const honoBundle = join(scratch, "hono.mjs");
    const kitBundle = join(scratch, "kit.mjs");
    await buildHonoBundle(scratch, honoBundle);
    const kitModules = await buildKitBundle(scratch, kitBundle);
    const { archive } = await import(pathToFileURL(honoBundle).href);
    const { renderPage, renderAccountFixture } = await import(pathToFileURL(kitBundle).href);
    const appShell = readFileSync(new URL("src/app.html", webDir), "utf8");
    const applicationModules = kitModules.filter((module) => !module.includes("node_modules/"));
    const forbiddenModules = applicationModules.filter((module) =>
      /(?:^|[\\/])(?:db|database|session)(?:[\\/.]|$)/i.test(module),
    );
    check(
      "compiled shared static shell has no database or session modules",
      forbiddenModules.length === 0,
      forbiddenModules.join(", "),
    );
    const accountHtml = renderAccountFixture();
    check(
      "explicit account chrome renders in the shared shell",
      accountHtml.includes('data-testid="explicit-account-chrome"') &&
        accountHtml.includes("Signed in as a member") &&
        !accountHtml.includes("Welcome, guest"),
    );

    const states = [
      { path: "/events/past", page: 1, total: 25, pager: ["/events/past?page=2"] },
      { path: "/events/past?page=2", page: 2, total: 25, pager: ["/events/past"] },
      { path: "/events/past", page: 1, total: 0, pager: [] },
      { path: "/events/past?page=9", page: 9, total: 25, pager: [] },
    ];
    for (const { path, page, total, pager } of states) {
      const { rows, request } = archive(total, APP_URL);
      const res = await request(path);
      check(`${path} (total ${total}): Hono answers 200`, res.status === 200, `got ${res.status}`);
      const honoHtml = await res.text();
      const pageSize = 20;
      const totalPages = Math.ceil(total / pageSize);
      const keys =
        page > totalPages
          ? []
          : rows.slice((page - 1) * pageSize, page * pageSize).map((r) => r.eventKey);
      console.log(`--- Hono ${path} ---`);
      expectArchive(honoHtml, { keys, pager });

      // Same rows through the Kit page: the load function only reorders the
      // same reads (normalizePastPage + listPast). listPast maps the raw
      // going_count column onto PublicEvent.goingCount; the synthetic Kit
      // rows must carry the mapped shape, not the raw column.
      const kitRows = keys.map((key) => {
        const row = rows.find((r) => r.eventKey === key);
        return {
          eventKey: row.eventKey,
          title: row.title,
          game: row.game,
          startsAt: new Date(row.startsAt),
          timezone: row.timezone,
          goingCount: 0,
          capacity: row.capacity,
        };
      });
      const kitHtml = renderPage({
        rows: kitRows,
        page,
        hasMore: page === 1 && total > pageSize,
        totalPages,
        appUrl: APP_URL,
      });
      console.log(`--- Kit ${path} ---`);
      expectArchive(kitHtml, { keys, pager });
      const kitHead = kitHtml.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
      const kitBody = kitHtml.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? "";
      const document = appShell
        .replace("%sveltekit.head%", kitHead)
        .replace("%sveltekit.body%", kitBody);
      expectShell(document);
      if (!browserFixturesRun) {
        await browserShellFixtures(document);
        browserFixturesRun = true;
      }

      const same = normalize(sectionOf(honoHtml)) === normalize(sectionOf(kitHtml));
      check(
        `${path}: archive section is byte-identical (modulo boolean serialization)`,
        same,
        "section HTML differs",
      );
      if (!same && process.env.KIT_E2E_DUMP) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(process.env.KIT_E2E_DUMP + "-hono.html", sectionOf(honoHtml));
        writeFileSync(process.env.KIT_E2E_DUMP + "-kit.html", sectionOf(kitHtml));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function previewParity(kitBase, honoBase) {
  for (const base of [kitBase, honoBase]) {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "preview base must be an HTTP(S) origin without credentials, path, query or fragment",
      );
    }
  }
  // Expected renderer derives from the shipped manifest
  // (src/route-ownership.ts ROUTE_MANIFEST), not a hard-coded "kit": with
  // enabled:false the Kit preview Worker sends /events/past to honoFetch and
  // never sets the marker — that is the rollback. Flipping enabled flips this
  // gate for the right reason. Query strings never change ownership.
  const ownershipSource = readFileSync(
    new URL("../src/route-ownership.ts", import.meta.url),
    "utf8",
  );
  const manifestMatch = ownershipSource.match(
    /path:\s*"\/events\/past"[^}]*enabled:\s*(true|false)/,
  );
  if (!manifestMatch)
    throw new Error("preview parity: cannot derive /events/past owner from ROUTE_MANIFEST");
  const kitOwnsArchive = manifestMatch[1] === "true";
  const expectedMarker = kitOwnsArchive ? "kit" : null;
  for (const path of ["/events/past", "/events/past?page=2"]) {
    const [kitRes, honoRes] = await Promise.all(
      [kitBase, honoBase].map((base) =>
        fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(15_000) }),
      ),
    );
    check(`Kit ${path}: HTTP 200`, kitRes.status === 200, `got ${kitRes.status}`);
    check(`Hono ${path}: HTTP 200`, honoRes.status === 200, `got ${honoRes.status}`);
    // Renderer marker (src/route-ownership.ts dispatchHookRequest): the Kit
    // branch sets x-two-renderer=kit; Hono (honoFetch or the catch-all) never
    // does. Present only when the manifest gives the path to Kit.
    const kitMarker = kitRes.headers.get("x-two-renderer");
    check(
      kitOwnsArchive
        ? `Kit ${path}: renderer marker proves Kit answered`
        : `Kit ${path}: no Kit marker (manifest keeps it on Hono)`,
      kitMarker === expectedMarker,
      `got ${JSON.stringify(kitMarker)}`,
    );
    check(
      `Hono ${path}: no Kit renderer marker`,
      honoRes.headers.get("x-two-renderer") === null,
      `got ${JSON.stringify(honoRes.headers.get("x-two-renderer"))}`,
    );
    if (kitRes.status !== 200 || honoRes.status !== 200) continue;
    const [kitHtml, honoHtml] = await Promise.all([kitRes, honoRes].map((r) => r.text()));
    const keys = [...kitHtml.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
    console.log(`--- Kit ${path} ---`);
    expectArchive(kitHtml, { keys, pager: [] });
    expectShell(kitHtml);
    const same = normalize(sectionOf(kitHtml)) === normalize(sectionOf(honoHtml));
    check(`${path}: preview sections match staging`, same, "section HTML differs");
  }
  // /api/* still reaches the unchanged Hono app through the Kit catch-all.
  const apiRes = await fetch(new URL("/api/agent-events", kitBase), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(
    "Kit /api/* reaches Hono (ingress refuses without credentials)",
    [401, 403, 404].includes(apiRes.status),
    `got ${apiRes.status}`,
  );
  // Reserved APIs never shadow: the Kit catch-all must not decorate Hono's
  // answer with the Kit marker, whatever the manifest claims.
  check(
    "Kit /api/* carries no Kit renderer marker",
    apiRes.headers.get("x-two-renderer") === null,
    `got ${JSON.stringify(apiRes.headers.get("x-two-renderer"))}`,
  );
}

const kitPreview = process.env.KIT_PREVIEW_URL?.trim() || null;
const honoPreview = process.env.HONO_PREVIEW_URL?.trim() || null;
if (Boolean(kitPreview) !== Boolean(honoPreview)) {
  console.error(
    "kit-preview-e2e: set both KIT_PREVIEW_URL and HONO_PREVIEW_URL, or neither (unit mode)",
  );
  process.exitCode = 2;
} else if (kitPreview && honoPreview) {
  await previewParity(kitPreview, honoPreview);
} else {
  await unitParity();
}
if (failures.length) {
  console.error(`kit-preview-e2e: ${failures.length} failed assertions`);
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log("kit-preview-e2e: all parity assertions passed");
}
