// Moderator navigation acceptance: saved-editor public/preview links (U1,
// criterion 2). Both saved-event editor twins expose the existing
// status-correct target: GET /e/:key serves drafts to moderators (403 for
// everyone else), published and past rows publicly, and cancelled rows as a
// 410 Gone page (src/events/routes-detail.tsx). So a draft editor links its
// preview (worded preview, never public), published and past editors link the
// public page, cancelled editors link nowhere (a 410 is a knowingly dead
// link), and unsaved/new forms omit the action. The link lives in the Status
// section beside the existing transitions, as a native anchor that works
// without JavaScript. Fixture-only: both real renderers (Hono JSX + Kit SSR),
// no DATABASE_URL, no network, no browser.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventFormPage } from "../src/admin/pages/event-form-page";
import type { EventRow } from "../src/admin/store";
import type { RosterQuery } from "../src/admin/table-list";
import type { KitEventEditRosterView, KitEventEditView } from "../src/admin/kit-event-edit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

const EVENT_KEY = "01J00000000000000000000015";
const PUBLIC_HREF = `/e/${EVENT_KEY}`;
const EMPTY_ROSTER_QUERY: RosterQuery = {
  q: "",
  status: "",
  sort: "status",
  order: "asc",
  page: 1,
};

type SavedStatus = "draft" | "published" | "cancelled" | "past";

function eventRow(status: SavedStatus): EventRow {
  return {
    eventKey: EVENT_KEY,
    title: "Friday games night",
    status,
    endsAt: new Date(Date.now() + 86_400_000),
    rsvpOpen: true,
  } as unknown as EventRow;
}

function kitRoster(): KitEventEditRosterView {
  return {
    total: 0,
    query: EMPTY_ROSTER_QUERY,
    entries: [],
    rangeStart: 0,
    rangeEnd: 0,
    rangeText: "No matching responses.",
    statusOptions: [{ value: "", label: "All", selected: true }],
    hasPrev: false,
    hasNext: false,
    prevUrl: null,
    nextUrl: null,
    clearUrl: null,
    firstUrl: null,
    emptyText: "No matching responses.",
    sortHeaders: [],
    searchAction: `/admin/events/${EVENT_KEY}#rsvp-roster`,
  };
}

function kitView(status: SavedStatus): KitEventEditView {
  return {
    key: EVENT_KEY,
    title: "Friday games night",
    status,
    values: {
      title: "",
      game: "",
      description: "",
      starts_at: "",
      ends_at: "",
      timezone: "",
      location: "",
      capacity: "",
    },
    errors: {},
    hasErrors: false,
    isDraft: status === "draft",
    showPublish: status === "draft",
    showCancel: status === "draft" || status === "published",
    rsvpAction: null,
    seriesNote: null,
    endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    roster: kitRoster(),
    pauseReviewHtml: null,
  };
}

type RenderKit = (data: Record<string, unknown>) => string;
let renderKitEdit: RenderKit;
let renderKitNew: RenderKit;
let scratch = "";

// Same real SSR compilation recipe as
// admin-dashboard-twin-parity-acceptance.test.ts. No route load, database,
// network, browser opt-in, source-grep assertions or renderer mocks.
beforeAll(async () => {
  scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "event-public-link-twin-ssr-"),
  );
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `import { render } from "svelte/server";
import EditPage from ${JSON.stringify(join(root, "web/src/routes/admin/events/[key]/+page.svelte"))};
import NewPage from ${JSON.stringify(join(root, "web/src/routes/admin/events/new/+page.svelte"))};
export function renderKitEdit(data) { return render(EditPage, { props: { data } }).body; }
export function renderKitNew(data) { return render(NewPage, { props: { data } }).body; }
`,
  );
  const outfile = join(scratch, "bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    tsconfigRaw: {},
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "event-public-link-twin-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const { js } = compile(readFileSync(args.path, "utf8"), {
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
  const mod = (await import(pathToFileURL(outfile).href)) as {
    renderKitEdit: RenderKit;
    renderKitNew: RenderKit;
  };
  renderKitEdit = mod.renderKitEdit;
  renderKitNew = mod.renderKitNew;
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const renderers = [
  {
    name: "Hono",
    renderEdit(status: SavedStatus) {
      return String(
        jsx(EventFormPage, {
          mode: "edit",
          row: eventRow(status),
          values: {},
          errors: {},
          roster: [],
          rosterTotal: 0,
          rosterQuery: EMPTY_ROSTER_QUERY,
        }),
      );
    },
    renderNew() {
      return String(jsx(EventFormPage, { mode: "new", values: {}, errors: {} }));
    },
  },
  {
    name: "Kit",
    renderEdit(status: SavedStatus) {
      return renderKitEdit({ view: kitView(status) });
    },
    renderNew() {
      return renderKitNew({ values: {}, errors: {}, hasErrors: false });
    },
  },
];

type Element = { attrs: string; body: string };
// Test-only markup walkers, mirroring the dashboard twin acceptance: the
// text walker advances token by token instead of a `<...>` regex replace so
// the helper does not read as an HTML sanitizer.
function text(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] === "<") {
      const close = html.indexOf(">", index);
      if (close === -1) break;
      index = close + 1;
      continue;
    }
    const next = html.indexOf("<", index);
    out += html.slice(index, next === -1 ? html.length : next);
    index = next === -1 ? html.length : next;
  }
  return out.replace(/\s+/g, " ").trim();
}
const attr = (element: Element, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(element.attrs)?.[1];
const elements = (html: string, tag: string): Element[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => ({
    attrs: match[1]!,
    body: match[2]!,
  }));
const PUBLIC_PATH = /^\/e\//;

function statusSection(html: string): Element {
  // The Status section nests inside the page's outer <section>, so a generic
  // non-greedy section walker would swallow its opening tag. Match the
  // labelled opening tag directly; the section itself nests no <section>.
  const opens = [...html.matchAll(/<section\b[^>]*aria-label="Status"[^>]*>/g)];
  expect(opens, "exactly one Status section").toHaveLength(1);
  const start = opens[0]!.index! + opens[0]![0].length;
  const end = html.indexOf("</section>", start);
  expect(end, "Status section closes").toBeGreaterThan(start);
  return { attrs: "", body: html.slice(start, end) };
}

function publicLinks(html: string): Element[] {
  return elements(statusSection(html).body, "a").filter((link) =>
    PUBLIC_PATH.test(attr(link, "href") ?? ""),
  );
}

for (const renderer of renderers) {
  describe(`${renderer.name} saved-editor public/preview link`, () => {
    it("draft editor links the moderator preview, worded preview not public", () => {
      const links = publicLinks(renderer.renderEdit("draft"));
      expect(links, "exactly one preview link in the Status section").toHaveLength(1);
      expect(attr(links[0]!, "href")).toBe(PUBLIC_HREF);
      const name = text(links[0]!.body);
      expect(name).toMatch(/preview/i);
      expect(name).not.toMatch(/public/i);
    });

    it.each(["published", "past"] as SavedStatus[])(
      "%s editor links the public page, worded public not preview",
      (status) => {
        const links = publicLinks(renderer.renderEdit(status));
        expect(links, "exactly one public link in the Status section").toHaveLength(1);
        expect(attr(links[0]!, "href")).toBe(PUBLIC_HREF);
        const name = text(links[0]!.body);
        expect(name).toMatch(/public/i);
        expect(name).not.toMatch(/preview/i);
      },
    );

    it("cancelled editor links nowhere public (the route answers 410 Gone)", () => {
      const section = statusSection(renderer.renderEdit("cancelled"));
      expect(
        elements(section.body, "a").filter((link) => PUBLIC_PATH.test(attr(link, "href") ?? "")),
      ).toHaveLength(0);
      for (const link of elements(section.body, "a")) {
        expect(text(link.body)).not.toMatch(/preview|public/i);
      }
    });

    it("unsaved form omits the public action", () => {
      const page = renderer.renderNew();
      expect(
        elements(page, "a").filter((link) => PUBLIC_PATH.test(attr(link, "href") ?? "")),
      ).toHaveLength(0);
    });
  });

  describe(`${renderer.name} saved-editor unchanged controls`, () => {
    const TRANSITIONS: {
      status: SavedStatus;
      publish: boolean;
      cancel: boolean;
      duplicate: boolean;
    }[] = [
      { status: "draft", publish: true, cancel: true, duplicate: true },
      { status: "published", publish: false, cancel: true, duplicate: true },
      { status: "cancelled", publish: false, cancel: false, duplicate: true },
      { status: "past", publish: false, cancel: false, duplicate: false },
    ];

    it.each(TRANSITIONS)(
      "$status keeps its publish/cancel/duplicate transitions",
      ({ status, publish, cancel, duplicate }) => {
        const page = renderer.renderEdit(status);
        expect(page.includes('data-testid="publish-event"'), "publish").toBe(publish);
        expect(page.includes('data-testid="cancel-event"'), "cancel").toBe(cancel);
        expect(page.includes('data-testid="duplicate-event"'), "duplicate").toBe(duplicate);
      },
    );

    it.each(["draft", "published", "cancelled", "past"] as SavedStatus[])(
      "%s keeps the Status heading and return-context actions",
      (status) => {
        const page = renderer.renderEdit(status);
        expect(page).toContain(`Status: ${status}`);
        const cancel = elements(page, "a").filter((link) => text(link.body) === "Cancel");
        expect(cancel.map((link) => attr(link, "href"))).toContain("/admin/events");
        expect(page).toContain('data-testid="save-event"');
      },
    );

    it("keeps the new-form save/cancel actions with no Status section", () => {
      const page = renderer.renderNew();
      expect(page).toContain("New event");
      expect(page).toContain('data-testid="save-event"');
      const cancel = elements(page, "a").filter((link) => text(link.body) === "Cancel");
      expect(cancel.map((link) => attr(link, "href"))).toContain("/admin/events");
      expect(page).not.toMatch(/aria-label="Status"/);
    });

    it("adds no delete affordance to the resource", () => {
      for (const status of ["draft", "published", "cancelled", "past"] as SavedStatus[]) {
        const page = renderer.renderEdit(status);
        expect(page).not.toContain("Delete event");
        expect(page).not.toContain('data-testid="delete-event"');
      }
      expect(renderer.renderNew()).not.toContain("Delete event");
    });

    it("keeps the dirty-form editor island and text-limit island", () => {
      for (const status of ["draft", "published"] as SavedStatus[]) {
        const page = renderer.renderEdit(status);
        expect(page).toContain("data-event-editor");
        expect(page).toContain("/islands/admin-event-editor.js");
        expect(page).toContain("/islands/admin-event-text-limits.js");
      }
      const fresh = renderer.renderNew();
      expect(fresh).toContain("data-event-editor");
      expect(fresh).toContain("/islands/admin-event-editor.js");
      expect(fresh).toContain("/islands/admin-event-text-limits.js");
    });

    it("keeps the roster save-first hint", () => {
      for (const status of ["draft", "published"] as SavedStatus[]) {
        expect(renderer.renderEdit(status)).toContain(
          "Save event changes before searching or sorting the roster.",
        );
      }
    });
  });
}

describe("saved-editor public-link twin parity", () => {
  it("resolves the same status-correct target in both twins", () => {
    for (const status of ["draft", "published", "past"] as SavedStatus[]) {
      const hrefs = renderers.map((renderer) => {
        const links = publicLinks(renderer.renderEdit(status));
        expect(links, `${renderer.name} ${status}`).toHaveLength(1);
        return attr(links[0]!, "href");
      });
      expect(hrefs[1], status).toBe(hrefs[0]);
    }
  });
});
