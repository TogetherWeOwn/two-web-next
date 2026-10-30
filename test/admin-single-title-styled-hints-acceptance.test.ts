// E8 acceptance: single admin tab titles plus styled hints and fieldset.
//
// TEST AUTHOR OWNED — the Builder builds on this branch and never edits this
// file. Corrections come back to the Test Author.
//
// Failing-first map (repo pin 45f29820):
//   RED now, GREEN after the Builder fix:
//     - Kit join-attempts list/detail pages declare their own <title> on top
//       of AdminShell's (duplicate declarations in the component tree).
//     - No bare-`.hint` rule exists (only `.field .hint`), so bare hint
//       paragraphs render at full body size on five admin surfaces.
//     - No `fieldset`/`legend` rules exist, so the Repeat group renders a
//       browser-default groove border.
//   GREEN now (controls that must stay green through the fix):
//     - Hono response HTML serves exactly one <title> with unchanged tab text
//       on both join-attempts routes.
//     - Kit SSR heads serve exactly one <title> with the same unchanged text
//       (Svelte 5 SSR dedupes identical <title> declarations today, so served
//       validity already holds; the duplication pins below are source-level
//       and that is where they fail).
//     - Hono-vs-Kit render equality on the five admin pages: list, detail,
//       activity-log, new-event (fieldset) and edit-event (series-info and
//       roster-hint). The Builder changes chrome, not markup or copy.
//
// Builder contract: remove the page-level <title> declarations (keep the
// AdminShell title props byte-identical), add the bare-`.hint` and
// fieldset/legend rules to the reviewed assets/styles.css source, and rebuild
// with `npm run build:assets` so public/styles.css carries them. Local
// fixtures only: no DB, no network, no Discord.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ActivityLogPage,
  EventFormPage,
  JoinAttemptPage,
  JoinAttemptsPage,
} from "../src/admin/pages";
import { EventFormFields } from "../src/admin/pages/event-form-fields";
import { EventRosterSection } from "../src/admin/pages/event-form-roster";
import { JOIN_RETENTION_DAYS } from "../src/admin/reads";
import type { ActivityLogViewerRow, JoinAttemptRow, RosterEntry } from "../src/admin/reads";
import type { EventRow } from "../src/admin/store";
import {
  parseActivityLogQuery,
  parseJoinAttemptsQuery,
  parseRosterQuery,
} from "../src/admin/table-list";
import { JOIN_OUTCOMES } from "../src/join/service";
import { pageShellFixture } from "./helpers/page-shells";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// --- Stylesheet helpers ------------------------------------------------------
// A minimal comment-strip + rule-split over the shared admin sheet, applied
// identically to the reviewed assets/ source and the deterministic esbuild
// --minify output in public/. No new dependencies.

type CssRule = { selectors: string[]; block: string };

function cssRules(css: string): CssRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (selectors.length > 0) rules.push({ selectors, block: match[2]! });
  }
  return rules;
}

const findRule = (rules: CssRule[], selector: string): CssRule | undefined =>
  [...rules].reverse().find((r) => r.selectors.includes(selector));

const findBareHintRule = (rules: CssRule[]): CssRule | undefined =>
  [...rules].reverse().find((r) => r.selectors.some((s) => s === ".hint" || s === "p.hint"));

// --- Kit SSR harness ---------------------------------------------------------
// One esbuild bundle SSR-renders the five Kit admin pages through web's
// svelte/compiler, following test/kit-activity-log-render.test.mjs. Each
// renderer returns the full svelte/server result so pins can read head (tab
// titles) and body (hint/fieldset markup) separately.

const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as any;

type KitRender = { head: string; body: string };
type KitRenderer = (data: unknown) => KitRender;

let renderList: KitRenderer;
let renderDetail: KitRenderer;
let renderActivity: KitRenderer;
let renderNew: KitRenderer;
let renderEdit: KitRenderer;

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: [
        'import { render } from "svelte/server";',
        'import ListPage from "./web/src/routes/admin/join-attempts/+page.svelte";',
        'import DetailPage from "./web/src/routes/admin/join-attempts/[id]/+page.svelte";',
        'import ActivityPage from "./web/src/routes/admin/activity-log/+page.svelte";',
        'import NewPage from "./web/src/routes/admin/events/new/+page.svelte";',
        'import EditPage from "./web/src/routes/admin/events/[key]/+page.svelte";',
        "export const renderList = (data) => render(ListPage, { props: { data } });",
        "export const renderDetail = (data) => render(DetailPage, { props: { data } });",
        "export const renderActivity = (data) => render(ActivityPage, { props: { data } });",
        "export const renderNew = (data) => render(NewPage, { props: { data } });",
        "export const renderEdit = (data) => render(EditPage, { props: { data } });",
      ].join("\n"),
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "e8-admin-chrome-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const bundled = `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`;
  const mod = await import(bundled);
  renderList = mod.renderList;
  renderDetail = mod.renderDetail;
  renderActivity = mod.renderActivity;
  renderNew = mod.renderNew;
  renderEdit = mod.renderEdit;
}, 60_000);

// --- Shared fixtures ---------------------------------------------------------

const OUTCOMES = [...JOIN_OUTCOMES];
const LIST_QUERY = parseJoinAttemptsQuery({});
const ACTIVITY_QUERY = parseActivityLogQuery({});

const attemptRow: JoinAttemptRow = {
  id: 7,
  outcome: "added",
  source: "join",
  requestId: "req-1",
  discordId: "123",
  createdAt: new Date("2026-10-01T12:00:00Z"),
};

const activityRows: ActivityLogViewerRow[] = [
  {
    id: 1,
    description: "updated event Alpha",
    subjectType: "Event",
    subjectId: "01J00000000000000000000015",
    causerId: "100000000000000111",
    event: "updated",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
  },
];

const at = new Date("2030-01-01T20:00:00Z");
const eventRow: EventRow = {
  id: 1,
  eventKey: "01J0000000000000000000ABCD",
  title: "Friday games",
  game: null,
  description: null,
  startsAt: at,
  endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "UTC",
  location: null,
  capacity: null,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: "weekly",
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 0,
  syncedRevision: 0,
  rsvpOpen: true,
  createdBy: null,
  createdAt: at,
  updatedAt: at,
};

const roster: RosterEntry[] = [
  { userId: "u1", username: "Alice", status: "going", answeredAt: at },
];

// The Hono series sentence (event-form-fields.tsx) and the Kit resolver
// sentence (kit-event-edit.ts) share this copy; the edit equality pin feeds
// the same frequency to both renderers and compares the rendered fragments.
const SERIES_NOTE =
  "Part of a weekly series. Moving this event moves the not-yet-started occurrences by the same amount.";

const kitListData = () => ({
  rows: [],
  query: { q: "", outcome: "", page: 1 },
  hasNext: false,
  prevUrl: null,
  nextUrl: null,
  outcomes: OUTCOMES,
  retentionDays: JOIN_RETENTION_DAYS,
});

const kitDetailData = () => ({
  view: {
    id: attemptRow.id,
    outcome: attemptRow.outcome,
    source: attemptRow.source,
    requestId: attemptRow.requestId,
    discordId: attemptRow.discordId,
    createdAt: attemptRow.createdAt.toISOString(),
  },
});

const kitActivityData = () => ({
  rows: activityRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  query: { subject: "", causer: "", page: 1 },
  hasNext: false,
});

// Fixture-schema migration only: the edit port now carries canonical escaped
// server HTML. All E8 acceptance expectations below remain unchanged.
const kitEditData = () => ({
  view: {
    formHtml: String(
      jsx(EventFormFields, {
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        action: `/admin/events/${eventRow.eventKey}`,
      }),
    ),
    rosterHtml: String(
      jsx(EventRosterSection, {
        eventKey: eventRow.eventKey,
        action: `/admin/events/${eventRow.eventKey}`,
        roster,
        rosterQuery: parseRosterQuery({}),
      }),
    ),
    title: eventRow.title,
    key: eventRow.eventKey,
    values: {},
    errors: {},
    hasErrors: false,
    seriesNote: SERIES_NOTE,
    status: "published",
    showPublish: false,
    showCancel: true,
    rsvpAction: null,
    roster: {
      total: 1,
      query: { q: "", status: "", sort: "answered", order: "desc", page: 1 },
      searchAction: `/admin/events/${eventRow.eventKey}#rsvp-roster`,
      sortHeaders: [],
      entries: [{ member: "Alice", status: "going", answeredAt: at.toISOString() }],
      emptyText: "No RSVPs.",
      hasPrev: false,
      prevUrl: null,
      hasNext: false,
      nextUrl: null,
      rangeStart: 1,
      rangeEnd: 1,
      rangeText: "Showing 1-1 of 1 responses",
      statusOptions: [
        { value: "", label: "All", selected: true },
        { value: "going", label: "Going", selected: false },
        { value: "waitlisted", label: "Waitlisted", selected: false },
        { value: "maybe", label: "Maybe", selected: false },
        { value: "not_going", label: "Not going", selected: false },
      ],
      clearUrl: null,
      firstUrl: null,
    },
  },
});

// Collapse render whitespace so Hono JSX line wraps and Kit SSR spacing
// compare as the copy readers see them.
const normalize = (html: string): string => html.replace(/\s+/g, " ").trim();

function bareHintInner(html: string): string {
  const match = html.match(/<p\b[^>]*\bclass="hint"[^>]*>([\s\S]*?)<\/p>/);
  expect(match, 'expected a bare <p class="hint"> in the render').not.toBeNull();
  return normalize(match![1]!);
}

function seriesInfoInner(html: string): string {
  const match = html.match(/<p\b[^>]*\bdata-testid="series-info"[^>]*>([\s\S]*?)<\/p>/);
  expect(match, "expected the series-info hint in the render").not.toBeNull();
  expect(match![0]).toContain('class="hint"');
  return normalize(match![1]!);
}

const titleCount = (html: string): number => html.match(/<title[\s>]/g)?.length ?? 0;

// --- Duplicate tab-title declarations (fail first) ---------------------------

describe("E8 Kit tab titles: AdminShell owns the single declaration", () => {
  it("the join-attempts list page declares no <title> of its own", () => {
    const page = read("web/src/routes/admin/join-attempts/+page.svelte");
    expect(
      page.match(/<title[\s>]/g),
      "AdminShell owns tab titles (admin/+layout.svelte): remove the page-level " +
        '<svelte:head><title> from the list page, keeping title="Join attempts" on <AdminShell>',
    ).toBeNull();
  });

  it("the join-attempt detail page declares no <title> of its own", () => {
    const page = read("web/src/routes/admin/join-attempts/[id]/+page.svelte");
    expect(
      page.match(/<title[\s>]/g),
      "AdminShell owns tab titles (admin/+layout.svelte): remove the page-level " +
        "<svelte:head><title> from the detail page, keeping title={`Join attempt ${view.id}`} on <AdminShell>",
    ).toBeNull();
  });
});

// --- Tab text unchanged (controls) -------------------------------------------

describe("E8 tab text: unchanged through the dedupe", () => {
  it("AdminShell renders the shared tab-title shape", () => {
    expect(read("web/src/lib/AdminShell.svelte")).toContain("<title>{title} — TWO admin</title>");
  });

  it("the list page keeps its shell title prop byte-identical", () => {
    expect(read("web/src/routes/admin/join-attempts/+page.svelte")).toContain(
      '<AdminShell title="Join attempts">',
    );
  });

  it("the detail page keeps its shell title prop byte-identical", () => {
    expect(read("web/src/routes/admin/join-attempts/[id]/+page.svelte")).toContain(
      "<AdminShell title={`Join attempt ${view.id}`}>",
    );
  });
});

// --- Served single titles (controls) -----------------------------------------

describe("E8 Hono response HTML: exactly one <title> per join-attempts page", () => {
  it("GET /admin/join-attempts serves one title with unchanged text", async () => {
    const response = await pageShellFixture().request("/admin/join-attempts");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(titleCount(html)).toBe(1);
    expect(html).toContain("<title>Join attempts — TWO admin</title>");
  });

  it("GET /admin/join-attempts/:id serves one title with unchanged text", async () => {
    const response = await pageShellFixture().request("/admin/join-attempts/1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(titleCount(html)).toBe(1);
    expect(html).toContain("<title>Join attempt 1 — TWO admin</title>");
  });
});

describe("E8 Kit served heads: exactly one <title> per join-attempts page", () => {
  it("the list head carries one title with unchanged text", () => {
    const { head } = renderList(kitListData());
    expect(titleCount(head)).toBe(1);
    expect(head).toContain("<title>Join attempts — TWO admin</title>");
  });

  it("the detail head carries one title with unchanged text", () => {
    const { head } = renderDetail(kitDetailData());
    expect(titleCount(head)).toBe(1);
    expect(head).toContain("<title>Join attempt 7 — TWO admin</title>");
  });
});

// --- Stylesheet rules (fail first) -------------------------------------------

describe("E8 stylesheet: bare hints and fieldset/legend in source and built output", () => {
  const sources = {
    "assets/styles.css": () => cssRules(read("assets/styles.css")),
    "public/styles.css": () => cssRules(read("public/styles.css")),
  } as const;

  for (const [name, load] of Object.entries(sources)) {
    it(`${name} carries a bare-.hint rule, not only .field .hint`, () => {
      expect(
        findBareHintRule(load()),
        `${name} must add a bare .hint rule (the existing .field .hint leaves bare ` +
          '<p class="hint"> at full body size on the five admin surfaces)',
      ).toBeDefined();
    });

    it(`${name} de-emphasizes bare hints: smaller and muted`, () => {
      const rule = findBareHintRule(load());
      expect(rule, `${name} must add a bare .hint rule first`).toBeDefined();
      expect(rule!.block).toMatch(/(?:^|[;\s])font-size\s*:\s*\.85rem\s*(?:;|$)/);
      expect(rule!.block).toMatch(/(?:^|[;\s])color\s*:\s*#6b6257\s*(?:;|$)/);
    });

    it(`${name} styles the Repeat fieldset away from the groove default`, () => {
      const rule = findRule(load(), "fieldset");
      expect(rule, `${name} must add a fieldset rule`).toBeDefined();
      expect(rule!.block).toMatch(/(?:^|[;\s])border\s*:\s*1px solid #d8cfc0\s*(?:;|$)/);
      expect(rule!.block).toMatch(/(?:^|[;\s])background\s*:\s*#fffdf8\s*(?:;|$)/);
    });

    it(`${name} styles the Repeat legend to match admin chrome`, () => {
      const rule = findRule(load(), "legend");
      expect(rule, `${name} must add a legend rule`).toBeDefined();
      expect(rule!.block).toMatch(/(?:^|[;\s])font-weight\s*:\s*700\s*(?:;|$)/);
      expect(rule!.block).toMatch(/(?:^|[;\s])padding\s*:\s*0 \.5rem\s*(?:;|$)/);
    });
  }

  it("assets keeps the scoped .field .hint rule the Builder extends, not replaces", () => {
    expect(findRule(cssRules(read("assets/styles.css")), ".field .hint")).toBeDefined();
  });

  it("built output keeps the scoped .field .hint rule after the rebuild", () => {
    expect(findRule(cssRules(read("public/styles.css")), ".field .hint")).toBeDefined();
  });
});

// --- Hono-vs-Kit render equality (controls) ----------------------------------

describe("E8 Hono-vs-Kit equality on the five admin pages", () => {
  it("list: the same bare hint on both renderers", () => {
    const hono = String(
      jsx(JoinAttemptsPage, { rows: [], query: LIST_QUERY, hasNext: false, outcomes: OUTCOMES }),
    );
    const kit = renderList(kitListData()).body;
    expect(bareHintInner(kit)).toBe(bareHintInner(hono));
    expect(bareHintInner(hono)).toContain("Search is an exact Discord id or request id.");
  });

  it("detail: the same bare hint on both renderers", () => {
    const hono = String(jsx(JoinAttemptPage, { row: attemptRow }));
    const kit = renderDetail(kitDetailData()).body;
    expect(bareHintInner(kit)).toBe(bareHintInner(hono));
    expect(bareHintInner(hono)).toContain(
      "Read-only. Attempted at and trace identifiers are shown as recorded.",
    );
  });

  it("activity-log: the same bare hint on both renderers", () => {
    const hono = String(
      jsx(ActivityLogPage, { rows: activityRows, query: ACTIVITY_QUERY, hasNext: false }),
    );
    const kit = renderActivity(kitActivityData()).body;
    expect(bareHintInner(kit)).toBe(bareHintInner(hono));
    expect(bareHintInner(hono)).toContain("imported causer IDs are labeled legacy.");
  });

  it("edit: the same series-info hint on both renderers", () => {
    const hono = String(
      jsx(EventFormPage, {
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster,
        rosterQuery: parseRosterQuery({}),
      }),
    );
    const kit = renderEdit(kitEditData()).body;
    expect(seriesInfoInner(kit)).toBe(seriesInfoInner(hono));
    expect(seriesInfoInner(hono)).toBe(normalize(SERIES_NOTE));
  });

  it("edit: the same roster hint on both renderers", () => {
    const hono = String(
      jsx(EventFormPage, {
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster,
        rosterQuery: parseRosterQuery({}),
      }),
    );
    const kit = renderEdit(kitEditData()).body;
    for (const html of [hono, kit]) {
      expect(normalize(html)).toContain(
        "Save event changes before searching or sorting the roster.",
      );
    }
  });

  it("new: the same Repeat fieldset and legend on both renderers", () => {
    const hono = String(jsx(EventFormPage, { mode: "new", values: {}, errors: {} }));
    const kit = renderNew({ values: {}, errors: {}, hasErrors: false }).body;
    for (const [label, html] of [
      ["Hono", hono],
      ["Kit", kit],
    ] as const) {
      expect(html, `${label} new-event render keeps the Repeat fieldset`).toContain("<fieldset>");
      expect(html, `${label} new-event render keeps the Repeat legend`).toContain(
        "<legend>Repeat</legend>",
      );
      for (const name of ["recurrence_frequency", "recurrence_count", "recurrence_ends_on"]) {
        expect(html, `${label} new-event render keeps ${name}`).toContain(`name="${name}"`);
      }
    }
  });
});
