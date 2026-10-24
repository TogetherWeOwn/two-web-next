// Acceptance: the join-attempts outcome filter must show the exact active
// outcome in both controls (Hono JoinAttemptsPage and the Kit
// /admin/join-attempts page), even when the outcome is not one of the
// canonical JOIN_OUTCOMES.
//
// The shared query grammar preserves any nonempty outcome verbatim (no
// trimming, no case folding; only NUL is dropped) and the shared read
// filters by exact equality, so ?outcome=mystery_outcome and
// ?outcome=%20added really do narrow the list. Both templates receive the
// canonical outcomes plus the parsed query and today render only the
// canonical options: for an unrecognized outcome no option is selected, so
// the browser displays the first option ("All") while the list stays
// filtered — the control lies about the active filter.
//
// Contract pinned here, for both renderers:
// - exactly one option is selected, and it is the exact active outcome;
// - an unrecognized outcome gets its own explicit option (value and label
//   are the exact outcome, HTML-escaped), instead of a misleading "All";
// - known outcomes and the genuinely empty filter keep today's rendering
//   (canonical options only, "All" selected only when outcome is "");
// - exact-filter semantics and paging retention are unchanged: parsing
//   does not normalize the outcome and prev/next links round-trip it
//   byte-for-byte;
// - moderator/member gates, audit subjects and read-only posture stay as
//   they are (guarded DB route case at the end).
//
// These tests are written from that contract. The unrecognized-outcome
// cases are expected to fail until both templates render the explicit
// option; the All/known/gate/paging controls already pass.
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JoinAttemptsPage } from "../src/admin/pages/join-attempts";
import { JOIN_RETENTION_DAYS } from "../src/admin/reads";
import { adminApp } from "../src/admin/routes";
import {
  JOIN_ATTEMPT_PAGE_SIZE,
  joinAttemptsUrl,
  parseJoinAttemptsQuery,
  type JoinAttemptsQuery,
} from "../src/admin/table-list";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import { joinAttempts } from "../src/db/schema";
import { JOIN_OUTCOMES } from "../src/join/service";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const UNKNOWN = "mystery_outcome";
const LEADING_SPACE = " added";
const TRAILING_SPACE = "added ";
const CASE_VARIANT = "Added";
const HTML_SENSITIVE = '"><script>alert(1)</script>';
const AMPERSAND = "A & B";
const UNRECOGNIZED = [
  UNKNOWN,
  LEADING_SPACE,
  TRAILING_SPACE,
  CASE_VARIANT,
  HTML_SENSITIVE,
  AMPERSAND,
];

type ParsedOption = { value: string; label: string; selected: boolean };

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return HTML_ENTITIES[entity] ?? _match;
  });
}

// Tag attributes, quote-aware: a quoted attribute value may itself
// contain ">" (Svelte leaves it raw there), which a browser accepts.
const ATTRS = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*)`;

// The outcome <select> as a browser sees it: option values, labels and the
// one `selected` attribute, entities decoded. No selected option at all
// means the browser displays the first option — that is the defect.
function parseOutcomeOptions(html: string): ParsedOption[] {
  const opens = [...html.matchAll(new RegExp(`<select\\b${ATTRS}>`, "g"))];
  const open = opens.find((m) => /\bid="outcome"/.test(m[1]!));
  expect(open, "an outcome select is rendered").toBeDefined();
  expect(open![1]).toMatch(/\bname="outcome"/);
  const bodyStart = open!.index + open![0].length;
  const body = html.slice(bodyStart, html.indexOf("</select>", bodyStart));
  return [...body.matchAll(new RegExp(`<option\\b${ATTRS}>([\\s\\S]*?)</option>`, "g"))].map(
    (m) => ({
      value: unescapeHtml(/\bvalue="([^"]*)"/.exec(m[1]!)?.[1] ?? ""),
      label: unescapeHtml(m[2]!),
      selected: /\bselected\b/.test(m[1]!),
    }),
  );
}

// The full control contract for one rendered page and active outcome.
function expectOutcomeControl(html: string, outcome: string) {
  const options = parseOutcomeOptions(html);

  // Canonical options are all still there exactly once, "All" for "".
  for (const canonical of ["", ...JOIN_OUTCOMES]) {
    const matches = options.filter((o) => o.value === canonical);
    expect(matches, `one option for canonical ${JSON.stringify(canonical)}`).toHaveLength(1);
    expect(matches[0]!.label).toBe(canonical === "" ? "All" : canonical);
  }

  // Exactly one selected option: the exact active outcome, labelled with
  // itself ("All" only for the genuinely empty filter). Checked first
  // because "no option is selected, so the browser shows All" is the
  // defect these cases exist to expose.
  const selected = options.filter((o) => o.selected);
  expect(selected, "exactly one selected option").toHaveLength(1);
  expect(selected[0]!.value).toBe(outcome);
  expect(selected[0]!.label).toBe(outcome === "" ? "All" : outcome);
  if (outcome !== "") {
    expect(options.find((o) => o.value === "")!.selected).toBe(false);
  }

  const recognized = outcome === "" || (JOIN_OUTCOMES as readonly string[]).includes(outcome);
  // An unrecognized outcome adds exactly one explicit option; a known or
  // empty outcome adds none (no duplicate canonical option).
  expect(options).toHaveLength(JOIN_OUTCOMES.length + 1 + (recognized ? 0 : 1));
}

function pagingOutcome(html: string, rel: "next" | "prev"): string | null {
  const href = html.match(new RegExp(`rel="${rel}" href="([^"]+)"`))?.[1]?.replaceAll("&amp;", "&");
  // Present whenever these helpers are called; a missing link must fail
  // the assertion at the call site, not silently read as "no outcome".
  expect(href, `a rel="${rel}" paging link is rendered`).toBeDefined();
  return new URL(href!, env.APP_URL).searchParams.get("outcome");
}

// --- Hono template ---------------------------------------------------------

function honoHtml(outcome: string | undefined): string {
  return String(
    jsx(JoinAttemptsPage, {
      rows: [],
      query: parseJoinAttemptsQuery({ outcome }),
      hasNext: true,
      outcomes: JOIN_OUTCOMES,
    }),
  );
}

describe("Hono join-attempts outcome control", () => {
  it("selects All only for the genuinely empty filter", () => {
    expectOutcomeControl(honoHtml(undefined), "");
    expectOutcomeControl(honoHtml(""), "");
  });

  it.each(JOIN_OUTCOMES)("selects the known outcome %s with no extra option", (outcome) => {
    expectOutcomeControl(honoHtml(outcome), outcome);
  });

  it.each(UNRECOGNIZED)(
    "selects an explicit option for the exact unrecognized outcome %j",
    (outcome) => {
      expectOutcomeControl(honoHtml(outcome), outcome);
    },
  );

  it("escapes an HTML-sensitive unrecognized outcome instead of emitting it as markup", () => {
    const html = honoHtml(HTML_SENSITIVE);
    expect(html).not.toContain("<script>alert(1)");
    expectOutcomeControl(html, HTML_SENSITIVE);
  });

  it.each([UNKNOWN, LEADING_SPACE, HTML_SENSITIVE])(
    "keeps the exact unrecognized outcome %j in the next-page link",
    (outcome) => {
      expect(pagingOutcome(honoHtml(outcome), "next")).toBe(outcome);
    },
  );
});

// --- Kit template ----------------------------------------------------------

const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};
type RenderPage = (data: Record<string, unknown>) => string;
let renderPage: RenderPage;
let scratch = "";

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-join-attempts-outcome-render-"));
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/join-attempts/+page.svelte"))};
export function renderPage(data) { return render(Page, { props: { data } }).body; }
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
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-join-attempts-outcome-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, { generate: "server", dev: false, filename: args.path });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as { renderPage: RenderPage };
  renderPage = mod.renderPage;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// The data shape web/src/routes/admin/join-attempts/+page.server.ts returns:
// canonical outcomes, the parsed query, prev/next URLs from the shared
// joinAttemptsUrl helper.
function kitHtml(outcome: string | undefined, page = 1): string {
  const query: JoinAttemptsQuery = parseJoinAttemptsQuery({
    outcome,
    page: page > 1 ? String(page) : undefined,
  });
  return renderPage({
    rows: [],
    query,
    hasNext: true,
    prevUrl: query.page > 1 ? joinAttemptsUrl(query, query.page - 1) : null,
    nextUrl: joinAttemptsUrl(query, query.page + 1),
    outcomes: [...JOIN_OUTCOMES],
    retentionDays: JOIN_RETENTION_DAYS,
  });
}

describe("Kit join-attempts outcome control", () => {
  it("selects All only for the genuinely empty filter", () => {
    expectOutcomeControl(kitHtml(undefined), "");
    expectOutcomeControl(kitHtml(""), "");
  });

  it.each(JOIN_OUTCOMES)("selects the known outcome %s with no extra option", (outcome) => {
    expectOutcomeControl(kitHtml(outcome), outcome);
  });

  it.each(UNRECOGNIZED)(
    "selects an explicit option for the exact unrecognized outcome %j",
    (outcome) => {
      expectOutcomeControl(kitHtml(outcome), outcome);
    },
  );

  it("escapes an HTML-sensitive unrecognized outcome instead of emitting it as markup", () => {
    const html = kitHtml(HTML_SENSITIVE);
    expect(html).not.toContain("<script>alert(1)");
    expectOutcomeControl(html, HTML_SENSITIVE);
  });

  it.each([UNKNOWN, LEADING_SPACE, HTML_SENSITIVE])(
    "keeps the exact unrecognized outcome %j in the next and prev links",
    (outcome) => {
      const html = kitHtml(outcome, 2);
      expect(pagingOutcome(html, "next")).toBe(outcome);
      expect(pagingOutcome(html, "prev")).toBe(outcome);
      expectOutcomeControl(html, outcome);
    },
  );
});

// --- Shared query grammar: the fix must not normalize the filter -----------

describe("join-attempts query grammar stays exact", () => {
  it.each([...JOIN_OUTCOMES, "", ...UNRECOGNIZED])(
    "parses outcome %j verbatim (no trim, no case folding, no allowlist)",
    (outcome) => {
      expect(parseJoinAttemptsQuery({ outcome }).outcome).toBe(outcome);
    },
  );

  it("still drops NUL so a NUL-only outcome reads as the empty filter", () => {
    const nul = String.fromCharCode(0);
    expect(parseJoinAttemptsQuery({ outcome: nul }).outcome).toBe("");
    expect(parseJoinAttemptsQuery({ outcome: `added${nul}` }).outcome).toBe("added");
  });

  it.each(UNRECOGNIZED)("round-trips unrecognized outcome %j through paging URLs", (outcome) => {
    const url = new URL(joinAttemptsUrl({ outcome, q: "", page: 1 }, 2), env.APP_URL);
    expect(url.searchParams.get("outcome")).toBe(outcome);
    expect(url.searchParams.get("page")).toBe("2");
  });
});

// --- Gates stay put (no DB) ------------------------------------------------

describe("join-attempts gates with an unrecognized outcome (no DB)", () => {
  it("keeps anonymous and plain-member requests behind the moderator guard", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const memberCookie = await cookieFor(store, MEMBER);
    const path = `/join-attempts?outcome=${encodeURIComponent(UNKNOWN)}`;
    expect((await app.request(path, {}, env)).status).toBe(302);
    expect((await app.request(path, { headers: { cookie: memberCookie } }, env)).status).toBe(403);
  });
});

// --- Guarded DB route case: visible control matches exact results ----------

describe.skipIf(!process.env.DATABASE_URL)(
  "join-attempts route with unrecognized outcomes (isolated agent-testdb / CI schema)",
  () => {
    let fixture: MemberDataFixture;
    let cookie: string;
    const store = createMemorySessionStore();

    const request = async (path: string) => {
      const response = await adminApp({ sessionStore: store, db: fixture.db }).request(
        path,
        { headers: { cookie } },
        { ...env, ADMIN_DB: fixture.db },
      );
      expect(response.status).toBe(200);
      return response.text();
    };
    const attemptIds = (html: string) =>
      [...html.matchAll(/href="\/admin\/join-attempts\/(\d+)(?:\?[^"]*)?"/g)].map((m) =>
        Number(m[1]),
      );
    const logs = () =>
      fixture.db.select().from(memberDataAccessLogs).orderBy(memberDataAccessLogs.id);

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(() => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      cookie = await cookieFor(store, MODERATOR);
    });

    const discordId = (i: number) => String(100000000000007000n + BigInt(i));

    async function seed() {
      let n = 0;
      const insert = (outcome: string, count: number) =>
        fixture.db
          .insert(joinAttempts)
          .values(
            Array.from({ length: count }, () => ({
              outcome,
              discordId: discordId(n++),
              requestId: `req-${outcome}-${n}`,
            })),
          )
          .returning();
      const added = await insert("added", 2);
      const leading = await insert(LEADING_SPACE, 1);
      const unknown = await insert(UNKNOWN, JOIN_ATTEMPT_PAGE_SIZE + 2);
      return { added, leading, unknown };
    }

    it("shows exactly the unrecognized rows, selects that outcome and keeps it while paging", async () => {
      const { unknown } = await seed();
      const ordered = [...unknown].reverse();

      const first = await request(`/join-attempts?outcome=${encodeURIComponent(UNKNOWN)}`);
      expect(attemptIds(first)).toEqual(ordered.slice(0, JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.id));
      expectOutcomeControl(first, UNKNOWN);
      expect(pagingOutcome(first, "next")).toBe(UNKNOWN);

      // Audit stays scoped to the retrieved unrecognized rows.
      const firstLogs = await logs();
      expect(firstLogs).toHaveLength(1);
      expect(firstLogs[0]!.route).toBe("admin.join-attempts.index");
      const unknownOwners = new Set(unknown.map((r) => r.discordId));
      expect(firstLogs[0]!.subjectUserIds.every((id) => unknownOwners.has(id))).toBe(true);

      const second = await request(
        `/join-attempts${new URL(first.match(/rel="next" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), env.APP_URL).search}`,
      );
      expect(attemptIds(second)).toEqual(ordered.slice(JOIN_ATTEMPT_PAGE_SIZE).map((r) => r.id));
      expectOutcomeControl(second, UNKNOWN);
      expect(pagingOutcome(second, "prev")).toBe(UNKNOWN);
      expect(second).not.toMatch(/rel="next"/);
      expect(await logs()).toHaveLength(2);
    });

    it("keeps leading-whitespace outcomes exact: ' added' never reads as 'added'", async () => {
      const { added, leading } = await seed();

      const spaced = await request(`/join-attempts?outcome=${encodeURIComponent(LEADING_SPACE)}`);
      expect(attemptIds(spaced)).toEqual([leading[0]!.id]);
      expectOutcomeControl(spaced, LEADING_SPACE);

      const canonical = await request("/join-attempts?outcome=added");
      expect(attemptIds(canonical).sort()).toEqual(added.map((r) => r.id).sort());
      expect(attemptIds(canonical)).not.toContain(leading[0]!.id);
      expectOutcomeControl(canonical, "added");
    });

    it("keeps All for the unfiltered list and the known outcome selected", async () => {
      await seed();
      expectOutcomeControl(await request("/join-attempts"), "");
      expectOutcomeControl(await request("/join-attempts?outcome=denied"), "denied");
    });
  },
);
