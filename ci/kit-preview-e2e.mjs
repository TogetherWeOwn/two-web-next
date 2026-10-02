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
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

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
  writeFileSync(entry, `
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
`);
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm",
    outfile, jsx: "automatic", logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "node_modules"), join(worktree, "web/node_modules")],
  });
}

// Bundle the real Svelte page to an SSR render function. .svelte sources are
// compiled with the web workspace's svelte/compiler; #lib/* resolves through
// the web tsconfig imports map, relative src/* through the worktree.
async function buildKitBundle(scratch, outfile) {
  const entry = join(scratch, "kit-e2e-entry.mjs");
  writeFileSync(entry, `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/events/past/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`);
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm",
    outfile, logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
    plugins: [{
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
    }],
  });
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
    html = html.replace(/<!--\[[\d-]*-->|<!--\]-->/g, "");
  } while (html !== previous);
  return html;
}

// Page-owned serialization the two frameworks legitimately emit differently;
// the archive section contract itself must be identical.
function normalize(html) {
  return stripHydrationMarkers(html)
    // Boolean-attribute serialization differs per framework (bare, ="",
    // ="true"); the contract is presence, pinned separately by expectArchive.
    .replace(/=(?:""|"true")(?=[\s>])/g, "")
    // `>` escaping is serializer-owned (Hono emits &gt;, Svelte a bare >);
    // the security-relevant escapes (&amp;, &lt;, quotes) are pinned exactly.
    .replace(/&gt;/g, ">")
    // Inter-tag whitespace is a serializer choice, not a contract.
    .replace(/>\s+</g, "><")
    .trim();
}

// The theme stylesheets hang every rule off the <body> class, so the Kit
// shell (web/src/app.html) must carry the class Hono's Layout emits.
const bodyClassOf = (html) => html.match(/<body(?:\s+class="([^"]*)")?[^>]*>/)?.[1] ?? null;

const failures = [];
function check(label, condition, detail = "") {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function expectArchive(html, { keys, pager }) {
  check("section renders with the archive testids",
    html.includes('data-testid="past-events"') && html.includes('data-testid="past-events-list"'));
  const found = [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
  check("event keys render newest-first", JSON.stringify(found) === JSON.stringify(keys), `got ${JSON.stringify(found)}`);
  check("never indexes", html.includes('<meta name="robots" content="noindex, follow"'));
  check("island script is the shared binder", html.includes('<script src="/islands/past-events.js"'));
  for (const href of pager) check(`pager links ${href}`, html.includes(`href="${href}"`));
  check("no RSVP surface", !html.includes("/rsvp") && !html.match(/data-testid="(?:rsvp-|waitlist-|event-going-count)/));
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
    await buildKitBundle(scratch, kitBundle);
    const { archive } = await import(pathToFileURL(honoBundle).href);
    const { renderPage } = await import(pathToFileURL(kitBundle).href);
    const appShell = readFileSync(new URL("src/app.html", webDir), "utf8");

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
      const keys = page > totalPages ? [] : rows.slice((page - 1) * pageSize, page * pageSize).map((r) => r.eventKey);
      console.log(`--- Hono ${path} ---`);
      expectArchive(honoHtml, { keys, pager });

      // Same rows through the Kit page: the load function only reorders the
      // same reads (normalizePastPage + listPast). listPast maps the raw
      // going_count column onto PublicEvent.goingCount; the synthetic Kit
      // rows must carry the mapped shape, not the raw column.
      const kitRows = keys.map((key) => {
        const row = rows.find((r) => r.eventKey === key);
        return { eventKey: row.eventKey, title: row.title, game: row.game, startsAt: new Date(row.startsAt), timezone: row.timezone, goingCount: 0, capacity: row.capacity };
      });
      const kitHtml = renderPage({
        rows: kitRows, page, hasMore: page === 1 && total > pageSize,
        totalPages, appUrl: APP_URL,
      });
      console.log(`--- Kit ${path} ---`);
      expectArchive(kitHtml, { keys, pager });

      const same = normalize(sectionOf(honoHtml)) === normalize(sectionOf(kitHtml));
      check(`${path}: archive section is byte-identical (modulo boolean serialization)`, same, "section HTML differs");
      // renderPage has no document shell; the Kit <body> comes from app.html.
      const honoBody = bodyClassOf(honoHtml);
      const kitBody = bodyClassOf(appShell);
      check(`${path}: app.html body carries Hono's theme class`, honoBody !== null && kitBody === honoBody, `Hono ${JSON.stringify(honoBody)}, Kit ${JSON.stringify(kitBody)}`);
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
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("preview base must be an HTTP(S) origin without credentials, path, query or fragment");
    }
  }
  for (const path of ["/events/past", "/events/past?page=2"]) {
    const [kitRes, honoRes] = await Promise.all([kitBase, honoBase].map((base) =>
      fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(15_000) })));
    check(`Kit ${path}: HTTP 200`, kitRes.status === 200, `got ${kitRes.status}`);
    check(`Hono ${path}: HTTP 200`, honoRes.status === 200, `got ${honoRes.status}`);
    if (kitRes.status !== 200 || honoRes.status !== 200) continue;
    const [kitHtml, honoHtml] = await Promise.all([kitRes, honoRes].map((r) => r.text()));
    const keys = [...kitHtml.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
    console.log(`--- Kit ${path} ---`);
    expectArchive(kitHtml, { keys, pager: [] });
    const same = normalize(sectionOf(kitHtml)) === normalize(sectionOf(honoHtml));
    check(`${path}: preview sections match staging`, same, "section HTML differs");
    const kitBody = bodyClassOf(kitHtml);
    const honoBody = bodyClassOf(honoHtml);
    check(`${path}: preview body carries the staging theme class`, honoBody !== null && kitBody === honoBody, `Hono ${JSON.stringify(honoBody)}, Kit ${JSON.stringify(kitBody)}`);
  }
  // /api/* still reaches the unchanged Hono app through the Kit catch-all.
  const apiRes = await fetch(new URL("/api/agent-events", kitBase), {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" }, body: "{}",
  });
  check("Kit /api/* reaches Hono (ingress refuses without credentials)", [401, 403, 404].includes(apiRes.status), `got ${apiRes.status}`);
}

const kitPreview = process.env.KIT_PREVIEW_URL;
const honoPreview = process.env.HONO_PREVIEW_URL;
if ((kitPreview ?? null) === null !== (honoPreview ?? null) === null) {
  console.error("kit-preview-e2e: set both KIT_PREVIEW_URL and HONO_PREVIEW_URL, or neither (unit mode)");
  process.exitCode = 2;
} else if (kitPreview && honoPreview) {
  await previewParity(kitPreview, honoPreview);
} else {
  await unitParity();
}
if (failures.length) {
  console.error(`kit-preview-e2e: ${failures.length} failed assertions`);
  process.exitCode = 1;
} else {
  console.log("kit-preview-e2e: all parity assertions passed");
}
